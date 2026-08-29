import { z } from "zod";
import { sha256Schema } from "./contracts.ts";
import { reviewAttestationRefSchema } from "../wave1/contracts.ts";
import { wave1UtcTimestampSchema } from "./wave1-temporal-governance.ts";

const stableIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/);

export const wave1ReviewBindingSchema = z.object({
  artifact_sha256: sha256Schema,
  parsed_sha256: sha256Schema,
  parser_version: z.string().min(1).max(160),
  source_set_version: z.string().min(1).max(160),
  interval_claim_id: stableIdSchema,
  interval_claim_sha256: sha256Schema,
  scope_claim_id: stableIdSchema,
  scope_claim_sha256: sha256Schema,
}).strict().readonly();

export const wave1ReviewAttestationSchema = z.object({
  ref: reviewAttestationRefSchema,
  parser_version: z.string().min(1).max(160),
  interval_claim_sha256: sha256Schema,
  scope_claim_sha256: sha256Schema,
}).strict().superRefine((record, context) => {
  if (record.ref.status !== "valid") {
    context.addIssue({ code: "custom", message: "issued_attestation_must_start_valid" });
  }
  if (!wave1UtcTimestampSchema.safeParse(record.ref.reviewed_at).success) {
    context.addIssue({ code: "custom", message: "review_time_must_be_canonical_utc" });
  }
}).readonly();

const issuedEventSchema = z.object({
  event_kind: z.literal("issued"),
  event_id: stableIdSchema,
  sequence: z.number().int().positive(),
  recorded_at: wave1UtcTimestampSchema,
  attestation: wave1ReviewAttestationSchema,
}).strict().readonly();

export const wave1InvalidationReasonSchema = z.enum([
  "artifact_bytes_changed",
  "parsed_output_changed",
  "parser_version_changed",
  "source_set_changed",
  "interval_claim_changed",
  "scope_claim_changed",
]);

const invalidatedEventSchema = z.object({
  event_kind: z.literal("invalidated"),
  event_id: stableIdSchema,
  sequence: z.number().int().positive(),
  recorded_at: wave1UtcTimestampSchema,
  attestation_id: stableIdSchema,
  reasons: z.array(wave1InvalidationReasonSchema).min(1).readonly(),
}).strict().readonly();

export const wave1ReviewEventSchema = z.discriminatedUnion("event_kind", [issuedEventSchema, invalidatedEventSchema]);
export type Wave1ReviewBinding = z.infer<typeof wave1ReviewBindingSchema>;
export type Wave1ReviewAttestation = z.infer<typeof wave1ReviewAttestationSchema>;
export type Wave1ReviewEvent = z.infer<typeof wave1ReviewEventSchema>;
export type Wave1InvalidationReason = z.infer<typeof wave1InvalidationReasonSchema>;

export function detectWave1AttestationInvalidations(
  attestation: Wave1ReviewAttestation,
  current: Wave1ReviewBinding,
): readonly Wave1InvalidationReason[] {
  const reviewed = wave1ReviewAttestationSchema.parse(attestation);
  const actual = wave1ReviewBindingSchema.parse(current);
  const reasons: Wave1InvalidationReason[] = [];
  if (reviewed.ref.artifact_sha256 !== actual.artifact_sha256) reasons.push("artifact_bytes_changed");
  if (reviewed.ref.parsed_sha256 !== actual.parsed_sha256) reasons.push("parsed_output_changed");
  if (reviewed.parser_version !== actual.parser_version) reasons.push("parser_version_changed");
  if (reviewed.ref.source_set_version !== actual.source_set_version) reasons.push("source_set_changed");
  if (reviewed.ref.interval_claim_id !== actual.interval_claim_id || reviewed.interval_claim_sha256 !== actual.interval_claim_sha256) {
    reasons.push("interval_claim_changed");
  }
  if (reviewed.ref.scope_claim_id !== actual.scope_claim_id || reviewed.scope_claim_sha256 !== actual.scope_claim_sha256) {
    reasons.push("scope_claim_changed");
  }
  return Object.freeze(reasons);
}

/** Returns a new log and never rewrites a prior attestation event. */
export function appendWave1ReviewEvent(
  currentLog: readonly Wave1ReviewEvent[],
  nextEvent: Wave1ReviewEvent,
): readonly Wave1ReviewEvent[] {
  const parsedLog = currentLog.map((event) => wave1ReviewEventSchema.parse(event));
  const parsedNext = wave1ReviewEventSchema.parse(nextEvent);
  if (parsedNext.sequence !== parsedLog.length + 1) throw new Error("review_event_sequence_must_be_append_only");
  const previous = parsedLog.at(-1);
  if (previous && parsedNext.recorded_at < previous.recorded_at) throw new Error("review_event_time_must_be_monotonic");
  if (parsedLog.some((event) => event.event_id === parsedNext.event_id)) throw new Error("review_event_id_reused");
  if (parsedNext.event_kind === "issued") {
    if (parsedLog.some((event) => event.event_kind === "issued" && event.attestation.ref.attestation_id === parsedNext.attestation.ref.attestation_id)) {
      throw new Error("attestation_id_reused");
    }
  } else {
    const issued = parsedLog.find((event) => event.event_kind === "issued" && event.attestation.ref.attestation_id === parsedNext.attestation_id);
    if (!issued) throw new Error("invalidation_requires_prior_attestation");
    if (parsedLog.some((event) => event.event_kind === "invalidated" && event.attestation_id === parsedNext.attestation_id)) {
      throw new Error("attestation_already_invalidated");
    }
  }
  return Object.freeze([...parsedLog, parsedNext]);
}

export function evaluateWave1Attestation(input: Readonly<{
  log: readonly Wave1ReviewEvent[];
  attestation_id: string;
  as_of: string;
  current_binding: Wave1ReviewBinding;
}>) {
  const asOf = wave1UtcTimestampSchema.parse(input.as_of);
  const log = input.log.map((event) => wave1ReviewEventSchema.parse(event));
  const issued = log.find((event) => (
    event.event_kind === "issued"
    && event.attestation.ref.attestation_id === input.attestation_id
    && event.recorded_at <= asOf
  ));
  if (!issued || issued.event_kind !== "issued") {
    return Object.freeze({ status: "missing" as const, reasons: Object.freeze(["review_attestation_missing"]), attestation: null });
  }
  const invalidation = log.find((event) => (
    event.event_kind === "invalidated"
    && event.attestation_id === input.attestation_id
    && event.recorded_at <= asOf
  ));
  const bindingReasons = detectWave1AttestationInvalidations(issued.attestation, input.current_binding);
  const reasons = invalidation?.event_kind === "invalidated"
    ? [...new Set([...invalidation.reasons, ...bindingReasons])].sort()
    : [...bindingReasons].sort();
  return Object.freeze({
    status: reasons.length === 0 ? "valid" as const : "invalidated" as const,
    reasons: Object.freeze(reasons),
    attestation: issued.attestation,
  });
}

export const wave1ActivationApprovalSchema = z.object({
  approval_id: stableIdSchema,
  attestation_id: stableIdSchema,
  approval_kind: z.enum(["legal_content_approval", "activation_control_approval"]),
  approver_id: z.string().min(1).max(160),
  approver_role: z.string().min(1).max(160),
  approved_at: wave1UtcTimestampSchema,
  binding_sha256: sha256Schema,
}).strict().readonly();

export type Wave1ActivationApproval = z.infer<typeof wave1ActivationApprovalSchema>;

/** Evaluation only: this function has no activation side effect. */
export function evaluateWave1FutureActivationGate(input: Readonly<{
  attestation_status: "missing" | "valid" | "invalidated";
  attestation_id: string;
  binding_sha256: string;
  approvals: readonly Wave1ActivationApproval[];
}>) {
  const bindingHash = sha256Schema.parse(input.binding_sha256);
  const approvals = input.approvals.map((approval) => wave1ActivationApprovalSchema.parse(approval));
  const eligible = approvals.filter((approval) => (
    approval.attestation_id === input.attestation_id && approval.binding_sha256 === bindingHash
  ));
  const legal = eligible.find((approval) => approval.approval_kind === "legal_content_approval");
  const activation = eligible.find((approval) => approval.approval_kind === "activation_control_approval");
  const reasons: string[] = [];
  if (input.attestation_status !== "valid") reasons.push("valid_review_attestation_required");
  if (!legal) reasons.push("legal_content_approval_required");
  if (!activation) reasons.push("activation_control_approval_required");
  if (legal && activation && legal.approver_id === activation.approver_id) reasons.push("separate_approvers_required");
  return Object.freeze({ eligible: reasons.length === 0, reasons: Object.freeze(reasons.sort()), activates_source: false as const });
}
