import { statement, type PostgresStatement } from "../contracts.ts";

type JsonRecord = Readonly<Record<string, unknown>>;

function json(value: unknown): string {
  return JSON.stringify(value);
}

export function trustOrganizationAppendStatement(input: Readonly<{
  tenant_id: string; record: JsonRecord; actor_id: string; idempotency_key: string;
  command_sha256: string; occurred_at: string;
}>): PostgresStatement {
  return statement("governance_trust_org_append", `select * from private.governance_trust_organization_append(
    $1::text, $2::jsonb, $3::text, $4::text, $5::text, $6::timestamptz
  )`, [input.tenant_id, json(input.record), input.actor_id, input.idempotency_key, input.command_sha256, input.occurred_at]);
}

export function trustPolicyAppendStatement(input: Readonly<{
  tenant_id: string; record: JsonRecord; actor_id: string; idempotency_key: string;
  command_sha256: string; occurred_at: string;
}>): PostgresStatement {
  return statement("governance_trust_policy_append", `select * from private.governance_trust_policy_append(
    $1::text, $2::jsonb, $3::text, $4::text, $5::text, $6::timestamptz
  )`, [input.tenant_id, json(input.record), input.actor_id, input.idempotency_key, input.command_sha256, input.occurred_at]);
}

export function reviewerAppendStatement(input: Readonly<{
  tenant_id: string; record: JsonRecord; actor_id: string; idempotency_key: string;
  command_sha256: string; occurred_at: string;
}>): PostgresStatement {
  return statement("governance_reviewer_append", `select * from private.governance_reviewer_append(
    $1::text, $2::jsonb, $3::text, $4::text, $5::text, $6::timestamptz
  )`, [input.tenant_id, json(input.record), input.actor_id, input.idempotency_key, input.command_sha256, input.occurred_at]);
}

export function keyChallengeAppendStatement(input: Readonly<{
  tenant_id: string; record: JsonRecord; actor_id: string; idempotency_key: string;
  command_sha256: string; occurred_at: string;
}>): PostgresStatement {
  return statement("governance_key_challenge_append", `select * from private.governance_key_challenge_append(
    $1::text, $2::jsonb, $3::text, $4::text, $5::text, $6::timestamptz
  )`, [input.tenant_id, json(input.record), input.actor_id, input.idempotency_key, input.command_sha256, input.occurred_at]);
}

export function reviewerKeyRegisterStatement(input: Readonly<{
  tenant_id: string; challenge_id: string; registered_at: string; proof_signature_sha256: string;
  rotation_authorization_signature_sha256: string | null; idempotency_key: string; command_sha256: string;
}>): PostgresStatement {
  return statement("governance_reviewer_key_register", `select * from private.governance_reviewer_key_register(
    $1::text, $2::text, $3::timestamptz, $4::text, $5::text, $6::text, $7::text
  )`, [input.tenant_id, input.challenge_id, input.registered_at, input.proof_signature_sha256,
    input.rotation_authorization_signature_sha256, input.idempotency_key, input.command_sha256]);
}

export function reviewerKeyRevokeStatement(input: Readonly<{
  tenant_id: string; key_id: string; effective_at: string; reason_code: string; actor_id: string;
  recorded_at: string; idempotency_key: string; command_sha256: string;
}>): PostgresStatement {
  return statement("governance_reviewer_key_revoke", `select * from private.governance_reviewer_key_revoke(
    $1::text, $2::text, $3::timestamptz, $4::text, $5::text, $6::timestamptz, $7::text, $8::text
  )`, [input.tenant_id, input.key_id, input.effective_at, input.reason_code, input.actor_id,
    input.recorded_at, input.idempotency_key, input.command_sha256]);
}

export function reviewerVerificationMaterialReadStatement(input: Readonly<{
  tenant_id: string; organization_id: string; organization_version: string; policy_version: string;
  reviewer_id: string; reviewer_identity_version: string; key_id: string; purpose: string;
  required_reviewer_role: string; issued_at: string; admitted_at: string;
}>): PostgresStatement {
  return statement("governance_verification_material", `select * from private.governance_reviewer_verification_material_read(
    $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text,
    $8::text, $9::text, $10::timestamptz, $11::timestamptz
  )`, [input.tenant_id, input.organization_id, input.organization_version, input.policy_version,
    input.reviewer_id, input.reviewer_identity_version, input.key_id, input.purpose,
    input.required_reviewer_role, input.issued_at, input.admitted_at]);
}

export function humanDecisionAdmitStatement(input: Readonly<{
  tenant_id: string; workflow_kind: string; aggregate_id: string; aggregate_version: string;
  aggregate_revision: number; payload: JsonRecord; payload_sha256: string; verification: JsonRecord;
  idempotency_key: string; command_sha256: string; admitted_at: string;
}>): PostgresStatement {
  return statement("governance_human_decision_admit", `select * from private.governance_human_decision_admit(
    $1::text, $2::text, $3::text, $4::text, $5::bigint, $6::jsonb, $7::text,
    $8::jsonb, $9::text, $10::text, $11::timestamptz
  )`, [input.tenant_id, input.workflow_kind, input.aggregate_id, input.aggregate_version,
    input.aggregate_revision, json(input.payload), input.payload_sha256, json(input.verification),
    input.idempotency_key, input.command_sha256, input.admitted_at]);
}

export function workEnqueueStatement(input: Readonly<{
  tenant_id: string; workflow_kind: string; work_item_id: string; aggregate_id: string;
  aggregate_version: string; work_kind: string; required_role: string; document_sha256: string | null;
  object_version_id: string | null; input_sha256: string; payload: JsonRecord; idempotency_key: string;
  command_sha256: string; created_at: string;
}>): PostgresStatement {
  return statement("governance_work_enqueue", `select * from private.governance_work_enqueue(
    $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text,
    $8::text, $9::text, $10::text, $11::jsonb, $12::text, $13::text, $14::timestamptz
  )`, [input.tenant_id, input.workflow_kind, input.work_item_id, input.aggregate_id,
    input.aggregate_version, input.work_kind, input.required_role, input.document_sha256,
    input.object_version_id, input.input_sha256, json(input.payload), input.idempotency_key,
    input.command_sha256, input.created_at]);
}

export function workClaimStatement(input: Readonly<{
  tenant_id: string; workflow_kind: string; work_kind: string; claimant_id: string;
  reviewer_role: string; now: string; lease_seconds: number;
}>): PostgresStatement {
  return statement("governance_work_claim", `select * from private.governance_work_claim(
    $1::text, $2::text, $3::text, $4::text, $5::text, $6::timestamptz, $7::integer
  )`, [input.tenant_id, input.workflow_kind, input.work_kind, input.claimant_id,
    input.reviewer_role, input.now, input.lease_seconds]);
}

export function workReleaseStatement(input: Readonly<{
  tenant_id: string; work_item_id: string; claimant_id: string; fencing_token: number;
  next_state: string; reason_code: string; occurred_at: string; idempotency_key: string; command_sha256: string;
}>): PostgresStatement {
  return statement("governance_work_release", `select * from private.governance_work_release(
    $1::text, $2::text, $3::text, $4::bigint, $5::text, $6::text, $7::timestamptz, $8::text, $9::text
  )`, [input.tenant_id, input.work_item_id, input.claimant_id, input.fencing_token,
    input.next_state, input.reason_code, input.occurred_at, input.idempotency_key, input.command_sha256]);
}

export function groundTruthEligibilityAppendStatement(input: Readonly<{
  tenant_id: string; decision: JsonRecord; work_item_id: string; claimant_id: string; fencing_token: number;
  envelope_id: string; idempotency_key: string; command_sha256: string; recorded_at: string;
}>): PostgresStatement {
  return statement("governance_gt_eligibility_append", `select * from private.governance_gt_eligibility_append(
    $1::text, $2::jsonb, $3::text, $4::text, $5::bigint, $6::text, $7::text, $8::text, $9::timestamptz
  )`, [input.tenant_id, json(input.decision), input.work_item_id, input.claimant_id,
    input.fencing_token, input.envelope_id, input.idempotency_key, input.command_sha256, input.recorded_at]);
}

export function groundTruthManifestAppendStatement(input: Readonly<{
  tenant_id: string; event_kind: string; manifest: JsonRecord; expected_workflow_revision: number;
  work_item_id: string | null; claimant_id: string | null; fencing_token: number | null;
  envelope_id: string | null; idempotency_key: string; command_sha256: string; recorded_at: string;
}>): PostgresStatement {
  return statement("governance_gt_manifest_append", `select * from private.governance_gt_manifest_append(
    $1::text, $2::text, $3::jsonb, $4::bigint, $5::text, $6::text, $7::bigint,
    $8::text, $9::text, $10::text, $11::timestamptz
  )`, [input.tenant_id, input.event_kind, json(input.manifest), input.expected_workflow_revision,
    input.work_item_id, input.claimant_id, input.fencing_token, input.envelope_id,
    input.idempotency_key, input.command_sha256, input.recorded_at]);
}

export function legalObservationImportStatement(input: Readonly<{
  tenant_id: string; candidate: JsonRecord; idempotency_key: string; command_sha256: string; imported_at: string;
}>): PostgresStatement {
  return statement("governance_legal_observation_import", `select * from private.governance_legal_observation_import(
    $1::text, $2::jsonb, $3::text, $4::text, $5::timestamptz
  )`, [input.tenant_id, json(input.candidate), input.idempotency_key, input.command_sha256, input.imported_at]);
}

export function legalObservationDecideStatement(input: Readonly<{
  tenant_id: string; decision: JsonRecord; expected_revision: number; work_item_id: string;
  claimant_id: string; fencing_token: number; envelope_id: string; idempotency_key: string;
  command_sha256: string; recorded_at: string;
}>): PostgresStatement {
  return statement("governance_legal_observation_decide", `select * from private.governance_legal_observation_decide(
    $1::text, $2::jsonb, $3::bigint, $4::text, $5::text, $6::bigint,
    $7::text, $8::text, $9::text, $10::timestamptz
  )`, [input.tenant_id, json(input.decision), input.expected_revision, input.work_item_id,
    input.claimant_id, input.fencing_token, input.envelope_id, input.idempotency_key,
    input.command_sha256, input.recorded_at]);
}

function fiveArgumentImport(
  name: string,
  text: string,
  input: Readonly<{ tenant_id: string; content: JsonRecord; idempotency_key: string; command_sha256: string; imported_at: string }>,
): PostgresStatement {
  return statement(name, text, [input.tenant_id, json(input.content), input.idempotency_key,
    input.command_sha256, input.imported_at]);
}

export function parameterImportStatement(input: Readonly<{
  tenant_id: string; candidate: JsonRecord; idempotency_key: string; command_sha256: string; imported_at: string;
}>): PostgresStatement {
  return fiveArgumentImport("governance_parameter_import", `select * from private.governance_parameter_import(
    $1::text, $2::jsonb, $3::text, $4::text, $5::timestamptz
  )`, {
    ...input, content: input.candidate,
  });
}

export function goldenCaseSetImportStatement(input: Readonly<{
  tenant_id: string; golden_case_set: JsonRecord; idempotency_key: string; command_sha256: string; imported_at: string;
}>): PostgresStatement {
  return fiveArgumentImport("governance_golden_case_import", `select * from private.governance_golden_case_set_import(
    $1::text, $2::jsonb, $3::text, $4::text, $5::timestamptz
  )`, {
    ...input, content: input.golden_case_set,
  });
}

export function ruleSpecImportStatement(input: Readonly<{
  tenant_id: string; rule_spec: JsonRecord; idempotency_key: string; command_sha256: string; imported_at: string;
}>): PostgresStatement {
  return fiveArgumentImport("governance_rulespec_import", `select * from private.governance_rulespec_import(
    $1::text, $2::jsonb, $3::text, $4::text, $5::timestamptz
  )`, {
    ...input, content: input.rule_spec,
  });
}

function governedApprovalAppend(
  name: string,
  text: string,
  input: Readonly<{
    tenant_id: string; decision: JsonRecord; expected_revision: number; work_item_id: string;
    claimant_id: string; fencing_token: number; envelope_id: string; idempotency_key: string;
    command_sha256: string; recorded_at: string;
  }>,
): PostgresStatement {
  return statement(name, text, [input.tenant_id, json(input.decision), input.expected_revision, input.work_item_id,
    input.claimant_id, input.fencing_token, input.envelope_id, input.idempotency_key,
    input.command_sha256, input.recorded_at]);
}

export function parameterAttestationAppendStatement(input: Parameters<typeof governedApprovalAppend>[2]): PostgresStatement {
  return governedApprovalAppend("governance_parameter_attest", `select * from private.governance_parameter_attestation_append(
    $1::text, $2::jsonb, $3::bigint, $4::text, $5::text, $6::bigint,
    $7::text, $8::text, $9::text, $10::timestamptz
  )`, input);
}

export function ruleSpecApprovalAppendStatement(input: Parameters<typeof governedApprovalAppend>[2]): PostgresStatement {
  return governedApprovalAppend("governance_rulespec_approve", `select * from private.governance_rulespec_approval_append(
    $1::text, $2::jsonb, $3::bigint, $4::text, $5::text, $6::bigint,
    $7::text, $8::text, $9::text, $10::timestamptz
  )`, input);
}

export function aggregateReadStatement(input: Readonly<{
  tenant_id: string; workflow_kind: string; aggregate_id: string; aggregate_version: string;
}>): PostgresStatement {
  return statement("governance_aggregate_read", `select * from private.governance_aggregate_read(
    $1::text, $2::text, $3::text, $4::text
  )`, [input.tenant_id, input.workflow_kind, input.aggregate_id, input.aggregate_version]);
}
