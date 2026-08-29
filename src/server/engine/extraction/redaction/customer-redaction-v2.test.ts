import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CUSTOMER_PAYSLIP_REDACTION_V2,
  detectSensitiveTextSignals,
  verifyCustomerRedactionV2,
  type SensitiveSignal,
} from "./customer-redaction-v2";

const approvedRoot = path.resolve("eval", "customer-payslips", "redacted-v2");

function validInput() {
  return {
    neutralDocumentId: "CUSTOMER_EVAL_001",
    artifactFilename: "CUSTOMER_EVAL_001.png",
    artifactPath: path.join(approvedRoot, "CUSTOMER_EVAL_001.png"),
    approvedRedactedRoot: approvedRoot,
    artifactMimeType: "image/png",
    pipelineVersion: CUSTOMER_PAYSLIP_REDACTION_V2,
    sourceSha256: "a".repeat(64),
    artifactSha256: "b".repeat(64),
    isSymlinkOrReference: false,
    metadataEntries: {},
    extractedHiddenText: "",
    detectedSignals: [] as SensitiveSignal[],
    knownSensitiveRegions: [{ x: 10, y: 10, width: 100, height: 40 }],
    opaqueMaskRegions: [{ x: 0, y: 0, width: 130, height: 70 }],
    retainedRegions: [{ x: 150, y: 100, width: 300, height: 500 }],
    serializedManifest: JSON.stringify({ neutral_id: "CUSTOMER_EVAL_001", pipeline: CUSTOMER_PAYSLIP_REDACTION_V2 }),
    maskSafetyMargin: 8,
  };
}

describe("customer payslip Redaction V2 verifier", () => {
  it("accepts only a flattened neutral allowlist artifact with complete sensitive-region coverage", () => {
    expect(verifyCustomerRedactionV2(validInput())).toEqual({ passed: true, failures: [] });
  });

  it("rejects a visible direct identifier in a header", () => {
    const input = validInput();
    input.detectedSignals = ["direct_identifier"];
    expect(verifyCustomerRedactionV2(input).failures.map((failure) => failure.code)).toContain("sensitive_pattern_detected");
  });

  it.each([
    ["national_id", "Synthetic reference 123456782"],
    ["address", "כתובת לדוגמה"],
    ["bank_details", "חשבון בנק 1234"],
    ["employee_number", "מספר עובד 123"],
    ["signature", "חתימה"],
    ["email", "person@example.test"],
    ["phone", "050-1234567"],
  ] as const)("detects a synthetic %s signal", (signal, text) => {
    expect(detectSensitiveTextSignals(text)).toContain(signal);
  });

  it("rejects a QR or barcode detector finding", () => {
    const input = validInput();
    input.detectedSignals = ["qr_or_barcode"];
    expect(verifyCustomerRedactionV2(input).passed).toBe(false);
  });

  it("rejects hidden PDF text beneath a visual mask", () => {
    const input = validInput();
    input.artifactMimeType = "application/pdf";
    input.extractedHiddenText = "synthetic hidden text";
    expect(verifyCustomerRedactionV2(input).failures.map((failure) => failure.code))
      .toEqual(expect.arrayContaining(["non_raster_artifact", "hidden_text_present"]));
  });

  it("rejects metadata containing identity", () => {
    const input = validInput();
    input.metadataEntries = { Author: "Synthetic Person" };
    expect(verifyCustomerRedactionV2(input).failures.map((failure) => failure.code)).toContain("identifying_metadata_present");
  });

  it("rejects a non-neutral filename", () => {
    const input = validInput();
    input.artifactFilename = "employee-payslip.png";
    expect(verifyCustomerRedactionV2(input).failures.map((failure) => failure.code)).toContain("non_neutral_filename");
  });

  it("rejects source path leakage in a manifest", () => {
    const input = validInput();
    input.serializedManifest = JSON.stringify({ source_path: "C:\\Users\\Example\\payslip.png" });
    expect(verifyCustomerRedactionV2(input).failures.map((failure) => failure.code)).toContain("source_path_or_identity_leak");
  });

  it("rejects an old failed V1 artifact", () => {
    const input = validInput();
    input.pipelineVersion = "customer-payslip-local-redaction-1";
    expect(verifyCustomerRedactionV2(input).failures.map((failure) => failure.code)).toContain("obsolete_redaction_pipeline");
  });

  it("rejects a known sensitive region not covered with margin", () => {
    const input = validInput();
    input.opaqueMaskRegions = [{ x: 10, y: 10, width: 100, height: 40 }];
    expect(verifyCustomerRedactionV2(input).failures.map((failure) => failure.code)).toContain("sensitive_region_not_covered");
  });

  it("rejects an allowlist region that overlaps a sensitive block", () => {
    const input = validInput();
    input.retainedRegions = [{ x: 50, y: 20, width: 200, height: 100 }];
    expect(verifyCustomerRedactionV2(input).failures.map((failure) => failure.code)).toContain("allowlist_overlaps_sensitive_region");
  });
});
