import { canonicalSha256, deepFreeze } from "../rule-runtime/canonical.ts";
import { lintRuleSpecForActivation, ruleSpecAuthoringSkeletonSchema, type RuleSpecAuthoringSkeleton } from "./rulespec-authoring.ts";

export const RULESPEC_AUTHORING_QUEUE_SCHEMA = "tivdoc-rulespec-authoring-queue-v0.10.0" as const;

export type RuleSpecAuthoringQueueEvent = Readonly<{
  schema_version: typeof RULESPEC_AUTHORING_QUEUE_SCHEMA;
  sequence: number;
  event_id: string;
  event_kind: "blank_template_queued" | "dependencies_invalidated";
  skeleton_id: string;
  skeleton_version: string;
  skeleton_sha256: string;
  state: "blank_non_operative" | "invalidated_non_operative";
  reason_code: string;
  dependency_sha256: string | null;
  activation_allowed: false;
  prior_event_sha256: string | null;
  event_sha256: string;
}>;

type QueueRecord = Readonly<{
  skeleton: RuleSpecAuthoringSkeleton;
  revision: number;
  state: RuleSpecAuthoringQueueEvent["state"];
  audit_head_sha256: string;
}>;

function validateSkeleton(candidate: unknown) {
  const skeleton = ruleSpecAuthoringSkeletonSchema.parse(candidate);
  const { content_sha256: expected, ...content } = skeleton;
  if (canonicalSha256(content) !== expected) throw new Error("RULESPEC_AUTHORING_CONTENT_HASH_MISMATCH");
  const lint = lintRuleSpecForActivation(skeleton);
  if (lint.activation_allowed || lint.execution_allowed) throw new Error("RULESPEC_BLANK_AUTHORING_QUEUE_MUST_BE_NON_OPERATIVE");
  return deepFreeze({ skeleton, lint });
}

export class RuleSpecAuthoringQueue {
  readonly #records = new Map<string, QueueRecord>();
  readonly #events: RuleSpecAuthoringQueueEvent[] = [];
  readonly #idempotency = new Map<string, Readonly<{ command_sha256: string; receipt: ReturnType<RuleSpecAuthoringQueue["status"]> }>>();

  enqueueBlank(input: Readonly<{ skeleton: unknown; idempotency_key: string; reason_code: string }>) {
    const { skeleton } = validateSkeleton(input.skeleton);
    const commandSha = canonicalSha256({ action: "enqueue_blank", skeleton_sha256: skeleton.content_sha256, reason_code: input.reason_code });
    const replay = this.#replay(input.idempotency_key, commandSha);
    if (replay) return deepFreeze({ ...replay, idempotent_replay: true });
    const existing = this.#records.get(skeleton.skeleton_id);
    if (existing && existing.skeleton.content_sha256 !== skeleton.content_sha256) throw new Error("RULESPEC_AUTHORING_APPEND_ONLY_VERSION_REQUIRED");
    if (!existing) {
      const event = this.#append("blank_template_queued", skeleton, "blank_non_operative", input.reason_code, null);
      this.#records.set(skeleton.skeleton_id, deepFreeze({ skeleton, revision: 1, state: "blank_non_operative", audit_head_sha256: event.event_sha256 }));
    }
    const receipt = this.status(skeleton.skeleton_id);
    this.#idempotency.set(input.idempotency_key, { command_sha256: commandSha, receipt });
    return deepFreeze({ ...receipt, idempotent_replay: existing !== undefined });
  }

  invalidateDependencies(input: Readonly<{ skeleton_id: string; expected_skeleton_sha256: string; dependency_sha256: string; idempotency_key: string; reason_code: string }>) {
    const record = this.#record(input.skeleton_id);
    if (record.skeleton.content_sha256 !== input.expected_skeleton_sha256) throw new Error("RULESPEC_AUTHORING_STALE_CONTENT_HASH");
    if (!/^[a-f0-9]{64}$/.test(input.dependency_sha256)) throw new Error("RULESPEC_AUTHORING_DEPENDENCY_HASH_INVALID");
    const commandSha = canonicalSha256({ action: "invalidate_dependencies", ...input });
    const replay = this.#replay(input.idempotency_key, commandSha);
    if (replay) return deepFreeze({ ...replay, idempotent_replay: true });
    const event = this.#append("dependencies_invalidated", record.skeleton, "invalidated_non_operative", input.reason_code, input.dependency_sha256);
    this.#records.set(input.skeleton_id, deepFreeze({ ...record, revision: record.revision + 1, state: "invalidated_non_operative", audit_head_sha256: event.event_sha256 }));
    const receipt = this.status(input.skeleton_id);
    this.#idempotency.set(input.idempotency_key, { command_sha256: commandSha, receipt });
    return deepFreeze({ ...receipt, idempotent_replay: false });
  }

  status(skeletonId: string) {
    const record = this.#record(skeletonId);
    return deepFreeze({ skeleton_id: skeletonId, skeleton_version: record.skeleton.skeleton_version, skeleton_sha256: record.skeleton.content_sha256, revision: record.revision, state: record.state, activation_allowed: false as const, execution_allowed: false as const, audit_head_sha256: record.audit_head_sha256 });
  }

  events() { return deepFreeze(this.#events.map((event) => ({ ...event }))); }

  verifyAuditChain() {
    let prior: string | null = null;
    for (const event of this.#events) {
      const { event_sha256: expected, ...body } = event;
      if (body.prior_event_sha256 !== prior || canonicalSha256(body) !== expected) return deepFreeze({ valid: false, event_count: this.#events.length, tail_sha256: prior });
      prior = event.event_sha256;
    }
    return deepFreeze({ valid: true, event_count: this.#events.length, tail_sha256: prior });
  }

  #record(id: string) {
    const record = this.#records.get(id);
    if (!record) throw new Error("RULESPEC_AUTHORING_TEMPLATE_NOT_FOUND");
    return record;
  }

  #replay(idempotencyKey: string, commandSha: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{7,159}$/.test(idempotencyKey)) throw new Error("RULESPEC_AUTHORING_IDEMPOTENCY_KEY_INVALID");
    const existing = this.#idempotency.get(idempotencyKey);
    if (!existing) return null;
    if (existing.command_sha256 !== commandSha) throw new Error("RULESPEC_AUTHORING_IDEMPOTENCY_CONFLICT");
    return existing.receipt;
  }

  #append(kind: RuleSpecAuthoringQueueEvent["event_kind"], skeleton: RuleSpecAuthoringSkeleton, state: RuleSpecAuthoringQueueEvent["state"], reason: string, dependencySha256: string | null) {
    if (!/^[A-Z][A-Z0-9_]{2,99}$/.test(reason)) throw new Error("RULESPEC_AUTHORING_REASON_CODE_INVALID");
    const prior = this.#events.at(-1)?.event_sha256 ?? null;
    const body = {
      schema_version: RULESPEC_AUTHORING_QUEUE_SCHEMA,
      sequence: this.#events.length + 1,
      event_id: `rulespec.authoring.event.${String(this.#events.length + 1).padStart(8, "0")}`,
      event_kind: kind,
      skeleton_id: skeleton.skeleton_id,
      skeleton_version: skeleton.skeleton_version,
      skeleton_sha256: skeleton.content_sha256,
      state,
      reason_code: reason,
      dependency_sha256: dependencySha256,
      activation_allowed: false as const,
      prior_event_sha256: prior,
    } as const;
    const event = deepFreeze({ ...body, event_sha256: canonicalSha256(body) }) as RuleSpecAuthoringQueueEvent;
    this.#events.push(event);
    return event;
  }
}
