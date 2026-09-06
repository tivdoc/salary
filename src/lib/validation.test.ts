import { describe, expect, it } from "vitest";
import { questionnaireSchema, uploadManifestSchema, validateUploadDescriptor } from "./validation";

const validQuestionnaire = {
  firstName: "נועה",
  phone: "050-1234567",
  email: "noa@example.com",
  stillEmployed: true,
  salaryType: "monthly",
  typicalHoursPerDay: "9",
  workDaysPerWeek: "5",
  worksFriday: true,
  worksSaturday: false,
  payslipAvailable: true,
  suspectedIssue: "השעות הנוספות מופיעות כסכום קבוע מדי חודש.",
  // S3.1: the engine's own inputs. Each decides whether a topic can be checked at all.
  employmentStartMonth: "2023-04",
  birthYear: "1994",
  sex: "female",
  hadPensionFundAtHire: false,
  employerProvidesTransport: false,
  commuteOver500m: true,
  managerialOrTrustRole: false,
};

describe("questionnaireSchema", () => {
  it("normalizes numeric questionnaire inputs", () => {
    const result = questionnaireSchema.parse(validQuestionnaire);
    expect(result.typicalHoursPerDay).toBe(9);
    expect(result.workDaysPerWeek).toBe(5);
  });

  it("rejects an implausible work day", () => {
    const result = questionnaireSchema.safeParse({ ...validQuestionnaire, typicalHoursPerDay: "22" });
    expect(result.success).toBe(false);
  });

  it("allows the suspected issue to stay optional", () => {
    const result = questionnaireSchema.safeParse({ ...validQuestionnaire, suspectedIssue: "" });
    expect(result.success).toBe(true);
  });
});

describe("validateUploadDescriptor", () => {
  it("accepts a PDF under 10MB", () => {
    expect(validateUploadDescriptor({ name: "payslip.pdf", type: "application/pdf", size: 450_000 })).toBeNull();
  });

  it("rejects executable content", () => {
    expect(validateUploadDescriptor({ name: "payslip.exe", type: "application/x-msdownload", size: 1000 })).toMatch(/PDF/);
  });

  it("rejects a file over 10MB", () => {
    expect(validateUploadDescriptor({ name: "large.png", type: "image/png", size: 11 * 1024 * 1024 })).toMatch(/10MB/);
  });
});

describe("uploadManifestSchema", () => {
  it("accepts one payslip and optional supporting documents", () => {
    const result = uploadManifestSchema.safeParse({
      files: [
        { documentType: "payslip", slot: "payslip-01", name: "august.pdf", type: "application/pdf", size: 120_000 },
        { documentType: "contract", slot: "contract", name: "contract.jpg", type: "image/jpeg", size: 240_000 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a manifest without a payslip", () => {
    const result = uploadManifestSchema.safeParse({
      files: [{ documentType: "contract", slot: "contract", name: "contract.pdf", type: "application/pdf", size: 120_000 }],
    });
    expect(result.success).toBe(false);
  });
});
