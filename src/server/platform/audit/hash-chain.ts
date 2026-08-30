import { createHash } from "node:crypto";

import type { AuditAnchorPort, AuditEventInput, AuditEventPort } from "../../../engine/wave4/contracts";

const OPAQUE = /^[a-z][a-z0-9_-]{7,63}$/;
const REASON = /^[A-Z][A-Z0-9_]{7,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type StoredAuditEvent = Readonly<AuditEventInput & {
  sequence: number;
  previous_sha256: string | null;
  event_sha256: string;
}>;

function canonicalEvent(event: Omit<StoredAuditEvent, "event_sha256">): string {
  return JSON.stringify({
    action: event.action,
    actor_id: event.actor_id,
    occurred_at: event.occurred_at,
    previous_sha256: event.previous_sha256,
    reason: event.reason,
    resource_id: event.resource_id,
    resource_revision: event.resource_revision,
    resource_sha256: event.resource_sha256,
    sequence: event.sequence,
  });
}

export function verifyAuditSnapshot(events: readonly StoredAuditEvent[]): Readonly<{ valid: boolean; event_count: number; tail_sha256: string | null }> {
  let previous: string | null = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const { event_sha256: ignored, ...core } = event;
    void ignored;
    if (event.sequence !== index + 1 || event.previous_sha256 !== previous || sha256(canonicalEvent(core)) !== event.event_sha256) {
      return Object.freeze({ valid: false, event_count: events.length, tail_sha256: previous });
    }
    previous = event.event_sha256;
  }
  return Object.freeze({ valid: true, event_count: events.length, tail_sha256: previous });
}

export class InMemoryHashChainAudit implements AuditEventPort {
  readonly #events: StoredAuditEvent[] = [];

  async append(input: AuditEventInput): Promise<Readonly<{ sequence: number; previous_sha256: string | null; event_sha256: string }>> {
    if (!OPAQUE.test(input.actor_id) || !OPAQUE.test(input.resource_id) || !REASON.test(input.action) || !REASON.test(input.reason)) throw new Error("AUDIT_FIELD_INVALID");
    if (!Number.isSafeInteger(input.resource_revision) || input.resource_revision < 0 || !SHA256.test(input.resource_sha256)) throw new Error("AUDIT_BINDING_INVALID");
    if (Number.isNaN(Date.parse(input.occurred_at))) throw new Error("AUDIT_TIMESTAMP_INVALID");
    const previousTime = this.#events.at(-1)?.occurred_at;
    if (previousTime && Date.parse(input.occurred_at) < Date.parse(previousTime)) throw new Error("AUDIT_TIMESTAMP_REGRESSION");
    const core = Object.freeze({
      ...input,
      sequence: this.#events.length + 1,
      previous_sha256: this.#events.at(-1)?.event_sha256 ?? null,
    });
    const event = Object.freeze({ ...core, event_sha256: sha256(canonicalEvent(core)) });
    this.#events.push(event);
    return Object.freeze({ sequence: event.sequence, previous_sha256: event.previous_sha256, event_sha256: event.event_sha256 });
  }

  async verify(): Promise<Readonly<{ valid: boolean; event_count: number; tail_sha256: string | null }>> {
    return verifyAuditSnapshot(this.#events);
  }

  events(): readonly StoredAuditEvent[] {
    return this.#events.map((event) => Object.freeze({ ...event }));
  }

  updateForbidden(): never {
    throw new Error("AUDIT_APPEND_ONLY");
  }

  deleteForbidden(): never {
    throw new Error("AUDIT_APPEND_ONLY");
  }

}

export class LocalAuditAnchor implements AuditAnchorPort {
  readonly #receipts: string[] = [];

  async anchor(input: Readonly<{ event_count: number; tail_sha256: string; anchored_at: string }>): Promise<Readonly<{ receipt_sha256: string }>> {
    if (!Number.isSafeInteger(input.event_count) || input.event_count <= 0 || !SHA256.test(input.tail_sha256) || Number.isNaN(Date.parse(input.anchored_at))) {
      throw new Error("AUDIT_ANCHOR_INVALID");
    }
    const receipt = sha256(JSON.stringify({ ...input, custody: "local_receipt_only", sequence: this.#receipts.length + 1 }));
    this.#receipts.push(receipt);
    return Object.freeze({ receipt_sha256: receipt });
  }

  capability(): Readonly<{ local_receipt: true; off_host_worm: false; blocker_code: "OFF_HOST_AUDIT_CUSTODY_PENDING" }> {
    return Object.freeze({ local_receipt: true, off_host_worm: false, blocker_code: "OFF_HOST_AUDIT_CUSTODY_PENDING" });
  }
}
