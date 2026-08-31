import { canonicalSha256 } from "../../../engine/rule-runtime/canonical";

export const P8_SCHEMA_VERSION = "tivdoc-overnight-v0.7-p8-integrated-v2" as const;

export type P8CheckStatus = "PASS" | "SKIPPED_BLOCKED";

export type P8Check = Readonly<{
  id: string;
  status: P8CheckStatus;
  evidence: Readonly<Record<string, unknown>>;
  evidence_sha256: string;
}>;

export type P8Dependency = Readonly<{
  lane: "public_fixture" | "native_visual";
  status: "SKIPPED_BLOCKED" | "SKIPPED_NO_ELIGIBLE_PROVENANCE";
  blocker_code: string;
  required_adapter: string;
  affected_acceptance_ids: readonly string[];
}>;

export type P8ReadyReceipt = Readonly<{
  schema_version: typeof P8_SCHEMA_VERSION;
  generated_at: "2040-01-01T00:00:00.000Z";
  base_commit: "bef916d8afddfa507a46c1db57cb2be97f1fc928";
  overall_status: "INTEGRATED_PASS_WITH_DECLARED_SKIPS" | "FAIL";
  checks: readonly P8Check[];
  dependencies: readonly P8Dependency[];
  counts: Readonly<{
    passed: number;
    skipped_blocked: number;
    failed: number;
    prohibited_actions: 0;
    real_calculations: 0;
    real_findings: 0;
    real_approvals: 0;
    real_exports: 0;
    customer_records_read: 0;
    external_calls: 0;
  }>;
  receipt_sha256: string;
}>;

export function p8Check(id: string, status: P8CheckStatus, evidence: Readonly<Record<string, unknown>>): P8Check {
  const normalized = Object.freeze({ ...evidence });
  return Object.freeze({ id, status, evidence: normalized, evidence_sha256: canonicalSha256({ id, status, evidence: normalized }) });
}

