import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { legalOperationsSha256 } from "../../../../../engine/legal-operations/canonical.ts";
import {
  humanDecisionEnvelopeSha256,
  humanDecisionPayloadSha256,
  humanDecisionSignatureSha256,
  humanDecisionSigningBytes,
  payloadWithoutEmbeddedSignature,
  type SignedHumanDecisionEnvelope,
  type VerifiedHumanDecision,
} from "../../../../../engine/legal-operations/human-trust.ts";
import { buildSyntheticLegalFixture } from "../../../../../engine/legal-operations/synthetic-fixtures.ts";
import { buildSyntheticGroundTruthWorkflow } from "../../../../../engine/extraction-ground-truth/synthetic-fixtures.ts";
import type {
  PostgresClient,
  PostgresQueryResult,
  PostgresStatement,
  PostgresTransactionContext,
} from "../contracts.ts";
import { decodeGovernanceMutationReceipt } from "./codecs.ts";
import {
  GOVERNANCE_SCHEMA_VERSION,
  GovernanceRepositoryError,
  type LegalObservationCandidate,
  type LegalObservationDecision,
} from "./contracts.ts";
import {
  PostgresGovernanceWorkRepository,
  PostgresGroundTruthRepository,
  PostgresLegalReconciliationRepository,
  PostgresParameterApprovalRepository,
  PostgresRuleSpecApprovalRepository,
} from "./repositories.ts";
import {
  aggregateReadStatement,
  goldenCaseSetImportStatement,
  groundTruthEligibilityAppendStatement,
  groundTruthManifestAppendStatement,
  humanDecisionAdmitStatement,
  keyChallengeAppendStatement,
  legalObservationDecideStatement,
  legalObservationImportStatement,
  parameterAttestationAppendStatement,
  parameterImportStatement,
  reviewerAppendStatement,
  reviewerKeyRegisterStatement,
  reviewerKeyRevokeStatement,
  reviewerVerificationMaterialReadStatement,
  ruleSpecApprovalAppendStatement,
  ruleSpecImportStatement,
  trustOrganizationAppendStatement,
  trustPolicyAppendStatement,
  workClaimStatement,
  workEnqueueStatement,
  workReleaseStatement,
} from "./statements.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const NOW = "2040-01-01T00:00:00.000Z";
const TENANT = "tenant.synthetic.governance";

class RecordingClient implements PostgresClient {
  readonly statements: PostgresStatement[] = [];

  constructor(private readonly handler: (statement: PostgresStatement) => PostgresQueryResult | Promise<PostgresQueryResult>) {}

  async query(statement: PostgresStatement): Promise<PostgresQueryResult> {
    this.statements.push(statement);
    return this.handler(statement);
  }
}

function context(client: PostgresClient): PostgresTransactionContext {
  return Object.freeze({ client, transaction_id: "tx.synthetic.governance" });
}

function mutationRow(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    tenant_id: TENANT,
    workflow_kind: "legal_reconciliation",
    aggregate_id: "observation.synthetic.001",
    aggregate_version: "1.0.0",
    revision: "2",
    state: "reconciliation_reviewed_inactive",
    content_sha256: SHA_A,
    audit_event_sha256: SHA_B,
    idempotent_replay: false,
    activation_allowed: false,
    ...overrides,
  };
}

function one(row: Readonly<Record<string, unknown>>): PostgresQueryResult {
  return Object.freeze({ rows: Object.freeze([row]), row_count: 1 });
}

function candidate(): LegalObservationCandidate {
  const seed = {
    schema_version: GOVERNANCE_SCHEMA_VERSION,
    observation_id: "observation.synthetic.001",
    observation_version: "1.0.0",
    observation_kind: "catalog_listing" as const,
    source_candidate_id: "source.synthetic.001",
    instrument_candidate_id: null,
    observed_url: "https://synthetic.invalid/legal-observation/001",
    artifact_version_id: null,
    byte_object_id: null,
    bytes_sha256: null,
    topic: "synthetic.topic",
    candidate_valid_from: null,
    candidate_valid_to: null,
    knowledge_time: NOW,
    sectors: ["synthetic.sector"],
    populations: ["synthetic.population"],
    geographies: ["synthetic.geography"],
    provenance: { synthetic_test_only: true },
    contradiction_refs: [],
    gap_refs: [],
    alias_refs: [],
    duplicate_refs: [],
    overlap_refs: [],
    legal_effect: "unreviewed" as const,
    activation_allowed: false as const,
  };
  return Object.freeze({ ...seed, candidate_sha256: legalOperationsSha256(seed) });
}

function signedDecision(): Readonly<{
  decision: LegalObservationDecision;
  verification: VerifiedHumanDecision;
  public_key_spki_pem: string;
  public_key_sha256: string;
}> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const publicKeySha256 = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  const decisionSeed = {
    schema_version: GOVERNANCE_SCHEMA_VERSION,
    decision_id: "decision.synthetic.001",
    observation_id: "observation.synthetic.001",
    observation_version: "1.0.0",
    candidate_sha256: candidate().candidate_sha256,
    disposition: "accepted" as const,
    reviewer_id: "reviewer.synthetic.source",
    reviewer_role: "human_source_reviewer" as const,
    decided_at: NOW,
    reason_code: "SYNTHETIC_EVIDENCE_RECONCILED",
    legal_effect: "reconciliation_candidate_only" as const,
    activation_allowed: false as const,
  };
  const payload = decisionSeed;
  const envelopeBody = {
    schema_version: "tivdoc-human-decision-envelope-v0.10.0" as const,
    envelope_id: "envelope.synthetic.001",
    organization_id: "organization.synthetic.001",
    organization_version: "1.0.0",
    policy_version: "1.0.0",
    reviewer_id: decisionSeed.reviewer_id,
    reviewer_identity_version: "1.0.0",
    reviewer_role: decisionSeed.reviewer_role,
    key_id: "key.synthetic.001",
    purpose: "source_review" as const,
    payload_schema_version: GOVERNANCE_SCHEMA_VERSION,
    payload_sha256: humanDecisionPayloadSha256(payload),
    issued_at: NOW,
    expires_at: "2040-01-01T01:00:00.000Z",
    nonce: "synthetic_nonce_000000000001",
    algorithm: "Ed25519" as const,
  };
  const signatureBase64 = sign(null, humanDecisionSigningBytes(envelopeBody), privateKey).toString("base64");
  const envelope: SignedHumanDecisionEnvelope = Object.freeze({ ...envelopeBody, signature_base64: signatureBase64 });
  const signatureSha256 = humanDecisionSignatureSha256(signatureBase64);
  const decision = Object.freeze({ ...decisionSeed, signature_sha256: signatureSha256 });
  const verification: VerifiedHumanDecision = Object.freeze({
    envelope,
    envelope_sha256: humanDecisionEnvelopeSha256(envelope),
    signature_sha256: signatureSha256,
    organization_id: envelope.organization_id,
    organization_version: envelope.organization_version,
    policy_version: envelope.policy_version,
    reviewer_id: envelope.reviewer_id,
    reviewer_identity_version: envelope.reviewer_identity_version,
    reviewer_role: envelope.reviewer_role,
    key_id: envelope.key_id,
    purpose: envelope.purpose,
    valid_at_signing_time: true,
    currently_trusted: true,
  });
  expect(humanDecisionPayloadSha256(payloadWithoutEmbeddedSignature(decision))).toBe(envelope.payload_sha256);
  return { decision, verification, public_key_spki_pem: publicKeyPem, public_key_sha256: publicKeySha256 };
}

describe("durable PostgreSQL governance boundary", () => {
  it("binds every statement builder to private governance functions only", () => {
    const record = { synthetic: true };
    const common = { tenant_id: TENANT, idempotency_key: "idem.synthetic.001", command_sha256: SHA_A };
    const approval = {
      ...common, decision: record, expected_revision: 1, work_item_id: "work.synthetic.001",
      claimant_id: "reviewer.synthetic.001", fencing_token: 1, envelope_id: "envelope.synthetic.001", recorded_at: NOW,
    };
    const statements = [
      trustOrganizationAppendStatement({ ...common, record, actor_id: "actor.synthetic.001", occurred_at: NOW }),
      trustPolicyAppendStatement({ ...common, record, actor_id: "actor.synthetic.001", occurred_at: NOW }),
      reviewerAppendStatement({ ...common, record, actor_id: "actor.synthetic.001", occurred_at: NOW }),
      keyChallengeAppendStatement({ ...common, record, actor_id: "actor.synthetic.001", occurred_at: NOW }),
      reviewerKeyRegisterStatement({ ...common, challenge_id: "challenge.synthetic.001", registered_at: NOW,
        proof_signature_sha256: SHA_A, rotation_authorization_signature_sha256: null }),
      reviewerKeyRevokeStatement({ ...common, key_id: "key.synthetic.001", effective_at: NOW,
        reason_code: "SYNTHETIC_REVOKE", actor_id: "actor.synthetic.001", recorded_at: NOW }),
      reviewerVerificationMaterialReadStatement({ tenant_id: TENANT, organization_id: "org.synthetic.001",
        organization_version: "1.0.0", policy_version: "1.0.0", reviewer_id: "reviewer.synthetic.001",
        reviewer_identity_version: "1.0.0", key_id: "key.synthetic.001", purpose: "source_review",
        required_reviewer_role: "human_source_reviewer", issued_at: NOW, admitted_at: NOW }),
      humanDecisionAdmitStatement({ ...common, workflow_kind: "legal_reconciliation", aggregate_id: "aggregate.synthetic.001",
        aggregate_version: "1.0.0", aggregate_revision: 1, payload: record, payload_sha256: SHA_A,
        verification: record, admitted_at: NOW }),
      workEnqueueStatement({ ...common, workflow_kind: "ground_truth", work_item_id: "work.synthetic.001",
        aggregate_id: "aggregate.synthetic.001", aggregate_version: "1.0.0", work_kind: "ground_truth_annotation",
        required_role: "human_ground_truth_annotator", document_sha256: SHA_A,
        object_version_id: "object.synthetic.001", input_sha256: SHA_B, payload: record, created_at: NOW }),
      workClaimStatement({ tenant_id: TENANT, workflow_kind: "ground_truth", work_kind: "ground_truth_annotation",
        claimant_id: "reviewer.synthetic.001", reviewer_role: "human_ground_truth_annotator", now: NOW, lease_seconds: 60 }),
      workReleaseStatement({ ...common, work_item_id: "work.synthetic.001", claimant_id: "reviewer.synthetic.001",
        fencing_token: 1, next_state: "pending", reason_code: "SYNTHETIC_RELEASE", occurred_at: NOW }),
      groundTruthEligibilityAppendStatement({ ...common, decision: record, work_item_id: "work.synthetic.001",
        claimant_id: "reviewer.synthetic.001", fencing_token: 1, envelope_id: "envelope.synthetic.001", recorded_at: NOW }),
      groundTruthManifestAppendStatement({ ...common, event_kind: "disagreement_recorded", manifest: record,
        expected_workflow_revision: 1, work_item_id: null, claimant_id: null, fencing_token: null,
        envelope_id: null, recorded_at: NOW }),
      legalObservationImportStatement({ ...common, candidate: record, imported_at: NOW }),
      legalObservationDecideStatement(approval),
      parameterImportStatement({ ...common, candidate: record, imported_at: NOW }),
      parameterAttestationAppendStatement(approval),
      goldenCaseSetImportStatement({ ...common, golden_case_set: record, imported_at: NOW }),
      ruleSpecImportStatement({ ...common, rule_spec: record, imported_at: NOW }),
      ruleSpecApprovalAppendStatement(approval),
      aggregateReadStatement({ tenant_id: TENANT, workflow_kind: "ground_truth",
        aggregate_id: "aggregate.synthetic.001", aggregate_version: "1.0.0" }),
    ];
    expect(statements).toHaveLength(21);
    for (const sql of statements) {
      expect(sql.text).toMatch(/^select \* from private\.governance_/u);
      expect(sql.text).not.toContain("public.");
      expect(sql.text).not.toContain("${");
    }
  });

  it("fails closed if PostgreSQL ever reports activation as allowed", () => {
    expect(() => decodeGovernanceMutationReceipt(mutationRow({ activation_allowed: true })))
      .toThrowError(new GovernanceRepositoryError("GOVERNANCE_ROW_MALFORMED", "decode_mutation_receipt"));
  });

  it("cryptographically re-verifies trust and atomically records a non-operative legal disposition", async () => {
    const signed = signedDecision();
    const client = new RecordingClient((sql) => {
      if (sql.name === "governance_verification_material") return one({
        tenant_id: TENANT,
        organization_id: signed.verification.organization_id,
        organization_version: signed.verification.organization_version,
        policy_version: signed.verification.policy_version,
        reviewer_id: signed.verification.reviewer_id,
        reviewer_identity_version: signed.verification.reviewer_identity_version,
        reviewer_roles: [signed.verification.reviewer_role],
        reviewer_record_sha256: SHA_A,
        key_id: signed.verification.key_id,
        public_key_spki_pem: signed.public_key_spki_pem,
        public_key_sha256: signed.public_key_sha256,
        purpose: signed.verification.purpose,
        required_reviewer_role: signed.verification.reviewer_role,
        valid_at_signing_time: true,
        currently_trusted: true,
      });
      if (sql.name === "governance_human_decision_admit") return one({
        tenant_id: TENANT,
        envelope_id: signed.verification.envelope.envelope_id,
        aggregate_id: signed.decision.observation_id,
        aggregate_version: signed.decision.observation_version,
        aggregate_revision: "2",
        envelope_sha256: signed.verification.envelope_sha256,
        signature_sha256: signed.verification.signature_sha256,
        reviewer_id: signed.verification.reviewer_id,
        reviewer_role: signed.verification.reviewer_role,
        key_id: signed.verification.key_id,
        purpose: signed.verification.purpose,
        admitted_at: NOW,
        idempotent_replay: false,
      });
      if (sql.name === "governance_legal_observation_decide") return one(mutationRow({
        content_sha256: legalOperationsSha256(signed.decision),
      }));
      throw new Error(`unexpected:${sql.name}`);
    });
    const repository = new PostgresLegalReconciliationRepository(context(client), TENANT);
    const receipt = await repository.decideObservation({
      candidate: candidate(),
      decision: signed.decision,
      expected_revision: 1,
      claim: { work_item_id: "work.synthetic.legal.001", claimant_id: signed.decision.reviewer_id, fencing_token: 7 },
      verification: signed.verification,
      metadata: { idempotency_key: "idem.synthetic.legal.001", occurred_at: NOW },
    });
    expect(receipt).toMatchObject({
      state: "reconciliation_reviewed_inactive",
      activation_allowed: false,
    });
    expect(client.statements.map((sql) => sql.name)).toEqual([
      "governance_verification_material",
      "governance_human_decision_admit",
      "governance_legal_observation_decide",
    ]);
  });

  it("rejects mutated observations and exact-binding failures before any database call", async () => {
    const client = new RecordingClient(() => { throw new Error("database_must_not_be_called"); });
    const legal = new PostgresLegalReconciliationRepository(context(client), TENANT);
    await expect(legal.importObservation({ ...candidate(), topic: "mutated.topic" }, {
      idempotency_key: "idem.synthetic.mutated", occurred_at: NOW,
    })).rejects.toMatchObject({ code: "GOVERNANCE_HASH_MISMATCH" });

    const fixture = buildSyntheticLegalFixture("minimum_wage");
    const parameter = new PostgresParameterApprovalRepository(context(client), TENANT);
    await expect(parameter.appendAttestation({
      candidate: fixture.parameter,
      attestation: { ...fixture.parameter_attestations[0], candidate_sha256: SHA_A },
      expected_revision: 1,
      claim: { work_item_id: "work.synthetic.parameter.001", claimant_id: fixture.parameter_attestations[0].reviewer_id,
        fencing_token: 1 },
      verification: {} as VerifiedHumanDecision,
      metadata: { idempotency_key: "idem.synthetic.parameter.001", occurred_at: NOW },
    })).rejects.toMatchObject({ code: "GOVERNANCE_HUMAN_DECISION_BINDING_MISMATCH" });

    const rules = new PostgresRuleSpecApprovalRepository(context(client), TENANT);
    await expect(rules.appendApproval({
      rule_spec: fixture.rule,
      approval: fixture.semantic_approvals[0],
      expected_revision: 1,
      claim: { work_item_id: "work.synthetic.rule.001", claimant_id: "different.synthetic.reviewer", fencing_token: 1 },
      verification: {} as VerifiedHumanDecision,
      metadata: { idempotency_key: "idem.synthetic.rule.001", occurred_at: NOW },
    })).rejects.toMatchObject({ code: "GOVERNANCE_HUMAN_DECISION_BINDING_MISMATCH" });
    expect(client.statements).toHaveLength(0);
  });

  it("requires exact bytes for Ground Truth work and permits only the unsigned system disagreement transition", async () => {
    const client = new RecordingClient((sql) => {
      expect(sql.name).toBe("governance_gt_manifest_append");
      return one(mutationRow({
        workflow_kind: "ground_truth",
        aggregate_id: "SYNTHETIC_GT_MANIFEST_001",
        aggregate_version: "1",
        revision: "3",
        state: "disagreement",
      }));
    });
    const work = new PostgresGovernanceWorkRepository(context(client), TENANT);
    await expect(work.enqueue({
      work_item_id: "work.synthetic.gt.001",
      workflow_kind: "ground_truth",
      aggregate_id: "SYNTHETIC_GT_MANIFEST_001",
      aggregate_version: "1",
      work_kind: "ground_truth_annotation",
      required_role: "human_ground_truth_annotator",
      document_sha256: SHA_A,
      object_version_id: null,
      input_sha256: SHA_B,
      payload: { synthetic_test_only: true },
      idempotency_key: "idem.synthetic.gt.enqueue",
      created_at: NOW,
    })).rejects.toMatchObject({ code: "GOVERNANCE_INPUT_INVALID" });
    expect(client.statements).toHaveLength(0);

    const workflow = buildSyntheticGroundTruthWorkflow();
    const groundTruth = new PostgresGroundTruthRepository(context(client), TENANT);
    const receipt = await groundTruth.appendManifest({
      event_kind: "disagreement_recorded",
      prior_manifest: workflow.annotation_2,
      manifest: workflow.disagreement,
      expected_workflow_revision: 2,
      claim: null,
      verification: null,
      metadata: { idempotency_key: "idem.synthetic.gt.disagreement", occurred_at: "2040-05-02T11:00:00.000Z" },
    });
    expect(receipt).toMatchObject({ state: "disagreement", activation_allowed: false });
    expect(client.statements).toHaveLength(1);
  });
});
