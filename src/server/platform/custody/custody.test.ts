import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  CustodyReplicationOutbox,
  LocalSyntheticCustodyStore,
  offHostCustodyCapability,
  selectRestoreSource,
  type CustodyDestinationPort,
} from "./replication.ts";
import { reconcilePrivacyStorage } from "./privacy-reconciliation.ts";

const AT = "2035-01-01T00:00:00.000Z";
const LATER = "2035-01-01T00:10:00.000Z";
const BYTES = new TextEncoder().encode("synthetic custody bytes");
const HASH = createHash("sha256").update(BYTES).digest("hex");

function enqueue(outbox: CustodyReplicationOutbox) {
  return outbox.enqueue({
    replication_id: "replication.001",
    idempotency_key: "replication.idempotency.001",
    source_store_id: "source.store.001",
    source_object_id: "source.object.001",
    source_receipt_sha256: "a".repeat(64),
    object_sha256: HASH,
    byte_count: BYTES.byteLength,
    retention_class: "case.record",
    key_version: "key.version.001",
    destination_id: "destination.store.001",
    created_at: AT,
  });
}

describe("provider-independent custody replication", () => {
  it("proves immutable two-store replication, exact reopen, idempotency and restart", async () => {
    let lease = 0;
    const source = new LocalSyntheticCustodyStore("source.store.001", [{ object_id: "source.object.001", bytes: BYTES }]);
    const destination = new LocalSyntheticCustodyStore("destination.store.001");
    const outbox = new CustodyReplicationOutbox({ runtime: "test", id_factory: () => `lease.${++lease}` });
    const queued = enqueue(outbox);
    expect(enqueue(outbox)).toEqual(queued);
    const claimed = outbox.claim({ destination, now: AT, lease_seconds: 120 })!;
    const completed = await outbox.execute({ replication_id: claimed.replication_id, lease_token: claimed.lease_token!, source, destination, completed_at: "2035-01-01T00:01:00.000Z" });
    expect(completed.state).toBe("completed");
    expect(completed.receipt?.object_sha256).toBe(HASH);
    expect((await destination.accessLog()).map((entry) => entry.operation)).toEqual(["put", "read"]);
    expect(selectRestoreSource([completed.receipt!], HASH)).toEqual(completed.receipt);

    const restarted = new CustodyReplicationOutbox({ runtime: "test", snapshot: outbox.snapshot(), id_factory: () => "restart.lease" });
    expect(restarted.get(completed.replication_id)).toEqual(completed);
    expect(restarted.claim({ destination, now: LATER, lease_seconds: 120 })).toBeNull();
  });

  it("fences stale leases, retries safely and records divergence without completed state", async () => {
    const source = new LocalSyntheticCustodyStore("source.store.001", [{ object_id: "source.object.001", bytes: BYTES }]);
    const destination = new LocalSyntheticCustodyStore("destination.store.001");
    let lease = 0;
    const outbox = new CustodyReplicationOutbox({ runtime: "test", id_factory: () => `lease.${++lease}` });
    enqueue(outbox);
    const first = outbox.claim({ destination, now: AT, lease_seconds: 60 })!;
    const retry = outbox.retry({ replication_id: first.replication_id, lease_token: first.lease_token!, error_code: "transient.failure", next_attempt_at: "2035-01-01T00:02:00.000Z", now: "2035-01-01T00:00:30.000Z" });
    expect(retry.state).toBe("retry_wait");
    expect(() => outbox.claim({ destination, now: "2035-01-01T00:01:00.000Z", lease_seconds: 60 })).not.toThrow();
    const second = outbox.claim({ destination, now: "2035-01-01T00:02:00.000Z", lease_seconds: 60 })!;
    await expect(outbox.execute({ replication_id: second.replication_id, lease_token: first.lease_token!, source, destination, completed_at: "2035-01-01T00:02:30.000Z" })).rejects.toThrow("CUSTODY_LEASE_FENCED");
    source.corruptForTest("source.object.001");
    const diverged = await outbox.execute({ replication_id: second.replication_id, lease_token: second.lease_token!, source, destination, completed_at: "2035-01-01T00:02:30.000Z" });
    expect(diverged).toMatchObject({ state: "diverged", receipt: null, error_code: "CUSTODY_SOURCE_INTEGRITY_FAILURE" });
  });

  it("rejects synthetic destinations outside tests and preserves exact managed blocker truth", () => {
    const destination = new LocalSyntheticCustodyStore("destination.store.001");
    const outbox = new CustodyReplicationOutbox({ runtime: "development" });
    enqueue(outbox);
    expect(() => outbox.claim({ destination, now: AT, lease_seconds: 60 })).toThrow("CUSTODY_SYNTHETIC_DESTINATION_TEST_ONLY");
    expect(offHostCustodyCapability()).toEqual({
      status: "BLOCKED",
      blocker_codes: ["OFF_HOST_AUDIT_CUSTODY_PENDING", "DURABLE_REPLICATED_CUSTODY_NOT_IMPLEMENTED"],
      local_two_store_proof_available: true,
      managed_destination_verified: false,
    });
  });

  it("detects a forged destination receipt and never publishes completion", async () => {
    const source = new LocalSyntheticCustodyStore("source.store.001", [{ object_id: "source.object.001", bytes: BYTES }]);
    const genuine = new LocalSyntheticCustodyStore("destination.store.001");
    const forged: CustodyDestinationPort = {
      destination_id: genuine.destination_id,
      destination_class: genuine.destination_class,
      async putImmutable(input) { return { ...(await genuine.putImmutable(input)), receipt_sha256: "0".repeat(64) }; },
      readExact: (input) => genuine.readExact(input),
      accessLog: () => genuine.accessLog(),
    };
    const outbox = new CustodyReplicationOutbox({ runtime: "test", id_factory: () => "lease.001" });
    enqueue(outbox);
    const claimed = outbox.claim({ destination: forged, now: AT, lease_seconds: 60 })!;
    const result = await outbox.execute({ replication_id: claimed.replication_id, lease_token: claimed.lease_token!, source, destination: forged, completed_at: "2035-01-01T00:00:30.000Z" });
    expect(result).toMatchObject({ state: "diverged", receipt: null, error_code: "CUSTODY_DESTINATION_DIVERGENCE" });
  });
});

describe("privacy, backup and object reconciliation", () => {
  it("produces an executable deletion plan only when integrity and legal hold permit it", () => {
    const plan = reconcilePrivacyStorage({
      case_id: "case.001",
      request_id: "privacy.001",
      request_kind: "deletion",
      legal_hold: false,
      database_object_refs: [{ object_id: "object.001", sha256: HASH, status: "active" }],
      object_inventory: [{ object_id: "object.001", sha256: HASH }],
      reports: [{ report_id: "report.001", object_id: "object.001", status: "invalidated" }],
      grants: [{ grant_id: "grant.001", object_id: "object.001", expires_at: "2034-01-01T00:00:00.000Z", revoked: false }],
      backup_object_ids: ["object.001"],
      audit_case_ids: ["case.001"],
      rpo_target_seconds: 3_600,
      rto_target_seconds: 7_200,
      reconciled_at: AT,
    });
    expect(plan.status).toBe("ready_for_human_execution");
    expect(plan.stale_grant_ids).toEqual(["grant.001"]);
    expect(plan.deletion_domains.every((entry) => entry.executable)).toBe(true);
    expect(plan.rpo_rto_configuration.proven).toBe(false);
    expect(plan.mutation_applied).toBe(false);
  });

  it("distinguishes legal-hold, missing, corrupt, orphan and audit-continuity blockers", () => {
    const plan = reconcilePrivacyStorage({
      case_id: "case.001",
      request_id: "privacy.001",
      request_kind: "deletion",
      legal_hold: true,
      database_object_refs: [
        { object_id: "object.missing", sha256: HASH, status: "active" },
        { object_id: "object.corrupt", sha256: HASH, status: "active" },
      ],
      object_inventory: [
        { object_id: "object.corrupt", sha256: "0".repeat(64) },
        { object_id: "object.orphan", sha256: HASH },
      ],
      reports: [{ report_id: "report.orphan", object_id: "object.deleted", status: "available" }],
      grants: [{ grant_id: "grant.stale", object_id: "object.deleted", expires_at: LATER, revoked: false }],
      backup_object_ids: ["object.deleted"],
      audit_case_ids: [],
      rpo_target_seconds: 3_600,
      rto_target_seconds: 7_200,
      reconciled_at: AT,
    });
    expect(plan.status).toBe("restricted_by_legal_hold");
    expect(plan.blocker_codes).toEqual([
      "PRIVACY_AUDIT_CONTINUITY_MISSING",
      "PRIVACY_LEGAL_HOLD_CONFLICT",
      "PRIVACY_OBJECTS_CORRUPT",
      "PRIVACY_OBJECTS_MISSING",
    ]);
    expect(plan).toMatchObject({
      stale_grant_ids: ["grant.stale"],
      orphan_object_ids: ["object.orphan"],
      missing_object_ids: ["object.missing"],
      corrupt_object_ids: ["object.corrupt"],
      orphan_report_ids: ["report.orphan"],
      backup_residual_object_ids: ["object.deleted"],
    });
    expect(plan.deletion_domains.every((entry) => !entry.executable)).toBe(true);
  });
});
