import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  buildDuplicateGroups,
  buildEmptyGroundTruthTemplate,
  containsUnsafePrivateData,
  evaluateCustomerBenchmarkGate,
  findSensitiveTextSignals,
  hammingDistance,
  rectangleContains,
  rectanglesIntersect,
  rectanglesTouchOrIntersect,
  sha256,
  stableJson,
  validateGroundTruthTemplate,
  validatePiiSafeReport,
  validateSourceAwarePlan,
  verifySyntheticRedactionArtifact,
} from "./customer-eval-tools-core.mjs";
import { CUSTOMER_EVAL_V3_DOCUMENTS } from "./customer-eval-v3-config.mjs";

const ATTACK_CASES = [
  ["plain email", "contact me at person@example.test", "email"],
  ["unicode-spaced email", "person\u200b@example.test", "email"],
  ["mobile phone with hyphen", "050-123-4567", "phone"],
  ["mobile phone with unicode dash", "050–123–4567", "phone"],
  ["landline with spaces", "03 123 4567", "phone"],
  ["Hebrew national ID label", "ת.ז. 123456789", "national_id_label"],
  ["Hebrew identity phrase", "מספר זהות 123456789", "national_id_label"],
  ["English national ID", "National ID 123456789", "national_id_label"],
  ["English identity number", "Identity number 123456789", "national_id_label"],
  ["Hebrew employee number", "מספר עובד 12345", "employee_number_label"],
  ["English employee number", "Employee number 12345", "employee_number_label"],
  ["English employee ID", "Employee ID 12345", "employee_number_label"],
  ["Hebrew bank account", "חשבון בנק 123456", "bank_account_label"],
  ["English bank account", "Bank account 123456", "bank_account_label"],
  ["English account number", "Account number 123456", "bank_account_label"],
  ["Hebrew address", "כתובת הרצל 1", "address_label"],
  ["Hebrew street", "רחוב הדוגמה 2", "address_label"],
  ["English address", "Address: Example 3", "address_label"],
  ["Hebrew telephone label", "טלפון 123", "contact_label"],
  ["Hebrew email label", "דוא\"ל example", "contact_label"],
  ["English email label", "Email: hidden", "contact_label"],
  ["English phone label", "Phone: hidden", "contact_label"],
  ["Windows source path", "C:\\private\\source.png", "filesystem_path"],
  ["UNC source path", "\\\\server\\private\\source.png", "filesystem_path"],
  ["file URI", "file:///private/source.png", "filesystem_path"],
  ["spaced neutral-looking identifier", "CUSTOMER EVAL 001", "noncanonical_customer_identifier"],
  ["dotted neutral-looking identifier", "CUSTOMER.EVAL.001", "noncanonical_customer_identifier"],
  ["hyphenated neutral-looking identifier", "CUSTOMER-EVAL-001", "noncanonical_customer_identifier"],
];

describe("synthetic redaction V3 attack corpus", () => {
  it.each(ATTACK_CASES)("rejects %s", (_name, payload, expectedFinding) => {
    expect(findSensitiveTextSignals(payload)).toContain(expectedFinding);
  });

  it("accepts a canonical neutral ID and payroll-only labels", () => {
    expect(findSensitiveTextSignals("CUSTOMER_EVAL_001 gross net pension deductions")).toEqual([]);
  });

  it("detects an invisible synthetic sentinel in a report", () => {
    expect(containsUnsafePrivateData({ status: "ok", note: "hidden-token" }, ["hidden-token"])).toContain(
      "synthetic_private_sentinel",
    );
  });

  it("rejects a zero safety inset", () => {
    expect(validateSourceAwarePlan(CUSTOMER_EVAL_V3_DOCUMENTS[0], 0).issues).toContain("unsafe_inset");
  });

  it("rejects a section that escapes the allowlist", () => {
    const document = structuredClone(CUSTOMER_EVAL_V3_DOCUMENTS[0]);
    document.sections[0][1] = document.allowlist.top - 10;
    expect(validateSourceAwarePlan(document, 3).passed).toBe(false);
  });

  it("rejects a collapsed section", () => {
    const document = structuredClone(CUSTOMER_EVAL_V3_DOCUMENTS[0]);
    document.sections[0][2] = document.sections[0][1] + 4;
    expect(validateSourceAwarePlan(document, 3).issues).toContain("empty_section_1");
  });

  it("rejects a non-neutral document ID", () => {
    const document = { ...CUSTOMER_EVAL_V3_DOCUMENTS[0], id: "real-person-name" };
    expect(validateSourceAwarePlan(document, 3).issues).toContain("non_neutral_document_id");
  });

  it("keeps touching rectangles non-intersecting", () => {
    expect(rectanglesIntersect({ left: 0, top: 0, width: 5, height: 5 }, { left: 5, top: 0, width: 2, height: 2 })).toBe(false);
  });

  it("detects a single-pixel overlap", () => {
    expect(rectanglesIntersect({ left: 0, top: 0, width: 5, height: 5 }, { left: 4, top: 4, width: 2, height: 2 })).toBe(true);
  });

  it("treats a sensitive crop boundary touch as unsafe", () => {
    expect(rectanglesTouchOrIntersect({ left: 0, top: 0, width: 5, height: 5 }, { left: 5, top: 0, width: 2, height: 2 })).toBe(true);
  });

  it("requires full rectangle containment", () => {
    expect(rectangleContains({ left: 0, top: 0, width: 5, height: 5 }, { left: 4, top: 4, width: 2, height: 2 })).toBe(false);
  });
});

describe("source-aware hidden-channel security regressions", () => {
  function safeArtifact() {
    return {
      neutral_document_id: "CUSTOMER_EVAL_001",
      source_sha256: "a".repeat(64),
      expected_source_sha256: "a".repeat(64),
      format: "raster_png",
      source_filename: null,
      source_path: null,
      decoded_codes: [],
      metadata: {},
      hidden_content: {},
      edge_identifier_fragment_detected: false,
      visual_structure_issue: null,
      allowlist: { left: 100, top: 100, width: 300, height: 400 },
      sensitive_inventory: [{ category: "identity_header", rectangle: { left: 0, top: 0, width: 500, height: 90 } }],
      sections: [{ category: "earnings_table", rectangle: { left: 110, top: 110, width: 280, height: 100 } }],
      synthetic_ocr_text: "",
    };
  }

  const ocrAttacks = [
    ["visible Hebrew name in a right sidebar", "שם עובד דוגמה", "pii_signal:identity_name_label"],
    ["visible English name in a footer", "Employee name: Synthetic", "pii_signal:identity_name_label"],
    ["Israeli-ID-like sequence", "ת.ז. 123456789", "pii_signal:national_id_label"],
    ["employee number beside totals", "מספר עובד 12345", "pii_signal:employee_number_label"],
    ["bank/account block", "חשבון בנק 123456", "pii_signal:bank_account_label"],
    ["phone", "050-123-4567", "pii_signal:phone"],
    ["email", "synthetic@example.test", "pii_signal:email"],
    ["address", "כתובת רחוב הדוגמה 1", "pii_signal:address_label"],
    ["signature", "חתימה", "pii_signal:signature_label"],
    ["employer registration number", "ח.פ. 123456789", "pii_signal:employer_registration_label"],
    ["mixed Hebrew Unicode spacing", "מספר\u200b זהות 123456789", "pii_signal:national_id_label"],
  ];

  it.each(ocrAttacks)("rejects %s", (_name, text, issue) => {
    expect(verifySyntheticRedactionArtifact({ ...safeArtifact(), synthetic_ocr_text: text }).issues).toContain(issue);
  });

  it.each([
    ["QR code", "QR_CODE"],
    ["Code 128 barcode", "CODE_128"],
  ])("rejects a decoded %s", (_name, code) => {
    expect(verifySyntheticRedactionArtifact({ ...safeArtifact(), decoded_codes: [code] }).issues).toContain(
      "barcode_or_qr_detected",
    );
  });

  it.each([
    ["rotated vertical identifier with empty OCR", { left: 105, top: 105, width: 8, height: 200 }],
    ["tiny low-contrast identifier with empty OCR", { left: 120, top: 120, width: 4, height: 3 }],
  ])("rejects %s from the source-aware inventory", (_name, rectangle) => {
    const artifact = safeArtifact();
    artifact.sensitive_inventory = [{ category: "synthetic_identifier", rectangle }];
    expect(verifySyntheticRedactionArtifact(artifact).issues).toContain("section_touches_sensitive_inventory_1");
  });

  it("rejects transparent text", () => {
    expect(verifySyntheticRedactionArtifact({ ...safeArtifact(), hidden_content: { transparent_text: true } }).issues)
      .toContain("concealed_text_present");
  });

  it("rejects text hidden beneath a visual mask", () => {
    expect(verifySyntheticRedactionArtifact({ ...safeArtifact(), hidden_content: { text_beneath_mask: true } }).issues)
      .toContain("concealed_text_present");
  });

  it("rejects PDF annotation identity even with empty OCR", () => {
    expect(verifySyntheticRedactionArtifact({ ...safeArtifact(), format: "pdf", hidden_content: { annotations: true } }).issues)
      .toEqual(expect.arrayContaining(["non_raster_output", "hidden_content_present"]));
  });

  it("rejects PDF metadata identity", () => {
    expect(verifySyntheticRedactionArtifact({ ...safeArtifact(), metadata: { author: "Synthetic Person" } }).issues)
      .toContain("identifying_metadata_present");
  });

  it("rejects EXIF identity", () => {
    expect(verifySyntheticRedactionArtifact({ ...safeArtifact(), metadata: { exif_artist: "Synthetic Person" } }).issues)
      .toContain("identifying_metadata_present");
  });

  it("rejects original filename leakage", () => {
    expect(verifySyntheticRedactionArtifact({ ...safeArtifact(), source_filename: "synthetic-person.png" }).issues)
      .toContain("source_reference_leakage");
  });

  it("rejects source-path leakage", () => {
    expect(verifySyntheticRedactionArtifact({ ...safeArtifact(), source_path: "C:\\private\\synthetic.png" }).issues)
      .toContain("source_reference_leakage");
  });

  it("rejects a partial mask leaving digit fragments", () => {
    expect(verifySyntheticRedactionArtifact({ ...safeArtifact(), edge_identifier_fragment_detected: true }).issues)
      .toContain("partial_identifier_fragment");
  });

  it("rejects a sensitive region touching the crop boundary", () => {
    const artifact = safeArtifact();
    artifact.sensitive_inventory = [{ category: "identity", rectangle: { left: 0, top: 110, width: 110, height: 10 } }];
    expect(verifySyntheticRedactionArtifact(artifact).issues).toContain("section_touches_sensitive_inventory_1");
  });

  it("rejects an allowlist rectangle expanded by one pixel", () => {
    const artifact = safeArtifact();
    artifact.sections[0].rectangle = { left: 99, top: 110, width: 291, height: 100 };
    expect(verifySyntheticRedactionArtifact(artifact).issues).toContain("section_outside_allowlist_1");
  });

  it("rejects a forbidden employer-identity category with empty OCR", () => {
    const artifact = safeArtifact();
    artifact.sections[0].category = "employer_identity";
    expect(verifySyntheticRedactionArtifact(artifact).issues).toContain("forbidden_section_category_1");
  });

  it("rejects a recoverable original page layer", () => {
    expect(verifySyntheticRedactionArtifact({ ...safeArtifact(), hidden_content: { recoverable_page_layer: true } }).issues)
      .toContain("hidden_content_present");
  });

  it("accepts a safe payroll-only raster", () => {
    expect(verifySyntheticRedactionArtifact(safeArtifact())).toEqual({ passed: true, issues: [] });
  });
});

describe("customer benchmark deny-by-default gate", () => {
  const root = path.resolve("eval", "customer-payslips", "data-only-v3");
  const output = path.resolve("output", "payslip-openai", "customer-v2.1");
  const approved = {
    ownerDeidentificationApproval: true,
    ownerV3VisualApproval: true,
    v3AutomatedVerification: true,
    groundTruthFrozen: true,
    rotatedApiKey: true,
    explicitExternalExecution: true,
    actualArtifactSha256: "a".repeat(64),
    expectedArtifactSha256: "a".repeat(64),
    artifactPath: path.join(root, "CUSTOMER_EVAL_001", "CUSTOMER_EVAL_001_DATA_ONLY.png"),
    approvedV3Root: root,
    outputPath: output,
    approvedOutputRoot: output,
    approvedIgnoredRoots: [path.resolve("output", "payslip-openai")],
    modelOutputImportedIntoGroundTruth: false,
    symlinkOrJunctionDetected: false,
  };

  it("passes only when every gate is explicit", () => {
    expect(evaluateCustomerBenchmarkGate(approved)).toEqual({ passed: true, issues: [] });
  });

  it.each([
    ["ownerDeidentificationApproval", "owner_deidentification_approval_required"],
    ["ownerV3VisualApproval", "owner_v3_visual_approval_required"],
    ["v3AutomatedVerification", "v3_automated_verification_required"],
    ["groundTruthFrozen", "ground_truth_frozen_required"],
    ["rotatedApiKey", "rotated_api_key_required"],
    ["explicitExternalExecution", "explicit_external_execution_required"],
  ])("rejects missing %s", (field, issue) => {
    expect(evaluateCustomerBenchmarkGate({ ...approved, [field]: false }).issues).toContain(issue);
  });

  it("rejects an artifact hash mismatch", () => {
    expect(evaluateCustomerBenchmarkGate({ ...approved, actualArtifactSha256: "b".repeat(64) }).issues).toContain(
      "artifact_hash_mismatch",
    );
  });

  it("rejects an original OneDrive artifact", () => {
    const result = evaluateCustomerBenchmarkGate({
      ...approved,
      artifactPath: path.resolve("C:\\Users\\smart\\OneDrive\\Рабочий стол\\Tivdoc\\CUSTOMER_EVAL_001.png"),
    });
    expect(result.issues).toContain("original_customer_path_forbidden");
  });

  it("rejects V1 artifacts", () => {
    expect(evaluateCustomerBenchmarkGate({ ...approved, artifactPath: path.resolve("eval/customer-payslips/redacted/CUSTOMER_EVAL_001.png") }).issues)
      .toContain("legacy_redaction_input_forbidden");
  });

  it("rejects V2 artifacts", () => {
    expect(evaluateCustomerBenchmarkGate({ ...approved, artifactPath: path.resolve("eval/customer-payslips/redacted-v2/CUSTOMER_EVAL_001.png") }).issues)
      .toContain("legacy_redaction_input_forbidden");
  });

  it("rejects a V3 path escape", () => {
    expect(evaluateCustomerBenchmarkGate({ ...approved, artifactPath: path.resolve("eval/customer-payslips/elsewhere/CUSTOMER_EVAL_001_DATA_ONLY.png") }).issues)
      .toContain("artifact_outside_v3_root");
  });

  it("rejects a non-neutral filename", () => {
    expect(evaluateCustomerBenchmarkGate({ ...approved, artifactPath: path.join(root, "person-name.png") }).issues)
      .toContain("non_neutral_artifact_name");
  });

  it("rejects output beyond the approved root", () => {
    expect(evaluateCustomerBenchmarkGate({ ...approved, outputPath: path.resolve("public/customer-output") }).issues)
      .toContain("output_outside_approved_root");
  });

  it("rejects an output that is not under an ignored root", () => {
    expect(evaluateCustomerBenchmarkGate({ ...approved, approvedIgnoredRoots: [path.resolve("tmp/unrelated")] }).issues)
      .toContain("output_not_git_ignored");
  });

  it("rejects model output imported into ground truth", () => {
    expect(evaluateCustomerBenchmarkGate({ ...approved, modelOutputImportedIntoGroundTruth: true }).issues)
      .toContain("model_output_ground_truth_import_forbidden");
  });

  it("rejects a symlink or junction input", () => {
    expect(evaluateCustomerBenchmarkGate({ ...approved, symlinkOrJunctionDetected: true }).issues)
      .toContain("symlink_or_junction_forbidden");
  });
});

describe("ground truth and reproducibility contracts", () => {
  it("builds value-empty templates", () => {
    const template = buildEmptyGroundTruthTemplate("CUSTOMER_EVAL_001", ["gross_salary"]);
    expect(template.fields[0]).toMatchObject({ classification: "unscored_not_annotated", value: null });
    expect(validateGroundTruthTemplate(template).passed).toBe(true);
  });

  it("rejects prefilled unannotated values", () => {
    const template = buildEmptyGroundTruthTemplate("CUSTOMER_EVAL_001", ["gross_salary"]);
    template.fields[0].value = 123;
    expect(validateGroundTruthTemplate(template).issues).toContain("unannotated_value_present:gross_salary");
  });

  it("rejects PII field names in ground truth", () => {
    const template = buildEmptyGroundTruthTemplate("CUSTOMER_EVAL_001", ["employee_name"]);
    expect(validateGroundTruthTemplate(template).issues).toContain("forbidden_private_field:employee_name");
  });

  it("rejects original filename fields in ground truth", () => {
    const template = buildEmptyGroundTruthTemplate("CUSTOMER_EVAL_001", ["gross_salary"]);
    template.original_filename = "synthetic-name.png";
    expect(validateGroundTruthTemplate(template).issues).toContain("schema:forbidden_key:original_filename");
  });

  it("rejects model-output provenance in ground truth", () => {
    const template = buildEmptyGroundTruthTemplate("CUSTOMER_EVAL_001", ["gross_salary"]);
    template.model_output = { gross_salary: 123 };
    expect(validateGroundTruthTemplate(template).issues).toContain("schema:forbidden_key:model_output");
  });

  it("requires two reviewers for exact critical truth", () => {
    const template = buildEmptyGroundTruthTemplate("CUSTOMER_EVAL_001", ["gross_salary"]);
    Object.assign(template.fields[0], { classification: "exact", value: 123, reviewers: ["reviewer-a"], dual_review_complete: true });
    expect(validateGroundTruthTemplate(template).issues).toContain("critical_field_not_dual_reviewed:gross_salary");
  });

  it("accepts dual-reviewed exact truth", () => {
    const template = buildEmptyGroundTruthTemplate("CUSTOMER_EVAL_001", ["gross_salary"]);
    Object.assign(template.fields[0], {
      classification: "exact",
      value: 123,
      reviewers: ["reviewer-a", "reviewer-b"],
      dual_review_complete: true,
    });
    expect(validateGroundTruthTemplate(template).passed).toBe(true);
  });

  it("excludes timestamps from stable evidence hashes", () => {
    expect(sha256(stableJson({ value: 1, created_timestamp: "first" }))).toBe(
      sha256(stableJson({ value: 1, created_timestamp: "second" })),
    );
  });

  it("computes perceptual hash Hamming distance", () => {
    expect(hammingDistance("0000", "000f")).toBe(4);
  });

  it("separates exact and visual duplicate groups", () => {
    expect(buildDuplicateGroups([
      { id: "A", sha256: "same", perceptual_hash: "0000" },
      { id: "B", sha256: "same", perceptual_hash: "ffff" },
      { id: "C", sha256: "other", perceptual_hash: "0001" },
    ])).toEqual({ exact: [["A", "B"]], visual: [["A", "C"]] });
  });
});

describe("PII-safe customer report serialization", () => {
  it("accepts the allowlisted safe report contract", () => {
    expect(validatePiiSafeReport({
      neutral_document_id: "CUSTOMER_EVAL_001",
      gate_codes: ["OWNER_VISUAL_APPROVAL_REQUIRED"],
      artifact_sha256: "a".repeat(64),
      confidence: 0.9,
      tokens: 0,
      cost: 0,
      latency_ms: 0,
      safe_error_code: null,
    }).passed).toBe(true);
  });

  it.each([
    ["original_filename", "synthetic-person.png"],
    ["original_path", "C:\\private\\synthetic.png"],
    ["employee_name", "Synthetic Person"],
    ["employer_identity", "Synthetic Employer"],
    ["national_id", "123456789"],
    ["address", "Synthetic Street 1"],
    ["bank_account", "123456"],
    ["phone", "050-123-4567"],
    ["email", "synthetic@example.test"],
    ["raw_ocr", "synthetic raw text"],
    ["provider_error_body", "synthetic body"],
    ["api_key", "synthetic-key-value"],
    ["screenshot", "base64-synthetic"],
  ])("rejects forbidden report key %s", (key, value) => {
    expect(validatePiiSafeReport({ [key]: value }).passed).toBe(false);
  });

  it("rejects a synthetic PII sentinel hidden under an allowed key", () => {
    expect(validatePiiSafeReport({ safe_error_code: "SYNTHETIC_SECRET" }, ["SYNTHETIC_SECRET"]).issues)
      .toContain("unsafe_value:synthetic_private_sentinel");
  });
});
