import { describe, expect, it } from "vitest";

import {
  CANONICAL_REPORT_IDENTITY_SCHEMA_VERSION,
  assertCanonicalReportIdentity,
  assertCanonicalReportIdentityMatches,
  canonicalReportDependencySha256,
  canonicalReportModelSha256,
  canonicalReportStorageObjectId,
  canonicalReportStorageObjectVersionId,
  createCanonicalReportIdentity,
  withCanonicalReportGrantRevision,
  type CanonicalReportIdentitySeed,
} from "./report-identity.ts";

const HASH = Object.freeze({
  owner: "1".repeat(64),
  analysis: "2".repeat(64),
  json: "3".repeat(64),
  html: "4".repeat(64),
  manifest: "5".repeat(64),
  report: "6".repeat(64),
  pdf: "7".repeat(64),
  approval: "8".repeat(64),
});

describe("canonical durable report identity", () => {
  it("binds every required revision and digest with deterministic serialization", () => {
    const first = identity();
    const second = identity();
    expect(first).toEqual(second);
    expect(first.identity_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.storage_object_id).toMatch(/^report-object:[a-f0-9]{48}$/u);
    expect(first.storage_object_version_id).toMatch(/^object_[a-f0-9]{48}$/u);
    expect(() => assertCanonicalReportIdentity(first)).not.toThrow();
  });

  it("canonicalizes dependency and report-model inputs independent of object key order", () => {
    const left = canonicalReportDependencySha256({
      rule_inputs: [
        { topic: "z-synthetic", payload_sha256: HASH.analysis },
        { topic: "a-synthetic", payload_sha256: HASH.owner },
      ],
      dependencies: {
        catalog_sha256: HASH.manifest,
        source_version_ids: ["source-z", "source-a"],
        parameter_version_ids: ["parameter-z", "parameter-a"],
        rule_spec_versions: ["rule-z", "rule-a"],
      },
    });
    const right = canonicalReportDependencySha256({
      dependencies: {
        rule_spec_versions: ["rule-a", "rule-z"],
        parameter_version_ids: ["parameter-a", "parameter-z"],
        source_version_ids: ["source-a", "source-z"],
        catalog_sha256: HASH.manifest,
      },
      rule_inputs: [
        { payload_sha256: HASH.owner, topic: "a-synthetic" },
        { payload_sha256: HASH.analysis, topic: "z-synthetic" },
      ],
    });
    expect(left).toBe(right);
    expect(canonicalReportModelSha256({
      analysis_result_sha256: HASH.analysis,
      json_sha256: HASH.json,
      html_sha256: HASH.html,
      manifest_sha256: HASH.manifest,
    })).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ["case_revision", 8, "CANONICAL_REPORT_IDENTITY_STALE"],
    ["rule_input_dependency_sha256", "9".repeat(64), "CANONICAL_REPORT_DEPENDENCY_MISMATCH"],
    ["report_model_sha256", "a".repeat(64), "CANONICAL_REPORT_MODEL_MISMATCH"],
    ["pdf_sha256", "b".repeat(64), "CANONICAL_REPORT_DIGEST_MISMATCH"],
    ["approval_revision", 2, "CANONICAL_REPORT_APPROVAL_MISMATCH"],
  ] as const)("rejects a mismatched %s", (key, value, code) => {
    const expected = identity();
    const actual = identity({ [key]: value });
    expect(() => assertCanonicalReportIdentityMatches(expected, actual)).toThrow(code);
  });

  it("re-hashes a monotonic grant revision and rejects stale grant use", () => {
    const staged = identity();
    const approved = withCanonicalReportGrantRevision(staged, 1);
    expect(approved.download_grant_revision).toBe(1);
    expect(approved.identity_sha256).not.toBe(staged.identity_sha256);
    expect(() => assertCanonicalReportIdentityMatches(approved, staged)).toThrow(
      "CANONICAL_REPORT_GRANT_MISMATCH",
    );
  });

  it("rejects a storage version not derived from the exact canonical report binding", () => {
    expect(() => identity({ storage_object_version_id: `object_${"f".repeat(48)}` })).toThrow(
      "CANONICAL_REPORT_STORAGE_MISMATCH",
    );
  });
});

function identity(overrides: Readonly<Record<string, unknown>> = {}) {
  const dependencySha256 = canonicalReportDependencySha256({
    rule_inputs: [{ topic: "synthetic", payload_sha256: HASH.analysis }],
    dependencies: { catalog_sha256: HASH.manifest, source_ids: [] },
  });
  const modelSha256 = canonicalReportModelSha256({
    analysis_result_sha256: HASH.analysis,
    json_sha256: HASH.json,
    html_sha256: HASH.html,
    manifest_sha256: HASH.manifest,
  });
  const core = Object.freeze({
    tenant_id: "tenant:synthetic:001",
    case_id: "case:synthetic:001",
    case_revision: 7,
    analysis_run_id: "analysis:synthetic:001",
    analysis_run_revision: 7,
    rule_input_dependency_sha256: dependencySha256,
    report_model_sha256: modelSha256,
    report_id: "report:synthetic:001",
    report_revision: 7,
    report_sha256: HASH.report,
    pdf_sha256: HASH.pdf,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => [
      "tenant_id", "case_id", "case_revision", "analysis_run_id", "analysis_run_revision",
      "rule_input_dependency_sha256", "report_model_sha256", "report_id", "report_revision",
      "report_sha256", "pdf_sha256",
    ].includes(key))),
  });
  const seed = {
    schema_version: CANONICAL_REPORT_IDENTITY_SCHEMA_VERSION,
    ...core,
    owner_binding_revision: 1,
    owner_binding_sha256: HASH.owner,
    storage_object_id: canonicalReportStorageObjectId(core),
    storage_object_version_id: canonicalReportStorageObjectVersionId(core),
    approval_task_id: "approval:synthetic:001",
    approval_revision: 1,
    approval_decision_sha256: HASH.approval,
    download_grant_revision: 0,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => [
      "owner_binding_revision", "owner_binding_sha256", "storage_object_id", "storage_object_version_id",
      "approval_task_id", "approval_revision", "approval_decision_sha256", "download_grant_revision",
    ].includes(key))),
  } as CanonicalReportIdentitySeed;
  return createCanonicalReportIdentity(seed);
}
