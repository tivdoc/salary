import { describe, expect, it } from "vitest";

import { InMemoryHashChainAudit, LocalAuditAnchor, verifyAuditSnapshot } from "./hash-chain";

const HASH = "a".repeat(64);

describe("V07-P2-AUDIT", () => {
  it("binds actor/action/resource/revision/hash/reason/time in an append-only chain", async () => {
    const audit = new InMemoryHashChainAudit();
    const first = await audit.append({ actor_id: "actor_00000001", action: "OBJECT_RESERVED", resource_id: "object_0000001", resource_revision: 1, resource_sha256: HASH, reason: "STORAGE_WRITE", occurred_at: "2026-08-30T00:00:00.000Z" });
    const second = await audit.append({ actor_id: "actor_00000002", action: "OBJECT_FINALIZED", resource_id: "object_0000001", resource_revision: 2, resource_sha256: HASH, reason: "STORAGE_WRITE", occurred_at: "2026-08-30T00:00:01.000Z" });
    expect(second.previous_sha256).toBe(first.event_sha256);
    expect(await audit.verify()).toMatchObject({ valid: true, event_count: 2, tail_sha256: second.event_sha256 });
    expect(audit.updateForbidden).toThrow("AUDIT_APPEND_ONLY");
    expect(audit.deleteForbidden).toThrow("AUDIT_APPEND_ONLY");
  });

  it("detects a mutated event", async () => {
    const audit = new InMemoryHashChainAudit();
    await audit.append({ actor_id: "actor_00000001", action: "OBJECT_RESERVED", resource_id: "object_0000001", resource_revision: 1, resource_sha256: HASH, reason: "STORAGE_WRITE", occurred_at: "2026-08-30T00:00:00.000Z" });
    const snapshot = audit.events();
    const altered = [{ ...snapshot[0], reason: "INCIDENT_REWRITE" }];
    expect(verifyAuditSnapshot(altered).valid).toBe(false);
    expect((await audit.verify()).valid).toBe(true);
  });

  it("creates a local hash receipt while retaining off-host custody blocker", async () => {
    const anchor = new LocalAuditAnchor();
    const receipt = await anchor.anchor({ event_count: 2, tail_sha256: HASH, anchored_at: "2026-08-30T00:00:02.000Z" });
    expect(receipt.receipt_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(anchor.capability()).toMatchObject({ local_receipt: true, off_host_worm: false, blocker_code: "OFF_HOST_AUDIT_CUSTODY_PENDING" });
  });
});
