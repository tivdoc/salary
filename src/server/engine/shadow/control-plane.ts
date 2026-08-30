import { canonicalSha256, deepFreeze } from "../../../engine/rule-runtime/canonical.ts";
import type { OfflineShadowFlags } from "./flags.ts";
import { SHADOW_RUN_SCHEMA, type OfflineShadowEvaluationPort, type ShadowAuditEvent, type ShadowExperimentDefinition, type ShadowRun, type ShadowSlotComparison, type ShadowSlotEvaluation, validateShadowDefinition } from "./contracts.ts";

type StoredRun = {
  run_id: string;
  definition_id: string;
  definition_sha256: string;
  revision: number;
  state: ShadowRun["state"];
  attempt: number;
  slots: ShadowSlotComparison[];
  blocker_codes: string[];
  created_at: string;
  updated_at: string;
};

export class OfflineShadowControlPlane {
  readonly #flags: OfflineShadowFlags;
  readonly #evaluator: OfflineShadowEvaluationPort;
  readonly #now: () => string;
  readonly #definitions = new Map<string, ShadowExperimentDefinition>();
  readonly #runs = new Map<string, StoredRun>();
  readonly #commandIdempotency = new Map<string, Readonly<{ command_sha256: string; run_id: string }>>();
  readonly #batchIdempotency = new Map<string, Readonly<{ command_sha256: string; run_ids: readonly string[] }>>();
  readonly #caseIdempotency = new Map<string, ShadowSlotEvaluation>();
  readonly #audit: ShadowAuditEvent[] = [];

  constructor(input: Readonly<{ flags: OfflineShadowFlags; evaluator: OfflineShadowEvaluationPort; now?: () => string }>) {
    this.#flags = input.flags;
    this.#evaluator = input.evaluator;
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  registerDefinition(candidate: unknown): ShadowExperimentDefinition {
    this.#requireEnabled();
    const definition = validateShadowDefinition(candidate);
    for (const bundle of definition.bundles) {
      if (bundle.classification === "deterministic_synthetic" && !this.#flags.synthetic_enabled) throw new Error("SHADOW_SYNTHETIC_FIXTURES_DISABLED");
      if (bundle.classification === "approved_public_non_identifying" && !this.#flags.public_enabled) throw new Error("SHADOW_PUBLIC_FIXTURES_DISABLED");
      if (bundle.customer_material) throw new Error("SHADOW_CUSTOMER_MATERIAL_FORBIDDEN");
    }
    const existing = this.#definitions.get(definition.definition_id);
    if (existing && existing.definition_sha256 !== definition.definition_sha256) throw new Error("SHADOW_DEFINITION_IMMUTABLE");
    if (!existing) {
      this.#definitions.set(definition.definition_id, definition);
      this.#appendAudit("definition_registered", definition.definition_id, 1, definition.definition_sha256);
    }
    return definition;
  }

  schedule(input: Readonly<{ definition_id: string; run_id: string; idempotency_key: string }>): ShadowRun {
    this.#requireEnabled();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{2,159}$/.test(input.run_id)) throw new Error("SHADOW_RUN_ID_INVALID");
    const definition = this.#requiredDefinition(input.definition_id);
    const commandSha = canonicalSha256({ action: "schedule", ...input, definition_sha256: definition.definition_sha256 });
    const replay = this.#commandReplay(input.idempotency_key, commandSha);
    if (replay) return this.getRun(replay);
    if (this.#runs.has(input.run_id)) throw new Error("SHADOW_RUN_ID_ALREADY_EXISTS");
    const now = this.#now();
    const stored: StoredRun = { run_id: input.run_id, definition_id: definition.definition_id, definition_sha256: definition.definition_sha256, revision: 1, state: "queued", attempt: 1, slots: [], blocker_codes: ["SHADOW_PROMOTION_THRESHOLDS_UNSET"], created_at: now, updated_at: now };
    this.#runs.set(input.run_id, stored);
    this.#commandIdempotency.set(input.idempotency_key, { command_sha256: commandSha, run_id: input.run_id });
    const run = this.#project(stored);
    this.#appendAudit("run_scheduled", run.run_id, run.revision, run.run_sha256);
    return run;
  }

  scheduleBatch(input: Readonly<{ batch_id: string; idempotency_key: string; runs: readonly Readonly<{ definition_id: string; run_id: string }>[] }>): readonly ShadowRun[] {
    this.#requireEnabled();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{2,159}$/.test(input.batch_id)) throw new Error("SHADOW_BATCH_ID_INVALID");
    if (input.runs.length < 1 || input.runs.length > 100) throw new Error("SHADOW_BATCH_SIZE_INVALID");
    const normalized = [...input.runs].sort((left, right) => left.run_id.localeCompare(right.run_id, "en"));
    if (new Set(normalized.map((run) => run.run_id)).size !== normalized.length) throw new Error("SHADOW_BATCH_DUPLICATE_RUN_ID");
    const commandSha = canonicalSha256({ action: "schedule_batch", batch_id: input.batch_id, runs: normalized });
    const existing = this.#batchIdempotency.get(input.idempotency_key);
    if (existing) {
      if (existing.command_sha256 !== commandSha) throw new Error("SHADOW_IDEMPOTENCY_CONFLICT");
      return deepFreeze(existing.run_ids.map((runId) => this.getRun(runId))) as readonly ShadowRun[];
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{7,149}$/.test(input.idempotency_key)) throw new Error("SHADOW_IDEMPOTENCY_KEY_INVALID");
    const derivedKeys = normalized.map((_, index) => `batch.${input.idempotency_key}.${String(index + 1).padStart(3, "0")}`);
    for (const [index, run] of normalized.entries()) {
      this.#requiredDefinition(run.definition_id);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{2,159}$/.test(run.run_id)) throw new Error("SHADOW_RUN_ID_INVALID");
      if (this.#runs.has(run.run_id)) throw new Error("SHADOW_RUN_ID_ALREADY_EXISTS");
      if (this.#commandIdempotency.has(derivedKeys[index])) throw new Error("SHADOW_BATCH_COMMAND_KEY_COLLISION");
    }
    const runs = normalized.map((run, index) => this.schedule({ ...run, idempotency_key: derivedKeys[index] }));
    this.#batchIdempotency.set(input.idempotency_key, { command_sha256: commandSha, run_ids: runs.map((run) => run.run_id) });
    return deepFreeze(runs) as readonly ShadowRun[];
  }

  async execute(runId: string): Promise<ShadowRun> {
    this.#requireEnabled();
    const stored = this.#requiredRun(runId);
    if (stored.state !== "queued") throw new Error("SHADOW_RUN_NOT_QUEUED");
    const definition = this.#requiredDefinition(stored.definition_id);
    stored.state = "running";
    stored.revision += 1;
    stored.updated_at = this.#now();
    this.#appendAudit("run_started", runId, stored.revision, this.#project(stored).run_sha256);
    try {
      const slots: ShadowSlotComparison[] = [];
      for (const bundle of [...definition.bundles].sort((a, b) => a.bundle_id.localeCompare(b.bundle_id, "en"))) {
        for (const topic of definition.topics) {
          const baseline = await this.#evaluate(definition, bundle, topic, definition.baseline_engine_version);
          const candidate = await this.#evaluate(definition, bundle, topic, definition.candidate_engine_version);
          assertSlotBoundary(definition, baseline);
          assertSlotBoundary(definition, candidate);
          const comparison = { bundle_id: bundle.bundle_id, topic, baseline, candidate, taxonomy: taxonomy(baseline, candidate) };
          slots.push(deepFreeze({ ...comparison, comparison_sha256: canonicalSha256(comparison) }) as ShadowSlotComparison);
        }
      }
      stored.slots = slots;
      stored.state = "completed";
      stored.revision += 1;
      stored.updated_at = this.#now();
      if (definition.catalog_mode === "real_inactive") stored.blocker_codes.push("LEGAL_SOURCE_CORPUS_INCOMPLETE", "REAL_RULES_INACTIVE");
      stored.blocker_codes = [...new Set(stored.blocker_codes)].sort();
      const result = this.#project(stored);
      this.#appendAudit("run_completed", runId, result.revision, result.run_sha256);
      return result;
    } catch (error) {
      stored.state = "failed";
      stored.revision += 1;
      stored.updated_at = this.#now();
      stored.blocker_codes = [...new Set([...stored.blocker_codes, safeErrorCode(error)])].sort();
      const result = this.#project(stored);
      this.#appendAudit("run_failed", runId, result.revision, result.run_sha256);
      return result;
    }
  }

  cancel(input: Readonly<{ run_id: string; expected_revision: number; idempotency_key: string }>): ShadowRun {
    return this.#transitionCommand("run_cancelled", input, ["queued", "running"], "cancelled");
  }

  resume(input: Readonly<{ run_id: string; expected_revision: number; idempotency_key: string }>): ShadowRun {
    return this.#transitionCommand("run_resumed", input, ["cancelled"], "queued");
  }

  retry(input: Readonly<{ run_id: string; expected_revision: number; idempotency_key: string }>): ShadowRun {
    this.#requireEnabled();
    const run = this.#requiredRun(input.run_id);
    const definition = this.#requiredDefinition(run.definition_id);
    const commandSha = canonicalSha256({ action: "run_retried", ...input });
    const replay = this.#commandReplay(input.idempotency_key, commandSha);
    if (replay) return this.getRun(replay);
    if (run.revision !== input.expected_revision) throw new Error("SHADOW_REVISION_CONFLICT");
    if (run.state !== "failed") throw new Error("SHADOW_STATE_TRANSITION_FORBIDDEN");
    if (run.attempt >= definition.retry_policy.max_attempts) throw new Error("SHADOW_RETRY_LIMIT_EXCEEDED");
    run.attempt += 1;
    run.state = "queued";
    run.revision += 1;
    run.updated_at = this.#now();
    const result = this.#project(run);
    this.#commandIdempotency.set(input.idempotency_key, { command_sha256: commandSha, run_id: input.run_id });
    this.#appendAudit("run_retried", result.run_id, result.revision, result.run_sha256);
    return result;
  }

  replay(runId: string): ShadowRun {
    this.#requireEnabled();
    const run = this.getRun(runId);
    if (run.state !== "completed") throw new Error("SHADOW_REPLAY_REQUIRES_COMPLETED_RUN");
    const reconstructed = this.#project(this.#requiredRun(runId));
    if (reconstructed.run_sha256 !== run.run_sha256) throw new Error("SHADOW_REPLAY_HASH_MISMATCH");
    this.#appendAudit("run_replayed", runId, run.revision, run.run_sha256);
    return reconstructed;
  }

  getRun(runId: string): ShadowRun {
    return this.#project(this.#requiredRun(runId));
  }

  auditEvents(): readonly ShadowAuditEvent[] {
    return deepFreeze(this.#audit.map((event) => ({ ...event }))) as readonly ShadowAuditEvent[];
  }

  #transitionCommand(action: ShadowAuditEvent["action"], input: Readonly<{ run_id: string; expected_revision: number; idempotency_key: string }>, allowed: readonly ShadowRun["state"][], target: ShadowRun["state"]): ShadowRun {
    this.#requireEnabled();
    const stored = this.#requiredRun(input.run_id);
    const commandSha = canonicalSha256({ action, ...input });
    const replay = this.#commandReplay(input.idempotency_key, commandSha);
    if (replay) return this.getRun(replay);
    if (stored.revision !== input.expected_revision) throw new Error("SHADOW_REVISION_CONFLICT");
    if (!allowed.includes(stored.state)) throw new Error("SHADOW_STATE_TRANSITION_FORBIDDEN");
    stored.state = target;
    stored.revision += 1;
    stored.updated_at = this.#now();
    const run = this.#project(stored);
    this.#commandIdempotency.set(input.idempotency_key, { command_sha256: commandSha, run_id: input.run_id });
    this.#appendAudit(action, run.run_id, run.revision, run.run_sha256);
    return run;
  }

  async #evaluate(definition: ShadowExperimentDefinition, bundle: ShadowExperimentDefinition["bundles"][number], topic: ShadowExperimentDefinition["topics"][number], engineVersion: string) {
    const key = `${definition.definition_sha256}:${bundle.bundle_sha256}:${topic}:${engineVersion}`;
    const existing = this.#caseIdempotency.get(key);
    if (existing) return existing;
    const result = deepFreeze(await this.#evaluator.evaluate({ definition, bundle, topic, engine_version: engineVersion, idempotency_key: key }));
    this.#caseIdempotency.set(key, result);
    return result;
  }

  #commandReplay(key: string, commandSha: string): string | null {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{7,159}$/.test(key)) throw new Error("SHADOW_IDEMPOTENCY_KEY_INVALID");
    const replay = this.#commandIdempotency.get(key);
    if (!replay) return null;
    if (replay.command_sha256 !== commandSha) throw new Error("SHADOW_IDEMPOTENCY_CONFLICT");
    return replay.run_id;
  }

  #requiredDefinition(id: string) { const value = this.#definitions.get(id); if (!value) throw new Error("SHADOW_DEFINITION_NOT_FOUND"); return value; }
  #requiredRun(id: string) { const value = this.#runs.get(id); if (!value) throw new Error("SHADOW_RUN_NOT_FOUND"); return value; }
  #requireEnabled() { if (!this.#flags.enabled) throw new Error("SHADOW_OFFLINE_DISABLED"); }

  #project(stored: StoredRun): ShadowRun {
    const slots = [...stored.slots];
    const terminal = ["completed", "failed", "cancelled"].includes(stored.state);
    const completed = stored.state === "completed";
    const metrics = {
      slot_count: slots.length,
      stable: slots.filter((slot) => slot.taxonomy === "stable").length,
      changed: slots.filter((slot) => slot.taxonomy === "changed").length,
      regression: slots.filter((slot) => slot.taxonomy === "regression").length,
      improvement: slots.filter((slot) => slot.taxonomy === "improvement").length,
      blocked: slots.filter((slot) => slot.taxonomy === "blocked").length,
      error: slots.filter((slot) => slot.baseline.status === "error" || slot.candidate.status === "error").length,
      monetary_output_count: 0 as const,
      finding_count: 0 as const,
      customer_report_count: 0 as const,
    };
    const stage_statuses = {
      definition: "pinned" as const,
      scheduling: stored.state === "queued" ? "queued" as const : terminal ? "terminal" as const : "started" as const,
      evaluation: stored.state === "queued" || stored.state === "cancelled" ? "not_started" as const : stored.state === "running" ? "running" as const : completed ? "complete" as const : "failed" as const,
      comparison: completed ? "complete" as const : "not_started" as const,
      reviewer_handoff: completed ? "pending_human_review" as const : "not_available" as const,
    };
    const handoffContent = completed ? { run_id: stored.run_id, definition_sha256: stored.definition_sha256, revision: stored.revision, slots_sha256: canonicalSha256(slots), metrics } : null;
    const reviewer_handoff = { status: stage_statuses.reviewer_handoff, human_review_required: true as const, promotion_allowed: false as const, packet_sha256: handoffContent ? canonicalSha256(handoffContent) : null };
    const payload = { schema_version: SHADOW_RUN_SCHEMA, run_id: stored.run_id, definition_id: stored.definition_id, definition_sha256: stored.definition_sha256, revision: stored.revision, state: stored.state, attempt: stored.attempt, slots, stage_statuses, metrics, reviewer_handoff, blocker_codes: [...stored.blocker_codes].sort(), promotion_thresholds: null, promotion_eligible: false as const, created_at: stored.created_at, updated_at: stored.updated_at };
    return deepFreeze({ ...payload, run_sha256: canonicalSha256(payload) }) as ShadowRun;
  }

  #appendAudit(action: ShadowAuditEvent["action"], resourceId: string, revision: number, resourceSha: string) {
    const prior = this.#audit.at(-1)?.event_sha256 ?? null;
    const payload = { sequence: this.#audit.length + 1, action, resource_id: resourceId, resource_revision: revision, resource_sha256: resourceSha, occurred_at: this.#now(), prior_event_sha256: prior };
    this.#audit.push(deepFreeze({ ...payload, event_sha256: canonicalSha256(payload) }) as ShadowAuditEvent);
  }
}

function taxonomy(baseline: ShadowSlotEvaluation, candidate: ShadowSlotEvaluation): ShadowSlotComparison["taxonomy"] {
  if (baseline.status === "blocked_legal_readiness" && candidate.status === "blocked_legal_readiness") return "blocked";
  if (baseline.status === "blocked_legal_readiness" && candidate.status !== baseline.status) return "improvement";
  if (candidate.status === "blocked_legal_readiness" && baseline.status !== candidate.status) return "regression";
  return baseline.result_sha256 === candidate.result_sha256 ? "stable" : "changed";
}

function assertSlotBoundary(definition: ShadowExperimentDefinition, slot: ShadowSlotEvaluation): void {
  if (slot.amount !== null || slot.finding_count !== 0 || slot.customer_report_count !== 0) throw new Error("SHADOW_PROHIBITED_REAL_OR_MONETARY_OUTPUT");
  if (definition.catalog_mode === "real_inactive" && (slot.status !== "blocked_legal_readiness" || slot.blocker_codes.length === 0)) throw new Error("SHADOW_REAL_INACTIVE_MUST_BLOCK");
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,99}$/.test(error.message)) return error.message;
  return "SHADOW_EVALUATION_FAILED";
}
