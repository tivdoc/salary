import { frozen, legalOperationsSha256 } from "../../../engine/legal-operations/canonical.ts";
import {
  assertVerifiedHumanBinding,
  humanDecisionEnvelopeSha256,
  payloadWithoutEmbeddedSignature,
  type HumanTrustPurpose,
  type HumanTrustVerificationPort,
  type SignedHumanDecisionEnvelope,
  type VerifiedHumanDecision,
} from "../../../engine/legal-operations/human-trust.ts";
import {
  signedLifecycleActionSchema,
  sourceReviewAttestationSchema,
  parameterAttestationSchema,
  semanticApprovalSchema,
  type LifecycleCommand,
  type SignedLifecycleAction,
} from "../../../engine/legal-operations/contracts.ts";
import { ruleSpecPackageSchema, validateGoldenCaseSet, type GoldenCaseSet } from "../../../engine/legal-operations/rulespec.ts";
import { AppendOnlyLegalOperationsStore, type ImportArtifactCommand } from "../../../engine/legal-operations/state-machine.ts";
import { realCatalogStatusMatrix } from "../../../engine/legal-operations/catalog.ts";

type ImmutableGoldenImport = Readonly<{
  golden_case_set_id: string;
  content_sha256: string;
  revision: number;
  receipt_sha256: string;
}>;

export class LegalOperationsApplicationService {
  readonly #store = new AppendOnlyLegalOperationsStore();
  readonly #goldenCases = new Map<string, GoldenCaseSet>();
  readonly #goldenIdempotency = new Map<string, Readonly<{ command_sha256: string; result: ImmutableGoldenImport }>>();
  readonly #ruleGoldenHashes = new Map<string, string>();
  readonly #importedGoldenHashes = new Set<string>();
  readonly #trust: HumanTrustVerificationPort | null;
  readonly #allowSyntheticMechanics: boolean;
  readonly #verifiedEnvelopes = new Map<string, string>();
  readonly #trustedDecisions = new Map<string, VerifiedHumanDecision[]>();

  constructor(options: Readonly<{ trust?: HumanTrustVerificationPort; allow_synthetic_mechanics?: boolean }> = {}) {
    this.#trust = options.trust ?? null;
    this.#allowSyntheticMechanics = options.allow_synthetic_mechanics === true;
  }

  importArtifact(command: ImportArtifactCommand) {
    const result = this.#store.importArtifact(command);
    if (command.artifact_kind === "rule_package") {
      const rule = ruleSpecPackageSchema.parse(command.content);
      this.#ruleGoldenHashes.set(`${command.artifact_id}@${command.artifact_version}`, rule.golden_case_set_sha256);
    }
    return result;
  }
  importSignedSourceDecision(artifactId: string, artifactVersion: string, candidate: unknown) {
    const attestation = sourceReviewAttestationSchema.parse(candidate);
    this.#assertSyntheticMechanics(attestation.reviewer_id);
    return this.#store.importSourceAttestation(artifactId, artifactVersion, attestation);
  }
  importParameterAttestation(artifactId: string, artifactVersion: string, candidate: unknown) {
    const attestation = parameterAttestationSchema.parse(candidate);
    this.#assertSyntheticMechanics(attestation.reviewer_id);
    return this.#store.importParameterAttestation(artifactId, artifactVersion, attestation);
  }
  importRuleOrGoldenApproval(artifactId: string, artifactVersion: string, candidate: unknown) {
    const approval = semanticApprovalSchema.parse(candidate);
    this.#assertSyntheticMechanics(approval.reviewer_id);
    if (approval.approval_kind === "golden_case_outputs" && !this.#importedGoldenHashes.has(approval.artifact_sha256)) throw new Error("GOLDEN_CASE_SET_IMPORT_REQUIRED");
    return this.#store.importSemanticApproval(artifactId, artifactVersion, approval);
  }
  transition(candidate: LifecycleCommand) {
    if (!this.#allowSyntheticMechanics && ["eligible", "active", "revoked", "superseded"].includes(candidate.target_state)) throw new Error("TRUSTED_SIGNED_LIFECYCLE_ACTION_REQUIRED");
    if (candidate.artifact_kind === "rule_package" && candidate.target_state === "approved") {
      const goldenSha256 = this.#ruleGoldenHashes.get(`${candidate.artifact_id}@${candidate.artifact_version}`);
      if (!goldenSha256 || !this.#importedGoldenHashes.has(goldenSha256)) throw new Error("GOLDEN_CASE_SET_IMPORT_REQUIRED");
    }
    return this.#store.transition(candidate);
  }
  status(artifactId: string, artifactVersion: string) { return this.#store.status(artifactId, artifactVersion); }
  history(artifactId: string, artifactVersion: string) { return this.#store.history(artifactId, artifactVersion); }

  importGoldenCaseSet(candidate: unknown, idempotencyKey: string): Readonly<{ result: ImmutableGoldenImport; idempotent_replay: boolean }> {
    const golden = validateGoldenCaseSet(candidate);
    const commandSha256 = legalOperationsSha256({ idempotency_key: idempotencyKey, golden_case_set: golden });
    const prior = this.#goldenIdempotency.get(idempotencyKey);
    if (prior) {
      if (prior.command_sha256 !== commandSha256) throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_GOLDEN_CASE_SET");
      return frozen({ result: prior.result, idempotent_replay: true });
    }
    const existing = this.#goldenCases.get(golden.golden_case_set_id);
    if (existing && existing.content_sha256 !== golden.content_sha256) throw new Error("APPEND_ONLY_GOLDEN_CASE_SET_MUTATION_REJECTED");
    this.#store.importGoldenCaseSet(golden);
    const result = frozen({ golden_case_set_id: golden.golden_case_set_id, content_sha256: golden.content_sha256, revision: 1, receipt_sha256: legalOperationsSha256({ action: "import_golden_case_set", golden_case_set_id: golden.golden_case_set_id, content_sha256: golden.content_sha256 }) });
    this.#goldenCases.set(golden.golden_case_set_id, golden);
    this.#importedGoldenHashes.add(golden.content_sha256);
    this.#goldenIdempotency.set(idempotencyKey, { command_sha256: commandSha256, result });
    return frozen({ result, idempotent_replay: existing !== undefined });
  }

  applySignedLifecycleAction(candidate: unknown) {
    const action = signedLifecycleActionSchema.parse(candidate);
    this.#assertSyntheticMechanics(action.actor_id);
    return this.#store.transition(this.#toCommand(action));
  }

  importTrustedSourceDecision(input: Readonly<{ artifact_id: string; artifact_version: string; payload: unknown; envelope: unknown }>) {
    const payload = sourceReviewAttestationSchema.parse(input.payload);
    const verification = this.#verifyHumanDecision(input.envelope, payloadWithoutEmbeddedSignature(payload), "source_review", payload.reviewer_role);
    this.#assertEnvelopePayloadSchema(verification.envelope, payload.schema_version);
    assertVerifiedHumanBinding(verification, { reviewer_id: payload.reviewer_id, reviewer_role: payload.reviewer_role, purpose: "source_review", occurred_at: payload.decided_at, embedded_signature_sha256: payload.signature_sha256 });
    this.#assertTrustedDecisionContext(input.artifact_id, input.artifact_version, verification);
    const result = this.#store.importSourceAttestation(input.artifact_id, input.artifact_version, payload);
    this.#recordTrustedDecision(input.artifact_id, input.artifact_version, verification);
    return frozen({ ...result, trust: verification });
  }

  importTrustedParameterAttestation(input: Readonly<{ artifact_id: string; artifact_version: string; payload: unknown; envelope: unknown }>) {
    const payload = parameterAttestationSchema.parse(input.payload);
    const verification = this.#verifyHumanDecision(input.envelope, payloadWithoutEmbeddedSignature(payload), "parameter_attestation", payload.reviewer_role);
    this.#assertEnvelopePayloadSchema(verification.envelope, payload.schema_version);
    assertVerifiedHumanBinding(verification, { reviewer_id: payload.reviewer_id, reviewer_role: payload.reviewer_role, purpose: "parameter_attestation", occurred_at: payload.attested_at, embedded_signature_sha256: payload.signature_sha256 });
    this.#assertTrustedDecisionContext(input.artifact_id, input.artifact_version, verification);
    const result = this.#store.importParameterAttestation(input.artifact_id, input.artifact_version, payload);
    this.#recordTrustedDecision(input.artifact_id, input.artifact_version, verification);
    return frozen({ ...result, trust: verification });
  }

  importTrustedRuleOrGoldenApproval(input: Readonly<{ artifact_id: string; artifact_version: string; payload: unknown; envelope: unknown }>) {
    const payload = semanticApprovalSchema.parse(input.payload);
    const purpose = payload.approval_kind === "rule_semantics" ? "rulespec_semantics" as const : "golden_case_outputs" as const;
    if (purpose === "golden_case_outputs" && !this.#importedGoldenHashes.has(payload.artifact_sha256)) throw new Error("GOLDEN_CASE_SET_IMPORT_REQUIRED");
    const verification = this.#verifyHumanDecision(input.envelope, payloadWithoutEmbeddedSignature(payload), purpose, payload.reviewer_role);
    this.#assertEnvelopePayloadSchema(verification.envelope, payload.schema_version);
    assertVerifiedHumanBinding(verification, { reviewer_id: payload.reviewer_id, reviewer_role: payload.reviewer_role, purpose, occurred_at: payload.decided_at, embedded_signature_sha256: payload.signature_sha256 });
    this.#assertTrustedDecisionContext(input.artifact_id, input.artifact_version, verification);
    const result = this.#store.importSemanticApproval(input.artifact_id, input.artifact_version, payload);
    this.#recordTrustedDecision(input.artifact_id, input.artifact_version, verification);
    return frozen({ ...result, trust: verification });
  }

  applyTrustedLifecycleAction(input: Readonly<{ payload: unknown; envelope: unknown }>) {
    const action = signedLifecycleActionSchema.parse(input.payload);
    const verification = this.#verifyHumanDecision(input.envelope, payloadWithoutEmbeddedSignature(action), "lifecycle_action", action.actor_role);
    this.#assertEnvelopePayloadSchema(verification.envelope, action.schema_version);
    assertVerifiedHumanBinding(verification, { reviewer_id: action.actor_id, reviewer_role: action.actor_role, purpose: "lifecycle_action", occurred_at: action.occurred_at, embedded_signature_sha256: action.signature_sha256 });
    this.#assertTrustedDecisionContext(action.artifact_id, action.artifact_version, verification);
    const result = this.#store.transition(this.#toCommand(action));
    this.#recordTrustedDecision(action.artifact_id, action.artifact_version, verification);
    return frozen({ ...result, trust: verification });
  }

  proposeActivation(candidate: Extract<SignedLifecycleAction, { action: "propose_activation" }>) { return this.applySignedLifecycleAction(candidate); }
  activate(candidate: Extract<SignedLifecycleAction, { action: "activate" }>) { return this.applySignedLifecycleAction(candidate); }
  revoke(candidate: Extract<SignedLifecycleAction, { action: "revoke" }>) { return this.applySignedLifecycleAction(candidate); }
  supersede(candidate: Extract<SignedLifecycleAction, { action: "supersede" }>) { return this.applySignedLifecycleAction(candidate); }

  async strictReadiness() {
    const matrix = await realCatalogStatusMatrix();
    return frozen({ ...matrix, strict_exit_code: matrix.passed && matrix.ready_count === 0 ? 2 : 1 });
  }

  trustedDecisionHistory(artifactId: string, artifactVersion: string) {
    return frozen([...(this.#trustedDecisions.get(`${artifactId}@${artifactVersion}`) ?? [])]);
  }

  #verifyHumanDecision(envelope: unknown, payload: unknown, purpose: HumanTrustPurpose, reviewerRole: string) {
    if (!this.#trust) throw new Error("HUMAN_TRUST_VERIFIER_REQUIRED");
    return this.#trust.verifyForAdmission({ envelope, payload, purpose, required_reviewer_role: reviewerRole });
  }

  #assertEnvelopePayloadSchema(envelope: SignedHumanDecisionEnvelope, expected: string) {
    if (envelope.payload_schema_version !== expected) throw new Error("HUMAN_TRUST_PAYLOAD_SCHEMA_BINDING_MISMATCH");
  }

  #assertTrustedDecisionContext(artifactId: string, artifactVersion: string, verification: VerifiedHumanDecision) {
    const envelopeSha = humanDecisionEnvelopeSha256(verification.envelope);
    const priorEnvelope = this.#verifiedEnvelopes.get(verification.envelope.envelope_id);
    if (priorEnvelope && priorEnvelope !== envelopeSha) throw new Error("HUMAN_TRUST_ENVELOPE_ID_REUSED");
    const key = `${artifactId}@${artifactVersion}`;
    const history = this.#trustedDecisions.get(key) ?? [];
    const context = history[0];
    if (context && (context.organization_id !== verification.organization_id || context.organization_version !== verification.organization_version || context.policy_version !== verification.policy_version)) throw new Error("HUMAN_TRUST_ARTIFACT_POLICY_CONTEXT_MISMATCH");
  }

  #recordTrustedDecision(artifactId: string, artifactVersion: string, verification: VerifiedHumanDecision) {
    this.#verifiedEnvelopes.set(verification.envelope.envelope_id, humanDecisionEnvelopeSha256(verification.envelope));
    const key = `${artifactId}@${artifactVersion}`;
    const history = this.#trustedDecisions.get(key) ?? [];
    if (!history.some((entry) => entry.envelope_sha256 === verification.envelope_sha256)) history.push(verification);
    this.#trustedDecisions.set(key, history);
  }

  #assertSyntheticMechanics(actorId?: string) {
    if (!this.#allowSyntheticMechanics) throw new Error("HUMAN_TRUST_ENVELOPE_REQUIRED");
    if (actorId !== undefined && !actorId.startsWith("syn.human.")) throw new Error("SYNTHETIC_MECHANICS_ACTOR_REQUIRED");
  }

  #toCommand(action: SignedLifecycleAction): LifecycleCommand {
    return {
      schema_version: "tivdoc-legal-lifecycle-command-v0.6.0",
      command_id: action.action_id,
      idempotency_key: action.idempotency_key,
      artifact_id: action.artifact_id,
      artifact_version: action.artifact_version,
      artifact_kind: action.artifact_kind,
      expected_state: action.expected_state,
      target_state: action.target_state,
      actor_id: action.actor_id,
      actor_role: action.actor_role,
      occurred_at: action.occurred_at,
      reason: action.reason,
      bound_content_sha256: action.bound_content_sha256,
      bindings: action.bindings,
      action_signature_sha256: action.signature_sha256,
    };
  }
}
