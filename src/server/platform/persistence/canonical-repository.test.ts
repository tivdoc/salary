import { describe, expect, it } from "vitest";
import type { CaseReviewDecision } from "../../../engine/wave3/contracts";
import { canonicalSha256 } from "./canonical";
import { CanonicalPlatformRepository } from "./canonical-repository";
import { LocalDurablePlatformStore } from "./transactional-store";

const at = "2026-08-31T00:00:00.000Z";
const tenant = "tenant:synthetic";
const caseId = "case:synthetic";

describe("canonical repository adapter", () => {
  it("atomically persists an analysis stage and its resume cursor", async () => {
    const store = new LocalDurablePlatformStore();
    const repository = new CanonicalPlatformRepository(store);
    const payload = { facts_snapshot_sha256: "a".repeat(64) };
    await repository.persistAnalysisStage({
      tenant_id: tenant, case_id: caseId, actor_id: "worker:synthetic", analysis_run_id: "analysis:001",
      stage: "canonical_facts", stage_expected_revision: 0, run_expected_revision: 0, expected_case_revision: 0,
      payload, payload_sha256: canonicalSha256(payload), resume_cursor: { next_stage: "rule_inputs" },
      idempotency_key: "analysis:001:canonical-facts", occurred_at: at,
    });
    expect(store.current("analysis_stages", "analysis:001:canonical_facts")?.payload).toEqual(payload);
    expect(store.current("analysis_runs", "analysis:001")?.payload).toMatchObject({ resume_cursor: { next_stage: "rule_inputs" } });
  });

  it("binds release eligibility to the exact immutable report hash", async () => {
    const store = new LocalDurablePlatformStore();
    const reportPayload = { report_sha256: "b".repeat(64), analysis_result_sha256: "c".repeat(64) };
    await store.execute({
      tenant_id: tenant, case_id: caseId, actor_id: "worker:synthetic", scope: "report.persist", idempotency_key: "report:001",
      expected_case_revision: 0, command: { action: "report.persist" }, command_sha256: canonicalSha256({ action: "report.persist" }), occurred_at: at,
      writes: [{ entity: "reports", record_id: "report:001", expected_revision: 0, payload: reportPayload, payload_sha256: canonicalSha256(reportPayload) }],
      invalidates: [], outbox: [],
    });
    const decision: CaseReviewDecision = {
      task_id: "review:001", task_kind: "report_approval", reviewer_id: "reviewer:synthetic", reviewer_role: "report_approver",
      decision: "approved", input_sha256: reportPayload.analysis_result_sha256, output_sha256: reportPayload.report_sha256,
      decided_at: at, reason: "synthetic_exact_hash_review", schema_version: "tivdoc-case-review-decision-v0.6.0",
    };
    const repository = new CanonicalPlatformRepository(store);
    await expect(repository.approveExactReport({
      tenant_id: tenant, case_id: caseId, actor_id: "reviewer:synthetic", report_id: "report:001", report_revision: 1,
      report_sha256: reportPayload.report_sha256, expected_case_revision: 1, review_expected_revision: 0, lifecycle_expected_revision: 0,
      decision, idempotency_key: "approve:001", occurred_at: at,
    })).resolves.toMatchObject({ case_revision: 2 });
    expect(store.current("lifecycle_revisions", "report-ready:report:001")?.payload).toMatchObject({ report_sha256: reportPayload.report_sha256 });
  });

  it("rejects an approval bound to any other hash with no mutation", async () => {
    const store = new LocalDurablePlatformStore();
    const reportPayload = { report_sha256: "b".repeat(64) };
    await store.execute({
      tenant_id: tenant, case_id: caseId, actor_id: "worker:synthetic", scope: "report.persist", idempotency_key: "report:002",
      expected_case_revision: 0, command: { action: "report.persist" }, command_sha256: canonicalSha256({ action: "report.persist" }), occurred_at: at,
      writes: [{ entity: "reports", record_id: "report:002", expected_revision: 0, payload: reportPayload, payload_sha256: canonicalSha256(reportPayload) }], invalidates: [], outbox: [],
    });
    const decision = {
      task_id: "review:002", task_kind: "report_approval", reviewer_id: "reviewer:synthetic", reviewer_role: "report_approver", decision: "approved",
      input_sha256: "c".repeat(64), output_sha256: "d".repeat(64), decided_at: at, reason: "synthetic", schema_version: "tivdoc-case-review-decision-v0.6.0",
    } as const;
    const repository = new CanonicalPlatformRepository(store);
    await expect(repository.approveExactReport({
      tenant_id: tenant, case_id: caseId, actor_id: "reviewer:synthetic", report_id: "report:002", report_revision: 1,
      report_sha256: reportPayload.report_sha256, expected_case_revision: 1, review_expected_revision: 0, lifecycle_expected_revision: 0,
      decision, idempotency_key: "approve:002", occurred_at: at,
    })).rejects.toMatchObject({ code: "IMMUTABLE_VERSION_MISMATCH" });
    expect(store.caseRevision(caseId)).toBe(1);
    expect(store.current("review_tasks", "review:002")).toBeNull();
  });
});
