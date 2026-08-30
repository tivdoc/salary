import { z } from "zod";
import { canonicalSha256, deepFreeze } from "../../../engine/rule-runtime/canonical.ts";
import { WAVE3_TOPICS, type Wave3Topic } from "../../../engine/wave3/contracts.ts";

export const SHADOW_DEFINITION_SCHEMA = "tivdoc-offline-shadow-definition-v0.7.0" as const;
export const SHADOW_RUN_SCHEMA = "tivdoc-offline-shadow-run-v0.7.0" as const;

export const shadowClassificationSchema = z.enum(["deterministic_synthetic", "approved_public_non_identifying", "sealed_non_customer_engineering"]);
export type ShadowClassification = z.infer<typeof shadowClassificationSchema>;

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{2,159}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);

export const shadowBundleSchema = z.object({
  bundle_id: id,
  bundle_version: z.string().regex(/^[0-9]+(?:\.[0-9]+){1,2}$/),
  bundle_sha256: sha,
  classification: shadowClassificationSchema,
  provenance_sha256: sha,
  sealed: z.literal(true),
  customer_material: z.literal(false),
  public_approval_sha256: sha.nullable(),
}).strict().superRefine((value, context) => {
  if (value.classification === "approved_public_non_identifying" && value.public_approval_sha256 === null) context.addIssue({ code: "custom", message: "shadow_public_bundle_requires_approval", path: ["public_approval_sha256"] });
}).readonly();

function refineShadowDefinition(value: { readonly topics: readonly Wave3Topic[]; readonly baseline_engine_version: string; readonly candidate_engine_version: string }, context: z.RefinementCtx): void {
  if (new Set(value.topics).size !== 7 || WAVE3_TOPICS.some((topic) => !value.topics.includes(topic))) context.addIssue({ code: "custom", message: "shadow_requires_exact_seven_topic_slots", path: ["topics"] });
  if (value.baseline_engine_version === value.candidate_engine_version) context.addIssue({ code: "custom", message: "shadow_versions_must_be_distinct" });
}

const shadowDefinitionContentBaseSchema = z.object({
  schema_version: z.literal(SHADOW_DEFINITION_SCHEMA),
  definition_id: id,
  definition_version: z.string().regex(/^[0-9]+(?:\.[0-9]+){1,2}$/),
  execution_mode: z.literal("offline"),
  catalog_mode: z.enum(["synthetic_test", "real_inactive"]),
  baseline_engine_version: id,
  candidate_engine_version: id,
  bundles: z.array(shadowBundleSchema).min(1).max(500).readonly(),
  topics: z.array(z.enum(WAVE3_TOPICS)).length(7).readonly(),
  retry_policy: z.object({ max_attempts: z.number().int().min(1).max(3) }).strict(),
  promotion_thresholds: z.null(),
  network_allowed: z.literal(false),
  external_persistence_allowed: z.literal(false),
  delivery_allowed: z.literal(false),
}).strict();

const shadowDefinitionContentSchema = shadowDefinitionContentBaseSchema.superRefine(refineShadowDefinition).readonly();

export const shadowDefinitionSchema = shadowDefinitionContentBaseSchema.extend({ definition_sha256: sha }).strict().superRefine(refineShadowDefinition).readonly();
export type ShadowExperimentDefinition = z.infer<typeof shadowDefinitionSchema>;
export type ShadowBundle = z.infer<typeof shadowBundleSchema>;

export type ShadowSlotEvaluation = Readonly<{
  topic: Wave3Topic;
  status: "synthetic_mechanics_complete" | "blocked_legal_readiness" | "error";
  amount: null;
  finding_count: 0;
  customer_report_count: 0;
  blocker_codes: readonly string[];
  result_sha256: string;
}>;

export interface OfflineShadowEvaluationPort {
  evaluate(input: Readonly<{
    definition: ShadowExperimentDefinition;
    bundle: ShadowBundle;
    topic: Wave3Topic;
    engine_version: string;
    idempotency_key: string;
  }>): Promise<ShadowSlotEvaluation>;
}

export type ShadowSlotComparison = Readonly<{
  bundle_id: string;
  topic: Wave3Topic;
  baseline: ShadowSlotEvaluation;
  candidate: ShadowSlotEvaluation;
  taxonomy: "stable" | "changed" | "regression" | "improvement" | "blocked";
  comparison_sha256: string;
}>;

export type ShadowRun = Readonly<{
  schema_version: typeof SHADOW_RUN_SCHEMA;
  run_id: string;
  definition_id: string;
  definition_sha256: string;
  revision: number;
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  attempt: number;
  slots: readonly ShadowSlotComparison[];
  stage_statuses: Readonly<{
    definition: "pinned";
    scheduling: "queued" | "started" | "terminal";
    evaluation: "not_started" | "running" | "complete" | "failed";
    comparison: "not_started" | "complete";
    reviewer_handoff: "not_available" | "pending_human_review";
  }>;
  metrics: Readonly<{
    slot_count: number;
    stable: number;
    changed: number;
    regression: number;
    improvement: number;
    blocked: number;
    error: number;
    monetary_output_count: 0;
    finding_count: 0;
    customer_report_count: 0;
  }>;
  reviewer_handoff: Readonly<{
    status: "not_available" | "pending_human_review";
    human_review_required: true;
    promotion_allowed: false;
    packet_sha256: string | null;
  }>;
  blocker_codes: readonly string[];
  promotion_thresholds: null;
  promotion_eligible: false;
  created_at: string;
  updated_at: string;
  run_sha256: string;
}>;

export type ShadowAuditEvent = Readonly<{
  sequence: number;
  action: "definition_registered" | "run_scheduled" | "run_started" | "run_completed" | "run_failed" | "run_cancelled" | "run_resumed" | "run_retried" | "run_replayed";
  resource_id: string;
  resource_revision: number;
  resource_sha256: string;
  occurred_at: string;
  prior_event_sha256: string | null;
  event_sha256: string;
}>;

export function createShadowDefinition(input: z.input<typeof shadowDefinitionContentSchema>): ShadowExperimentDefinition {
  const parsed = shadowDefinitionContentSchema.parse(input);
  const content = shadowDefinitionContentSchema.parse({ ...parsed, bundles: [...parsed.bundles].sort((a, b) => a.bundle_id.localeCompare(b.bundle_id, "en")), topics: [...WAVE3_TOPICS] });
  return deepFreeze(shadowDefinitionSchema.parse({ ...content, definition_sha256: canonicalSha256(content) })) as ShadowExperimentDefinition;
}

export function validateShadowDefinition(input: unknown): ShadowExperimentDefinition {
  const definition = shadowDefinitionSchema.parse(input);
  const { definition_sha256: expected, ...content } = definition;
  if (canonicalSha256(content) !== expected) throw new Error("SHADOW_DEFINITION_HASH_MISMATCH");
  return deepFreeze(definition) as ShadowExperimentDefinition;
}
