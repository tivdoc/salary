import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { canonicalSha256, canonicalStringify, deepFreeze } from "../../../engine/rule-runtime/canonical.ts";
import { WAVE3_TOPICS } from "../../../engine/wave3/contracts.ts";
import {
  shadowThresholdPolicySchema,
  type ShadowComparison,
  type ShadowFieldDelta,
  type ShadowThresholdPolicy,
  type SignedShadowDisagreementDecision,
} from "../../../engine/shadow/contracts.ts";
import { ShadowReviewerTrustStore } from "../../../engine/shadow/signatures.ts";

export type ShadowDisagreementRecord = Readonly<{
  schema_version: "tivdoc-shadow-disagreement-record-v0.10.0";
  disagreement_id: string;
  revision: number;
  status: "pending_human_review" | "resolved" | "rejected";
  comparison: ShadowComparison;
  threshold_policy: ShadowThresholdPolicy;
  signed_decision: SignedShadowDisagreementDecision | null;
  created_at: string;
  updated_at: string;
  previous_record_sha256: string | null;
  automatic_customer_promotion: false;
  automatic_production_promotion: false;
  record_sha256: string;
}>;

const ID = /^[a-z][a-z0-9:._-]{2,159}$/u;
const SHA = /^[a-f0-9]{64}$/u;

function ensureChild(rootValue: string, candidateValue: string) {
  const root = path.resolve(rootValue);
  const candidate = path.resolve(candidateValue);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("SHADOW_DISAGREEMENT_PATH_ESCAPE");
  return candidate;
}

function validateComparison(input: ShadowComparison) {
  const topLevelKeys = ["automatic_customer_promotion", "automatic_production_promotion", "baseline_approval_receipt_sha256", "baseline_snapshot_sha256", "candidate_snapshot_sha256", "comparison_id", "comparison_sha256", "human_review_required", "non_degradation", "schema_version", "threshold_policy_sha256", "topic_deltas", "totals"];
  if (!input || typeof input !== "object" || Object.keys(input).sort().join("|") !== topLevelKeys.join("|")
    || input.schema_version !== "tivdoc-shadow-comparison-v0.10.0"
    || !ID.test(input.comparison_id) || !SHA.test(input.comparison_sha256)
    || !SHA.test(input.baseline_snapshot_sha256) || !SHA.test(input.baseline_approval_receipt_sha256)
    || !SHA.test(input.candidate_snapshot_sha256) || !SHA.test(input.threshold_policy_sha256)
    || !["passed", "failed", "manual_review"].includes(input.non_degradation)
    || input.human_review_required !== true
    || input.automatic_customer_promotion !== false
    || input.automatic_production_promotion !== false
    || !Array.isArray(input.topic_deltas) || input.topic_deltas.length !== WAVE3_TOPICS.length
    || !input.totals || typeof input.totals !== "object"
    || Object.keys(input.totals).sort().join("|") !== "blocked_state_changes|changed_fields|regressions|uncertainty_increases") throw new Error("SHADOW_DISAGREEMENT_COMPARISON_INVALID");
  const topics = new Set<string>();
  let regressions = 0;
  let uncertaintyIncreases = 0;
  let changedFields = 0;
  let blockedStateChanges = 0;
  for (const topic of input.topic_deltas) {
    const topicKeys = ["changed_field_count", "field_deltas", "regression_count", "requires_human_review", "topic", "topic_sha256", "uncertainty_increase_count"];
    if (!topic || typeof topic !== "object" || Object.keys(topic).sort().join("|") !== topicKeys.join("|")
      || !WAVE3_TOPICS.includes(topic.topic) || topics.has(topic.topic)
      || !Array.isArray(topic.field_deltas) || topic.field_deltas.length > 128
      || !Number.isSafeInteger(topic.regression_count) || topic.regression_count < 0
      || !Number.isSafeInteger(topic.uncertainty_increase_count) || topic.uncertainty_increase_count < 0
      || !Number.isSafeInteger(topic.changed_field_count) || topic.changed_field_count < 0
      || typeof topic.requires_human_review !== "boolean" || !SHA.test(topic.topic_sha256)) throw new Error("SHADOW_DISAGREEMENT_TOPIC_INVALID");
    topics.add(topic.topic);
    for (const field of topic.field_deltas) {
      const fieldKeys = ["baseline_fingerprint", "baseline_state", "baseline_uncertainty", "blocked_state_change", "candidate_fingerprint", "candidate_state", "candidate_uncertainty", "delta_sha256", "field_id", "regression", "taxonomy", "topic", "uncertainty_change"];
      if (!field || typeof field !== "object" || Object.keys(field).sort().join("|") !== fieldKeys.join("|")
        || field.topic !== topic.topic || !ID.test(field.field_id)
        || (field.baseline_fingerprint !== null && !SHA.test(field.baseline_fingerprint))
        || (field.candidate_fingerprint !== null && !SHA.test(field.candidate_fingerprint))
        || !["complete", "blocked", "uncertain", "error", "missing"].includes(field.baseline_state)
        || !["complete", "blocked", "uncertain", "error", "missing"].includes(field.candidate_state)
        || !["none", "low", "high", "unknown", "missing"].includes(field.baseline_uncertainty)
        || !["none", "low", "high", "unknown", "missing"].includes(field.candidate_uncertainty)
        || typeof field.regression !== "boolean"
        || !["stable", "increased", "decreased"].includes(field.uncertainty_change)
        || !["stable", "added", "removed"].includes(field.blocked_state_change)
        || !["stable", "changed", "regression", "improvement", "uncertainty_increased", "uncertainty_decreased", "blocked_added", "blocked_removed"].includes(field.taxonomy)
        || !SHA.test(field.delta_sha256)) throw new Error("SHADOW_DISAGREEMENT_FIELD_INVALID");
      const { delta_sha256: deltaSha, ...deltaContent } = field;
      if (canonicalSha256(deltaContent) !== deltaSha) throw new Error("SHADOW_DISAGREEMENT_FIELD_HASH_MISMATCH");
    }
    const { topic_sha256: topicSha, ...topicContent } = topic;
    if (canonicalSha256(topicContent) !== topicSha
      || topic.regression_count !== topic.field_deltas.filter((field: ShadowFieldDelta) => field.regression).length
      || topic.uncertainty_increase_count !== topic.field_deltas.filter((field: ShadowFieldDelta) => field.uncertainty_change === "increased").length
      || topic.changed_field_count !== topic.field_deltas.filter((field: ShadowFieldDelta) => field.taxonomy !== "stable").length
      || topic.requires_human_review !== (topic.changed_field_count > 0)) throw new Error("SHADOW_DISAGREEMENT_TOPIC_HASH_OR_TOTAL_INVALID");
    regressions += topic.regression_count;
    uncertaintyIncreases += topic.uncertainty_increase_count;
    changedFields += topic.changed_field_count;
    blockedStateChanges += topic.field_deltas.filter((field: ShadowFieldDelta) => field.blocked_state_change !== "stable").length;
  }
  if (topics.size !== WAVE3_TOPICS.length
    || input.totals.regressions !== regressions || input.totals.uncertainty_increases !== uncertaintyIncreases
    || input.totals.changed_fields !== changedFields || input.totals.blocked_state_changes !== blockedStateChanges) throw new Error("SHADOW_DISAGREEMENT_TOTALS_INVALID");
  const { comparison_sha256: expected, ...content } = input;
  if (canonicalSha256(content) !== expected) throw new Error("SHADOW_DISAGREEMENT_COMPARISON_HASH_MISMATCH");
  return input;
}

function sealRecord(input: Omit<ShadowDisagreementRecord, "record_sha256">): ShadowDisagreementRecord {
  return deepFreeze({ ...input, record_sha256: canonicalSha256(input) }) as ShadowDisagreementRecord;
}

function validateRecord(input: unknown): ShadowDisagreementRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("SHADOW_DISAGREEMENT_RECORD_INVALID");
  const record = input as ShadowDisagreementRecord;
  const expectedKeys = ["automatic_customer_promotion", "automatic_production_promotion", "comparison", "created_at", "disagreement_id", "previous_record_sha256", "record_sha256", "revision", "schema_version", "signed_decision", "status", "threshold_policy", "updated_at"];
  if (Object.keys(record).sort().join("|") !== expectedKeys.join("|")
    || record.schema_version !== "tivdoc-shadow-disagreement-record-v0.10.0"
    || !ID.test(record.disagreement_id) || !Number.isSafeInteger(record.revision) || record.revision < 1
    || !["pending_human_review", "resolved", "rejected"].includes(record.status)
    || !SHA.test(record.record_sha256)
    || (record.previous_record_sha256 !== null && !SHA.test(record.previous_record_sha256))
    || record.automatic_customer_promotion !== false || record.automatic_production_promotion !== false) throw new Error("SHADOW_DISAGREEMENT_RECORD_INVALID");
  validateComparison(record.comparison);
  shadowThresholdPolicySchema.parse(record.threshold_policy);
  const { record_sha256: expected, ...content } = record;
  if (canonicalSha256(content) !== expected) throw new Error("SHADOW_DISAGREEMENT_RECORD_HASH_MISMATCH");
  if ((record.status === "pending_human_review") !== (record.signed_decision === null)) throw new Error("SHADOW_DISAGREEMENT_DECISION_STATE_INVALID");
  return deepFreeze(record) as ShadowDisagreementRecord;
}

export class LocalFileShadowDisagreementQueue {
  readonly #root: string;
  readonly #trust: ShadowReviewerTrustStore;
  readonly #now: () => string;

  constructor(input: Readonly<{
    root: string;
    root_kind: "generated_offline_synthetic_disagreements";
    trust_store: ShadowReviewerTrustStore;
    now?: () => string;
  }>) {
    if (input.root_kind !== "generated_offline_synthetic_disagreements" || !path.isAbsolute(input.root)) throw new Error("SHADOW_DISAGREEMENT_ROOT_NOT_OWNED");
    this.#root = path.resolve(input.root);
    this.#trust = input.trust_store;
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  async enqueue(input: Readonly<{ disagreement_id: string; comparison: ShadowComparison; threshold_policy: ShadowThresholdPolicy }>) {
    if (!ID.test(input.disagreement_id)) throw new Error("SHADOW_DISAGREEMENT_ID_INVALID");
    const comparison = validateComparison(input.comparison);
    const thresholds = shadowThresholdPolicySchema.parse(input.threshold_policy);
    if (comparison.threshold_policy_sha256 !== thresholds.policy_sha256) throw new Error("SHADOW_DISAGREEMENT_THRESHOLD_BINDING_MISMATCH");
    const existing = await this.#history(input.disagreement_id);
    if (existing.length > 0) {
      const first = existing[0];
      if (first.comparison.comparison_sha256 !== comparison.comparison_sha256 || first.threshold_policy.policy_sha256 !== thresholds.policy_sha256) {
        throw new Error("SHADOW_DISAGREEMENT_ID_CONFLICT");
      }
      return existing.at(-1)!;
    }
    const now = this.#now();
    const record = sealRecord({
      schema_version: "tivdoc-shadow-disagreement-record-v0.10.0",
      disagreement_id: input.disagreement_id,
      revision: 1,
      status: "pending_human_review",
      comparison,
      threshold_policy: thresholds,
      signed_decision: null,
      created_at: now,
      updated_at: now,
      previous_record_sha256: null,
      automatic_customer_promotion: false,
      automatic_production_promotion: false,
    });
    await this.#append(record);
    return record;
  }

  async decide(input: unknown) {
    const decision = this.#trust.verifyDecision(input);
    const history = await this.#history(decision.disagreement_id);
    const current = history.at(-1);
    if (!current) throw new Error("SHADOW_DISAGREEMENT_NOT_FOUND");
    if (current.status !== "pending_human_review") {
      if (current.signed_decision?.payload_sha256 === decision.payload_sha256 && current.signed_decision.signature_base64 === decision.signature_base64) return current;
      throw new Error("SHADOW_DISAGREEMENT_ALREADY_DECIDED");
    }
    if (decision.disagreement_revision !== current.revision + 1
      || decision.comparison_sha256 !== current.comparison.comparison_sha256
      || decision.threshold_policy_sha256 !== current.threshold_policy.policy_sha256) throw new Error("SHADOW_DISAGREEMENT_DECISION_BINDING_MISMATCH");
    const record = sealRecord({
      ...this.#withoutHash(current),
      revision: current.revision + 1,
      status: decision.decision,
      signed_decision: decision,
      updated_at: decision.signed_at,
      previous_record_sha256: current.record_sha256,
      automatic_customer_promotion: false,
      automatic_production_promotion: false,
    });
    await this.#append(record);
    return record;
  }

  async get(disagreementId: string) {
    const record = (await this.#history(disagreementId)).at(-1);
    if (!record) throw new Error("SHADOW_DISAGREEMENT_NOT_FOUND");
    return record;
  }

  async pending() {
    await mkdir(this.#root, { recursive: true });
    const names = (await readdir(this.#root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && ID.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, "en"));
    const pending: ShadowDisagreementRecord[] = [];
    for (const name of names) {
      const current = (await this.#history(name)).at(-1);
      if (current?.status === "pending_human_review") pending.push(current);
    }
    return Object.freeze(pending);
  }

  async #history(disagreementId: string) {
    if (!ID.test(disagreementId)) throw new Error("SHADOW_DISAGREEMENT_ID_INVALID");
    const directory = ensureChild(this.#root, path.join(this.#root, disagreementId));
    try {
      const directoryInfo = await lstat(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("SHADOW_DISAGREEMENT_DIRECTORY_INVALID");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const names = (await readdir(directory)).filter((name) => /^\d{8}\.json$/u.test(name)).sort();
    const history: ShadowDisagreementRecord[] = [];
    for (const name of names) {
      const target = ensureChild(directory, path.join(directory, name));
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("SHADOW_DISAGREEMENT_FILE_INVALID");
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(target, "utf8"));
      } catch {
        throw new Error("SHADOW_DISAGREEMENT_FILE_TRUNCATED");
      }
      const record = validateRecord(parsed);
      if (record.disagreement_id !== disagreementId || record.revision !== Number(name.slice(0, 8))
        || record.revision !== history.length + 1
        || record.previous_record_sha256 !== (history.at(-1)?.record_sha256 ?? null)) throw new Error("SHADOW_DISAGREEMENT_HISTORY_INVALID");
      history.push(record);
    }
    return history;
  }

  async #append(record: ShadowDisagreementRecord) {
    const directory = ensureChild(this.#root, path.join(this.#root, record.disagreement_id));
    await mkdir(directory, { recursive: true });
    const target = ensureChild(directory, path.join(directory, `${String(record.revision).padStart(8, "0")}.json`));
    const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new Error("SHADOW_DISAGREEMENT_REVISION_CONFLICT");
      throw error;
    });
    try {
      await handle.writeFile(`${canonicalStringify(record)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  #withoutHash(record: ShadowDisagreementRecord): Omit<ShadowDisagreementRecord, "record_sha256"> {
    const { record_sha256, ...content } = record;
    void record_sha256;
    return content;
  }
}
