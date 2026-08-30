import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "./canonical";
import { CANONICAL_REPOSITORY_MAPPING, REPOSITORY_ENTITIES, type AtomicCommand } from "./contracts";
import { LocalDurablePlatformStore, TRANSACTION_FAILURE_STAGES } from "./transactional-store";

const tenantId = "tenant:synthetic:001";
const caseId = "case:synthetic:001";
const at = "2026-08-31T00:00:00.000Z";

function atomic(overrides: Partial<AtomicCommand> = {}): AtomicCommand {
  const body = overrides.command ?? { action: "persist_facts", facts_sha256: "a".repeat(64) };
  const payload = { schema_version: "synthetic-facts-v1", facts: [] };
  return {
    tenant_id: tenantId,
    case_id: caseId,
    actor_id: "actor:synthetic:worker",
    scope: "facts.persist",
    idempotency_key: "facts:001",
    expected_case_revision: 0,
    command_sha256: canonicalSha256(body),
    command: body,
    occurred_at: at,
    writes: [{ entity: "canonical_facts", record_id: "facts:001", expected_revision: 0, payload, payload_sha256: canonicalSha256(payload) }],
    invalidates: [],
    outbox: [{ logical_effect_id: "facts:001:index", effect_kind: "facts_persisted", payload: { case_id: caseId }, payload_sha256: canonicalSha256({ case_id: caseId }) }],
    ...overrides,
  };
}

describe("canonical repository mapping", () => {
  it("maps every frozen repository exactly once with ownership, revision, hash, retention, actors and deletion policy", () => {
    expect(CANONICAL_REPOSITORY_MAPPING.map((item) => item.entity).sort()).toEqual([...REPOSITORY_ENTITIES].sort());
    expect(new Set(CANONICAL_REPOSITORY_MAPPING.map((item) => item.entity)).size).toBe(REPOSITORY_ENTITIES.length);
    for (const item of CANONICAL_REPOSITORY_MAPPING) {
      expect(item.table).toMatch(/^[a-z][a-z0-9_]+$/);
      expect(item.primary_key.length).toBeGreaterThan(0);
      expect(item.hash_column).toBeTruthy();
      expect(item.authorized_actors.length).toBeGreaterThan(0);
    }
  });
});

describe("atomic persistence, idempotency and optimistic concurrency", () => {
  it("turns 32 concurrent identical commands into one logical mutation", async () => {
    const store = new LocalDurablePlatformStore();
    const command = atomic();
    const receipts = await Promise.all(Array.from({ length: 32 }, () => store.execute(command)));
    expect(receipts.filter((receipt) => !receipt.idempotent_replay)).toHaveLength(1);
    expect(receipts.filter((receipt) => receipt.idempotent_replay)).toHaveLength(31);
    expect(store.history("canonical_facts", "facts:001")).toHaveLength(1);
    expect(store.auditEvents()).toHaveLength(1);
    expect(store.outboxEvents()).toHaveLength(1);
  });

  it("rejects same key with a changed command without mutation", async () => {
    const store = new LocalDurablePlatformStore();
    await store.execute(atomic());
    const changedBody = { action: "persist_facts", facts_sha256: "b".repeat(64) };
    await expect(store.execute(atomic({ command: changedBody, command_sha256: canonicalSha256(changedBody), expected_case_revision: 1 })))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_COMMAND_MISMATCH" });
    expect(store.caseRevision(caseId)).toBe(1);
    expect(store.auditEvents()).toHaveLength(1);
  });

  it("allows exactly one of two expected-revision writes", async () => {
    const store = new LocalDurablePlatformStore();
    const first = atomic({ idempotency_key: "cas:first" });
    const secondBody = { action: "persist_extraction" };
    const secondPayload = { schema_version: "synthetic-extraction-v1" };
    const second = atomic({
      idempotency_key: "cas:second",
      scope: "extraction.persist",
      command: secondBody,
      command_sha256: canonicalSha256(secondBody),
      writes: [{ entity: "extractions", record_id: "extraction:001", expected_revision: 0, payload: secondPayload, payload_sha256: canonicalSha256(secondPayload) }],
    });
    const outcomes = await Promise.allSettled([store.execute(first), store.execute(second)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "CASE_REVISION_CONFLICT" } });
  });

  it.each(TRANSACTION_FAILURE_STAGES)("rolls back all visible state on injected %s", async (stage) => {
    const store = new LocalDurablePlatformStore();
    const finding = { status: "blocked_legal_readiness", amount: null };
    const report = { report_sha256: "7".repeat(64) };
    const approval = { decision: "approved", report_sha256: report.report_sha256 };
    await expect(store.execute(atomic({
      writes: [
        { entity: "topic_results", record_id: "finding:001", expected_revision: 0, payload: finding, payload_sha256: canonicalSha256(finding) },
        { entity: "reports", record_id: "report:failure", expected_revision: 0, payload: report, payload_sha256: canonicalSha256(report) },
        { entity: "review_tasks", record_id: "approval:failure", expected_revision: 0, payload: approval, payload_sha256: canonicalSha256(approval) },
      ],
    }), stage)).rejects.toMatchObject({ code: "INJECTED_FAILURE" });
    expect(store.caseRevision(caseId)).toBe(0);
    expect(store.current("topic_results", "finding:001")).toBeNull();
    expect(store.current("reports", "report:failure")).toBeNull();
    expect(store.current("review_tasks", "approval:failure")).toBeNull();
    expect(store.auditEvents()).toHaveLength(0);
    expect(store.outboxEvents()).toHaveLength(0);
  });

  it("does not let a stale approval survive an upstream mutation race", async () => {
    const store = new LocalDurablePlatformStore();
    const report = { report_sha256: "c".repeat(64), analysis_sha256: "d".repeat(64) };
    await store.execute(atomic({
      idempotency_key: "report:create",
      scope: "report.create",
      writes: [{ entity: "reports", record_id: "report:001", expected_revision: 0, payload: report, payload_sha256: canonicalSha256(report) }],
      outbox: [],
    }));
    const mutationBody = { action: "facts_changed", prior_report_sha256: report.report_sha256 };
    const approvalBody = { action: "approve", report_sha256: report.report_sha256 };
    const mutation = atomic({
      idempotency_key: "facts:mutate",
      expected_case_revision: 1,
      command: mutationBody,
      command_sha256: canonicalSha256(mutationBody),
      writes: [],
      invalidates: [{ entity: "reports", record_id: "report:001", expected_revision: 1 }],
      outbox: [],
    });
    const approvalPayload = { decision: "approved", report_sha256: report.report_sha256 };
    const approval = atomic({
      idempotency_key: "report:approve",
      expected_case_revision: 1,
      command: approvalBody,
      command_sha256: canonicalSha256(approvalBody),
      writes: [{ entity: "review_tasks", record_id: "review:001", expected_revision: 0, payload: approvalPayload, payload_sha256: canonicalSha256(approvalPayload) }],
      invalidates: [],
      outbox: [],
    });
    const outcomes = await Promise.allSettled([store.execute(mutation), store.execute(approval)]);
    expect(outcomes[0].status).toBe("fulfilled");
    expect(outcomes[1]).toMatchObject({ status: "rejected", reason: { code: "CASE_REVISION_CONFLICT" } });
    expect(store.current("reports", "report:001")?.visible).toBe(false);
    expect(store.current("review_tasks", "review:001")).toBeNull();
  });

  it("restores exact pinned versions and refuses fall-forward after restart", async () => {
    const store = new LocalDurablePlatformStore();
    const pins = { source_version_ids: ["source:v1"], rule_spec_versions: ["rulespec:v1"], catalog_sha256: "e".repeat(64) };
    const pinSha = canonicalSha256(pins);
    await store.execute(atomic({
      idempotency_key: "pins:001",
      scope: "analysis.pin",
      writes: [{ entity: "legal_version_pins", record_id: "analysis:001", expected_revision: 0, payload: pins, payload_sha256: pinSha }],
      outbox: [],
    }));
    const restarted = new LocalDurablePlatformStore(store.snapshot());
    expect(restarted.current("legal_version_pins", "analysis:001")?.payload).toEqual(pins);
    expect(() => restarted.assertPinnedVersionsAvailable([pinSha])).not.toThrow();
    expect(() => restarted.assertPinnedVersionsAvailable(["f".repeat(64)])).toThrowError(/PINNED_VERSION_UNAVAILABLE/);
  });

  it("uses fencing and deduplicated logical effects for at-least-once outbox publication", async () => {
    const store = new LocalDurablePlatformStore();
    await store.execute(atomic());
    const first = await store.claimOutbox("worker:a", 0, 10);
    const reclaimed = await store.claimOutbox("worker:b", 10, 10);
    expect(reclaimed?.fencing_token).toBe(2);
    await expect(store.publishOutbox({ outbox_id: first!.outbox_id, worker_id: "worker:a", fencing_token: first!.fencing_token, logical_effect_sha256: "1".repeat(64) }))
      .rejects.toMatchObject({ code: "STALE_FENCING_TOKEN" });
    await expect(store.publishOutbox({ outbox_id: reclaimed!.outbox_id, worker_id: "worker:b", fencing_token: reclaimed!.fencing_token, logical_effect_sha256: "1".repeat(64) }))
      .resolves.toEqual({ deduplicated: false });
    const repeatBody = { action: "requeue_index_effect" };
    await store.execute(atomic({
      idempotency_key: "facts:001:requeue",
      expected_case_revision: 1,
      command: repeatBody,
      command_sha256: canonicalSha256(repeatBody),
      writes: [],
    }));
    const duplicate = await store.claimOutbox("worker:c", 20, 10);
    await expect(store.publishOutbox({ outbox_id: duplicate!.outbox_id, worker_id: "worker:c", fencing_token: duplicate!.fencing_token, logical_effect_sha256: "1".repeat(64) }))
      .resolves.toEqual({ deduplicated: true });
  });
});
