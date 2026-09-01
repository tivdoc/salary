-- Tivdoc V0.10.1 forward-only durable human/legal governance workflows.
-- Private, server-mediated and deliberately non-operative: no source, parameter,
-- RuleSpec or legal observation can be activated by this migration.

create schema if not exists private;

create type private.governance_mutation_receipt as (
  tenant_id text,
  workflow_kind text,
  aggregate_id text,
  aggregate_version text,
  revision bigint,
  state text,
  content_sha256 text,
  audit_event_sha256 text,
  idempotent_replay boolean,
  activation_allowed boolean
);

create type private.governance_human_decision_receipt as (
  tenant_id text,
  envelope_id text,
  aggregate_id text,
  aggregate_version text,
  aggregate_revision bigint,
  envelope_sha256 text,
  signature_sha256 text,
  reviewer_id text,
  reviewer_role text,
  key_id text,
  purpose text,
  admitted_at timestamptz,
  idempotent_replay boolean
);

create type private.governance_verification_material as (
  tenant_id text,
  organization_id text,
  organization_version text,
  policy_version text,
  reviewer_id text,
  reviewer_identity_version text,
  reviewer_roles text[],
  reviewer_record_sha256 text,
  key_id text,
  public_key_spki_pem text,
  public_key_sha256 text,
  purpose text,
  required_reviewer_role text,
  valid_at_signing_time boolean,
  currently_trusted boolean
);

create type private.governance_work_claim_receipt as (
  tenant_id text,
  work_item_id text,
  workflow_kind text,
  aggregate_id text,
  aggregate_version text,
  work_kind text,
  required_role text,
  document_sha256 text,
  object_version_id text,
  input_sha256 text,
  state text,
  claimant_id text,
  fencing_token bigint,
  lease_expires_at timestamptz
);

create table private.governance_reviewer_organizations (
  tenant_id text not null,
  organization_id text not null,
  organization_version text not null,
  record_json jsonb not null check (jsonb_typeof(record_json) = 'object'),
  record_sha256 text not null check (record_sha256 ~ '^[a-f0-9]{64}$'),
  valid_from timestamptz not null,
  expires_at timestamptz,
  actor_id text not null,
  created_at timestamptz not null,
  primary key (tenant_id, organization_id, organization_version),
  check (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'),
  check (organization_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'),
  check (organization_version ~ '^[1-9][0-9]*(\.[0-9]+){0,2}$'),
  check (actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'),
  check (expires_at is null or expires_at > valid_from)
);

create table private.governance_reviewer_policies (
  tenant_id text not null,
  organization_id text not null,
  organization_version text not null,
  policy_version text not null,
  record_json jsonb not null check (jsonb_typeof(record_json) = 'object'),
  policy_sha256 text not null check (policy_sha256 ~ '^[a-f0-9]{64}$'),
  effective_from timestamptz not null,
  expires_at timestamptz,
  actor_id text not null,
  created_at timestamptz not null,
  primary key (tenant_id, organization_id, organization_version, policy_version),
  foreign key (tenant_id, organization_id, organization_version)
    references private.governance_reviewer_organizations(tenant_id, organization_id, organization_version)
    on delete restrict,
  check (policy_version ~ '^[1-9][0-9]*(\.[0-9]+){0,2}$'),
  check (expires_at is null or expires_at > effective_from)
);

create table private.governance_reviewers (
  tenant_id text not null,
  reviewer_id text not null,
  reviewer_identity_version text not null,
  organization_id text not null,
  organization_version text not null,
  record_json jsonb not null check (jsonb_typeof(record_json) = 'object'),
  reviewer_record_sha256 text not null check (reviewer_record_sha256 ~ '^[a-f0-9]{64}$'),
  valid_from timestamptz not null,
  expires_at timestamptz not null,
  actor_id text not null,
  created_at timestamptz not null,
  primary key (tenant_id, reviewer_id, reviewer_identity_version),
  foreign key (tenant_id, organization_id, organization_version)
    references private.governance_reviewer_organizations(tenant_id, organization_id, organization_version)
    on delete restrict,
  check (reviewer_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'),
  check (reviewer_identity_version ~ '^[1-9][0-9]*(\.[0-9]+){0,2}$'),
  check (expires_at > valid_from),
  check (actor_id is distinct from reviewer_id)
);

create table private.governance_key_challenges (
  tenant_id text not null,
  challenge_id text not null,
  reviewer_id text not null,
  reviewer_identity_version text not null,
  organization_id text not null,
  organization_version text not null,
  key_id text not null,
  record_json jsonb not null check (jsonb_typeof(record_json) = 'object'),
  challenge_sha256 text not null check (challenge_sha256 ~ '^[a-f0-9]{64}$'),
  public_key_spki_pem text not null,
  public_key_sha256 text not null check (public_key_sha256 ~ '^[a-f0-9]{64}$'),
  valid_from timestamptz not null,
  expires_at timestamptz not null,
  replaces_key_id text,
  issued_at timestamptz not null,
  challenge_expires_at timestamptz not null,
  actor_id text not null,
  primary key (tenant_id, challenge_id),
  unique (tenant_id, key_id),
  foreign key (tenant_id, reviewer_id, reviewer_identity_version)
    references private.governance_reviewers(tenant_id, reviewer_id, reviewer_identity_version)
    on delete restrict,
  check (expires_at > valid_from),
  check (challenge_expires_at > issued_at),
  check (valid_from >= issued_at),
  check (replaces_key_id is null or replaces_key_id is distinct from key_id)
);

create table private.governance_key_challenge_consumptions (
  tenant_id text not null,
  challenge_id text not null,
  consumed_at timestamptz not null,
  proof_signature_sha256 text not null check (proof_signature_sha256 ~ '^[a-f0-9]{64}$'),
  rotation_authorization_signature_sha256 text
    check (rotation_authorization_signature_sha256 is null or rotation_authorization_signature_sha256 ~ '^[a-f0-9]{64}$'),
  primary key (tenant_id, challenge_id),
  foreign key (tenant_id, challenge_id)
    references private.governance_key_challenges(tenant_id, challenge_id) on delete restrict
);

create table private.governance_reviewer_keys (
  tenant_id text not null,
  key_id text not null,
  challenge_id text not null,
  reviewer_id text not null,
  reviewer_identity_version text not null,
  organization_id text not null,
  organization_version text not null,
  public_key_spki_pem text not null,
  public_key_sha256 text not null check (public_key_sha256 ~ '^[a-f0-9]{64}$'),
  valid_from timestamptz not null,
  expires_at timestamptz not null,
  registered_at timestamptz not null,
  proof_signature_sha256 text not null check (proof_signature_sha256 ~ '^[a-f0-9]{64}$'),
  primary key (tenant_id, key_id),
  foreign key (tenant_id, challenge_id)
    references private.governance_key_challenge_consumptions(tenant_id, challenge_id) on delete restrict,
  foreign key (tenant_id, reviewer_id, reviewer_identity_version)
    references private.governance_reviewers(tenant_id, reviewer_id, reviewer_identity_version)
    on delete restrict,
  check (expires_at > valid_from),
  check (registered_at <= expires_at)
);

create table private.governance_key_rotations (
  tenant_id text not null,
  prior_key_id text not null,
  replacement_key_id text not null,
  rotated_at timestamptz not null,
  authorization_signature_sha256 text not null check (authorization_signature_sha256 ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz not null,
  primary key (tenant_id, prior_key_id),
  unique (tenant_id, replacement_key_id),
  foreign key (tenant_id, prior_key_id)
    references private.governance_reviewer_keys(tenant_id, key_id) on delete restrict,
  foreign key (tenant_id, replacement_key_id)
    references private.governance_reviewer_keys(tenant_id, key_id) on delete restrict,
  check (prior_key_id is distinct from replacement_key_id)
);

create table private.governance_key_revocations (
  tenant_id text not null,
  key_id text not null,
  effective_at timestamptz not null,
  reason_code text not null check (reason_code ~ '^[A-Z][A-Z0-9_]{2,99}$'),
  actor_id text not null,
  recorded_at timestamptz not null,
  primary key (tenant_id, key_id),
  foreign key (tenant_id, key_id)
    references private.governance_reviewer_keys(tenant_id, key_id) on delete restrict,
  check (recorded_at >= effective_at)
);

create table private.governance_human_decisions (
  tenant_id text not null,
  envelope_id text not null,
  workflow_kind text not null,
  aggregate_id text not null,
  aggregate_version text not null,
  aggregate_revision bigint not null check (aggregate_revision > 0),
  envelope_json jsonb not null check (jsonb_typeof(envelope_json) = 'object'),
  envelope_sha256 text not null check (envelope_sha256 ~ '^[a-f0-9]{64}$'),
  signature_sha256 text not null check (signature_sha256 ~ '^[a-f0-9]{64}$'),
  payload_json jsonb not null check (jsonb_typeof(payload_json) = 'object'),
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  organization_id text not null,
  organization_version text not null,
  policy_version text not null,
  reviewer_id text not null,
  reviewer_identity_version text not null,
  reviewer_role text not null,
  key_id text not null,
  purpose text not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  admitted_at timestamptz not null,
  valid_at_signing_time boolean not null check (valid_at_signing_time),
  current_trust_at_admission boolean not null check (current_trust_at_admission),
  primary key (tenant_id, envelope_id),
  unique (tenant_id, envelope_sha256),
  foreign key (tenant_id, organization_id, organization_version)
    references private.governance_reviewer_organizations(tenant_id, organization_id, organization_version)
    on delete restrict,
  foreign key (tenant_id, organization_id, organization_version, policy_version)
    references private.governance_reviewer_policies(tenant_id, organization_id, organization_version, policy_version)
    on delete restrict,
  foreign key (tenant_id, reviewer_id, reviewer_identity_version)
    references private.governance_reviewers(tenant_id, reviewer_id, reviewer_identity_version)
    on delete restrict,
  foreign key (tenant_id, key_id)
    references private.governance_reviewer_keys(tenant_id, key_id) on delete restrict,
  check (workflow_kind in ('ground_truth', 'legal_reconciliation', 'parameter_approval', 'rulespec_approval')),
  check (expires_at > issued_at),
  check (admitted_at >= issued_at and admitted_at <= expires_at)
);

create table private.governance_work_items (
  tenant_id text not null,
  work_item_id text not null,
  workflow_kind text not null,
  aggregate_id text not null,
  aggregate_version text not null,
  work_kind text not null,
  required_role text not null,
  document_sha256 text check (document_sha256 is null or document_sha256 ~ '^[a-f0-9]{64}$'),
  object_version_id text,
  input_sha256 text not null check (input_sha256 ~ '^[a-f0-9]{64}$'),
  payload_json jsonb not null check (jsonb_typeof(payload_json) = 'object'),
  state text not null check (state in ('pending', 'claimed', 'released', 'completed')),
  claimant_id text,
  fencing_token bigint not null default 0 check (fencing_token >= 0),
  lease_expires_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, work_item_id),
  check (workflow_kind in ('reviewer_trust', 'ground_truth', 'legal_reconciliation', 'parameter_approval', 'rulespec_approval')),
  check (work_kind in (
    'ground_truth_visual_eligibility', 'ground_truth_annotation', 'ground_truth_adjudication',
    'ground_truth_lock', 'legal_observation_reconciliation', 'parameter_attestation',
    'rulespec_semantics', 'golden_case_outputs'
  )),
  check (workflow_kind is distinct from 'ground_truth' or (document_sha256 is not null and object_version_id is not null)),
  check (
    (state in ('pending', 'released') and claimant_id is null and lease_expires_at is null)
    or (state = 'claimed' and claimant_id is not null and lease_expires_at is not null)
    or (state = 'completed' and claimant_id is not null and lease_expires_at is null)
  )
);

create table private.governance_gt_eligibility_versions (
  tenant_id text not null,
  eligibility_id text not null,
  document_sha256 text not null check (document_sha256 ~ '^[a-f0-9]{64}$'),
  revision bigint not null check (revision > 0),
  decision_json jsonb not null check (jsonb_typeof(decision_json) = 'object'),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('eligible_for_private_ground_truth_work', 'rejected_for_private_ground_truth_work')),
  envelope_id text not null,
  recorded_at timestamptz not null,
  primary key (tenant_id, eligibility_id, revision),
  unique (tenant_id, document_sha256, revision),
  foreign key (tenant_id, envelope_id)
    references private.governance_human_decisions(tenant_id, envelope_id) on delete restrict
);

create table private.governance_gt_manifest_versions (
  tenant_id text not null,
  manifest_id text not null,
  manifest_revision bigint not null check (manifest_revision > 0),
  workflow_revision bigint not null check (workflow_revision > 0),
  event_kind text not null,
  document_sha256 text not null check (document_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null,
  manifest_json jsonb not null check (jsonb_typeof(manifest_json) = 'object'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  envelope_id text,
  recorded_at timestamptz not null,
  primary key (tenant_id, manifest_id, workflow_revision),
  unique (tenant_id, manifest_id, manifest_sha256),
  foreign key (tenant_id, envelope_id)
    references private.governance_human_decisions(tenant_id, envelope_id) on delete restrict,
  check (event_kind in ('annotation_1_signed', 'annotation_2_signed', 'disagreement_recorded', 'adjudication_signed', 'ground_truth_locked', 'correction_started')),
  check (status in ('annotation_1', 'annotation_2', 'disagreement', 'human_adjudication', 'locked_ground_truth')),
  check ((event_kind = 'disagreement_recorded') = (envelope_id is null))
);

create table private.governance_gt_locks (
  tenant_id text not null,
  document_sha256 text not null,
  manifest_id text not null,
  manifest_revision bigint not null,
  workflow_revision bigint not null,
  locked_sha256 text not null check (locked_sha256 ~ '^[a-f0-9]{64}$'),
  envelope_id text not null,
  locked_at timestamptz not null,
  primary key (tenant_id, document_sha256, manifest_id),
  foreign key (tenant_id, manifest_id, workflow_revision)
    references private.governance_gt_manifest_versions(tenant_id, manifest_id, workflow_revision)
    on delete restrict,
  foreign key (tenant_id, envelope_id)
    references private.governance_human_decisions(tenant_id, envelope_id) on delete restrict
);

-- Mutable projection only: the immutable lock and supersession histories remain
-- authoritative. This primary key makes concurrent active locks for one exact
-- tenant/document pair physically impossible.
create table private.governance_gt_active_locks (
  tenant_id text not null,
  document_sha256 text not null check (document_sha256 ~ '^[a-f0-9]{64}$'),
  manifest_id text not null,
  activated_at timestamptz not null,
  primary key (tenant_id, document_sha256),
  foreign key (tenant_id, document_sha256, manifest_id)
    references private.governance_gt_locks(tenant_id, document_sha256, manifest_id)
    on delete restrict
);

create table private.governance_gt_lock_supersessions (
  tenant_id text not null,
  document_sha256 text not null,
  prior_manifest_id text not null,
  superseding_manifest_id text not null,
  superseded_at timestamptz not null,
  primary key (tenant_id, document_sha256, prior_manifest_id),
  foreign key (tenant_id, document_sha256, prior_manifest_id)
    references private.governance_gt_locks(tenant_id, document_sha256, manifest_id) on delete restrict,
  check (prior_manifest_id is distinct from superseding_manifest_id)
);

create table private.governance_legal_observation_versions (
  tenant_id text not null,
  observation_id text not null,
  observation_version text not null,
  revision bigint not null check (revision > 0),
  state text not null,
  candidate_json jsonb not null check (jsonb_typeof(candidate_json) = 'object'),
  candidate_sha256 text not null check (candidate_sha256 ~ '^[a-f0-9]{64}$'),
  activation_allowed boolean not null default false check (not activation_allowed),
  recorded_at timestamptz not null,
  primary key (tenant_id, observation_id, observation_version, revision),
  check (state in (
    'reconciliation_candidate_inactive', 'reconciliation_rejected',
    'reconciliation_needs_more_evidence', 'reconciliation_superseded',
    'reconciliation_reviewed_inactive'
  ))
);

create table private.governance_legal_observation_decisions (
  tenant_id text not null,
  decision_id text not null,
  observation_id text not null,
  observation_version text not null,
  revision bigint not null check (revision > 1),
  disposition text not null check (disposition in ('accepted', 'rejected', 'needs_more_evidence', 'superseded')),
  reviewer_id text not null,
  decision_json jsonb not null check (jsonb_typeof(decision_json) = 'object'),
  decision_sha256 text not null check (decision_sha256 ~ '^[a-f0-9]{64}$'),
  envelope_id text not null,
  recorded_at timestamptz not null,
  primary key (tenant_id, decision_id),
  unique (tenant_id, observation_id, observation_version, revision),
  foreign key (tenant_id, envelope_id)
    references private.governance_human_decisions(tenant_id, envelope_id) on delete restrict
);

create table private.governance_parameter_versions (
  tenant_id text not null,
  parameter_id text not null,
  parameter_version text not null,
  revision bigint not null check (revision > 0),
  state text not null check (state in ('candidate_inactive', 'awaiting_second_attestation', 'dual_attested_inactive')),
  candidate_json jsonb not null check (jsonb_typeof(candidate_json) = 'object'),
  candidate_sha256 text not null check (candidate_sha256 ~ '^[a-f0-9]{64}$'),
  bindings_sha256 text not null check (bindings_sha256 ~ '^[a-f0-9]{64}$'),
  activation_allowed boolean not null default false check (not activation_allowed),
  recorded_at timestamptz not null,
  primary key (tenant_id, parameter_id, parameter_version, revision)
);

create table private.governance_parameter_attestations (
  tenant_id text not null,
  attestation_id text not null,
  parameter_id text not null,
  parameter_version text not null,
  revision bigint not null check (revision > 1),
  reviewer_id text not null,
  attestation_json jsonb not null check (jsonb_typeof(attestation_json) = 'object'),
  attestation_sha256 text not null check (attestation_sha256 ~ '^[a-f0-9]{64}$'),
  envelope_id text not null,
  recorded_at timestamptz not null,
  primary key (tenant_id, attestation_id),
  unique (tenant_id, parameter_id, parameter_version, reviewer_id),
  unique (tenant_id, parameter_id, parameter_version, revision),
  foreign key (tenant_id, envelope_id)
    references private.governance_human_decisions(tenant_id, envelope_id) on delete restrict
);

create table private.governance_golden_case_sets (
  tenant_id text not null,
  golden_case_set_id text not null,
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  content_json jsonb not null check (jsonb_typeof(content_json) = 'object'),
  recorded_at timestamptz not null,
  primary key (tenant_id, golden_case_set_id),
  unique (tenant_id, content_sha256)
);

create table private.governance_rulespec_versions (
  tenant_id text not null,
  rule_spec_id text not null,
  rule_spec_version text not null,
  revision bigint not null check (revision > 0),
  state text not null check (state in ('candidate_inactive', 'awaiting_complementary_approval', 'dual_approved_inactive')),
  package_json jsonb not null check (jsonb_typeof(package_json) = 'object'),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  golden_case_set_sha256 text not null check (golden_case_set_sha256 ~ '^[a-f0-9]{64}$'),
  activation_allowed boolean not null default false check (not activation_allowed),
  recorded_at timestamptz not null,
  primary key (tenant_id, rule_spec_id, rule_spec_version, revision)
);

create table private.governance_rulespec_approvals (
  tenant_id text not null,
  approval_id text not null,
  rule_spec_id text not null,
  rule_spec_version text not null,
  revision bigint not null check (revision > 1),
  approval_kind text not null check (approval_kind in ('rule_semantics', 'golden_case_outputs')),
  reviewer_id text not null,
  approval_json jsonb not null check (jsonb_typeof(approval_json) = 'object'),
  approval_sha256 text not null check (approval_sha256 ~ '^[a-f0-9]{64}$'),
  envelope_id text not null,
  recorded_at timestamptz not null,
  primary key (tenant_id, approval_id),
  unique (tenant_id, rule_spec_id, rule_spec_version, approval_kind),
  unique (tenant_id, rule_spec_id, rule_spec_version, reviewer_id),
  unique (tenant_id, rule_spec_id, rule_spec_version, revision),
  foreign key (tenant_id, envelope_id)
    references private.governance_human_decisions(tenant_id, envelope_id) on delete restrict
);

create table private.governance_idempotency (
  tenant_id text not null,
  scope text not null,
  idempotency_key text not null,
  command_sha256 text not null check (command_sha256 ~ '^[a-f0-9]{64}$'),
  result_json jsonb not null check (jsonb_typeof(result_json) = 'object'),
  result_sha256 text not null check (result_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  primary key (tenant_id, scope, idempotency_key)
);

create table private.governance_audit_events (
  tenant_id text not null,
  workflow_kind text not null,
  aggregate_id text not null,
  sequence bigint not null check (sequence > 0),
  event_kind text not null,
  detail_sha256 text not null check (detail_sha256 ~ '^[a-f0-9]{64}$'),
  prior_event_sha256 text check (prior_event_sha256 is null or prior_event_sha256 ~ '^[a-f0-9]{64}$'),
  event_sha256 text not null check (event_sha256 ~ '^[a-f0-9]{64}$'),
  actor_id text not null,
  occurred_at timestamptz not null,
  primary key (tenant_id, workflow_kind, aggregate_id, sequence),
  unique (tenant_id, event_sha256)
);

create table private.governance_aggregate_snapshots (
  tenant_id text not null,
  mutation_scope text not null,
  workflow_kind text not null,
  aggregate_id text not null,
  aggregate_version text not null,
  revision bigint not null check (revision > 0),
  state text not null,
  content_json jsonb not null,
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  audit_event_sha256 text not null check (audit_event_sha256 ~ '^[a-f0-9]{64}$'),
  activation_allowed boolean not null default false check (not activation_allowed),
  recorded_at timestamptz not null,
  primary key (tenant_id, mutation_scope, workflow_kind, aggregate_id, aggregate_version, revision)
);

create index governance_work_claim_idx
  on private.governance_work_items(
    tenant_id, workflow_kind, work_kind, state, lease_expires_at, created_at, work_item_id
  );
create index governance_work_claimant_idx
  on private.governance_work_items(tenant_id, claimant_id, state);
create index governance_gt_document_history_idx
  on private.governance_gt_manifest_versions(tenant_id, document_sha256, manifest_revision, workflow_revision);
create index governance_legal_observation_current_idx
  on private.governance_legal_observation_versions(tenant_id, observation_id, observation_version, revision desc);
create index governance_parameter_current_idx
  on private.governance_parameter_versions(tenant_id, parameter_id, parameter_version, revision desc);
create index governance_rulespec_current_idx
  on private.governance_rulespec_versions(tenant_id, rule_spec_id, rule_spec_version, revision desc);
create index governance_audit_chain_idx
  on private.governance_audit_events(tenant_id, workflow_kind, aggregate_id, sequence desc);
create index governance_snapshot_current_idx
  on private.governance_aggregate_snapshots(tenant_id, workflow_kind, aggregate_id, aggregate_version, revision desc);

create function private.governance_jsonb_canonical_text(target jsonb, target_depth integer default 0)
returns text
language plpgsql immutable security definer set search_path = '' as $$
declare
  kind text := pg_catalog.jsonb_typeof(target);
  rendered text;
  current_indent text := pg_catalog.repeat('  ', target_depth);
  child_indent text := pg_catalog.repeat('  ', target_depth + 1);
begin
  if target_depth < 0 or target_depth > 100 then
    raise exception using errcode = '22023', message = 'GOVERNANCE_CANONICAL_JSON_DEPTH_INVALID';
  end if;
  if kind = 'object' then
    select case when pg_catalog.count(*) = 0 then '{}'
      else E'{\n' || pg_catalog.string_agg(
        child_indent || pg_catalog.to_jsonb(entry.key)::text || ': '
          || private.governance_jsonb_canonical_text(entry.value, target_depth + 1),
        E',\n' order by entry.key collate "C"
      ) || E'\n' || current_indent || '}' end into rendered
    from pg_catalog.jsonb_each(target) entry;
    return rendered;
  elsif kind = 'array' then
    select case when pg_catalog.count(*) = 0 then '[]'
      else E'[\n' || pg_catalog.string_agg(
        child_indent || private.governance_jsonb_canonical_text(entry.value, target_depth + 1),
        E',\n' order by entry.ordinality
      ) || E'\n' || current_indent || ']' end into rendered
    from pg_catalog.jsonb_array_elements(target) with ordinality entry(value, ordinality);
    return rendered;
  end if;
  return target::text;
end;
$$;

create function private.governance_jsonb_compact_text(target jsonb, target_depth integer default 0)
returns text
language plpgsql immutable security definer set search_path = '' as $$
declare
  kind text := pg_catalog.jsonb_typeof(target);
  rendered text;
begin
  if target_depth < 0 or target_depth > 100 then
    raise exception using errcode = '22023', message = 'GOVERNANCE_COMPACT_JSON_DEPTH_INVALID';
  end if;
  if kind = 'object' then
    select case when pg_catalog.count(*) = 0 then '{}'
      else '{' || pg_catalog.string_agg(
        pg_catalog.to_jsonb(entry.key)::text || ':'
          || private.governance_jsonb_compact_text(entry.value, target_depth + 1),
        ',' order by entry.key collate "C"
      ) || '}' end into rendered
    from pg_catalog.jsonb_each(target) entry;
    return rendered;
  elsif kind = 'array' then
    select case when pg_catalog.count(*) = 0 then '[]'
      else '[' || pg_catalog.string_agg(
        private.governance_jsonb_compact_text(entry.value, target_depth + 1),
        ',' order by entry.ordinality
      ) || ']' end into rendered
    from pg_catalog.jsonb_array_elements(target) with ordinality entry(value, ordinality);
    return rendered;
  end if;
  return target::text;
end;
$$;

create function private.governance_legal_observation_import(
  target_tenant text,
  target_candidate jsonb,
  target_idempotency_key text,
  target_command_sha256 text,
  target_imported_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  target_id text := target_candidate ->> 'observation_id';
  target_version text := target_candidate ->> 'observation_version';
  target_sha256 text := target_candidate ->> 'candidate_sha256';
  valid_from date := nullif(target_candidate ->> 'candidate_valid_from', '')::date;
  valid_to date := nullif(target_candidate ->> 'candidate_valid_to', '')::date;
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'legal_observation_import', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  if pg_catalog.jsonb_typeof(target_candidate) is distinct from 'object'
     or target_candidate ->> 'schema_version' is distinct from 'tivdoc-durable-governance-v0.10.1'
     or target_candidate ->> 'legal_effect' is distinct from 'unreviewed'
     or coalesce((target_candidate ->> 'activation_allowed')::boolean, true)
     or target_id is null or target_version is null
     or target_sha256 !~ '^[a-f0-9]{64}$'
     or private.governance_jsonb_sha256(target_candidate - 'candidate_sha256') is distinct from target_sha256
     or ((target_candidate ->> 'byte_object_id') is null) is distinct from
        ((target_candidate ->> 'bytes_sha256') is null)
     or ((target_candidate ->> 'bytes_sha256') is not null
         and target_candidate ->> 'bytes_sha256' !~ '^[a-f0-9]{64}$')
     or (valid_from is not null and valid_to is not null and valid_to < valid_from) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_OBSERVATION_INVALID';
  end if;
  insert into private.governance_legal_observation_versions(
    tenant_id, observation_id, observation_version, revision, state,
    candidate_json, candidate_sha256, activation_allowed, recorded_at
  ) values (
    target_tenant, target_id, target_version, 1, 'reconciliation_candidate_inactive',
    target_candidate, target_sha256, false, target_imported_at
  );
  result := private.governance_finish_mutation(
    target_tenant, 'legal_observation_import', target_idempotency_key, target_command_sha256,
    'legal_reconciliation', target_id, target_version, 1,
    'reconciliation_candidate_inactive', target_candidate, target_sha256,
    'legal_observation_imported', 'system_import', target_imported_at, true
  );
  return next result;
end;
$$;

create function private.governance_parameter_import(
  target_tenant text,
  target_candidate jsonb,
  target_idempotency_key text,
  target_command_sha256 text,
  target_imported_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  target_id text := target_candidate ->> 'parameter_id';
  target_version text := target_candidate ->> 'parameter_version';
  target_sha256 text := target_candidate ->> 'candidate_sha256';
  bindings_sha256 text := private.governance_jsonb_sha256(target_candidate -> 'bindings');
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'parameter_import', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  if pg_catalog.jsonb_typeof(target_candidate) is distinct from 'object'
     or target_candidate ->> 'schema_version' is distinct from 'tivdoc-parameter-candidate-v0.6.0'
     or target_id is null or target_version is null
     or target_candidate -> 'bindings' is null
     or target_sha256 !~ '^[a-f0-9]{64}$'
     or private.governance_jsonb_sha256(target_candidate - 'candidate_sha256') is distinct from target_sha256
     or nullif(target_candidate ->> 'effective_to', '')::date <
        nullif(target_candidate ->> 'effective_from', '')::date then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_PARAMETER_CANDIDATE_INVALID';
  end if;
  insert into private.governance_parameter_versions(
    tenant_id, parameter_id, parameter_version, revision, state, candidate_json,
    candidate_sha256, bindings_sha256, activation_allowed, recorded_at
  ) values (
    target_tenant, target_id, target_version, 1, 'candidate_inactive', target_candidate,
    target_sha256, bindings_sha256, false, target_imported_at
  );
  result := private.governance_finish_mutation(
    target_tenant, 'parameter_import', target_idempotency_key, target_command_sha256,
    'parameter_approval', target_id, target_version, 1, 'candidate_inactive',
    target_candidate, target_sha256, 'parameter_candidate_imported',
    'system_import', target_imported_at, true
  );
  return next result;
end;
$$;

create function private.governance_parameter_attestation_append(
  target_tenant text,
  target_attestation jsonb,
  target_expected_revision bigint,
  target_work_item_id text,
  target_claimant_id text,
  target_fencing_token bigint,
  target_envelope_id text,
  target_idempotency_key text,
  target_command_sha256 text,
  target_recorded_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  claim private.governance_work_items%rowtype;
  admission private.governance_human_decisions%rowtype;
  current_version private.governance_parameter_versions%rowtype;
  target_id text := target_attestation ->> 'candidate_id';
  target_version text := target_attestation ->> 'candidate_version';
  next_revision bigint := target_expected_revision + 1;
  prior_count bigint;
  target_state text;
  attestation_sha256 text := private.governance_jsonb_sha256(target_attestation);
  snapshot jsonb;
  snapshot_sha256 text;
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'parameter_attestation_append', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  select * into strict current_version from private.governance_parameter_versions item
  where item.tenant_id = target_tenant and item.parameter_id = target_id
    and item.parameter_version = target_version
  order by item.revision desc limit 1 for update;
  if current_version.revision is distinct from target_expected_revision then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_REVISION_FENCED';
  end if;
  select * into strict claim from private.governance_claim_assert(
    target_tenant, target_work_item_id, target_claimant_id, target_fencing_token,
    'parameter_attestation', target_recorded_at
  );
  select * into strict admission from private.governance_decision_assert(
    target_tenant, target_envelope_id, 'parameter_approval', target_id,
    target_version, next_revision, 'parameter_attestation', 'human_parameter_reviewer',
    target_claimant_id, target_attestation ->> 'signature_sha256'
  );
  if pg_catalog.jsonb_typeof(target_attestation) is distinct from 'object'
     or admission.payload_json is distinct from
        (target_attestation - 'signature_sha256' - 'action_signature_sha256')
     or target_attestation ->> 'schema_version' is distinct from 'tivdoc-parameter-attestation-v0.6.0'
     or target_attestation ->> 'attestation_id' is null
     or target_attestation ->> 'candidate_sha256' is distinct from current_version.candidate_sha256
     or target_attestation ->> 'reviewer_id' is distinct from target_claimant_id
     or target_attestation ->> 'reviewer_role' is distinct from 'human_parameter_reviewer'
     or target_attestation ->> 'decision' is distinct from 'approved'
     or target_attestation ->> 'bindings_sha256' is distinct from current_version.bindings_sha256
     or target_attestation ->> 'unit' is distinct from current_version.candidate_json ->> 'unit'
     or target_attestation ->> 'rounding_policy' is distinct from
        current_version.candidate_json ->> 'rounding_policy'
     or target_attestation -> 'value' is distinct from current_version.candidate_json -> 'value'
     or target_attestation -> 'operative_source_version_ids' is distinct from
        current_version.candidate_json -> 'operative_source_version_ids'
     or claim.workflow_kind is distinct from 'parameter_approval'
     or claim.aggregate_id is distinct from target_id or claim.aggregate_version is distinct from target_version
     or claim.required_role is distinct from 'human_parameter_reviewer' then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_PARAMETER_ATTESTATION_BINDING_MISMATCH';
  end if;
  select pg_catalog.count(*) into prior_count
  from private.governance_parameter_attestations item
  where item.tenant_id = target_tenant and item.parameter_id = target_id
    and item.parameter_version = target_version;
  if prior_count >= 2 or exists (
    select 1 from private.governance_parameter_attestations item
    where item.tenant_id = target_tenant and item.parameter_id = target_id
      and item.parameter_version = target_version
      and item.reviewer_id = target_claimant_id
  ) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_PARAMETER_REVIEWER_SEPARATION_REQUIRED';
  end if;
  if prior_count = 1 and not exists (
    select 1 from pg_catalog.jsonb_array_elements_text(
      current_version.candidate_json -> 'support_roles'
    ) role(value) where role.value = 'primary_binding'
  ) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_PARAMETER_PRIMARY_BINDING_REQUIRED';
  end if;
  target_state := case when prior_count = 0
    then 'awaiting_second_attestation' else 'dual_attested_inactive' end;
  insert into private.governance_parameter_attestations(
    tenant_id, attestation_id, parameter_id, parameter_version, revision,
    reviewer_id, attestation_json, attestation_sha256, envelope_id, recorded_at
  ) values (
    target_tenant, target_attestation ->> 'attestation_id', target_id, target_version,
    next_revision, target_claimant_id, target_attestation, attestation_sha256,
    target_envelope_id, target_recorded_at
  );
  insert into private.governance_parameter_versions(
    tenant_id, parameter_id, parameter_version, revision, state, candidate_json,
    candidate_sha256, bindings_sha256, activation_allowed, recorded_at
  ) values (
    target_tenant, target_id, target_version, next_revision, target_state,
    current_version.candidate_json, current_version.candidate_sha256,
    current_version.bindings_sha256, false, target_recorded_at
  );
  perform private.governance_complete_claim(
    target_tenant, target_work_item_id, target_claimant_id,
    target_fencing_token, target_recorded_at
  );
  snapshot := pg_catalog.jsonb_build_object(
    'candidate', current_version.candidate_json,
    'latest_attestation', target_attestation,
    'attestation_count', prior_count + 1,
    'activation_allowed', false
  );
  snapshot_sha256 := private.governance_jsonb_sha256(snapshot);
  result := private.governance_finish_mutation(
    target_tenant, 'parameter_attestation_append', target_idempotency_key,
    target_command_sha256, 'parameter_approval', target_id, target_version,
    next_revision, target_state, snapshot, snapshot_sha256,
    'parameter_attestation_appended', target_claimant_id, target_recorded_at, true
  );
  return next result;
end;
$$;

create function private.governance_legal_observation_decide(
  target_tenant text,
  target_decision jsonb,
  target_expected_revision bigint,
  target_work_item_id text,
  target_claimant_id text,
  target_fencing_token bigint,
  target_envelope_id text,
  target_idempotency_key text,
  target_command_sha256 text,
  target_recorded_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  claim private.governance_work_items%rowtype;
  admission private.governance_human_decisions%rowtype;
  current_version private.governance_legal_observation_versions%rowtype;
  target_id text := target_decision ->> 'observation_id';
  target_version text := target_decision ->> 'observation_version';
  next_revision bigint := target_expected_revision + 1;
  disposition text := target_decision ->> 'disposition';
  target_state text;
  decision_sha256 text := private.governance_jsonb_sha256(target_decision);
  snapshot jsonb;
  snapshot_sha256 text;
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'legal_observation_decide', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  select * into strict current_version
  from private.governance_legal_observation_versions item
  where item.tenant_id = target_tenant and item.observation_id = target_id
    and item.observation_version = target_version
  order by item.revision desc limit 1 for update;
  if current_version.revision is distinct from target_expected_revision then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_REVISION_FENCED';
  end if;
  select * into strict claim from private.governance_claim_assert(
    target_tenant, target_work_item_id, target_claimant_id, target_fencing_token,
    'legal_observation_reconciliation', target_recorded_at
  );
  select * into strict admission from private.governance_decision_assert(
    target_tenant, target_envelope_id, 'legal_reconciliation', target_id,
    target_version, next_revision, 'source_review', 'human_source_reviewer',
    target_claimant_id, target_decision ->> 'signature_sha256'
  );
  if pg_catalog.jsonb_typeof(target_decision) is distinct from 'object'
     or admission.payload_json is distinct from
        (target_decision - 'signature_sha256' - 'action_signature_sha256')
     or target_decision ->> 'schema_version' is distinct from 'tivdoc-durable-governance-v0.10.1'
     or target_decision ->> 'decision_id' is null
     or target_decision ->> 'candidate_sha256' is distinct from current_version.candidate_sha256
     or target_decision ->> 'reviewer_id' is distinct from target_claimant_id
     or target_decision ->> 'reviewer_role' is distinct from 'human_source_reviewer'
     or target_decision ->> 'legal_effect' is distinct from 'reconciliation_candidate_only'
     or coalesce((target_decision ->> 'activation_allowed')::boolean, true)
     or disposition not in ('accepted', 'rejected', 'needs_more_evidence', 'superseded')
     or claim.workflow_kind is distinct from 'legal_reconciliation'
     or claim.aggregate_id is distinct from target_id or claim.aggregate_version is distinct from target_version
     or claim.required_role is distinct from 'human_source_reviewer' then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_DECISION_BINDING_MISMATCH';
  end if;
  target_state := case disposition
    when 'accepted' then 'reconciliation_reviewed_inactive'
    when 'rejected' then 'reconciliation_rejected'
    when 'needs_more_evidence' then 'reconciliation_needs_more_evidence'
    when 'superseded' then 'reconciliation_superseded'
  end;
  insert into private.governance_legal_observation_decisions(
    tenant_id, decision_id, observation_id, observation_version, revision,
    disposition, reviewer_id, decision_json, decision_sha256, envelope_id, recorded_at
  ) values (
    target_tenant, target_decision ->> 'decision_id', target_id, target_version,
    next_revision, disposition, target_claimant_id, target_decision,
    decision_sha256, target_envelope_id, target_recorded_at
  );
  insert into private.governance_legal_observation_versions(
    tenant_id, observation_id, observation_version, revision, state,
    candidate_json, candidate_sha256, activation_allowed, recorded_at
  ) values (
    target_tenant, target_id, target_version, next_revision, target_state,
    current_version.candidate_json, current_version.candidate_sha256, false, target_recorded_at
  );
  perform private.governance_complete_claim(
    target_tenant, target_work_item_id, target_claimant_id,
    target_fencing_token, target_recorded_at
  );
  snapshot := pg_catalog.jsonb_build_object(
    'candidate', current_version.candidate_json,
    'decision', target_decision,
    'activation_allowed', false
  );
  snapshot_sha256 := private.governance_jsonb_sha256(snapshot);
  result := private.governance_finish_mutation(
    target_tenant, 'legal_observation_decide', target_idempotency_key, target_command_sha256,
    'legal_reconciliation', target_id, target_version, next_revision, target_state,
    snapshot, snapshot_sha256, 'legal_observation_' || disposition,
    target_claimant_id, target_recorded_at, true
  );
  return next result;
end;
$$;

create function private.governance_jsonb_sha256(target jsonb)
returns text
language sql immutable security definer set search_path = '' as $$
  select pg_catalog.encode(public.digest(
    pg_catalog.convert_to(private.governance_jsonb_canonical_text(target) || E'\n', 'UTF8'), 'sha256'
  ), 'hex')
$$;

create function private.governance_forbid_mutation()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'GOVERNANCE_APPEND_ONLY';
end;
$$;

create function private.governance_idempotency_lookup(
  target_tenant text,
  target_scope text,
  target_idempotency_key text,
  target_command_sha256 text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  existing private.governance_idempotency%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    target_tenant || ':governance:idempotency:' || target_scope || ':' || target_idempotency_key, 0
  ));
  select * into existing from private.governance_idempotency item
  where item.tenant_id = target_tenant and item.scope = target_scope
    and item.idempotency_key = target_idempotency_key;
  if existing.idempotency_key is null then return null; end if;
  if existing.command_sha256 is distinct from target_command_sha256 then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_IDEMPOTENCY_COMMAND_MISMATCH';
  end if;
  return existing.result_json;
end;
$$;

create function private.governance_store_idempotency(
  target_tenant text,
  target_scope text,
  target_idempotency_key text,
  target_command_sha256 text,
  target_result jsonb,
  target_created_at timestamptz
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into private.governance_idempotency(
    tenant_id, scope, idempotency_key, command_sha256,
    result_json, result_sha256, created_at
  ) values (
    target_tenant, target_scope, target_idempotency_key, target_command_sha256,
    target_result, private.governance_jsonb_sha256(target_result), target_created_at
  );
end;
$$;

create function private.governance_append_audit(
  target_tenant text,
  target_workflow_kind text,
  target_aggregate_id text,
  target_event_kind text,
  target_detail_sha256 text,
  target_actor_id text,
  target_occurred_at timestamptz
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  next_sequence bigint;
  prior_sha256 text;
  next_sha256 text;
  audit_payload jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    private.governance_jsonb_canonical_text(pg_catalog.jsonb_build_object(
      'tenant_id', target_tenant,
      'workflow_kind', target_workflow_kind,
      'aggregate_id', target_aggregate_id
    )), 0
  ));
  select event.sequence + 1, event.event_sha256
    into next_sequence, prior_sha256
  from private.governance_audit_events event
  where event.tenant_id = target_tenant and event.workflow_kind = target_workflow_kind
    and event.aggregate_id = target_aggregate_id
  order by event.sequence desc limit 1;
  next_sequence := coalesce(next_sequence, 1);
  audit_payload := pg_catalog.jsonb_build_object(
    'tenant_id', target_tenant,
    'workflow_kind', target_workflow_kind,
    'aggregate_id', target_aggregate_id,
    'sequence', next_sequence,
    'event_kind', target_event_kind,
    'detail_sha256', target_detail_sha256,
    'prior_event_sha256', prior_sha256,
    'actor_id', target_actor_id,
    'occurred_at_utc', pg_catalog.to_char(
      target_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  );
  next_sha256 := private.governance_jsonb_sha256(audit_payload);
  insert into private.governance_audit_events(
    tenant_id, workflow_kind, aggregate_id, sequence, event_kind, detail_sha256,
    prior_event_sha256, event_sha256, actor_id, occurred_at
  ) values (
    target_tenant, target_workflow_kind, target_aggregate_id, next_sequence,
    target_event_kind, target_detail_sha256, prior_sha256, next_sha256,
    target_actor_id, target_occurred_at
  );
  return next_sha256;
end;
$$;

create function private.governance_finish_mutation(
  target_tenant text,
  target_scope text,
  target_idempotency_key text,
  target_command_sha256 text,
  target_workflow_kind text,
  target_aggregate_id text,
  target_aggregate_version text,
  target_revision bigint,
  target_state text,
  target_content_json jsonb,
  target_content_sha256 text,
  target_event_kind text,
  target_actor_id text,
  target_occurred_at timestamptz,
  target_store_snapshot boolean
) returns private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  audit_sha256 text;
  result private.governance_mutation_receipt;
  result_json jsonb;
begin
  audit_sha256 := private.governance_append_audit(
    target_tenant, target_workflow_kind, target_aggregate_id, target_event_kind,
    target_content_sha256, target_actor_id, target_occurred_at
  );
  result := row(
    target_tenant, target_workflow_kind, target_aggregate_id, target_aggregate_version,
    target_revision, target_state, target_content_sha256, audit_sha256, false, false
  )::private.governance_mutation_receipt;
  result_json := pg_catalog.to_jsonb(result);
  perform private.governance_store_idempotency(
    target_tenant, target_scope, target_idempotency_key, target_command_sha256,
    result_json, target_occurred_at
  );
  if target_store_snapshot then
    insert into private.governance_aggregate_snapshots(
      tenant_id, mutation_scope, workflow_kind, aggregate_id, aggregate_version, revision, state,
      content_json, content_sha256, audit_event_sha256, activation_allowed, recorded_at
    ) values (
      target_tenant, target_scope, target_workflow_kind, target_aggregate_id, target_aggregate_version,
      target_revision, target_state, target_content_json, target_content_sha256,
      audit_sha256, false, target_occurred_at
    );
  end if;
  return result;
end;
$$;

create function private.governance_claim_assert(
  target_tenant text,
  target_work_item_id text,
  target_claimant_id text,
  target_fencing_token bigint,
  target_expected_work_kind text,
  target_occurred_at timestamptz
) returns setof private.governance_work_items
language plpgsql security definer set search_path = '' as $$
begin
  return query
  select item.* from private.governance_work_items item
  where item.tenant_id = target_tenant and item.work_item_id = target_work_item_id
    and item.state = 'claimed' and item.claimant_id = target_claimant_id
    and item.fencing_token = target_fencing_token
    and item.work_kind = target_expected_work_kind
    and item.lease_expires_at > pg_catalog.statement_timestamp()
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_WORK_CLAIM_FENCED';
  end if;
end;
$$;

create function private.governance_complete_claim(
  target_tenant text,
  target_work_item_id text,
  target_claimant_id text,
  target_fencing_token bigint,
  target_occurred_at timestamptz
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update private.governance_work_items item
  set state = 'completed', lease_expires_at = null, updated_at = pg_catalog.statement_timestamp()
  where item.tenant_id = target_tenant and item.work_item_id = target_work_item_id
    and item.state = 'claimed' and item.claimant_id = target_claimant_id
    and item.fencing_token = target_fencing_token
    and item.lease_expires_at > pg_catalog.statement_timestamp();
  if not found then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_WORK_CLAIM_FENCED';
  end if;
end;
$$;

create function private.governance_trust_organization_append(
  target_tenant text,
  target_record jsonb,
  target_actor_id text,
  target_idempotency_key text,
  target_command_sha256 text,
  target_occurred_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  target_id text := target_record ->> 'organization_id';
  target_version text := target_record ->> 'organization_version';
  target_sha256 text := target_record ->> 'organization_record_sha256';
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'trust_organization_append', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  if jsonb_typeof(target_record) is distinct from 'object'
     or target_record ->> 'schema_version' is distinct from 'tivdoc-reviewer-trust-v0.10.0'
     or target_sha256 !~ '^[a-f0-9]{64}$'
     or private.governance_jsonb_sha256(target_record - 'organization_record_sha256') is distinct from target_sha256
     or not exists (
       select 1 from pg_catalog.jsonb_array_elements_text(target_record -> 'policy_admin_ids') admin(value)
       where admin.value = target_actor_id
     ) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TRUST_ORGANIZATION_INVALID';
  end if;
  insert into private.governance_reviewer_organizations(
    tenant_id, organization_id, organization_version, record_json, record_sha256,
    valid_from, expires_at, actor_id, created_at
  ) values (
    target_tenant, target_id, target_version, target_record, target_sha256,
    (target_record ->> 'valid_from')::timestamptz,
    nullif(target_record ->> 'expires_at', '')::timestamptz,
    target_actor_id, target_occurred_at
  );
  result := private.governance_finish_mutation(
    target_tenant, 'trust_organization_append', target_idempotency_key, target_command_sha256,
    'reviewer_trust', target_id, target_version, 1, 'organization_registered',
    target_record, target_sha256, 'organization_registered', target_actor_id,
    target_occurred_at, true
  );
  return next result;
end;
$$;

create function private.governance_trust_policy_append(
  target_tenant text,
  target_record jsonb,
  target_actor_id text,
  target_idempotency_key text,
  target_command_sha256 text,
  target_occurred_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  organization private.governance_reviewer_organizations%rowtype;
  target_id text := target_record ->> 'organization_id';
  organization_version text := target_record ->> 'organization_version';
  target_version text := target_record ->> 'policy_version';
  target_sha256 text := target_record ->> 'policy_sha256';
  effective_at timestamptz;
  target_expires_at timestamptz;
  max_envelope_ttl_seconds integer;
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'trust_policy_append', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  select * into strict organization from private.governance_reviewer_organizations item
  where item.tenant_id = target_tenant and item.organization_id = target_id
    and item.organization_version = organization_version;
  effective_at := (target_record ->> 'effective_from')::timestamptz;
  target_expires_at := nullif(target_record ->> 'expires_at', '')::timestamptz;
  if target_record ->> 'max_envelope_ttl_seconds' !~ '^[0-9]{2,6}$' then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TRUST_POLICY_TTL_INVALID';
  end if;
  max_envelope_ttl_seconds := (target_record ->> 'max_envelope_ttl_seconds')::integer;
  if target_record ->> 'schema_version' is distinct from 'tivdoc-reviewer-trust-v0.10.0'
     or target_sha256 !~ '^[a-f0-9]{64}$'
     or private.governance_jsonb_sha256(target_record - 'policy_sha256') is distinct from target_sha256
     or not exists (
       select 1 from pg_catalog.jsonb_array_elements_text(organization.record_json -> 'policy_admin_ids') admin(value)
       where admin.value = target_actor_id
     )
     or max_envelope_ttl_seconds < 60 or max_envelope_ttl_seconds > 604800
     or effective_at < organization.valid_from
     or (organization.expires_at is not null and (effective_at >= organization.expires_at
       or target_expires_at > organization.expires_at)) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TRUST_POLICY_INVALID';
  end if;
  insert into private.governance_reviewer_policies(
    tenant_id, organization_id, organization_version, policy_version, record_json,
    policy_sha256, effective_from, expires_at, actor_id, created_at
  ) values (
    target_tenant, target_id, organization_version, target_version, target_record,
    target_sha256, effective_at, target_expires_at, target_actor_id, target_occurred_at
  );
  result := private.governance_finish_mutation(
    target_tenant, 'trust_policy_append', target_idempotency_key, target_command_sha256,
    'reviewer_trust', target_id, target_version, 1, 'policy_published',
    target_record, target_sha256, 'policy_published', target_actor_id,
    target_occurred_at, true
  );
  return next result;
end;
$$;

create function private.governance_reviewer_append(
  target_tenant text,
  target_record jsonb,
  target_actor_id text,
  target_idempotency_key text,
  target_command_sha256 text,
  target_occurred_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  organization private.governance_reviewer_organizations%rowtype;
  policy private.governance_reviewer_policies%rowtype;
  target_id text := target_record ->> 'reviewer_id';
  target_version text := target_record ->> 'reviewer_identity_version';
  target_sha256 text := target_record ->> 'reviewer_record_sha256';
  valid_at timestamptz;
  expires_at timestamptz;
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'reviewer_append', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  select * into strict organization from private.governance_reviewer_organizations item
  where item.tenant_id = target_tenant
    and item.organization_id = target_record ->> 'organization_id'
    and item.organization_version = target_record ->> 'organization_version';
  valid_at := (target_record ->> 'valid_from')::timestamptz;
  expires_at := (target_record ->> 'expires_at')::timestamptz;
  select * into strict policy from private.governance_reviewer_policies item
  where item.tenant_id = target_tenant and item.organization_id = organization.organization_id
    and item.organization_version = organization.organization_version
    and item.effective_from <= valid_at and (item.expires_at is null or item.expires_at > valid_at)
  order by item.effective_from desc, item.policy_version desc limit 1;
  if target_record ->> 'schema_version' is distinct from 'tivdoc-reviewer-trust-v0.10.0'
     or target_id = target_actor_id
     or target_sha256 !~ '^[a-f0-9]{64}$'
     or private.governance_jsonb_sha256(target_record - 'reviewer_record_sha256') is distinct from target_sha256
     or not exists (
       select 1 from pg_catalog.jsonb_array_elements_text(organization.record_json -> 'policy_admin_ids') admin(value)
       where admin.value = target_actor_id
     )
     or valid_at < organization.valid_from or expires_at > coalesce(organization.expires_at, expires_at)
     or exists (
       select 1 from pg_catalog.jsonb_array_elements_text(target_record -> 'reviewer_roles') reviewer_role(value)
       where not exists (
         select 1 from pg_catalog.jsonb_array_elements(policy.record_json -> 'grants') grant(value)
         where grant.value ->> 'reviewer_role' = reviewer_role.value
       )
     ) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_REVIEWER_INVALID';
  end if;
  insert into private.governance_reviewers(
    tenant_id, reviewer_id, reviewer_identity_version, organization_id, organization_version,
    record_json, reviewer_record_sha256, valid_from, expires_at, actor_id, created_at
  ) values (
    target_tenant, target_id, target_version, organization.organization_id,
    organization.organization_version, target_record, target_sha256,
    valid_at, expires_at, target_actor_id, target_occurred_at
  );
  result := private.governance_finish_mutation(
    target_tenant, 'reviewer_append', target_idempotency_key, target_command_sha256,
    'reviewer_trust', target_id, target_version, 1, 'reviewer_registered',
    target_record, target_sha256, 'reviewer_registered', target_actor_id,
    target_occurred_at, true
  );
  return next result;
end;
$$;

create function private.governance_key_challenge_append(
  target_tenant text,
  target_record jsonb,
  target_actor_id text,
  target_idempotency_key text,
  target_command_sha256 text,
  target_occurred_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  reviewer private.governance_reviewers%rowtype;
  organization private.governance_reviewer_organizations%rowtype;
  prior_key private.governance_reviewer_keys%rowtype;
  target_sha256 text := private.governance_jsonb_sha256(target_record);
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'key_challenge_append', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  select * into strict reviewer from private.governance_reviewers item
  where item.tenant_id = target_tenant and item.reviewer_id = target_record ->> 'reviewer_id'
    and item.reviewer_identity_version = target_record ->> 'reviewer_identity_version';
  select * into strict organization from private.governance_reviewer_organizations item
  where item.tenant_id = target_tenant and item.organization_id = reviewer.organization_id
    and item.organization_version = reviewer.organization_version;
  if target_record ->> 'schema_version' is distinct from 'tivdoc-key-possession-challenge-v0.10.0'
     or target_record ->> 'organization_id' is distinct from reviewer.organization_id
     or target_record ->> 'organization_version' is distinct from reviewer.organization_version
     or target_record ->> 'public_key_sha256' !~ '^[a-f0-9]{64}$'
     or (target_record ->> 'valid_from')::timestamptz < reviewer.valid_from
     or (target_record ->> 'expires_at')::timestamptz > reviewer.expires_at
     or (target_record ->> 'issued_at')::timestamptz > (target_record ->> 'valid_from')::timestamptz
     or target_occurred_at is distinct from (target_record ->> 'issued_at')::timestamptz then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_KEY_CHALLENGE_INVALID';
  end if;
  if target_record ->> 'replaces_key_id' is null then
    if not exists (
      select 1 from pg_catalog.jsonb_array_elements_text(organization.record_json -> 'policy_admin_ids') admin(value)
      where admin.value = target_actor_id
    ) then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_KEY_CHALLENGE_ACTOR_FORBIDDEN';
    end if;
  else
    select * into strict prior_key from private.governance_reviewer_keys item
    where item.tenant_id = target_tenant and item.key_id = target_record ->> 'replaces_key_id';
    if prior_key.reviewer_id is distinct from reviewer.reviewer_id
       or (target_actor_id is distinct from reviewer.reviewer_id and not exists (
         select 1 from pg_catalog.jsonb_array_elements_text(organization.record_json -> 'policy_admin_ids') admin(value)
         where admin.value = target_actor_id
       )) then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_KEY_ROTATION_ACTOR_FORBIDDEN';
    end if;
  end if;
  insert into private.governance_key_challenges(
    tenant_id, challenge_id, reviewer_id, reviewer_identity_version,
    organization_id, organization_version, key_id, record_json, challenge_sha256,
    public_key_spki_pem, public_key_sha256, valid_from, expires_at, replaces_key_id,
    issued_at, challenge_expires_at, actor_id
  ) values (
    target_tenant, target_record ->> 'challenge_id', reviewer.reviewer_id,
    reviewer.reviewer_identity_version, reviewer.organization_id, reviewer.organization_version,
    target_record ->> 'key_id', target_record, target_sha256,
    target_record ->> 'public_key_spki_pem', target_record ->> 'public_key_sha256',
    (target_record ->> 'valid_from')::timestamptz, (target_record ->> 'expires_at')::timestamptz,
    target_record ->> 'replaces_key_id', (target_record ->> 'issued_at')::timestamptz,
    (target_record ->> 'challenge_expires_at')::timestamptz, target_actor_id
  );
  result := private.governance_finish_mutation(
    target_tenant, 'key_challenge_append', target_idempotency_key, target_command_sha256,
    'reviewer_trust', target_record ->> 'key_id', reviewer.reviewer_identity_version,
    1, 'key_challenge_issued', target_record, target_sha256,
    'key_challenge_issued', target_actor_id, target_occurred_at, true
  );
  return next result;
end;
$$;

create function private.governance_reviewer_key_register(
  target_tenant text,
  target_challenge_id text,
  target_registered_at timestamptz,
  target_proof_signature_sha256 text,
  target_rotation_authorization_signature_sha256 text,
  target_idempotency_key text,
  target_command_sha256 text
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  challenge private.governance_key_challenges%rowtype;
  prior_key private.governance_reviewer_keys%rowtype;
  event_state text := 'key_registered';
  content jsonb;
  content_sha256 text;
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'reviewer_key_register', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  select * into strict challenge from private.governance_key_challenges item
  where item.tenant_id = target_tenant and item.challenge_id = target_challenge_id for update;
  if target_registered_at > challenge.challenge_expires_at
     or target_registered_at < challenge.issued_at
     or target_proof_signature_sha256 !~ '^[a-f0-9]{64}$'
     or exists (
       select 1 from private.governance_key_challenge_consumptions used
       where used.tenant_id = target_tenant and used.challenge_id = target_challenge_id
     ) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_KEY_REGISTRATION_INVALID';
  end if;
  if challenge.replaces_key_id is null then
    if target_rotation_authorization_signature_sha256 is not null then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_KEY_ROTATION_AUTHORIZATION_UNEXPECTED';
    end if;
  else
    if target_rotation_authorization_signature_sha256 !~ '^[a-f0-9]{64}$' then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_KEY_ROTATION_AUTHORIZATION_REQUIRED';
    end if;
    select * into strict prior_key from private.governance_reviewer_keys item
    where item.tenant_id = target_tenant and item.key_id = challenge.replaces_key_id for update;
    if prior_key.reviewer_id is distinct from challenge.reviewer_id
       or prior_key.organization_id is distinct from challenge.organization_id
       or exists (select 1 from private.governance_key_rotations rotation
         where rotation.tenant_id = target_tenant and rotation.prior_key_id = prior_key.key_id)
       or exists (select 1 from private.governance_key_revocations revocation
         where revocation.tenant_id = target_tenant and revocation.key_id = prior_key.key_id
           and revocation.effective_at <= target_registered_at) then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_KEY_ROTATION_INVALID';
    end if;
    event_state := 'key_rotated';
  end if;
  insert into private.governance_key_challenge_consumptions(
    tenant_id, challenge_id, consumed_at, proof_signature_sha256,
    rotation_authorization_signature_sha256
  ) values (
    target_tenant, target_challenge_id, target_registered_at, target_proof_signature_sha256,
    target_rotation_authorization_signature_sha256
  );
  insert into private.governance_reviewer_keys(
    tenant_id, key_id, challenge_id, reviewer_id, reviewer_identity_version,
    organization_id, organization_version, public_key_spki_pem, public_key_sha256,
    valid_from, expires_at, registered_at, proof_signature_sha256
  ) values (
    target_tenant, challenge.key_id, challenge.challenge_id, challenge.reviewer_id,
    challenge.reviewer_identity_version, challenge.organization_id, challenge.organization_version,
    challenge.public_key_spki_pem, challenge.public_key_sha256, challenge.valid_from,
    challenge.expires_at, target_registered_at, target_proof_signature_sha256
  );
  if challenge.replaces_key_id is not null then
    insert into private.governance_key_rotations(
      tenant_id, prior_key_id, replacement_key_id, rotated_at,
      authorization_signature_sha256, recorded_at
    ) values (
      target_tenant, challenge.replaces_key_id, challenge.key_id, challenge.valid_from,
      target_rotation_authorization_signature_sha256, target_registered_at
    );
  end if;
  content := pg_catalog.jsonb_build_object(
    'key_id', challenge.key_id,
    'public_key_sha256', challenge.public_key_sha256,
    'proof_signature_sha256', target_proof_signature_sha256,
    'replaces_key_id', challenge.replaces_key_id,
    'rotation_authorization_signature_sha256', target_rotation_authorization_signature_sha256,
    'registered_at', target_registered_at
  );
  content_sha256 := private.governance_jsonb_sha256(content);
  result := private.governance_finish_mutation(
    target_tenant, 'reviewer_key_register', target_idempotency_key, target_command_sha256,
    'reviewer_trust', challenge.key_id, challenge.reviewer_identity_version,
    1, event_state, content, content_sha256, event_state,
    challenge.reviewer_id, target_registered_at, true
  );
  return next result;
end;
$$;

create function private.governance_reviewer_key_revoke(
  target_tenant text,
  target_key_id text,
  target_effective_at timestamptz,
  target_reason_code text,
  target_actor_id text,
  target_recorded_at timestamptz,
  target_idempotency_key text,
  target_command_sha256 text
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  trusted_key private.governance_reviewer_keys%rowtype;
  organization private.governance_reviewer_organizations%rowtype;
  content jsonb;
  content_sha256 text;
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'reviewer_key_revoke', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  select * into strict trusted_key from private.governance_reviewer_keys item
  where item.tenant_id = target_tenant and item.key_id = target_key_id for update;
  select * into strict organization from private.governance_reviewer_organizations item
  where item.tenant_id = target_tenant and item.organization_id = trusted_key.organization_id
    and item.organization_version = trusted_key.organization_version;
  if target_reason_code !~ '^[A-Z][A-Z0-9_]{2,99}$'
     or target_effective_at < trusted_key.valid_from or target_recorded_at < target_effective_at
     or (target_actor_id is distinct from trusted_key.reviewer_id and not exists (
       select 1 from pg_catalog.jsonb_array_elements_text(organization.record_json -> 'policy_admin_ids') admin(value)
       where admin.value = target_actor_id
     )) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_KEY_REVOCATION_INVALID';
  end if;
  insert into private.governance_key_revocations(
    tenant_id, key_id, effective_at, reason_code, actor_id, recorded_at
  ) values (
    target_tenant, target_key_id, target_effective_at, target_reason_code,
    target_actor_id, target_recorded_at
  );
  content := pg_catalog.jsonb_build_object(
    'key_id', target_key_id, 'effective_at', target_effective_at,
    'reason_code', target_reason_code, 'actor_id', target_actor_id,
    'recorded_at', target_recorded_at
  );
  content_sha256 := private.governance_jsonb_sha256(content);
  result := private.governance_finish_mutation(
    target_tenant, 'reviewer_key_revoke', target_idempotency_key, target_command_sha256,
    'reviewer_trust', target_key_id, trusted_key.reviewer_identity_version,
    2, 'key_revoked', content, content_sha256, 'key_revoked',
    target_actor_id, target_recorded_at, true
  );
  return next result;
end;
$$;

create function private.governance_reviewer_verification_material_read(
  target_tenant text,
  target_organization_id text,
  target_organization_version text,
  target_policy_version text,
  target_reviewer_id text,
  target_reviewer_identity_version text,
  target_key_id text,
  target_purpose text,
  target_required_reviewer_role text,
  target_issued_at timestamptz,
  target_admitted_at timestamptz
) returns setof private.governance_verification_material
language plpgsql stable security definer set search_path = '' as $$
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  return query
  select
    target_tenant,
    organization.organization_id,
    organization.organization_version,
    policy.policy_version,
    reviewer.reviewer_id,
    reviewer.reviewer_identity_version,
    array(select role.value from pg_catalog.jsonb_array_elements_text(reviewer.record_json -> 'reviewer_roles') role(value)),
    reviewer.reviewer_record_sha256,
    trusted_key.key_id,
    trusted_key.public_key_spki_pem,
    trusted_key.public_key_sha256,
    target_purpose,
    target_required_reviewer_role,
    (
      organization.valid_from <= target_issued_at
      and (organization.expires_at is null or organization.expires_at > target_issued_at)
      and policy.effective_from <= target_issued_at
      and (policy.expires_at is null or policy.expires_at > target_issued_at)
      and reviewer.valid_from <= target_issued_at and reviewer.expires_at > target_issued_at
      and trusted_key.valid_from <= target_issued_at and trusted_key.expires_at > target_issued_at
      and exists (
        select 1 from pg_catalog.jsonb_array_elements_text(reviewer.record_json -> 'reviewer_roles') role(value)
        where role.value = target_required_reviewer_role
      )
      and exists (
        select 1 from pg_catalog.jsonb_array_elements(policy.record_json -> 'grants') grant(value),
          pg_catalog.jsonb_array_elements_text(grant.value -> 'purposes') purpose(value)
        where grant.value ->> 'reviewer_role' = target_required_reviewer_role
          and purpose.value = target_purpose
      )
      and not exists (
        select 1 from private.governance_reviewer_policies newer_policy
        where newer_policy.tenant_id = policy.tenant_id
          and newer_policy.organization_id = policy.organization_id
          and newer_policy.organization_version = policy.organization_version
          and newer_policy.effective_from <= target_issued_at
          and (
            newer_policy.effective_from > policy.effective_from
            or (
              newer_policy.effective_from = policy.effective_from
              and pg_catalog.string_to_array(newer_policy.policy_version, '.')::integer[]
                > pg_catalog.string_to_array(policy.policy_version, '.')::integer[]
            )
          )
      )
      and not exists (
        select 1 from private.governance_key_rotations rotation
        where rotation.tenant_id = target_tenant and rotation.prior_key_id = target_key_id
          and rotation.rotated_at <= target_issued_at
      )
      and not exists (
        select 1 from private.governance_key_revocations revocation
        where revocation.tenant_id = target_tenant and revocation.key_id = target_key_id
          and revocation.effective_at <= target_issued_at
      )
    ) as valid_at_signing_time,
    (
      organization.valid_from <= target_admitted_at
      and (organization.expires_at is null or organization.expires_at > target_admitted_at)
      and policy.effective_from <= target_admitted_at
      and (policy.expires_at is null or policy.expires_at > target_admitted_at)
      and reviewer.valid_from <= target_admitted_at and reviewer.expires_at > target_admitted_at
      and trusted_key.valid_from <= target_admitted_at and trusted_key.expires_at > target_admitted_at
      and not exists (
        select 1 from private.governance_reviewer_policies newer_policy
        where newer_policy.tenant_id = policy.tenant_id
          and newer_policy.organization_id = policy.organization_id
          and newer_policy.organization_version = policy.organization_version
          and newer_policy.effective_from <= target_admitted_at
          and (
            newer_policy.effective_from > policy.effective_from
            or (
              newer_policy.effective_from = policy.effective_from
              and pg_catalog.string_to_array(newer_policy.policy_version, '.')::integer[]
                > pg_catalog.string_to_array(policy.policy_version, '.')::integer[]
            )
          )
      )
      and not exists (
        select 1 from private.governance_key_rotations rotation
        where rotation.tenant_id = target_tenant and rotation.prior_key_id = target_key_id
          and rotation.rotated_at <= target_admitted_at
      )
      and not exists (
        select 1 from private.governance_key_revocations revocation
        where revocation.tenant_id = target_tenant and revocation.key_id = target_key_id
          and revocation.effective_at <= target_admitted_at
      )
    ) as currently_trusted
  from private.governance_reviewer_organizations organization
  join private.governance_reviewer_policies policy
    on policy.tenant_id = organization.tenant_id
   and policy.organization_id = organization.organization_id
   and policy.organization_version = organization.organization_version
  join private.governance_reviewers reviewer
    on reviewer.tenant_id = organization.tenant_id
   and reviewer.organization_id = organization.organization_id
   and reviewer.organization_version = organization.organization_version
  join private.governance_reviewer_keys trusted_key
    on trusted_key.tenant_id = reviewer.tenant_id
   and trusted_key.reviewer_id = reviewer.reviewer_id
   and trusted_key.reviewer_identity_version = reviewer.reviewer_identity_version
  where organization.tenant_id = target_tenant
    and organization.organization_id = target_organization_id
    and organization.organization_version = target_organization_version
    and policy.policy_version = target_policy_version
    and reviewer.reviewer_id = target_reviewer_id
    and reviewer.reviewer_identity_version = target_reviewer_identity_version
    and trusted_key.key_id = target_key_id;
end;
$$;

create function private.governance_human_decision_admit(
  target_tenant text,
  target_workflow_kind text,
  target_aggregate_id text,
  target_aggregate_version text,
  target_aggregate_revision bigint,
  target_payload jsonb,
  target_payload_sha256 text,
  target_verification jsonb,
  target_idempotency_key text,
  target_command_sha256 text,
  target_admitted_at timestamptz
) returns setof private.governance_human_decision_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_human_decision_receipt;
  result_json jsonb;
  envelope jsonb := target_verification -> 'envelope';
  material private.governance_verification_material;
  policy private.governance_reviewer_policies%rowtype;
  audit_sha256 text;
  envelope_sha256 text := target_verification ->> 'envelope_sha256';
  signature_sha256 text := target_verification ->> 'signature_sha256';
  target_envelope_id text := envelope ->> 'envelope_id';
  database_admitted_at timestamptz := pg_catalog.statement_timestamp();
  max_envelope_ttl_seconds integer;
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'human_decision_admit', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_human_decision_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  if target_workflow_kind not in ('ground_truth', 'legal_reconciliation', 'parameter_approval', 'rulespec_approval')
     or target_aggregate_revision < 1
     or jsonb_typeof(target_payload) is distinct from 'object' or jsonb_typeof(target_verification) is distinct from 'object'
     or jsonb_typeof(envelope) is distinct from 'object'
     or envelope ->> 'schema_version' is distinct from 'tivdoc-human-decision-envelope-v0.10.0'
     or envelope ->> 'algorithm' is distinct from 'Ed25519'
     or envelope ->> 'signature_base64' !~ '^[A-Za-z0-9+/]{86}==$'
     or pg_catalog.octet_length(pg_catalog.decode(envelope ->> 'signature_base64', 'base64')) is distinct from 64
     or pg_catalog.replace(pg_catalog.encode(
       pg_catalog.decode(envelope ->> 'signature_base64', 'base64'), 'base64'
     ), E'\n', '') is distinct from envelope ->> 'signature_base64'
     or target_payload_sha256 !~ '^[a-f0-9]{64}$'
     or private.governance_jsonb_sha256(target_payload) is distinct from target_payload_sha256
     or envelope ->> 'payload_sha256' is distinct from target_payload_sha256
     or envelope_sha256 is distinct from private.governance_jsonb_sha256(envelope)
     or signature_sha256 is distinct from pg_catalog.encode(public.digest(
       pg_catalog.decode(envelope ->> 'signature_base64', 'base64'), 'sha256'
     ), 'hex')
     or target_verification ->> 'organization_id' is distinct from envelope ->> 'organization_id'
     or target_verification ->> 'organization_version' is distinct from envelope ->> 'organization_version'
     or target_verification ->> 'policy_version' is distinct from envelope ->> 'policy_version'
     or target_verification ->> 'reviewer_id' is distinct from envelope ->> 'reviewer_id'
     or target_verification ->> 'reviewer_identity_version' is distinct from envelope ->> 'reviewer_identity_version'
     or target_verification ->> 'reviewer_role' is distinct from envelope ->> 'reviewer_role'
     or target_verification ->> 'key_id' is distinct from envelope ->> 'key_id'
     or target_verification ->> 'purpose' is distinct from envelope ->> 'purpose'
     or coalesce((target_verification ->> 'valid_at_signing_time')::boolean, false) is not true
     or coalesce((target_verification ->> 'currently_trusted')::boolean, false) is not true
     or target_admitted_at is null
     or pg_catalog.abs(extract(epoch from (target_admitted_at - database_admitted_at))) > 300
     or database_admitted_at < (envelope ->> 'issued_at')::timestamptz
     or database_admitted_at > (envelope ->> 'expires_at')::timestamptz then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_HUMAN_DECISION_INVALID';
  end if;
  select * into strict material
  from private.governance_reviewer_verification_material_read(
    target_tenant, envelope ->> 'organization_id', envelope ->> 'organization_version',
    envelope ->> 'policy_version', envelope ->> 'reviewer_id',
    envelope ->> 'reviewer_identity_version', envelope ->> 'key_id',
    envelope ->> 'purpose', envelope ->> 'reviewer_role',
    (envelope ->> 'issued_at')::timestamptz, database_admitted_at
  );
  if not material.valid_at_signing_time or not material.currently_trusted then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_HUMAN_DECISION_UNTRUSTED';
  end if;
  select * into strict policy from private.governance_reviewer_policies item
  where item.tenant_id = target_tenant and item.organization_id = material.organization_id
    and item.organization_version = material.organization_version
    and item.policy_version = material.policy_version;
  if policy.record_json ->> 'max_envelope_ttl_seconds' !~ '^[0-9]{2,6}$' then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_HUMAN_DECISION_TTL_INVALID';
  end if;
  max_envelope_ttl_seconds := (policy.record_json ->> 'max_envelope_ttl_seconds')::integer;
  if max_envelope_ttl_seconds < 60 or max_envelope_ttl_seconds > 604800 then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_HUMAN_DECISION_TTL_INVALID';
  end if;
  if extract(epoch from (
       (envelope ->> 'expires_at')::timestamptz - (envelope ->> 'issued_at')::timestamptz
     )) > max_envelope_ttl_seconds then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_HUMAN_DECISION_TTL_EXCEEDED';
  end if;
  insert into private.governance_human_decisions(
    tenant_id, envelope_id, workflow_kind, aggregate_id, aggregate_version,
    aggregate_revision, envelope_json, envelope_sha256, signature_sha256,
    payload_json, payload_sha256, organization_id, organization_version, policy_version,
    reviewer_id, reviewer_identity_version, reviewer_role, key_id, purpose,
    issued_at, expires_at, admitted_at, valid_at_signing_time, current_trust_at_admission
  ) values (
    target_tenant, target_envelope_id, target_workflow_kind, target_aggregate_id,
    target_aggregate_version, target_aggregate_revision, envelope, envelope_sha256,
    signature_sha256, target_payload, target_payload_sha256, material.organization_id,
    material.organization_version, material.policy_version, material.reviewer_id,
    material.reviewer_identity_version, material.required_reviewer_role, material.key_id,
    material.purpose, (envelope ->> 'issued_at')::timestamptz,
    (envelope ->> 'expires_at')::timestamptz, database_admitted_at, true, true
  );
  audit_sha256 := private.governance_append_audit(
    target_tenant, target_workflow_kind, target_aggregate_id, 'decision_admitted',
    envelope_sha256, material.reviewer_id, database_admitted_at
  );
  result := row(
    target_tenant, target_envelope_id, target_aggregate_id, target_aggregate_version,
    target_aggregate_revision, envelope_sha256, signature_sha256, material.reviewer_id,
    material.required_reviewer_role, material.key_id, material.purpose,
    database_admitted_at, false
  )::private.governance_human_decision_receipt;
  result_json := pg_catalog.to_jsonb(result);
  perform private.governance_store_idempotency(
    target_tenant, 'human_decision_admit', target_idempotency_key,
    target_command_sha256, result_json, database_admitted_at
  );
  return next result;
end;
$$;

create function private.governance_work_enqueue(
  target_tenant text,
  target_workflow_kind text,
  target_work_item_id text,
  target_aggregate_id text,
  target_aggregate_version text,
  target_work_kind text,
  target_required_role text,
  target_document_sha256 text,
  target_object_version_id text,
  target_input_sha256 text,
  target_payload jsonb,
  target_idempotency_key text,
  target_command_sha256 text,
  target_created_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'work_enqueue', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  if target_workflow_kind not in ('reviewer_trust', 'ground_truth', 'legal_reconciliation', 'parameter_approval', 'rulespec_approval')
     or target_work_kind not in (
       'ground_truth_visual_eligibility', 'ground_truth_annotation', 'ground_truth_adjudication',
       'ground_truth_lock', 'legal_observation_reconciliation', 'parameter_attestation',
       'rulespec_semantics', 'golden_case_outputs'
     )
     or target_input_sha256 !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(target_payload) is distinct from 'object'
     or (target_workflow_kind = 'ground_truth' and (
       target_document_sha256 !~ '^[a-f0-9]{64}$' or target_object_version_id is null
     )) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_WORK_INPUT_INVALID';
  end if;
  insert into private.governance_work_items(
    tenant_id, work_item_id, workflow_kind, aggregate_id, aggregate_version,
    work_kind, required_role, document_sha256, object_version_id, input_sha256,
    payload_json, state, created_at, updated_at
  ) values (
    target_tenant, target_work_item_id, target_workflow_kind, target_aggregate_id,
    target_aggregate_version, target_work_kind, target_required_role,
    target_document_sha256, target_object_version_id, target_input_sha256,
    target_payload, 'pending', target_created_at, target_created_at
  );
  result := private.governance_finish_mutation(
    target_tenant, 'work_enqueue', target_idempotency_key, target_command_sha256,
    target_workflow_kind, target_aggregate_id, target_aggregate_version,
    1, 'pending', target_payload, target_input_sha256, 'work_enqueued',
    'governance.queue', target_created_at, false
  );
  return next result;
end;
$$;

create function private.governance_work_claim(
  target_tenant text,
  target_workflow_kind text,
  target_work_kind text,
  target_claimant_id text,
  target_reviewer_role text,
  target_now timestamptz,
  target_lease_seconds integer
) returns setof private.governance_work_claim_receipt
language plpgsql security definer set search_path = '' as $$
declare
  candidate private.governance_work_items%rowtype;
  claimed private.governance_work_items%rowtype;
  database_now timestamptz := pg_catalog.statement_timestamp();
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  if target_lease_seconds < 30 or target_lease_seconds > 86400 then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_WORK_LEASE_INVALID';
  end if;
  if target_now is null
     or pg_catalog.abs(extract(epoch from (target_now - database_now))) > 300 then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_WORK_CLOCK_INVALID';
  end if;
  select * into candidate from private.governance_work_items item
  where item.tenant_id = target_tenant and item.workflow_kind = target_workflow_kind
    and item.work_kind = target_work_kind and item.required_role = target_reviewer_role
    and (
      item.state in ('pending', 'released')
      or (item.state = 'claimed' and item.lease_expires_at <= database_now)
    )
  order by item.created_at, item.work_item_id
  for update skip locked limit 1;
  if candidate.work_item_id is null then return; end if;
  update private.governance_work_items item
  set state = 'claimed', claimant_id = target_claimant_id,
      fencing_token = item.fencing_token + 1,
      lease_expires_at = database_now + pg_catalog.make_interval(secs => target_lease_seconds),
      updated_at = database_now
  where item.tenant_id = target_tenant and item.work_item_id = candidate.work_item_id
  returning * into strict claimed;
  perform private.governance_append_audit(
    target_tenant, claimed.workflow_kind, claimed.aggregate_id, 'work_claimed',
    claimed.input_sha256, target_claimant_id, database_now
  );
  return next row(
    claimed.tenant_id, claimed.work_item_id, claimed.workflow_kind, claimed.aggregate_id,
    claimed.aggregate_version, claimed.work_kind, claimed.required_role,
    claimed.document_sha256, claimed.object_version_id, claimed.input_sha256,
    claimed.state, claimed.claimant_id, claimed.fencing_token, claimed.lease_expires_at
  )::private.governance_work_claim_receipt;
end;
$$;

create function private.governance_work_release(
  target_tenant text,
  target_work_item_id text,
  target_claimant_id text,
  target_fencing_token bigint,
  target_next_state text,
  target_reason_code text,
  target_occurred_at timestamptz,
  target_idempotency_key text,
  target_command_sha256 text
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  item private.governance_work_items%rowtype;
  content jsonb;
  database_now timestamptz := pg_catalog.statement_timestamp();
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'work_release', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  select * into strict item from private.governance_work_items queued
  where queued.tenant_id = target_tenant and queued.work_item_id = target_work_item_id
  for update;
  if item.state is distinct from 'claimed' or item.claimant_id is distinct from target_claimant_id
     or item.fencing_token is distinct from target_fencing_token
     or item.lease_expires_at <= database_now
     or target_occurred_at is null
     or pg_catalog.abs(extract(epoch from (target_occurred_at - database_now))) > 300
     or target_next_state not in ('pending', 'released')
     or target_reason_code is null
     or target_reason_code !~ '^[A-Z][A-Z0-9_]{2,99}$' then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_WORK_RELEASE_FENCED';
  end if;
  update private.governance_work_items queued
  set state = target_next_state, claimant_id = null, lease_expires_at = null,
      updated_at = database_now
  where queued.tenant_id = target_tenant and queued.work_item_id = target_work_item_id;
  content := pg_catalog.jsonb_build_object(
    'work_item_id', item.work_item_id, 'next_state', target_next_state,
    'reason_code', target_reason_code, 'fencing_token', target_fencing_token
  );
  result := private.governance_finish_mutation(
    target_tenant, 'work_release', target_idempotency_key, target_command_sha256,
    item.workflow_kind, item.aggregate_id, item.aggregate_version,
    target_fencing_token, target_next_state, content, item.input_sha256,
    'work_released', target_claimant_id, target_occurred_at, false
  );
  return next result;
end;
$$;

create function private.governance_decision_assert(
  target_tenant text,
  target_envelope_id text,
  target_workflow_kind text,
  target_aggregate_id text,
  target_aggregate_version text,
  target_aggregate_revision bigint,
  target_purpose text,
  target_reviewer_role text,
  target_reviewer_id text,
  target_signature_sha256 text
) returns setof private.governance_human_decisions
language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  select decision.* from private.governance_human_decisions decision
  where decision.tenant_id = target_tenant and decision.envelope_id = target_envelope_id
    and decision.workflow_kind = target_workflow_kind
    and decision.aggregate_id = target_aggregate_id
    and decision.aggregate_version = target_aggregate_version
    and decision.aggregate_revision = target_aggregate_revision
    and decision.purpose = target_purpose
    and decision.reviewer_role = target_reviewer_role
    and decision.reviewer_id = target_reviewer_id
    and decision.signature_sha256 = target_signature_sha256
    and decision.valid_at_signing_time and decision.current_trust_at_admission;
  if not found then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_HUMAN_DECISION_BINDING_MISMATCH';
  end if;
end;
$$;

create function private.governance_gt_eligibility_append(
  target_tenant text,
  target_decision jsonb,
  target_work_item_id text,
  target_claimant_id text,
  target_fencing_token bigint,
  target_envelope_id text,
  target_idempotency_key text,
  target_command_sha256 text,
  target_recorded_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  claim private.governance_work_items%rowtype;
  admission private.governance_human_decisions%rowtype;
  target_id text := target_decision ->> 'eligibility_id';
  document_sha256 text := target_decision ->> 'document_sha256';
  content_sha256 text := private.governance_jsonb_sha256(target_decision);
  target_state text;
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'gt_eligibility_append', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  select * into strict claim from private.governance_claim_assert(
    target_tenant, target_work_item_id, target_claimant_id, target_fencing_token,
    'ground_truth_visual_eligibility', target_recorded_at
  );
  select * into strict admission from private.governance_decision_assert(
    target_tenant, target_envelope_id, 'ground_truth', target_id, '1', 1,
    'ground_truth_visual_eligibility', 'human_ground_truth_eligibility_reviewer',
    target_decision ->> 'reviewer_id', target_decision ->> 'signature_sha256'
  );
  if admission.payload_json is distinct from
       (target_decision - 'signature_sha256' - 'action_signature_sha256')
     or target_decision ->> 'schema_version' is distinct from 'tivdoc-trusted-ground-truth-v0.10.0'
     or target_decision ->> 'reviewer_id' is distinct from target_claimant_id
     or target_decision ->> 'reviewer_role' is distinct from claim.required_role
     or claim.workflow_kind is distinct from 'ground_truth' or claim.aggregate_id is distinct from target_id
     or claim.aggregate_version is distinct from '1' or claim.document_sha256 is distinct from document_sha256
     or document_sha256 !~ '^[a-f0-9]{64}$'
     or (target_decision ->> 'decided_at')::timestamptz is distinct from admission.issued_at
     or (
       (target_decision ->> 'decision' = 'eligible') is distinct from
       (target_decision ->> 'visual_review' = 'completed_eligible'
        and target_decision ->> 'license_gate' = 'authorized_for_private_evaluation'
        and target_decision ->> 'pii_gate' = 'private_handling_controls_verified')
     ) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_GT_ELIGIBILITY_INVALID';
  end if;
  target_state := case target_decision ->> 'decision'
    when 'eligible' then 'eligible_for_private_ground_truth_work'
    else 'rejected_for_private_ground_truth_work'
  end;
  insert into private.governance_gt_eligibility_versions(
    tenant_id, eligibility_id, document_sha256, revision, decision_json,
    content_sha256, state, envelope_id, recorded_at
  ) values (
    target_tenant, target_id, document_sha256, 1, target_decision,
    content_sha256, target_state, target_envelope_id, target_recorded_at
  );
  perform private.governance_complete_claim(
    target_tenant, target_work_item_id, target_claimant_id,
    target_fencing_token, target_recorded_at
  );
  result := private.governance_finish_mutation(
    target_tenant, 'gt_eligibility_append', target_idempotency_key, target_command_sha256,
    'ground_truth', target_id, '1', 1, target_state, target_decision,
    content_sha256, 'visual_eligibility_recorded', target_claimant_id,
    target_recorded_at, true
  );
  return next result;
end;
$$;

create function private.governance_gt_manifest_append(
  target_tenant text,
  target_event_kind text,
  target_manifest jsonb,
  target_expected_workflow_revision bigint,
  target_work_item_id text,
  target_claimant_id text,
  target_fencing_token bigint,
  target_envelope_id text,
  target_idempotency_key text,
  target_command_sha256 text,
  target_recorded_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  prior private.governance_gt_manifest_versions%rowtype;
  claim private.governance_work_items%rowtype;
  admission private.governance_human_decisions%rowtype;
  active_lock private.governance_gt_locks%rowtype;
  superseded_manifest private.governance_gt_manifest_versions%rowtype;
  target_manifest_id text := target_manifest ->> 'manifest_id';
  target_manifest_revision bigint := (target_manifest ->> 'revision')::bigint;
  next_workflow_revision bigint := target_expected_workflow_revision + 1;
  document_sha256 text := target_manifest ->> 'document_sha256';
  target_status text := target_manifest ->> 'status';
  content_sha256 text := private.governance_jsonb_sha256(target_manifest);
  expected_work_kind text;
  expected_purpose text;
  expected_role text;
  expected_reviewer text;
  expected_action text;
  actor_id text := 'ground.truth.system';
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'gt_manifest_append', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  if pg_catalog.jsonb_typeof(target_manifest) is distinct from 'object'
     or target_manifest_id !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'
     or target_manifest_revision < 1
     or target_manifest ->> 'schema_version' !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'
     or pg_catalog.jsonb_typeof(target_manifest -> 'sections') is distinct from 'array'
     or pg_catalog.jsonb_array_length(target_manifest -> 'sections') < 1
     or pg_catalog.jsonb_typeof(target_manifest -> 'annotations') is distinct from 'array'
     or pg_catalog.jsonb_array_length(target_manifest -> 'annotations') < 1
     or target_expected_workflow_revision < 0 or document_sha256 !~ '^[a-f0-9]{64}$'
     or target_event_kind not in (
       'annotation_1_signed', 'annotation_2_signed', 'disagreement_recorded',
       'adjudication_signed', 'ground_truth_locked', 'correction_started'
     ) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_GT_MANIFEST_INVALID';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    private.governance_jsonb_canonical_text(pg_catalog.jsonb_build_object(
      'tenant_id', target_tenant, 'document_sha256', document_sha256
    )), 0
  ));
  select * into prior from private.governance_gt_manifest_versions item
  where item.tenant_id = target_tenant and item.manifest_id = target_manifest_id
  order by item.workflow_revision desc limit 1 for update;
  if coalesce(prior.workflow_revision, 0) is distinct from target_expected_workflow_revision then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_GT_WORKFLOW_REVISION_CONFLICT';
  end if;
  if prior.workflow_revision is not null and (
       prior.document_sha256 is distinct from document_sha256
       or prior.manifest_revision is distinct from target_manifest_revision
       or prior.manifest_json ->> 'schema_version' is distinct from target_manifest ->> 'schema_version'
       or prior.manifest_json -> 'sections' is distinct from target_manifest -> 'sections'
       or prior.manifest_json ->> 'annotator_1_id' is distinct from target_manifest ->> 'annotator_1_id'
       or prior.manifest_json ->> 'supersedes_manifest_id' is distinct from target_manifest ->> 'supersedes_manifest_id'
       or prior.manifest_json ->> 'revision_reason' is distinct from target_manifest ->> 'revision_reason'
       or prior.manifest_json ->> 'created_at' is distinct from target_manifest ->> 'created_at'
       or (
         select coalesce(pg_catalog.jsonb_agg(entry.value order by entry.ordinality), '[]'::jsonb)
         from pg_catalog.jsonb_array_elements(target_manifest -> 'annotations')
           with ordinality entry(value, ordinality)
         where entry.ordinality <= pg_catalog.jsonb_array_length(prior.manifest_json -> 'annotations')
       ) is distinct from prior.manifest_json -> 'annotations'
     ) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_GT_IMMUTABLE_CHAIN_MISMATCH';
  end if;
  if target_event_kind = 'annotation_1_signed' then
    expected_work_kind := 'ground_truth_annotation';
    expected_purpose := 'ground_truth_annotation';
    expected_role := 'human_ground_truth_annotator';
    expected_reviewer := target_manifest ->> 'annotator_1_id';
    expected_action := 'annotation_1';
    if target_expected_workflow_revision is distinct from 0 or target_manifest_revision is distinct from 1
       or target_status is distinct from 'annotation_1' or target_manifest ->> 'supersedes_manifest_id' is not null then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_GT_ANNOTATION_1_TRANSITION_INVALID';
    end if;
  elsif target_event_kind = 'correction_started' then
    expected_work_kind := 'ground_truth_annotation';
    expected_purpose := 'ground_truth_annotation';
    expected_role := 'human_ground_truth_annotator';
    expected_reviewer := target_manifest ->> 'annotator_1_id';
    expected_action := 'annotation_1';
    if target_expected_workflow_revision is distinct from 0 or target_manifest_revision <= 1
       or target_status is distinct from 'annotation_1' or target_manifest ->> 'supersedes_manifest_id' is null then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_GT_CORRECTION_TRANSITION_INVALID';
    end if;
    select lock.* into strict active_lock
    from private.governance_gt_active_locks active
    join private.governance_gt_locks lock
      on lock.tenant_id = active.tenant_id
     and lock.document_sha256 = active.document_sha256
     and lock.manifest_id = active.manifest_id
    where active.tenant_id = target_tenant and active.document_sha256 = document_sha256
      and active.manifest_id = target_manifest ->> 'supersedes_manifest_id'
    for update of active;
    select * into strict superseded_manifest
    from private.governance_gt_manifest_versions version
    where version.tenant_id = target_tenant
      and version.manifest_id = active_lock.manifest_id
      and version.workflow_revision = active_lock.workflow_revision;
    if target_manifest_revision is distinct from active_lock.manifest_revision + 1
       or superseded_manifest.document_sha256 is distinct from document_sha256
       or superseded_manifest.manifest_json ->> 'schema_version' is distinct from target_manifest ->> 'schema_version'
       or superseded_manifest.manifest_json -> 'sections' is distinct from target_manifest -> 'sections' then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_GT_CORRECTION_BINDING_MISMATCH';
    end if;
    delete from private.governance_gt_active_locks active
    where active.tenant_id = target_tenant and active.document_sha256 = document_sha256
      and active.manifest_id = active_lock.manifest_id;
    insert into private.governance_gt_lock_supersessions(
      tenant_id, document_sha256, prior_manifest_id, superseding_manifest_id, superseded_at
    ) values (
      target_tenant, document_sha256, active_lock.manifest_id,
      target_manifest_id, target_recorded_at
    );
  elsif target_event_kind = 'annotation_2_signed' then
    expected_work_kind := 'ground_truth_annotation';
    expected_purpose := 'ground_truth_annotation';
    expected_role := 'human_ground_truth_annotator';
    expected_reviewer := target_manifest ->> 'annotator_2_id';
    expected_action := 'annotation_2';
    if prior.status is distinct from 'annotation_1' or target_status is distinct from 'annotation_2'
       or prior.manifest_revision is distinct from target_manifest_revision
       or target_manifest ->> 'annotator_1_id' = target_manifest ->> 'annotator_2_id'
       or pg_catalog.jsonb_array_length(target_manifest -> 'annotations')
          <= pg_catalog.jsonb_array_length(prior.manifest_json -> 'annotations') then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_GT_ANNOTATION_2_TRANSITION_INVALID';
    end if;
  elsif target_event_kind = 'disagreement_recorded' then
    if prior.status is distinct from 'annotation_2' or target_status is distinct from 'disagreement'
       or (target_manifest - 'status') is distinct from (prior.manifest_json - 'status')
       or target_work_item_id is not null or target_claimant_id is not null
       or target_fencing_token is not null or target_envelope_id is not null then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_GT_DISAGREEMENT_TRANSITION_INVALID';
    end if;
  elsif target_event_kind = 'adjudication_signed' then
    expected_work_kind := 'ground_truth_adjudication';
    expected_purpose := 'ground_truth_adjudication';
    expected_role := 'human_ground_truth_adjudicator';
    expected_reviewer := target_manifest ->> 'adjudicator_id';
    expected_action := 'human_adjudication';
    if prior.status not in ('annotation_2', 'disagreement') or target_status is distinct from 'human_adjudication'
       or expected_reviewer in (target_manifest ->> 'annotator_1_id', target_manifest ->> 'annotator_2_id')
       or target_manifest ->> 'annotator_2_id' is distinct from prior.manifest_json ->> 'annotator_2_id'
       or pg_catalog.jsonb_array_length(target_manifest -> 'annotations')
          <= pg_catalog.jsonb_array_length(prior.manifest_json -> 'annotations') then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_GT_ADJUDICATION_TRANSITION_INVALID';
    end if;
  else
    expected_work_kind := 'ground_truth_lock';
    expected_purpose := 'ground_truth_lock';
    expected_role := 'human_ground_truth_lock_reviewer';
    expected_reviewer := target_claimant_id;
    expected_action := 'lock';
    if prior.status is distinct from 'human_adjudication' or target_status is distinct from 'locked_ground_truth'
       or target_manifest ->> 'locked_sha256' !~ '^[a-f0-9]{64}$'
       or (target_manifest - 'status' - 'locked_sha256')
          is distinct from (prior.manifest_json - 'status' - 'locked_sha256')
       or expected_reviewer in (
         target_manifest ->> 'annotator_1_id', target_manifest ->> 'annotator_2_id',
         target_manifest ->> 'adjudicator_id'
       ) or exists (
         select 1 from private.governance_gt_active_locks active
         where active.tenant_id = target_tenant and active.document_sha256 = document_sha256
       ) then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_GT_LOCK_TRANSITION_INVALID';
    end if;
  end if;
  if target_event_kind is distinct from 'disagreement_recorded' then
    select * into strict claim from private.governance_claim_assert(
      target_tenant, target_work_item_id, target_claimant_id, target_fencing_token,
      expected_work_kind, target_recorded_at
    );
    if claim.workflow_kind is distinct from 'ground_truth' or claim.aggregate_id is distinct from target_manifest_id
       or claim.aggregate_version is distinct from target_manifest_revision::text
       or claim.document_sha256 is distinct from document_sha256 or claim.required_role is distinct from expected_role
       or target_claimant_id is distinct from expected_reviewer then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_GT_CLAIM_BINDING_MISMATCH';
    end if;
    select * into strict admission from private.governance_decision_assert(
      target_tenant, target_envelope_id, 'ground_truth', target_manifest_id,
      target_manifest_revision::text, next_workflow_revision, expected_purpose,
      expected_role, expected_reviewer,
      (select decision.signature_sha256 from private.governance_human_decisions decision
       where decision.tenant_id = target_tenant and decision.envelope_id = target_envelope_id)
    );
    if admission.payload_json is distinct from pg_catalog.jsonb_build_object(
      'schema_version', 'tivdoc-trusted-ground-truth-v0.10.0',
      'action', expected_action,
      'manifest_id', target_manifest_id,
      'revision', target_manifest_revision,
      'document_sha256', document_sha256,
      'prior_manifest_sha256', case
        when target_event_kind = 'correction_started' then
          pg_catalog.encode(public.digest(
            pg_catalog.convert_to(private.governance_jsonb_compact_text(superseded_manifest.manifest_json), 'UTF8'),
            'sha256'
          ), 'hex')
        when prior.workflow_revision is null then null
        else pg_catalog.encode(public.digest(
          pg_catalog.convert_to(private.governance_jsonb_compact_text(prior.manifest_json), 'UTF8'),
          'sha256'
        ), 'hex')
      end,
      'resulting_manifest_sha256', pg_catalog.encode(public.digest(
        pg_catalog.convert_to(private.governance_jsonb_compact_text(target_manifest), 'UTF8'),
        'sha256'
      ), 'hex')
    ) then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_GT_SIGNED_PAYLOAD_MISMATCH';
    end if;
    actor_id := admission.reviewer_id;
  end if;
  insert into private.governance_gt_manifest_versions(
    tenant_id, manifest_id, manifest_revision, workflow_revision, event_kind,
    document_sha256, status, manifest_json, manifest_sha256, envelope_id, recorded_at
  ) values (
    target_tenant, target_manifest_id, target_manifest_revision, next_workflow_revision,
    target_event_kind, document_sha256, target_status, target_manifest,
    content_sha256, target_envelope_id, target_recorded_at
  );
  if target_event_kind = 'ground_truth_locked' then
    insert into private.governance_gt_locks(
      tenant_id, document_sha256, manifest_id, manifest_revision,
      workflow_revision, locked_sha256, envelope_id, locked_at
    ) values (
      target_tenant, document_sha256, target_manifest_id, target_manifest_revision,
      next_workflow_revision, target_manifest ->> 'locked_sha256', target_envelope_id,
      target_recorded_at
    );
    insert into private.governance_gt_active_locks(
      tenant_id, document_sha256, manifest_id, activated_at
    ) values (
      target_tenant, document_sha256, target_manifest_id, target_recorded_at
    );
  end if;
  if target_event_kind is distinct from 'disagreement_recorded' then
    perform private.governance_complete_claim(
      target_tenant, target_work_item_id, target_claimant_id,
      target_fencing_token, target_recorded_at
    );
  end if;
  result := private.governance_finish_mutation(
    target_tenant, 'gt_manifest_append', target_idempotency_key, target_command_sha256,
    'ground_truth', target_manifest_id, target_manifest_revision::text,
    next_workflow_revision, target_status, target_manifest, content_sha256,
    target_event_kind, actor_id, target_recorded_at, true
  );
  return next result;
end;
$$;

create function private.governance_golden_case_set_import(
  target_tenant text,
  target_golden_case_set jsonb,
  target_idempotency_key text,
  target_command_sha256 text,
  target_imported_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  target_id text := target_golden_case_set ->> 'golden_case_set_id';
  target_sha256 text := target_golden_case_set ->> 'content_sha256';
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'golden_case_set_import', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  if pg_catalog.jsonb_typeof(target_golden_case_set) is distinct from 'object'
     or target_golden_case_set ->> 'schema_version' is distinct from
        'tivdoc-rulespec-golden-case-set-v0.6.0'
     or target_id is null
     or target_golden_case_set ->> 'rule_spec_id' is null
     or target_golden_case_set ->> 'rule_spec_version' is null
     or pg_catalog.jsonb_typeof(target_golden_case_set -> 'cases') is distinct from 'array'
     or pg_catalog.jsonb_array_length(target_golden_case_set -> 'cases') = 0
     or target_sha256 !~ '^[a-f0-9]{64}$'
     or private.governance_jsonb_sha256(target_golden_case_set - 'content_sha256') is distinct from
        target_sha256 then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_GOLDEN_CASE_SET_INVALID';
  end if;
  insert into private.governance_golden_case_sets(
    tenant_id, golden_case_set_id, content_sha256, content_json, recorded_at
  ) values (
    target_tenant, target_id, target_sha256, target_golden_case_set, target_imported_at
  );
  result := private.governance_finish_mutation(
    target_tenant, 'golden_case_set_import', target_idempotency_key, target_command_sha256,
    'rulespec_approval', target_id, '1', 1, 'registered',
    target_golden_case_set, target_sha256, 'golden_case_set_imported',
    'system_import', target_imported_at, true
  );
  return next result;
end;
$$;

create function private.governance_rulespec_import(
  target_tenant text,
  target_rule_spec jsonb,
  target_idempotency_key text,
  target_command_sha256 text,
  target_imported_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  target_id text := target_rule_spec ->> 'rule_spec_id';
  target_version text := target_rule_spec ->> 'rule_spec_version';
  target_sha256 text := target_rule_spec ->> 'content_sha256';
  golden_sha256 text := target_rule_spec ->> 'golden_case_set_sha256';
  effective_from date := (target_rule_spec #>> '{effective_period,from}')::date;
  effective_to date := nullif(target_rule_spec #>> '{effective_period,to}', '')::date;
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'rulespec_import', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  if pg_catalog.jsonb_typeof(target_rule_spec) is distinct from 'object'
     or target_rule_spec ->> 'schema_version' is distinct from 'tivdoc-rulespec-v0.6.0'
     or target_id is null or target_version is null
     or target_rule_spec ->> 'catalog_boundary' not in ('synthetic_test_only', 'real_inactive')
     or target_sha256 !~ '^[a-f0-9]{64}$'
     or golden_sha256 !~ '^[a-f0-9]{64}$'
     or private.governance_jsonb_sha256(target_rule_spec - 'content_sha256') is distinct from target_sha256
     or effective_from is null
     or (effective_to is not null and effective_to < effective_from) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_RULESPEC_INVALID';
  end if;
  insert into private.governance_rulespec_versions(
    tenant_id, rule_spec_id, rule_spec_version, revision, state, package_json,
    content_sha256, golden_case_set_sha256, activation_allowed, recorded_at
  ) values (
    target_tenant, target_id, target_version, 1, 'candidate_inactive', target_rule_spec,
    target_sha256, golden_sha256, false, target_imported_at
  );
  result := private.governance_finish_mutation(
    target_tenant, 'rulespec_import', target_idempotency_key, target_command_sha256,
    'rulespec_approval', target_id, target_version, 1, 'candidate_inactive',
    target_rule_spec, target_sha256, 'rulespec_imported',
    'system_import', target_imported_at, true
  );
  return next result;
end;
$$;

create function private.governance_rulespec_approval_append(
  target_tenant text,
  target_approval jsonb,
  target_expected_revision bigint,
  target_work_item_id text,
  target_claimant_id text,
  target_fencing_token bigint,
  target_envelope_id text,
  target_idempotency_key text,
  target_command_sha256 text,
  target_recorded_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  claim private.governance_work_items%rowtype;
  admission private.governance_human_decisions%rowtype;
  current_version private.governance_rulespec_versions%rowtype;
  target_id text := target_approval ->> 'artifact_id';
  target_version text := target_approval ->> 'artifact_version';
  next_revision bigint := target_expected_revision + 1;
  approval_kind text := target_approval ->> 'approval_kind';
  expected_hash text;
  expected_role text;
  expected_purpose text;
  expected_work_kind text;
  prior_count bigint;
  target_state text;
  approval_sha256 text := private.governance_jsonb_sha256(target_approval);
  snapshot jsonb;
  snapshot_sha256 text;
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'rulespec_approval_append', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  if approval_kind = 'rule_semantics' then
    expected_role := 'human_rule_reviewer';
    expected_purpose := 'rulespec_semantics';
    expected_work_kind := 'rulespec_semantics';
  elsif approval_kind = 'golden_case_outputs' then
    expected_role := 'human_golden_case_reviewer';
    expected_purpose := 'golden_case_outputs';
    expected_work_kind := 'golden_case_outputs';
  else
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_RULESPEC_APPROVAL_INVALID';
  end if;
  select * into strict current_version from private.governance_rulespec_versions item
  where item.tenant_id = target_tenant and item.rule_spec_id = target_id
    and item.rule_spec_version = target_version
  order by item.revision desc limit 1 for update;
  if current_version.revision is distinct from target_expected_revision then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_REVISION_FENCED';
  end if;
  expected_hash := case approval_kind when 'rule_semantics'
    then current_version.content_sha256 else current_version.golden_case_set_sha256 end;
  select * into strict claim from private.governance_claim_assert(
    target_tenant, target_work_item_id, target_claimant_id, target_fencing_token,
    expected_work_kind, target_recorded_at
  );
  select * into strict admission from private.governance_decision_assert(
    target_tenant, target_envelope_id, 'rulespec_approval', target_id,
    target_version, next_revision, expected_purpose, expected_role,
    target_claimant_id, target_approval ->> 'signature_sha256'
  );
  if pg_catalog.jsonb_typeof(target_approval) is distinct from 'object'
     or admission.payload_json is distinct from
        (target_approval - 'signature_sha256' - 'action_signature_sha256')
     or target_approval ->> 'schema_version' is distinct from 'tivdoc-legal-semantic-approval-v0.6.0'
     or target_approval ->> 'approval_id' is null
     or target_approval ->> 'artifact_sha256' is distinct from expected_hash
     or target_approval ->> 'reviewer_id' is distinct from target_claimant_id
     or target_approval ->> 'reviewer_role' is distinct from expected_role
     or target_approval ->> 'decision' is distinct from 'approved'
     or claim.workflow_kind is distinct from 'rulespec_approval'
     or claim.aggregate_id is distinct from target_id or claim.aggregate_version is distinct from target_version
     or claim.required_role is distinct from expected_role then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_RULESPEC_APPROVAL_BINDING_MISMATCH';
  end if;
  if not exists (
    select 1 from private.governance_golden_case_sets golden
    where golden.tenant_id = target_tenant
      and golden.content_sha256 = current_version.golden_case_set_sha256
      and golden.content_json ->> 'rule_spec_id' = target_id
      and golden.content_json ->> 'rule_spec_version' = target_version
  ) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_GOLDEN_CASE_SET_REQUIRED';
  end if;
  select pg_catalog.count(*) into prior_count
  from private.governance_rulespec_approvals item
  where item.tenant_id = target_tenant and item.rule_spec_id = target_id
    and item.rule_spec_version = target_version;
  if prior_count >= 2 or exists (
    select 1 from private.governance_rulespec_approvals item
    where item.tenant_id = target_tenant and item.rule_spec_id = target_id
      and item.rule_spec_version = target_version
      and (item.approval_kind = approval_kind or item.reviewer_id = target_claimant_id)
  ) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_RULESPEC_APPROVAL_SEPARATION_REQUIRED';
  end if;
  target_state := case when prior_count = 0
    then 'awaiting_complementary_approval' else 'dual_approved_inactive' end;
  insert into private.governance_rulespec_approvals(
    tenant_id, approval_id, rule_spec_id, rule_spec_version, revision,
    approval_kind, reviewer_id, approval_json, approval_sha256, envelope_id, recorded_at
  ) values (
    target_tenant, target_approval ->> 'approval_id', target_id, target_version,
    next_revision, approval_kind, target_claimant_id, target_approval,
    approval_sha256, target_envelope_id, target_recorded_at
  );
  insert into private.governance_rulespec_versions(
    tenant_id, rule_spec_id, rule_spec_version, revision, state, package_json,
    content_sha256, golden_case_set_sha256, activation_allowed, recorded_at
  ) values (
    target_tenant, target_id, target_version, next_revision, target_state,
    current_version.package_json, current_version.content_sha256,
    current_version.golden_case_set_sha256, false, target_recorded_at
  );
  perform private.governance_complete_claim(
    target_tenant, target_work_item_id, target_claimant_id,
    target_fencing_token, target_recorded_at
  );
  snapshot := pg_catalog.jsonb_build_object(
    'rule_spec', current_version.package_json,
    'latest_approval', target_approval,
    'approval_count', prior_count + 1,
    'activation_allowed', false
  );
  snapshot_sha256 := private.governance_jsonb_sha256(snapshot);
  result := private.governance_finish_mutation(
    target_tenant, 'rulespec_approval_append', target_idempotency_key,
    target_command_sha256, 'rulespec_approval', target_id, target_version,
    next_revision, target_state, snapshot, snapshot_sha256,
    'rulespec_' || approval_kind || '_approved', target_claimant_id,
    target_recorded_at, true
  );
  return next result;
end;
$$;

create function private.governance_aggregate_read(
  target_tenant text,
  target_workflow_kind text,
  target_aggregate_id text,
  target_aggregate_version text
) returns table (
  tenant_id text,
  workflow_kind text,
  aggregate_id text,
  aggregate_version text,
  revision bigint,
  state text,
  content_sha256 text,
  audit_event_sha256 text,
  idempotent_replay boolean,
  activation_allowed boolean,
  content_json jsonb
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  return query
  select snapshot.tenant_id, snapshot.workflow_kind, snapshot.aggregate_id,
    snapshot.aggregate_version, snapshot.revision, snapshot.state,
    snapshot.content_sha256, snapshot.audit_event_sha256, false,
    snapshot.activation_allowed, snapshot.content_json
  from private.governance_aggregate_snapshots snapshot
  where snapshot.tenant_id = target_tenant
    and snapshot.workflow_kind = target_workflow_kind
    and snapshot.aggregate_id = target_aggregate_id
    and snapshot.aggregate_version = target_aggregate_version
  order by snapshot.recorded_at desc, snapshot.revision desc, snapshot.mutation_scope desc
  limit 1;
end;
$$;

-- Every decision and version relation is append-only. Work-item lease state is
-- the sole mutable relation and remains fencing-token protected by the API.
create trigger governance_reviewer_organizations_immutable
before update or delete on private.governance_reviewer_organizations
for each row execute function private.governance_forbid_mutation();
create trigger governance_reviewer_policies_immutable
before update or delete on private.governance_reviewer_policies
for each row execute function private.governance_forbid_mutation();
create trigger governance_reviewers_immutable
before update or delete on private.governance_reviewers
for each row execute function private.governance_forbid_mutation();
create trigger governance_key_challenges_immutable
before update or delete on private.governance_key_challenges
for each row execute function private.governance_forbid_mutation();
create trigger governance_key_challenge_consumptions_immutable
before update or delete on private.governance_key_challenge_consumptions
for each row execute function private.governance_forbid_mutation();
create trigger governance_reviewer_keys_immutable
before update or delete on private.governance_reviewer_keys
for each row execute function private.governance_forbid_mutation();
create trigger governance_key_rotations_immutable
before update or delete on private.governance_key_rotations
for each row execute function private.governance_forbid_mutation();
create trigger governance_key_revocations_immutable
before update or delete on private.governance_key_revocations
for each row execute function private.governance_forbid_mutation();
create trigger governance_human_decisions_immutable
before update or delete on private.governance_human_decisions
for each row execute function private.governance_forbid_mutation();
create trigger governance_gt_eligibility_versions_immutable
before update or delete on private.governance_gt_eligibility_versions
for each row execute function private.governance_forbid_mutation();
create trigger governance_gt_manifest_versions_immutable
before update or delete on private.governance_gt_manifest_versions
for each row execute function private.governance_forbid_mutation();
create trigger governance_gt_locks_immutable
before update or delete on private.governance_gt_locks
for each row execute function private.governance_forbid_mutation();
create trigger governance_gt_lock_supersessions_immutable
before update or delete on private.governance_gt_lock_supersessions
for each row execute function private.governance_forbid_mutation();
create trigger governance_legal_observation_versions_immutable
before update or delete on private.governance_legal_observation_versions
for each row execute function private.governance_forbid_mutation();
create trigger governance_legal_observation_decisions_immutable
before update or delete on private.governance_legal_observation_decisions
for each row execute function private.governance_forbid_mutation();
create trigger governance_parameter_versions_immutable
before update or delete on private.governance_parameter_versions
for each row execute function private.governance_forbid_mutation();
create trigger governance_parameter_attestations_immutable
before update or delete on private.governance_parameter_attestations
for each row execute function private.governance_forbid_mutation();
create trigger governance_golden_case_sets_immutable
before update or delete on private.governance_golden_case_sets
for each row execute function private.governance_forbid_mutation();
create trigger governance_rulespec_versions_immutable
before update or delete on private.governance_rulespec_versions
for each row execute function private.governance_forbid_mutation();
create trigger governance_rulespec_approvals_immutable
before update or delete on private.governance_rulespec_approvals
for each row execute function private.governance_forbid_mutation();
create trigger governance_idempotency_immutable
before update or delete on private.governance_idempotency
for each row execute function private.governance_forbid_mutation();
create trigger governance_audit_events_immutable
before update or delete on private.governance_audit_events
for each row execute function private.governance_forbid_mutation();
create trigger governance_aggregate_snapshots_immutable
before update or delete on private.governance_aggregate_snapshots
for each row execute function private.governance_forbid_mutation();

alter table private.governance_reviewer_organizations enable row level security;
alter table private.governance_reviewer_organizations force row level security;
alter table private.governance_reviewer_policies enable row level security;
alter table private.governance_reviewer_policies force row level security;
alter table private.governance_reviewers enable row level security;
alter table private.governance_reviewers force row level security;
alter table private.governance_key_challenges enable row level security;
alter table private.governance_key_challenges force row level security;
alter table private.governance_key_challenge_consumptions enable row level security;
alter table private.governance_key_challenge_consumptions force row level security;
alter table private.governance_reviewer_keys enable row level security;
alter table private.governance_reviewer_keys force row level security;
alter table private.governance_key_rotations enable row level security;
alter table private.governance_key_rotations force row level security;
alter table private.governance_key_revocations enable row level security;
alter table private.governance_key_revocations force row level security;
alter table private.governance_human_decisions enable row level security;
alter table private.governance_human_decisions force row level security;
alter table private.governance_work_items enable row level security;
alter table private.governance_work_items force row level security;
alter table private.governance_gt_eligibility_versions enable row level security;
alter table private.governance_gt_eligibility_versions force row level security;
alter table private.governance_gt_manifest_versions enable row level security;
alter table private.governance_gt_manifest_versions force row level security;
alter table private.governance_gt_locks enable row level security;
alter table private.governance_gt_locks force row level security;
alter table private.governance_gt_active_locks enable row level security;
alter table private.governance_gt_active_locks force row level security;
alter table private.governance_gt_lock_supersessions enable row level security;
alter table private.governance_gt_lock_supersessions force row level security;
alter table private.governance_legal_observation_versions enable row level security;
alter table private.governance_legal_observation_versions force row level security;
alter table private.governance_legal_observation_decisions enable row level security;
alter table private.governance_legal_observation_decisions force row level security;
alter table private.governance_parameter_versions enable row level security;
alter table private.governance_parameter_versions force row level security;
alter table private.governance_parameter_attestations enable row level security;
alter table private.governance_parameter_attestations force row level security;
alter table private.governance_golden_case_sets enable row level security;
alter table private.governance_golden_case_sets force row level security;
alter table private.governance_rulespec_versions enable row level security;
alter table private.governance_rulespec_versions force row level security;
alter table private.governance_rulespec_approvals enable row level security;
alter table private.governance_rulespec_approvals force row level security;
alter table private.governance_idempotency enable row level security;
alter table private.governance_idempotency force row level security;
alter table private.governance_audit_events enable row level security;
alter table private.governance_audit_events force row level security;
alter table private.governance_aggregate_snapshots enable row level security;
alter table private.governance_aggregate_snapshots force row level security;

-- These policies are defense in depth for the only callable role. Direct table
-- privileges remain revoked below; SECURITY DEFINER functions also assert the
-- same tenant context before touching any row.
create policy governance_reviewer_organizations_service_tenant
on private.governance_reviewer_organizations for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_reviewer_policies_service_tenant
on private.governance_reviewer_policies for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_reviewers_service_tenant
on private.governance_reviewers for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_key_challenges_service_tenant
on private.governance_key_challenges for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_key_challenge_consumptions_service_tenant
on private.governance_key_challenge_consumptions for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_reviewer_keys_service_tenant
on private.governance_reviewer_keys for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_key_rotations_service_tenant
on private.governance_key_rotations for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_key_revocations_service_tenant
on private.governance_key_revocations for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_human_decisions_service_tenant
on private.governance_human_decisions for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_work_items_service_tenant
on private.governance_work_items for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_gt_eligibility_versions_service_tenant
on private.governance_gt_eligibility_versions for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_gt_manifest_versions_service_tenant
on private.governance_gt_manifest_versions for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_gt_locks_service_tenant
on private.governance_gt_locks for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_gt_active_locks_service_tenant
on private.governance_gt_active_locks for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_gt_lock_supersessions_service_tenant
on private.governance_gt_lock_supersessions for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_legal_observation_versions_service_tenant
on private.governance_legal_observation_versions for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_legal_observation_decisions_service_tenant
on private.governance_legal_observation_decisions for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_parameter_versions_service_tenant
on private.governance_parameter_versions for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_parameter_attestations_service_tenant
on private.governance_parameter_attestations for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_golden_case_sets_service_tenant
on private.governance_golden_case_sets for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_rulespec_versions_service_tenant
on private.governance_rulespec_versions for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_rulespec_approvals_service_tenant
on private.governance_rulespec_approvals for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_idempotency_service_tenant
on private.governance_idempotency for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_audit_events_service_tenant
on private.governance_audit_events for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));
create policy governance_aggregate_snapshots_service_tenant
on private.governance_aggregate_snapshots for all to service_role
using (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''))
with check (tenant_id = nullif(current_setting('tivdoc.tenant_id', true), ''));

revoke all on table
  private.governance_reviewer_organizations,
  private.governance_reviewer_policies,
  private.governance_reviewers,
  private.governance_key_challenges,
  private.governance_key_challenge_consumptions,
  private.governance_reviewer_keys,
  private.governance_key_rotations,
  private.governance_key_revocations,
  private.governance_human_decisions,
  private.governance_work_items,
  private.governance_gt_eligibility_versions,
  private.governance_gt_manifest_versions,
  private.governance_gt_locks,
  private.governance_gt_active_locks,
  private.governance_gt_lock_supersessions,
  private.governance_legal_observation_versions,
  private.governance_legal_observation_decisions,
  private.governance_parameter_versions,
  private.governance_parameter_attestations,
  private.governance_golden_case_sets,
  private.governance_rulespec_versions,
  private.governance_rulespec_approvals,
  private.governance_idempotency,
  private.governance_audit_events,
  private.governance_aggregate_snapshots
from public, anon, authenticated, service_role;

revoke all on type private.governance_mutation_receipt from public, anon, authenticated, service_role;
revoke all on type private.governance_human_decision_receipt from public, anon, authenticated, service_role;
revoke all on type private.governance_verification_material from public, anon, authenticated, service_role;
revoke all on type private.governance_work_claim_receipt from public, anon, authenticated, service_role;

revoke all on function private.governance_jsonb_canonical_text(jsonb,integer) from public, anon, authenticated, service_role;
revoke all on function private.governance_jsonb_compact_text(jsonb,integer) from public, anon, authenticated, service_role;
revoke all on function private.governance_jsonb_sha256(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.governance_forbid_mutation() from public, anon, authenticated, service_role;
revoke all on function private.governance_idempotency_lookup(text,text,text,text) from public, anon, authenticated, service_role;
revoke all on function private.governance_store_idempotency(text,text,text,text,jsonb,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.governance_append_audit(text,text,text,text,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.governance_finish_mutation(text,text,text,text,text,text,text,bigint,text,jsonb,text,text,text,timestamptz,boolean) from public, anon, authenticated, service_role;
revoke all on function private.governance_claim_assert(text,text,text,bigint,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.governance_complete_claim(text,text,text,bigint,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.governance_decision_assert(text,text,text,text,text,bigint,text,text,text,text) from public, anon, authenticated, service_role;

revoke all on function private.governance_trust_organization_append(text,jsonb,text,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.governance_trust_policy_append(text,jsonb,text,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.governance_reviewer_append(text,jsonb,text,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.governance_key_challenge_append(text,jsonb,text,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.governance_reviewer_key_register(text,text,timestamptz,text,text,text,text) from public, anon, authenticated, service_role;
revoke all on function private.governance_reviewer_key_revoke(text,text,timestamptz,text,text,timestamptz,text,text) from public, anon, authenticated, service_role;
revoke all on function private.governance_reviewer_verification_material_read(text,text,text,text,text,text,text,text,text,timestamptz,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.governance_human_decision_admit(text,text,text,text,bigint,jsonb,text,jsonb,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.governance_work_enqueue(text,text,text,text,text,text,text,text,text,text,jsonb,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.governance_work_claim(text,text,text,text,text,timestamptz,integer) from public, anon, authenticated, service_role;
revoke all on function private.governance_work_release(text,text,text,bigint,text,text,timestamptz,text,text) from public, anon, authenticated, service_role;
revoke all on function private.governance_gt_eligibility_append(text,jsonb,text,text,bigint,text,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.governance_gt_manifest_append(text,text,jsonb,bigint,text,text,bigint,text,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.governance_legal_observation_import(text,jsonb,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.governance_legal_observation_decide(text,jsonb,bigint,text,text,bigint,text,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.governance_parameter_import(text,jsonb,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.governance_parameter_attestation_append(text,jsonb,bigint,text,text,bigint,text,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.governance_golden_case_set_import(text,jsonb,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.governance_rulespec_import(text,jsonb,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.governance_rulespec_approval_append(text,jsonb,bigint,text,text,bigint,text,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.governance_aggregate_read(text,text,text,text) from public, anon, authenticated, service_role;

grant usage on schema private to service_role;
grant usage on type private.governance_mutation_receipt to service_role;
grant usage on type private.governance_human_decision_receipt to service_role;
grant usage on type private.governance_verification_material to service_role;
grant usage on type private.governance_work_claim_receipt to service_role;

grant execute on function private.governance_trust_organization_append(text,jsonb,text,text,text,timestamptz) to service_role;
grant execute on function private.governance_trust_policy_append(text,jsonb,text,text,text,timestamptz) to service_role;
grant execute on function private.governance_reviewer_append(text,jsonb,text,text,text,timestamptz) to service_role;
grant execute on function private.governance_key_challenge_append(text,jsonb,text,text,text,timestamptz) to service_role;
grant execute on function private.governance_reviewer_key_register(text,text,timestamptz,text,text,text,text) to service_role;
grant execute on function private.governance_reviewer_key_revoke(text,text,timestamptz,text,text,timestamptz,text,text) to service_role;
grant execute on function private.governance_reviewer_verification_material_read(text,text,text,text,text,text,text,text,text,timestamptz,timestamptz) to service_role;
grant execute on function private.governance_human_decision_admit(text,text,text,text,bigint,jsonb,text,jsonb,text,text,timestamptz) to service_role;
grant execute on function private.governance_work_enqueue(text,text,text,text,text,text,text,text,text,text,jsonb,text,text,timestamptz) to service_role;
grant execute on function private.governance_work_claim(text,text,text,text,text,timestamptz,integer) to service_role;
grant execute on function private.governance_work_release(text,text,text,bigint,text,text,timestamptz,text,text) to service_role;
grant execute on function private.governance_gt_eligibility_append(text,jsonb,text,text,bigint,text,text,text,timestamptz) to service_role;
grant execute on function private.governance_gt_manifest_append(text,text,jsonb,bigint,text,text,bigint,text,text,text,timestamptz) to service_role;
grant execute on function private.governance_legal_observation_import(text,jsonb,text,text,timestamptz) to service_role;
grant execute on function private.governance_legal_observation_decide(text,jsonb,bigint,text,text,bigint,text,text,text,timestamptz) to service_role;
grant execute on function private.governance_parameter_import(text,jsonb,text,text,timestamptz) to service_role;
grant execute on function private.governance_parameter_attestation_append(text,jsonb,bigint,text,text,bigint,text,text,text,timestamptz) to service_role;
grant execute on function private.governance_golden_case_set_import(text,jsonb,text,text,timestamptz) to service_role;
grant execute on function private.governance_rulespec_import(text,jsonb,text,text,timestamptz) to service_role;
grant execute on function private.governance_rulespec_approval_append(text,jsonb,bigint,text,text,bigint,text,text,text,timestamptz) to service_role;
grant execute on function private.governance_aggregate_read(text,text,text,text) to service_role;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'durable_human_legal_governance',
  'tivdoc-durable-governance-v0.10.1',
  '202609010004_durable_governance_workflows'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;

comment on table private.governance_human_decisions is
  'Immutable, revision-bound signed human decisions; admission records trust at signing and admission time.';
comment on table private.governance_work_items is
  'Durable reviewer queue with expiring leases and monotonically increasing fencing tokens.';
comment on table private.governance_legal_observation_versions is
  'Reconciliation-only legal observations. activation_allowed is structurally fixed false.';
comment on table private.governance_parameter_versions is
  'Two-reviewer parameter evidence workflow. Even dual-attested rows remain inactive.';
comment on table private.governance_rulespec_versions is
  'Complementary RuleSpec/golden-output review workflow. Even dual-approved rows remain inactive.';
