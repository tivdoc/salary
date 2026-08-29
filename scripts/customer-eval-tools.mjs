import { spawnSync } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import {
  buildDuplicateGroups,
  buildEmptyGroundTruthTemplate,
  containsUnsafePrivateData,
  findSensitiveTextSignals,
  normalizedRectangle,
  sha256,
  stableJson,
  validateGroundTruthTemplate,
  validatePiiSafeReport,
  validateSourceAwarePlan,
} from "./customer-eval-tools-core.mjs";
import {
  CUSTOMER_EVAL_GROUND_TRUTH_FIELDS,
  CUSTOMER_EVAL_V3_DOCUMENTS,
  CUSTOMER_EVAL_V3_PIPELINE,
} from "./customer-eval-v3-config.mjs";

const repoRoot = process.cwd();
const customerRoot = path.resolve(repoRoot, "eval", "customer-payslips");
const v2InputRoot = path.join(customerRoot, "redacted-v2");
const v2InspectionRoot = path.join(customerRoot, "inspection-v2");
const v3DataRoot = path.join(customerRoot, "data-only-v3");
const v3InspectionRoot = path.join(customerRoot, "inspection-v3");
const v3ReviewRoot = path.join(customerRoot, "review-v3");
const groundTruthRoot = path.join(customerRoot, "ground-truth", "customer-v3");
const v2ManifestPath = path.join(v2InspectionRoot, "redaction-v2-manifest.json");
const v2FreezePath = path.join(v2InspectionRoot, "redaction-v2-freeze.json");
const v3CorpusManifestPath = path.join(v3InspectionRoot, "data-only-v3-corpus-manifest.json");
const v3FreezePath = path.join(v3InspectionRoot, "data-only-v3-freeze.json");
const reviewManifestPath = path.join(v3ReviewRoot, "review-manifest.json");
const PNG_OPTIONS = { compressionLevel: 9, adaptiveFiltering: false, palette: false };
const TESSERACT = "C:\\Program Files\\Tesseract-OCR\\tesseract.exe";

function safeRelative(filePath) {
  const relative = path.relative(repoRoot, filePath).replaceAll("\\", "/");
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("path_escape");
  return relative;
}

function assertIgnored(targetPath) {
  const result = spawnSync("git", ["check-ignore", "-q", safeRelative(targetPath)], {
    cwd: repoRoot,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`evaluation_path_not_git_ignored:${safeRelative(targetPath)}`);
}

async function ensurePrivateDirectories() {
  for (const directory of [v3DataRoot, v3InspectionRoot, v3ReviewRoot, groundTruthRoot]) {
    assertIgnored(directory);
    await mkdir(directory, { recursive: true });
  }
}

async function hashFile(filePath) {
  return sha256(await readFile(filePath));
}

async function writeImmutable(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (existsSync(filePath)) {
    const existing = await readFile(filePath);
    if (!existing.equals(buffer)) throw new Error(`immutable_evidence_mismatch:${safeRelative(filePath)}`);
    return false;
  }
  await writeFile(filePath, buffer, { flag: "wx" });
  return true;
}

async function writeEvidenceJson(filePath, value) {
  if (existsSync(filePath)) {
    const current = JSON.parse(await readFile(filePath, "utf8"));
    if (stableJson(current) !== stableJson(value)) throw new Error(`immutable_manifest_mismatch:${safeRelative(filePath)}`);
    return false;
  }
  return writeImmutable(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function timestamp() {
  return new Date().toISOString();
}

async function loadAndVerifyV2() {
  const [manifestText, freezeText] = await Promise.all([
    readFile(v2ManifestPath, "utf8"),
    readFile(v2FreezePath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const freeze = JSON.parse(freezeText);
  if (manifest.redaction_pipeline_version !== "customer-payslip-redaction-v2") throw new Error("v2_pipeline_mismatch");
  if (manifest.document_count !== CUSTOMER_EVAL_V3_DOCUMENTS.length) throw new Error("v2_document_count_mismatch");
  if (freeze.redaction_v2_manifest_sha256 !== sha256(manifestText)) throw new Error("v2_manifest_freeze_mismatch");
  const realV2Root = await realpath(v2InputRoot);
  if ((await lstat(v2InputRoot)).isSymbolicLink()) throw new Error("v2_root_symlink_forbidden");

  for (const expected of CUSTOMER_EVAL_V3_DOCUMENTS) {
    const record = manifest.documents.find((entry) => entry.neutral_document_id === expected.id);
    if (!record?.verification_passed) throw new Error(`v2_not_verified:${expected.id}`);
    if (record.v2_artifact_sha256 !== expected.v2Sha256) throw new Error(`V2_INPUT_HASH_MISMATCH:${expected.id}`);
    const artifactPath = path.join(v2InputRoot, `${expected.id}.png`);
    if ((await lstat(artifactPath)).isSymbolicLink()) throw new Error(`v2_artifact_symlink_forbidden:${expected.id}`);
    const realArtifactPath = await realpath(artifactPath);
    const realRelative = path.relative(realV2Root, realArtifactPath);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error(`v2_artifact_path_escape:${expected.id}`);
    if ((await hashFile(artifactPath)) !== expected.v2Sha256) throw new Error(`V2_INPUT_HASH_MISMATCH:${expected.id}`);
    const metadata = await sharp(artifactPath).metadata();
    if (metadata.width !== expected.dimensions.width || metadata.height !== expected.dimensions.height) {
      throw new Error(`v2_dimensions_mismatch:${expected.id}`);
    }
  }
  return { manifestSha256: sha256(manifestText), manifest };
}

async function makeContactSheet(files, columns = 3) {
  const thumbWidth = 360;
  const gap = 20;
  const backgrounds = [];
  for (const file of files) {
    const buffer = await sharp(file).resize({ width: thumbWidth, fit: "inside", withoutEnlargement: true }).png(PNG_OPTIONS).toBuffer();
    const metadata = await sharp(buffer).metadata();
    backgrounds.push({ input: buffer, width: metadata.width, height: metadata.height });
  }
  const rows = [];
  for (let index = 0; index < backgrounds.length; index += columns) rows.push(backgrounds.slice(index, index + columns));
  const rowHeights = rows.map((row) => Math.max(...row.map((entry) => entry.height)));
  const canvasWidth = columns * thumbWidth + (columns + 1) * gap;
  const canvasHeight = rowHeights.reduce((sum, height) => sum + height, 0) + (rows.length + 1) * gap;
  const composite = [];
  let itemIndex = 0;
  let top = gap;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    for (let column = 0; column < rows[rowIndex].length; column += 1) {
      const entry = backgrounds[itemIndex];
      composite.push({ input: entry.input, left: gap + column * (thumbWidth + gap), top });
      itemIndex += 1;
    }
    top += rowHeights[rowIndex] + gap;
  }
  return sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 3, background: "#eeeae1" } })
    .composite(composite)
    .removeAlpha()
    .png(PNG_OPTIONS)
    .toBuffer();
}

async function renderSection(sourcePath, rectangle) {
  return sharp(sourcePath)
    .extract(rectangle)
    .resize({ width: rectangle.width * 2, kernel: sharp.kernel.lanczos3 })
    .sharpen({ sigma: 0.8, m1: 0.8, m2: 1.5 })
    .removeAlpha()
    .png(PNG_OPTIONS)
    .toBuffer();
}

async function renderDataOnlyComposite(sectionBuffers) {
  const sectionMetadata = await Promise.all(sectionBuffers.map((buffer) => sharp(buffer).metadata()));
  const padding = 24;
  const compositeWidth = Math.max(...sectionMetadata.map((entry) => entry.width)) + padding * 2;
  const compositeHeight = sectionMetadata.reduce((sum, entry) => sum + entry.height, 0) + padding * (sectionBuffers.length + 1);
  let top = padding;
  const layers = sectionBuffers.map((buffer, index) => {
    const layer = { input: buffer, left: padding, top };
    top += sectionMetadata[index].height + padding;
    return layer;
  });
  return sharp({
    create: { width: compositeWidth, height: compositeHeight, channels: 3, background: "#f4f1ea" },
  })
    .composite(layers)
    .removeAlpha()
    .png(PNG_OPTIONS)
    .toBuffer();
}

function scanRasterLocally(filePath) {
  if (!existsSync(TESSERACT)) return { passed: false, method: "unavailable", findings: ["local_ocr_unavailable"] };
  const tessdata = path.join(customerRoot, "tools", "tessdata");
  const args = [filePath, "stdout", "-l", "heb+eng", "--psm", "6", "tsv"];
  if (existsSync(tessdata)) args.push("--tessdata-dir", tessdata);
  const result = spawnSync(TESSERACT, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) return { passed: false, method: "tesseract_local", findings: ["local_ocr_failed"] };
  const lines = new Map();
  for (const row of result.stdout.split(/\r?\n/u).slice(1)) {
    const columns = row.split("\t");
    if (columns.length < 12 || columns[0] !== "5" || !columns[11]) continue;
    const key = columns.slice(1, 5).join(":");
    const current = lines.get(key) ?? { top: Number(columns[7]), bottom: Number(columns[7]) + Number(columns[9]), words: [] };
    current.top = Math.min(current.top, Number(columns[7]));
    current.bottom = Math.max(current.bottom, Number(columns[7]) + Number(columns[9]));
    current.words.push(columns.slice(11).join("\t"));
    lines.set(key, current);
  }
  const locations = [];
  for (const line of lines.values()) {
    for (const finding of findSensitiveTextSignals(line.words.join(" "))) {
      locations.push(`${finding}@${line.top}-${line.bottom}`);
    }
  }
  const findings = [...new Set(locations.map((entry) => entry.split("@")[0]))].sort();
  return { passed: findings.length === 0, method: "tesseract_local", findings, locations: locations.sort() };
}

async function generateV3() {
  await ensurePrivateDirectories();
  const v2 = await loadAndVerifyV2();
  const createdAt = timestamp();
  const documentRecords = [];
  const compositePaths = [];
  const sectionPaths = [];

  for (const document of CUSTOMER_EVAL_V3_DOCUMENTS) {
    const plan = validateSourceAwarePlan(document, 3);
    if (!plan.passed) throw new Error(`${document.id}:${plan.issues.join(",")}`);
    const sourcePath = path.join(v2InputRoot, `${document.id}.png`);
    const documentOutput = path.join(v3DataRoot, document.id);
    const sectionOutput = path.join(documentOutput, "sections");
    await mkdir(sectionOutput, { recursive: true });
    const sections = [];

    for (let index = 0; index < plan.sections.length; index += 1) {
      const section = plan.sections[index];
      const number = String(index + 1).padStart(2, "0");
      const outputPath = path.join(sectionOutput, `${document.id}_SECTION_${number}.png`);
      const buffer = await renderSection(sourcePath, section.rectangle);
      await writeImmutable(outputPath, buffer);
      const metadata = await sharp(buffer).metadata();
      const sectionScan = scanRasterLocally(outputPath);
      if (!sectionScan.passed) {
        throw new Error(`${document.id}:SECTION_${number}:sensitive_scan_failed:${sectionScan.locations.join(",")}`);
      }
      sections.push({
        section_id: `${document.id}_SECTION_${number}`,
        category: section.category,
        source_rectangle: section.rectangle,
        normalized_source_rectangle: normalizedRectangle(section.rectangle, document.dimensions),
        safety_inset_pixels: 3,
        artifact_path: safeRelative(outputPath),
        artifact_sha256: sha256(buffer),
        width: metadata.width,
        height: metadata.height,
      });
      sectionPaths.push(outputPath);
    }

    const sectionBuffers = await Promise.all(sections.map((entry) => readFile(path.resolve(repoRoot, entry.artifact_path))));
    const compositeBuffer = await renderDataOnlyComposite(sectionBuffers);
    const compositePath = path.join(documentOutput, `${document.id}_DATA_ONLY.png`);
    await writeImmutable(compositePath, compositeBuffer);
    compositePaths.push(compositePath);
    const compositeMetadata = await sharp(compositeBuffer).metadata();
    const localScan = scanRasterLocally(compositePath);
    if (!localScan.passed) throw new Error(`${document.id}:sensitive_scan_failed:${localScan.locations.join(",")}`);

    const sensitiveInventory = {
      schema_version: "customer-sensitive-inventory-v3",
      pipeline_version: CUSTOMER_EVAL_V3_PIPELINE,
      neutral_document_id: document.id,
      source_artifact_sha256: document.v2Sha256,
      source_inventory_version: `source-aware-inventory-v3-${document.id}`,
      entries: plan.inventory,
      pii_text_values_stored: false,
      created_timestamp: createdAt,
    };
    const inventoryPath = path.join(v3InspectionRoot, `${document.id}-sensitive-inventory.json`);
    await writeEvidenceJson(inventoryPath, sensitiveInventory);

    const record = {
      artifact_classification: "verified_deidentified_data_only_evaluation_artifact",
      neutral_document_id: document.id,
      pipeline_version: CUSTOMER_EVAL_V3_PIPELINE,
      region_plan_version: `customer-payslip-data-only-region-plan-v3-${document.id}`,
      sensitive_inventory_version: sensitiveInventory.source_inventory_version,
      source_pipeline_version: "customer-payslip-redaction-v2",
      source_artifact_sha256: document.v2Sha256,
      source_dimensions: document.dimensions,
      source_allowlist: document.allowlist,
      source_allowlist_normalized: normalizedRectangle(document.allowlist, document.dimensions),
      sensitive_inventory_path: safeRelative(inventoryPath),
      sections,
      retained_section_categories: sections.map((section) => section.category),
      safety_margin: { mode: "inward_inset", pixels: 3, configurable: true },
      composite: {
        artifact_path: safeRelative(compositePath),
        artifact_sha256: sha256(compositeBuffer),
        width: compositeMetadata.width,
        height: compositeMetadata.height,
        neutral_canvas_only: true,
        labels_added: false,
        full_page_background_included: false,
      },
      verification_checks: {
        v2_source_hash_match: true,
        source_aware_inventory_clear: true,
        every_output_pixel_has_allowlisted_or_neutral_lineage: true,
        sections_within_allowlist: true,
        inward_safety_margin_applied: true,
        raster_only_no_hidden_content: true,
        metadata_removed: !compositeMetadata.exif && !compositeMetadata.icc && !compositeMetadata.xmp && !compositeMetadata.iptc,
        local_pattern_and_label_scan_clear: true,
        barcode_scan_clear_by_verified_v2_subset_lineage: true,
        no_generated_document_content: true,
        source_v2_unchanged: true,
      },
      issue_codes: [],
      automated_verification_limits: [
        "owner_must_confirm_row_and_column_legibility",
        "owner_must_confirm_no_partial_identifier_fragments",
        "owner_must_confirm_no_mask_intersects_scored_values",
      ],
      local_scan_method: localScan.method,
      verification_passed: true,
      known_data_limitation_codes: ["salary_period_unavailable"],
      created_timestamp: createdAt,
    };
    const documentManifestPath = path.join(v3InspectionRoot, `${document.id}-data-only-v3-manifest.json`);
    await writeEvidenceJson(documentManifestPath, record);
    documentRecords.push({ ...record, document_manifest_path: safeRelative(documentManifestPath) });
  }

  const compositeContactSheetPath = path.join(v3ReviewRoot, "data-only-v3-composites-contact-sheet.png");
  const sectionsContactSheetPath = path.join(v3ReviewRoot, "data-only-v3-sections-contact-sheet.png");
  await writeImmutable(compositeContactSheetPath, await makeContactSheet(compositePaths, 2));
  await writeImmutable(sectionsContactSheetPath, await makeContactSheet(sectionPaths, 3));

  const corpusManifest = {
    schema_version: "customer-data-only-corpus-v3",
    pipeline_version: CUSTOMER_EVAL_V3_PIPELINE,
    status: "pending_owner_visual_review",
    source_v2_manifest_sha256: v2.manifestSha256,
    document_count: documentRecords.length,
    created_count: documentRecords.length,
    excluded_count: 0,
    section_count: documentRecords.reduce((sum, entry) => sum + entry.sections.length, 0),
    documents: documentRecords,
    automated_verification_passed: true,
    external_execution_performed: false,
    created_timestamp: createdAt,
  };
  await writeEvidenceJson(v3CorpusManifestPath, corpusManifest);
  const freeze = {
    schema_version: "customer-data-only-freeze-v3",
    pipeline_version: CUSTOMER_EVAL_V3_PIPELINE,
    corpus_manifest_sha256: sha256(stableJson(corpusManifest)),
    source_v2_manifest_sha256: v2.manifestSha256,
    document_artifact_hashes: documentRecords.map((entry) => ({
      neutral_document_id: entry.neutral_document_id,
      composite_sha256: entry.composite.artifact_sha256,
      section_sha256: entry.sections.map((section) => section.artifact_sha256),
    })),
  };
  await writeEvidenceJson(v3FreezePath, freeze);

  const reviewManifest = {
    schema_version: "customer-data-only-review-v3",
    pipeline_version: CUSTOMER_EVAL_V3_PIPELINE,
    status: "pending_owner_visual_review",
    automated_result: "passed",
    approval_recorded: false,
    composite_contact_sheet: {
      path: safeRelative(compositeContactSheetPath),
      sha256: await hashFile(compositeContactSheetPath),
    },
    sections_contact_sheet: {
      path: safeRelative(sectionsContactSheetPath),
      sha256: await hashFile(sectionsContactSheetPath),
    },
    documents: documentRecords.map((entry, index) => ({
      neutral_document_id: entry.neutral_document_id,
      composite_sha256: entry.composite.artifact_sha256,
      composite_sheet_position: index + 1,
      section_count: entry.sections.length,
      status: "pending_owner_visual_review",
    })),
    created_timestamp: createdAt,
  };
  await writeEvidenceJson(reviewManifestPath, reviewManifest);
  await writeImmutable(
    path.join(v3ReviewRoot, "OWNER_REVIEW_CHECKLIST.md"),
    [
      "# Customer payslip data-only V3 owner review",
      "",
      "Status: `pending_owner_visual_review`",
      "",
      "For every neutral document and every section, verify:",
      "",
      "- no name, address, phone, email, national ID, employee number, bank details, signature, QR, or barcode is visible;",
      "- no employer registration or unnecessary identity-bearing header/footer content is visible;",
      "- each crop contains only the intended payroll table region;",
      "- composite whitespace contains no document pixels or added labels;",
      "- legibility is sufficient without reconstructing the original page;",
      "- the displayed hashes match `review-manifest.json`.",
      "",
      "Do not mark approval in generated evidence. Approval must be a separate, explicit owner action.",
      "",
    ].join("\n"),
  );
  return { documents: documentRecords.length, sections: corpusManifest.section_count, freeze: freeze.corpus_manifest_sha256 };
}

async function verifyV3() {
  await ensurePrivateDirectories();
  await loadAndVerifyV2();
  const [corpus, freeze, review] = await Promise.all([
    readFile(v3CorpusManifestPath, "utf8").then(JSON.parse),
    readFile(v3FreezePath, "utf8").then(JSON.parse),
    readFile(reviewManifestPath, "utf8").then(JSON.parse),
  ]);
  const issues = [];
  if (corpus.pipeline_version !== CUSTOMER_EVAL_V3_PIPELINE) issues.push("pipeline_version_mismatch");
  if (corpus.document_count !== CUSTOMER_EVAL_V3_DOCUMENTS.length) issues.push("document_count_mismatch");
  if (freeze.corpus_manifest_sha256 !== sha256(stableJson(corpus))) issues.push("corpus_freeze_mismatch");
  if (review.status !== "pending_owner_visual_review" || review.approval_recorded !== false) issues.push("unsafe_review_status");
  for (const record of corpus.documents ?? []) {
    const expected = CUSTOMER_EVAL_V3_DOCUMENTS.find((entry) => entry.id === record.neutral_document_id);
    if (!expected) {
      issues.push("unexpected_document_id");
      continue;
    }
    if (record.source_artifact_sha256 !== expected.v2Sha256) issues.push(`${expected.id}:source_hash_mismatch`);
    const plan = validateSourceAwarePlan(expected, 3);
    if (!plan.passed) issues.push(...plan.issues.map((issue) => `${expected.id}:${issue}`));
    if (record.sections?.length !== plan.sections.length) issues.push(`${expected.id}:section_count_mismatch`);
    const sourcePath = path.join(v2InputRoot, `${expected.id}.png`);
    const expectedSectionBuffers = [];
    for (let index = 0; index < plan.sections.length; index += 1) {
      const planned = plan.sections[index];
      const recorded = record.sections?.[index];
      const expectedBuffer = await renderSection(sourcePath, planned.rectangle);
      expectedSectionBuffers.push(expectedBuffer);
      if (recorded?.category !== planned.category) issues.push(`${expected.id}:section_category_mismatch_${index + 1}`);
      if (JSON.stringify(recorded?.source_rectangle) !== JSON.stringify(planned.rectangle)) {
        issues.push(`${expected.id}:section_rectangle_mismatch_${index + 1}`);
      }
      if (recorded?.artifact_sha256 !== sha256(expectedBuffer)) issues.push(`${expected.id}:section_lineage_mismatch_${index + 1}`);
    }
    const expectedComposite = await renderDataOnlyComposite(expectedSectionBuffers);
    if (record.composite?.artifact_sha256 !== sha256(expectedComposite)) issues.push(`${expected.id}:composite_lineage_mismatch`);
    const artifacts = [record.composite, ...record.sections];
    for (const artifact of artifacts) {
      const artifactPath = path.resolve(repoRoot, artifact.artifact_path);
      try {
        if (safeRelative(artifactPath) !== artifact.artifact_path) issues.push(`${expected.id}:noncanonical_artifact_path`);
        if (!artifactPath.startsWith(`${v3DataRoot}${path.sep}`)) issues.push(`${expected.id}:artifact_path_escape`);
        if ((await hashFile(artifactPath)) !== artifact.artifact_sha256) issues.push(`${expected.id}:artifact_hash_mismatch`);
        const metadata = await sharp(artifactPath).metadata();
        if (metadata.pages && metadata.pages !== 1) issues.push(`${expected.id}:multipage_artifact`);
        if (metadata.exif || metadata.icc || metadata.xmp || metadata.iptc) issues.push(`${expected.id}:metadata_present`);
        if (artifact !== record.composite && ((metadata.width ?? 0) < 600 || (metadata.height ?? 0) < 40)) {
          issues.push(`${expected.id}:section_below_legibility_dimensions`);
        }
        const localScan = scanRasterLocally(artifactPath);
        if (!localScan.passed) issues.push(`${expected.id}:local_sensitive_scan_failed`);
      } catch {
        issues.push(`${expected.id}:artifact_unreadable`);
      }
    }
  }
  for (const sheet of [review.composite_contact_sheet, review.sections_contact_sheet]) {
    if ((await hashFile(path.resolve(repoRoot, sheet.path))) !== sheet.sha256) issues.push("review_sheet_hash_mismatch");
  }
  const privateFindings = containsUnsafePrivateData({ corpus, freeze, review });
  if (privateFindings.length > 0) issues.push(...privateFindings.map((entry) => `manifest_private_data:${entry}`));
  const reportContract = validatePiiSafeReport({ corpus, freeze, review });
  if (!reportContract.passed) issues.push(...reportContract.issues.map((entry) => `report_contract:${entry}`));
  if (issues.length > 0) throw new Error(`v3_verification_failed:${[...new Set(issues)].join(",")}`);
  return { documents: corpus.document_count, sections: corpus.section_count, freeze: freeze.corpus_manifest_sha256 };
}

async function initializeGroundTruth() {
  await ensurePrivateDirectories();
  const corpus = JSON.parse(await readFile(v3CorpusManifestPath, "utf8"));
  const created = [];
  for (const document of CUSTOMER_EVAL_V3_DOCUMENTS) {
    const target = path.join(groundTruthRoot, `${document.id}.ground-truth.json`);
    const template = buildEmptyGroundTruthTemplate(document.id, CUSTOMER_EVAL_GROUND_TRUTH_FIELDS);
    template.v3_artifact_sha256 = corpus.documents.find((entry) => entry.neutral_document_id === document.id)?.composite.artifact_sha256;
    if (await writeEvidenceJson(target, template)) created.push(document.id);
  }
  const index = {
    schema_version: "customer-ground-truth-index-v3",
    status: "annotation_required",
    frozen: false,
    model_output_import_allowed: false,
    documents: CUSTOMER_EVAL_V3_DOCUMENTS.map((entry) => ({
      neutral_document_id: entry.id,
      path: safeRelative(path.join(groundTruthRoot, `${entry.id}.ground-truth.json`)),
    })),
  };
  await writeEvidenceJson(path.join(groundTruthRoot, "index.json"), index);
  return { created: created.length, total: CUSTOMER_EVAL_V3_DOCUMENTS.length };
}

async function validateGroundTruth() {
  const indexPath = path.join(groundTruthRoot, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  const corpus = JSON.parse(await readFile(v3CorpusManifestPath, "utf8"));
  const issues = [];
  if (index.frozen !== false || index.model_output_import_allowed !== false) issues.push("unsafe_ground_truth_index_state");
  for (const entry of index.documents ?? []) {
    const target = path.resolve(repoRoot, entry.path);
    if (!target.startsWith(`${groundTruthRoot}${path.sep}`)) issues.push("ground_truth_path_escape");
    const template = JSON.parse(await readFile(target, "utf8"));
    const result = validateGroundTruthTemplate(template, { requireFrozen: index.frozen === true });
    if (!result.passed) issues.push(...result.issues.map((issue) => `${entry.neutral_document_id}:${issue}`));
    const expectedHash = corpus.documents.find((document) => document.neutral_document_id === entry.neutral_document_id)?.composite.artifact_sha256;
    if (template.v3_artifact_sha256 !== expectedHash) issues.push(`${entry.neutral_document_id}:v3_artifact_hash_mismatch`);
  }
  if (containsUnsafePrivateData(index).length > 0) issues.push("private_data_in_ground_truth_index");
  if (issues.length > 0) throw new Error(`ground_truth_validation_failed:${issues.join(",")}`);
  return { documents: index.documents.length, frozen: false, status: "annotation_required" };
}

async function createCleanupPlan() {
  await ensurePrivateDirectories();
  const candidates = [
    ["failed_redaction_v1", path.join(customerRoot, "redacted")],
    ["failed_redaction_v2_attempts", path.join(v2InspectionRoot, "failed-attempt-1")],
  ];
  const targets = [];
  for (const [classification, target] of candidates) {
    const artifacts = [];
    if (existsSync(target)) {
      const files = await walkFiles(target);
      for (const file of files) {
        const neutralId = path.parse(file).name.match(/^CUSTOMER_EVAL_\d{3}/u)?.[0];
        if (!neutralId) continue;
        const details = await stat(file);
        artifacts.push({
          neutral_document_id: neutralId,
          artifact_category: classification,
          sha256: await hashFile(file),
          created_date: details.birthtime.toISOString(),
          planned_deletion_date: null,
        });
      }
    }
    targets.push({
      artifact_category: classification,
      ignored_directory: safeRelative(target),
      exists: existsSync(target),
      artifacts,
    });
  }
  const plan = {
    schema_version: "customer-evaluation-cleanup-plan-v1",
    mode: "dry_run_only",
    deletion_performed: false,
    source_originals_in_scope: false,
    v2_verified_inputs_in_scope: false,
    v3_evidence_in_scope: false,
    targets,
  };
  const output = path.join(v3InspectionRoot, "cleanup-plan.json");
  await writeEvidenceJson(output, plan);
  return {
    categories: targets.filter((entry) => entry.exists).length,
    artifacts: targets.reduce((sum, entry) => sum + entry.artifacts.length, 0),
    deletionPerformed: false,
    path: safeRelative(output),
  };
}

async function perceptualHash(filePath) {
  try {
    const { data } = await sharp(filePath).resize(9, 8, { fit: "fill" }).greyscale().raw().toBuffer({ resolveWithObject: true });
    let bits = "";
    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 8; column += 1) {
        bits += data[row * 9 + column] > data[row * 9 + column + 1] ? "1" : "0";
      }
    }
    return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
  } catch {
    return null;
  }
}

async function walkFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await walkFiles(target)));
    else if (entry.isFile()) output.push(target);
  }
  return output;
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith("--")) options[args[index].slice(2)] = args[index + 1] ?? true;
  }
  return options;
}

async function prepareGenericCorpus(args) {
  const options = parseOptions(args);
  if (typeof options.input !== "string" || typeof options.output !== "string") {
    throw new Error("corpus_prepare_requires_--input_and_--output");
  }
  const inputRoot = path.resolve(options.input);
  const outputRoot = path.resolve(options.output);
  const lowerInput = inputRoot.toLowerCase().replaceAll("\\", "/");
  if (lowerInput.includes("/onedrive/работочий стол/tivdoc") || lowerInput.includes("/eval/customer-payslips")) {
    throw new Error("customer_documents_forbidden_in_generic_corpus");
  }
  assertIgnored(outputRoot);
  await mkdir(path.join(outputRoot, "artifacts"), { recursive: true });
  const supported = new Set([".png", ".jpg", ".jpeg", ".webp", ".pdf"]);
  const sourceFiles = (await walkFiles(inputRoot)).filter((file) => supported.has(path.extname(file).toLowerCase())).sort();
  const documents = [];
  for (let index = 0; index < sourceFiles.length; index += 1) {
    const source = sourceFiles[index];
    const id = `CORPUS_EVAL_${String(index + 1).padStart(4, "0")}`;
    const extension = path.extname(source).toLowerCase() === ".jpeg" ? ".jpg" : path.extname(source).toLowerCase();
    const artifact = path.join(outputRoot, "artifacts", `${id}${extension}`);
    const bytes = await readFile(source);
    if (!existsSync(artifact)) await copyFile(source, artifact);
    else if (!(await readFile(artifact)).equals(bytes)) throw new Error(`immutable_corpus_artifact_mismatch:${id}`);
    let pages = 1;
    let pdfKind = null;
    let dimensions = null;
    if (extension === ".pdf") {
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      pages = pdf.getPageCount();
      const byteText = bytes.toString("latin1");
      pdfKind = /\/Font\b/u.test(byteText) && /(?:\bBT\b|\bTj\b|\bTJ\b)/u.test(byteText)
        ? "text_native_candidate"
        : "raster_pdf_candidate";
      const size = pdf.getPage(0)?.getSize();
      if (size) dimensions = { width: Math.round(size.width), height: Math.round(size.height) };
    } else {
      const metadata = await sharp(source).metadata();
      dimensions = { width: metadata.width, height: metadata.height };
    }
    documents.push({
      id,
      artifact_path: path.relative(outputRoot, artifact).replaceAll("\\", "/"),
      sha256: sha256(bytes),
      perceptual_hash: await perceptualHash(source),
      format: extension.slice(1),
      page_count: pages,
      dimensions,
      pdf_content_class: pdfKind,
      quality: {
        band: !dimensions || dimensions.width < 700 || dimensions.height < 700
          ? "low"
          : dimensions.width < 1400 || dimensions.height < 1400
            ? "medium"
            : "high",
        low_resolution: Boolean(dimensions && (dimensions.width < 700 || dimensions.height < 700)),
        bytes: bytes.length,
      },
    });
  }
  const formats = Object.fromEntries([...new Set(documents.map((entry) => entry.format))].sort().map((format) => [
    format,
    documents.filter((entry) => entry.format === format).length,
  ]));
  const manifest = {
    schema_version: "generic-local-payslip-corpus-v1",
    document_count: documents.length,
    documents,
    duplicates: buildDuplicateGroups(documents),
    diversity: {
      formats,
      multipage_documents: documents.filter((entry) => entry.page_count > 1).length,
      text_native_pdf_candidates: documents.filter((entry) => entry.pdf_content_class === "text_native_candidate").length,
      raster_pdf_candidates: documents.filter((entry) => entry.pdf_content_class === "raster_pdf_candidate").length,
      low_resolution_documents: documents.filter((entry) => entry.quality.low_resolution).length,
    },
    private_source_paths_stored: false,
  };
  await writeEvidenceJson(path.join(outputRoot, "corpus-manifest.json"), manifest);
  const templates = path.join(outputRoot, "ground-truth-templates");
  await mkdir(templates, { recursive: true });
  for (const document of documents) {
    const template = {
      schema_version: "generic-corpus-ground-truth-v1",
      neutral_document_id: document.id,
      status: "annotation_required",
      frozen: false,
      fields: CUSTOMER_EVAL_GROUND_TRUTH_FIELDS.map((field) => ({
        field,
        classification: "unscored_not_annotated",
        value: null,
        reviewers: [],
      })),
    };
    await writeEvidenceJson(path.join(templates, `${document.id}.json`), template);
  }
  return { documents: documents.length, exactDuplicates: manifest.duplicates.exact.length, visualDuplicates: manifest.duplicates.visual.length };
}

async function status() {
  const result = await verifyV3();
  const review = JSON.parse(await readFile(reviewManifestPath, "utf8"));
  const groundTruthIndex = existsSync(path.join(groundTruthRoot, "index.json"))
    ? JSON.parse(await readFile(path.join(groundTruthRoot, "index.json"), "utf8"))
    : null;
  return {
    pipeline: CUSTOMER_EVAL_V3_PIPELINE,
    automated_verification: "passed",
    document_count: result.documents,
    section_count: result.sections,
    visual_review: review.status,
    ground_truth: groundTruthIndex?.status ?? "not_initialized",
    external_execution_performed: false,
    documents: CUSTOMER_EVAL_V3_DOCUMENTS.map((entry) => ({
      neutral_document_id: entry.id,
      automated_verification: "passed",
      visual_review: "pending_owner_visual_review",
    })),
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  let result;
  if (command === "redaction-v3") result = await generateV3();
  else if (command === "verify-v3") result = await verifyV3();
  else if (command === "status") result = await status();
  else if (command === "review-package") {
    await generateV3();
    const verified = await verifyV3();
    result = { ...verified, status: "pending_owner_visual_review", reviewPath: safeRelative(v3ReviewRoot) };
  } else if (command === "ground-truth-init") result = await initializeGroundTruth();
  else if (command === "ground-truth-validate") result = await validateGroundTruth();
  else if (command === "cleanup-plan") result = await createCleanupPlan();
  else if (command === "corpus-prepare") result = await prepareGenericCorpus(args);
  else throw new Error(`unknown_command:${command ?? "missing"}`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`CUSTOMER_EVAL_TOOL_FAILED ${error instanceof Error ? error.message : "unknown_error"}\n`);
  process.exitCode = 1;
});
