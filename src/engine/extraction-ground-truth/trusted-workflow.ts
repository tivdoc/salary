import { z } from "zod";
import type { GroundTruthFieldAnnotation, GroundTruthManifest } from "../wave2/contracts.ts";
import { isoTimestampSchema } from "../domain/primitives.ts";
import { canonicalSha256, deepFreeze } from "../rule-runtime/canonical.ts";
import {
  assertVerifiedHumanBinding,
  humanTrustIdSchema,
  payloadWithoutEmbeddedSignature,
  type HumanTrustPurpose,
  type HumanTrustVerificationPort,
  type VerifiedHumanDecision,
} from "../legal-operations/human-trust.ts";
import { legalOperationsIdSchema, legalOperationsSha256Schema } from "../legal-operations/contracts.ts";
import { legalOperationsSha256 } from "../legal-operations/canonical.ts";
import { addGroundTruthAnnotation2, createGroundTruthAnnotation1, lockGroundTruth, recordGroundTruthDisagreement, recordHumanAdjudication } from "./workflow.ts";
import { manifestHasDisagreement, validateGroundTruthManifest } from "./validation.ts";

export const TRUSTED_GT_SCHEMA = "tivdoc-trusted-ground-truth-v0.10.0" as const;

export const groundTruthVisualEligibilitySchema = z.object({
  schema_version: z.literal(TRUSTED_GT_SCHEMA),
  eligibility_id: legalOperationsIdSchema,
  document_sha256: legalOperationsSha256Schema,
  catalog_boundary: z.enum(["synthetic_test_only", "real_inactive"]),
  visual_review: z.enum(["completed_eligible", "not_eligible"]),
  license_gate: z.enum(["authorized_for_private_evaluation", "not_authorized"]),
  pii_gate: z.enum(["private_handling_controls_verified", "controls_not_verified"]),
  decision: z.enum(["eligible", "rejected"]),
  reviewer_id: humanTrustIdSchema,
  reviewer_role: z.literal("human_ground_truth_eligibility_reviewer"),
  decided_at: isoTimestampSchema,
  reason_code: z.string().regex(/^[A-Z][A-Z0-9_]{2,99}$/),
  signature_sha256: legalOperationsSha256Schema,
}).strict().superRefine((decision, context) => {
  const allGatesPass = decision.visual_review === "completed_eligible" && decision.license_gate === "authorized_for_private_evaluation" && decision.pii_gate === "private_handling_controls_verified";
  if ((decision.decision === "eligible") !== allGatesPass) context.addIssue({ code: "custom", message: "ground_truth_visual_license_pii_gate_mismatch" });
}).readonly();

export type GroundTruthVisualEligibility = z.infer<typeof groundTruthVisualEligibilitySchema>;

export type TrustedGroundTruthEvent = Readonly<{
  schema_version: typeof TRUSTED_GT_SCHEMA;
  sequence: number;
  event_id: string;
  event_kind: "visual_eligibility_recorded" | "annotation_1_signed" | "annotation_2_signed" | "disagreement_recorded" | "adjudication_signed" | "ground_truth_locked";
  manifest_id: string | null;
  revision: number | null;
  document_sha256: string;
  actor_id: string;
  manifest_sha256: string | null;
  envelope_sha256: string | null;
  prior_event_sha256: string | null;
  event_sha256: string;
}>;

type GroundTruthAction = "annotation_1" | "annotation_2" | "human_adjudication" | "lock";

export function trustedGroundTruthActionPayload(action: GroundTruthAction, prior: GroundTruthManifest | null, next: GroundTruthManifest) {
  const validatedNext = validateGroundTruthManifest(next);
  const payload = {
    schema_version: TRUSTED_GT_SCHEMA,
    action,
    manifest_id: validatedNext.manifest_id,
    revision: validatedNext.revision,
    document_sha256: validatedNext.document_sha256,
    prior_manifest_sha256: prior === null ? null : canonicalSha256(validateGroundTruthManifest(prior)),
    resulting_manifest_sha256: canonicalSha256(validatedNext),
  } as const;
  return deepFreeze(payload);
}

export class TrustedGroundTruthWorkflow {
  readonly #trust: HumanTrustVerificationPort;
  readonly #eligibility = new Map<string, Readonly<{ decision: GroundTruthVisualEligibility; verification: VerifiedHumanDecision }>>();
  readonly #manifests = new Map<string, GroundTruthManifest>();
  readonly #events: TrustedGroundTruthEvent[] = [];

  constructor(trust: HumanTrustVerificationPort) {
    this.#trust = trust;
  }

  recordVisualEligibility(candidate: unknown, envelope: unknown) {
    const decision = groundTruthVisualEligibilitySchema.parse(candidate);
    const verification = this.#trust.verifyForAdmission({ envelope, payload: payloadWithoutEmbeddedSignature(decision), purpose: "ground_truth_visual_eligibility", required_reviewer_role: decision.reviewer_role });
    if (verification.envelope.payload_schema_version !== decision.schema_version) throw new Error("GROUND_TRUTH_TRUST_SCHEMA_BINDING_MISMATCH");
    assertVerifiedHumanBinding(verification, { reviewer_id: decision.reviewer_id, reviewer_role: decision.reviewer_role, purpose: "ground_truth_visual_eligibility", occurred_at: decision.decided_at, embedded_signature_sha256: decision.signature_sha256 });
    const existing = this.#eligibility.get(decision.document_sha256);
    if (existing && legalOperationsSha256(existing.decision) !== legalOperationsSha256(decision)) throw new Error("GROUND_TRUTH_ELIGIBILITY_APPEND_ONLY_REVISION_REQUIRED");
    if (!existing) {
      this.#eligibility.set(decision.document_sha256, deepFreeze({ decision, verification }));
      this.#append("visual_eligibility_recorded", null, decision.document_sha256, decision.reviewer_id, null, verification.envelope_sha256);
    }
    return deepFreeze({ decision, trust: verification, idempotent_replay: existing !== undefined });
  }

  startAnnotation1(candidate: unknown, envelope: unknown) {
    const manifest = createGroundTruthAnnotation1(candidate);
    this.#requireEligible(manifest.document_sha256);
    if (this.#manifests.has(manifest.manifest_id)) throw new Error("GROUND_TRUTH_MANIFEST_APPEND_ONLY_MUTATION_REJECTED");
    const payload = trustedGroundTruthActionPayload("annotation_1", null, manifest);
    const verification = this.#verifyAction(envelope, payload, "ground_truth_annotation", "human_ground_truth_annotator", manifest.annotator_1_id);
    this.#manifests.set(manifest.manifest_id, manifest);
    this.#append("annotation_1_signed", manifest, manifest.document_sha256, verification.reviewer_id, canonicalSha256(manifest), verification.envelope_sha256);
    return this.#summary(manifest);
  }

  previewAnnotation2(manifestId: string, annotations: readonly GroundTruthFieldAnnotation[]) {
    const prior = this.#manifest(manifestId);
    const next = addGroundTruthAnnotation2(prior, annotations);
    return trustedGroundTruthActionPayload("annotation_2", prior, next);
  }

  addAnnotation2(manifestId: string, annotations: readonly GroundTruthFieldAnnotation[], envelope: unknown) {
    const prior = this.#manifest(manifestId);
    const next = addGroundTruthAnnotation2(prior, annotations);
    const author = next.annotator_2_id!;
    const payload = trustedGroundTruthActionPayload("annotation_2", prior, next);
    const verification = this.#verifyAction(envelope, payload, "ground_truth_annotation", "human_ground_truth_annotator", author);
    this.#manifests.set(manifestId, next);
    this.#append("annotation_2_signed", next, next.document_sha256, author, canonicalSha256(next), verification.envelope_sha256);
    return this.#summary(next);
  }

  recordDisagreement(manifestId: string) {
    const prior = this.#manifest(manifestId);
    const next = recordGroundTruthDisagreement(prior);
    this.#manifests.set(manifestId, next);
    this.#append("disagreement_recorded", next, next.document_sha256, "ground.truth.system", canonicalSha256(next), null);
    return this.#summary(next);
  }

  adjudicationBrief(manifestId: string) {
    const manifest = this.#manifest(manifestId);
    if (manifest.status !== "annotation_2" && manifest.status !== "disagreement") throw new Error("GROUND_TRUTH_ADJUDICATION_BRIEF_NOT_AVAILABLE");
    return deepFreeze({
      manifest_id: manifest.manifest_id,
      revision: manifest.revision,
      document_sha256: manifest.document_sha256,
      annotations: manifest.annotations,
      disagreement: manifestHasDisagreement(manifest),
    });
  }

  previewAdjudication(manifestId: string, annotations: readonly GroundTruthFieldAnnotation[]) {
    const prior = this.#manifest(manifestId);
    const next = recordHumanAdjudication(prior, annotations);
    return trustedGroundTruthActionPayload("human_adjudication", prior, next);
  }

  adjudicate(manifestId: string, annotations: readonly GroundTruthFieldAnnotation[], envelope: unknown) {
    const prior = this.#manifest(manifestId);
    const next = recordHumanAdjudication(prior, annotations);
    const author = next.adjudicator_id!;
    const payload = trustedGroundTruthActionPayload("human_adjudication", prior, next);
    const verification = this.#verifyAction(envelope, payload, "ground_truth_adjudication", "human_ground_truth_adjudicator", author);
    this.#manifests.set(manifestId, next);
    this.#append("adjudication_signed", next, next.document_sha256, author, canonicalSha256(next), verification.envelope_sha256);
    return this.#summary(next);
  }

  previewLock(manifestId: string) {
    const prior = this.#manifest(manifestId);
    const next = lockGroundTruth(prior);
    return trustedGroundTruthActionPayload("lock", prior, next);
  }

  lock(manifestId: string, envelope: unknown) {
    const prior = this.#manifest(manifestId);
    const next = lockGroundTruth(prior);
    const payload = trustedGroundTruthActionPayload("lock", prior, next);
    const verification = this.#verifyAction(envelope, payload, "ground_truth_lock", "human_ground_truth_lock_reviewer", undefined);
    if ([next.annotator_1_id, next.annotator_2_id, next.adjudicator_id].includes(verification.reviewer_id)) throw new Error("GROUND_TRUTH_LOCK_REVIEWER_MUST_BE_INDEPENDENT");
    this.#manifests.set(manifestId, next);
    this.#append("ground_truth_locked", next, next.document_sha256, verification.reviewer_id, canonicalSha256(next), verification.envelope_sha256);
    return this.#summary(next);
  }

  annotation2Brief(manifestId: string) {
    const manifest = this.#manifest(manifestId);
    if (manifest.status !== "annotation_1") throw new Error("GROUND_TRUTH_ANNOTATION_2_BRIEF_NOT_AVAILABLE");
    return deepFreeze({ manifest_id: manifest.manifest_id, revision: manifest.revision, document_sha256: manifest.document_sha256, sections: manifest.sections, field_identities: manifest.annotations.map((entry) => entry.field_identity).sort() });
  }

  status() {
    const locked = [...this.#manifests.values()].filter((manifest) => manifest.status === "locked_ground_truth");
    const realLockedCount = locked.filter((manifest) => this.#eligibility.get(manifest.document_sha256)?.decision.catalog_boundary === "real_inactive").length;
    return deepFreeze({
      eligible_document_count: [...this.#eligibility.values()].filter((entry) => entry.decision.decision === "eligible").length,
      manifest_count: this.#manifests.size,
      locked_count: locked.length,
      real_locked_count: realLockedCount,
      synthetic_locked_count: locked.length - realLockedCount,
      audit_head_sha256: this.#events.at(-1)?.event_sha256 ?? null,
    });
  }

  events() { return deepFreeze(this.#events.map((event) => ({ ...event }))); }

  verifyAuditChain() {
    let prior: string | null = null;
    for (const event of this.#events) {
      const { event_sha256: expected, ...body } = event;
      if (body.prior_event_sha256 !== prior || legalOperationsSha256(body) !== expected) return deepFreeze({ valid: false, event_count: this.#events.length, tail_sha256: prior });
      prior = event.event_sha256;
    }
    return deepFreeze({ valid: true, event_count: this.#events.length, tail_sha256: prior });
  }

  #verifyAction(envelope: unknown, payload: unknown, purpose: HumanTrustPurpose, role: string, reviewerId: string | undefined) {
    const verification = this.#trust.verifyForAdmission({ envelope, payload, purpose, required_reviewer_role: role });
    if (verification.envelope.payload_schema_version !== TRUSTED_GT_SCHEMA) throw new Error("GROUND_TRUTH_TRUST_SCHEMA_BINDING_MISMATCH");
    if (reviewerId !== undefined && verification.reviewer_id !== reviewerId) throw new Error("GROUND_TRUTH_TRUST_REVIEWER_BINDING_MISMATCH");
    return verification;
  }

  #requireEligible(documentSha256: string) {
    const entry = this.#eligibility.get(documentSha256);
    if (!entry || entry.decision.decision !== "eligible") throw new Error("GROUND_TRUTH_VISUAL_LICENSE_PII_ELIGIBILITY_REQUIRED");
  }

  #manifest(manifestId: string) {
    const manifest = this.#manifests.get(manifestId);
    if (!manifest) throw new Error("GROUND_TRUTH_MANIFEST_NOT_FOUND");
    return manifest;
  }

  #summary(manifest: GroundTruthManifest) {
    return deepFreeze({ manifest_id: manifest.manifest_id, revision: manifest.revision, document_sha256: manifest.document_sha256, status: manifest.status, manifest_sha256: canonicalSha256(manifest), locked_sha256: manifest.locked_sha256 });
  }

  #append(kind: TrustedGroundTruthEvent["event_kind"], manifest: GroundTruthManifest | null, documentSha256: string, actorId: string, manifestSha256: string | null, envelopeSha256: string | null) {
    const prior = this.#events.at(-1)?.event_sha256 ?? null;
    const body = {
      schema_version: TRUSTED_GT_SCHEMA,
      sequence: this.#events.length + 1,
      event_id: `ground.truth.event.${String(this.#events.length + 1).padStart(8, "0")}`,
      event_kind: kind,
      manifest_id: manifest?.manifest_id ?? null,
      revision: manifest?.revision ?? null,
      document_sha256: documentSha256,
      actor_id: actorId,
      manifest_sha256: manifestSha256,
      envelope_sha256: envelopeSha256,
      prior_event_sha256: prior,
    } as const;
    const event = deepFreeze({ ...body, event_sha256: legalOperationsSha256(body) }) as TrustedGroundTruthEvent;
    this.#events.push(event);
    return event;
  }
}
