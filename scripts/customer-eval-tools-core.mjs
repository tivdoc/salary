import { createHash } from "node:crypto";
import path from "node:path";

export const NEUTRAL_CUSTOMER_ID = /^CUSTOMER_EVAL_\d{3}$/;
export const GROUND_TRUTH_STATES = new Set([
  "exact",
  "expected_absent",
  "ambiguous",
  "unscored_not_annotated",
]);
export const ALLOWED_V3_REGION_CATEGORIES = new Set([
  "salary_period",
  "earnings_table",
  "hours_and_rates",
  "overtime_rows",
  "totals",
  "pension_and_severance",
  "travel_and_convalescence",
  "vacation_and_sick_balances",
  "other_scored_payroll_components",
]);
const FORBIDDEN_PRIVATE_KEY = /(?:^|_)(?:original_(?:file(?:name)?|path)|source_(?:file(?:name)?|path)|person_name|employee_name|employer_name|employer_identity|national_id|address|bank_(?:account|details)|phone|email|raw_ocr|ocr_text|raw_provider|provider_error_body|api_key|screenshot|model_output)(?:$|_)/iu;
const FORBIDDEN_GROUND_TRUTH_FIELD = /(?:person_name|employee_(?:name|id|number)|employer_(?:name|identity|registration|number|id|address)|national_id|identity_number|address|phone|email|bank_(?:account|details)|signature|barcode|source_|original_|ocr)/iu;

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => !key.endsWith("timestamp") && key !== "created_at" && key !== "updated_at")
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function stableJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizedRectangle(rectangle, dimensions) {
  const { width, height } = dimensions;
  return {
    left: rectangle.left / width,
    top: rectangle.top / height,
    width: rectangle.width / width,
    height: rectangle.height / height,
  };
}

export function rectangleContains(outer, inner) {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.left + inner.width <= outer.left + outer.width &&
    inner.top + inner.height <= outer.top + outer.height
  );
}

export function rectanglesIntersect(first, second) {
  return !(
    first.left + first.width <= second.left ||
    second.left + second.width <= first.left ||
    first.top + first.height <= second.top ||
    second.top + second.height <= first.top
  );
}

export function rectanglesTouchOrIntersect(first, second) {
  return !(
    first.left + first.width < second.left ||
    second.left + second.width < first.left ||
    first.top + first.height < second.top ||
    second.top + second.height < first.top
  );
}

export function buildSensitiveInventory(document) {
  const { width, height } = document.dimensions;
  const allowed = document.allowlist;
  const candidates = [
    ["employee_and_employer_identity_header", { left: 0, top: 0, width, height: allowed.top }],
    [
      "identity_payment_and_mixed_summary_sidebar",
      { left: 0, top: allowed.top, width: allowed.left, height: allowed.height },
    ],
    [
      "non_allowlisted_right_margin",
      {
        left: allowed.left + allowed.width,
        top: allowed.top,
        width: width - allowed.left - allowed.width,
        height: allowed.height,
      },
    ],
    [
      "identity_bearing_footer_and_free_text",
      { left: 0, top: allowed.top + allowed.height, width, height: height - allowed.top - allowed.height },
    ],
  ];

  return candidates
    .filter(([, rectangle]) => rectangle.width > 0 && rectangle.height > 0)
    .map(([category, rectangle]) => ({
      page: 1,
      category,
      rectangle,
      normalized_rectangle: normalizedRectangle(rectangle, document.dimensions),
      status: "removed_by_v2_and_excluded_from_v3",
      verification_status: "verified_excluded_by_source_aware_allowlist",
    }));
}

export function validateSourceAwarePlan(document, inset = 3) {
  const issues = [];
  const inventory = buildSensitiveInventory(document);
  if (!NEUTRAL_CUSTOMER_ID.test(document.id)) issues.push("non_neutral_document_id");
  if (!Number.isInteger(inset) || inset < 1) issues.push("unsafe_inset");
  if (!rectangleContains({ left: 0, top: 0, ...document.dimensions }, document.allowlist)) {
    issues.push("allowlist_outside_document");
  }

  const sections = document.sections.map(([category, top, bottom], index) => {
    const rectangle = {
      left: document.allowlist.left + inset,
      top: top + inset,
      width: document.allowlist.width - inset * 2,
      height: bottom - top - inset * 2,
    };
    if (rectangle.width <= 0 || rectangle.height <= 0) issues.push(`empty_section_${index + 1}`);
    if (!ALLOWED_V3_REGION_CATEGORIES.has(category)) issues.push(`forbidden_section_category_${index + 1}`);
    if (!rectangleContains(document.allowlist, rectangle)) issues.push(`section_outside_allowlist_${index + 1}`);
    if (inventory.some((entry) => rectanglesTouchOrIntersect(entry.rectangle, rectangle))) {
      issues.push("unsafe_region_overlap");
      issues.push(`section_touches_sensitive_inventory_${index + 1}`);
    }
    return { category, rectangle };
  });

  return { passed: issues.length === 0, issues, sections, inventory };
}

function normalizedScanText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/\s+/g, " ");
}

export function findSensitiveTextSignals(value) {
  const text = normalizedScanText(value);
  const compact = text.replace(/[\s._-]/g, "");
  const findings = [];
  const checks = [
    ["email", /[\p{L}\p{N}.%+_-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/iu],
    ["iban", /\b[A-Z]{2}\s?\d{2}(?:[\s-]?[A-Z0-9]){10,30}\b/iu],
    ["phone", /(?:^|\D)(?:0(?:2|3|4|8|9)[\s.-]?\d{3}[\s.-]?\d{4}|05\d[\s.-]?\d{3}[\s.-]?\d{4})(?:\D|$)/u],
    ["national_id_label", /(?:ת\.?\s*ז\.?|מספר\s*זהות|national\s*id|identity\s*(?:no|number))/iu],
    ["employee_number_label", /(?:מספר\s*עובד|employee\s*(?:no|number|id))/iu],
    ["bank_account_label", /(?:חשבון\s*בנק|bank\s*account|account\s*(?:no|number))/iu],
    ["address_label", /(?:כתובת|רחוב|address\s*:)/iu],
    ["contact_label", /(?:טלפון|דוא["׳']?ל|e-?mail\s*:|phone\s*:)/iu],
    ["signature_label", /(?:חתימה|signature)/iu],
    ["employer_registration_label", /(?:ח\.?\s*פ\.?|תיק\s*ניכויים|מספר\s*תאגיד|company\s*number|registration\s*number|tax\s*file)/iu],
    ["identity_name_label", /(?:שם\s*(?:עובד|מעסיק|חברה)|employee\s*name|employer\s*name|company\s*name)/iu],
    ["filesystem_path", /(?:[A-Z]:[\\/]|file:\/\/|\\\\[^\\\s]+\\)/iu],
    ["api_key", /(?:OPENAI_API_KEY|sk-[A-Za-z0-9_-]{12,})/u],
  ];
  for (const [kind, pattern] of checks) if (pattern.test(text)) findings.push(kind);
  if (/CUSTOMER(?:[\s._-]*EVAL)?[\s._-]*\d{3}/iu.test(text) && !/CUSTOMER_EVAL_\d{3}/u.test(text)) {
    findings.push("noncanonical_customer_identifier");
  }
  if (/(?:תז|מספרזהות|nationalid|identitynumber)\D{0,8}\d{9}/iu.test(compact)) findings.push("national_id_value");
  return [...new Set(findings)].sort();
}

export function containsUnsafePrivateData(value, extraSentinels = []) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const findings = findSensitiveTextSignals(serialized);
  for (const sentinel of extraSentinels) {
    if (sentinel && serialized.includes(sentinel)) findings.push("synthetic_private_sentinel");
  }
  return [...new Set(findings)].sort();
}

export function validatePiiSafeReport(value, extraSentinels = []) {
  const issues = containsUnsafePrivateData(value, extraSentinels).map((finding) => `unsafe_value:${finding}`);
  function visit(current, trail = []) {
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, [...trail, String(index)]));
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, entry] of Object.entries(current)) {
      if (FORBIDDEN_PRIVATE_KEY.test(key)) issues.push(`forbidden_key:${[...trail, key].join(".")}`);
      visit(entry, [...trail, key]);
    }
  }
  visit(value);
  return { passed: issues.length === 0, issues: [...new Set(issues)].sort() };
}

export function verifySyntheticRedactionArtifact(artifact) {
  const issues = [];
  if (!NEUTRAL_CUSTOMER_ID.test(artifact.neutral_document_id ?? "")) issues.push("non_neutral_document_id");
  if (artifact.source_sha256 !== artifact.expected_source_sha256) issues.push("source_hash_mismatch");
  if (artifact.format !== "raster_png") issues.push("non_raster_output");
  if (artifact.source_filename || artifact.source_path) issues.push("source_reference_leakage");
  if ((artifact.decoded_codes ?? []).length > 0) issues.push("barcode_or_qr_detected");
  if (artifact.metadata && Object.keys(artifact.metadata).length > 0) issues.push("identifying_metadata_present");
  const hidden = artifact.hidden_content ?? {};
  if (hidden.annotations || hidden.forms || hidden.embedded_files || hidden.text_layer || hidden.recoverable_page_layer) {
    issues.push("hidden_content_present");
  }
  if (hidden.transparent_text || hidden.text_beneath_mask) issues.push("concealed_text_present");
  if (artifact.edge_identifier_fragment_detected) issues.push("partial_identifier_fragment");
  if (artifact.visual_structure_issue) issues.push(artifact.visual_structure_issue);
  for (const [index, section] of (artifact.sections ?? []).entries()) {
    if (!ALLOWED_V3_REGION_CATEGORIES.has(section.category)) issues.push(`forbidden_section_category_${index + 1}`);
    if (!rectangleContains(artifact.allowlist, section.rectangle)) issues.push(`section_outside_allowlist_${index + 1}`);
    if ((artifact.sensitive_inventory ?? []).some((entry) => rectanglesTouchOrIntersect(entry.rectangle, section.rectangle))) {
      issues.push("unsafe_region_overlap");
      issues.push(`section_touches_sensitive_inventory_${index + 1}`);
    }
  }
  for (const finding of findSensitiveTextSignals(artifact.synthetic_ocr_text ?? "")) issues.push(`pii_signal:${finding}`);
  return { passed: issues.length === 0, issues: [...new Set(issues)].sort() };
}

export function buildEmptyGroundTruthTemplate(documentId, fields) {
  if (!NEUTRAL_CUSTOMER_ID.test(documentId)) throw new TypeError("Ground truth requires a neutral document ID");
  return {
    schema_version: "customer-ground-truth-v3",
    neutral_document_id: documentId,
    status: "annotation_required",
    frozen: false,
    fields: fields.map((field) => ({
      field,
      classification: "unscored_not_annotated",
      value: null,
      critical: true,
      reviewers: [],
      dual_review_complete: false,
    })),
  };
}

export function validateGroundTruthTemplate(template, { requireFrozen = false } = {}) {
  const issues = [];
  if (!NEUTRAL_CUSTOMER_ID.test(template?.neutral_document_id ?? "")) issues.push("non_neutral_document_id");
  if (!Array.isArray(template?.fields) || template.fields.length === 0) issues.push("fields_missing");
  for (const entry of template?.fields ?? []) {
    if (FORBIDDEN_GROUND_TRUTH_FIELD.test(entry.field ?? "")) issues.push(`forbidden_private_field:${entry.field ?? "unknown"}`);
    if (!GROUND_TRUTH_STATES.has(entry.classification)) issues.push(`invalid_classification:${entry.field ?? "unknown"}`);
    if (entry.classification === "unscored_not_annotated" && entry.value !== null) {
      issues.push(`unannotated_value_present:${entry.field}`);
    }
    if (entry.classification === "expected_absent" && entry.value !== null) {
      issues.push(`expected_absent_value_present:${entry.field}`);
    }
    if (entry.classification === "exact" && (entry.value === null || entry.value === "")) {
      issues.push(`exact_value_missing:${entry.field}`);
    }
    const reviewers = Array.isArray(entry.reviewers) ? new Set(entry.reviewers.filter(Boolean)) : new Set();
    const resolvedWithoutExactValue = ["ambiguous", "unscored_not_annotated"].includes(entry.classification);
    if (entry.critical && !resolvedWithoutExactValue && (!entry.dual_review_complete || reviewers.size < 2)) {
      issues.push(`critical_field_not_dual_reviewed:${entry.field}`);
    }
  }
  const privateFindings = containsUnsafePrivateData(template);
  if (privateFindings.length > 0) issues.push(...privateFindings.map((finding) => `private_data:${finding}`));
  const reportContract = validatePiiSafeReport(template);
  if (!reportContract.passed) issues.push(...reportContract.issues.map((issue) => `schema:${issue}`));
  if (requireFrozen && template?.frozen !== true) issues.push("ground_truth_not_frozen");
  if (template?.frozen === true && issues.some((issue) => issue.startsWith("critical_field_not_dual_reviewed"))) {
    issues.push("freeze_forbidden");
  }
  return { passed: issues.length === 0, issues: [...new Set(issues)].sort() };
}

function isSubpath(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function evaluateCustomerBenchmarkGate(input) {
  const issues = [];
  const requiredTrue = [
    ["owner_deidentification_approval", input.ownerDeidentificationApproval],
    ["owner_v3_visual_approval", input.ownerV3VisualApproval],
    ["v3_automated_verification", input.v3AutomatedVerification],
    ["ground_truth_frozen", input.groundTruthFrozen],
    ["rotated_api_key", input.rotatedApiKey],
    ["explicit_external_execution", input.explicitExternalExecution],
  ];
  for (const [name, value] of requiredTrue) if (value !== true) issues.push(`${name}_required`);
  if (input.actualArtifactSha256 !== input.expectedArtifactSha256) issues.push("artifact_hash_mismatch");
  if (!NEUTRAL_CUSTOMER_ID.test(path.parse(input.artifactPath ?? "").name.replace("_DATA_ONLY", ""))) {
    issues.push("non_neutral_artifact_name");
  }
  if (!isSubpath(input.artifactPath ?? "", input.approvedV3Root ?? "")) issues.push("artifact_outside_v3_root");
  if (!isSubpath(input.outputPath ?? "", input.approvedOutputRoot ?? "")) issues.push("output_outside_approved_root");
  if (input.approvedIgnoredRoots?.every((root) => !isSubpath(input.outputPath ?? "", root))) {
    issues.push("output_not_git_ignored");
  }
  const lowerPath = String(input.artifactPath ?? "").toLowerCase().replaceAll("\\", "/");
  if (/(?:^|\/)redacted(?:-v2)?(?:\/|$)/u.test(lowerPath)) issues.push("legacy_redaction_input_forbidden");
  if (lowerPath.includes("onedrive") || lowerPath.includes("работочий стол") || lowerPath.includes("desktop")) {
    issues.push("original_customer_path_forbidden");
  }
  if (input.modelOutputImportedIntoGroundTruth === true) issues.push("model_output_ground_truth_import_forbidden");
  if (input.symlinkOrJunctionDetected === true) issues.push("symlink_or_junction_forbidden");
  return { passed: issues.length === 0, issues: [...new Set(issues)].sort() };
}

export function hammingDistance(first, second) {
  if (!first || !second || first.length !== second.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let index = 0; index < first.length; index += 1) {
    const xor = Number.parseInt(first[index], 16) ^ Number.parseInt(second[index], 16);
    distance += xor.toString(2).replaceAll("0", "").length;
  }
  return distance;
}

export function buildDuplicateGroups(items, visualThreshold = 6) {
  const exact = [];
  const visual = [];
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      if (items[left].sha256 === items[right].sha256) {
        exact.push([items[left].id, items[right].id]);
      } else if (hammingDistance(items[left].perceptual_hash, items[right].perceptual_hash) <= visualThreshold) {
        visual.push([items[left].id, items[right].id]);
      }
    }
  }
  return { exact, visual };
}
