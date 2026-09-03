-- Wave 5 (G-7 lock semantics). First real call of the lock branch of
-- private.governance_gt_manifest_append, from the ground-truth matrix running
-- as tivdoc_operations_runtime, failed with SQLSTATE 42702 (ambiguous column
-- reference) at
--
--   exists (select 1 from private.governance_gt_active_locks active
--           where active.tenant_id = target_tenant and active.document_sha256 = document_sha256)
--
-- The PL/pgSQL variable `document_sha256` shadows the column of the same name
-- on governance_gt_active_locks and governance_gt_locks, so every statement in
-- this function that reads those tables — the lock guard, the correction
-- lookup, and the active-lock delete on correction — cannot be planned. The
-- annotation, disagreement and adjudication branches never touch those tables
-- and ran clean, which is why 202609020013 and the matrix's first ten
-- observations passed while the lock branch had been implemented_uncalled since
-- 202609010004. Same class of defect as 202609020014. Nothing else changes —
-- same checks, same raises, same grants, same owner; the body is the DEV body
-- with the variable renamed to `target_document_sha256` wherever it is the
-- variable. INSERT column lists keep the column name.
CREATE OR REPLACE FUNCTION private.governance_gt_manifest_append(target_tenant text, target_event_kind text, target_manifest jsonb, target_expected_workflow_revision bigint, target_work_item_id text, target_claimant_id text, target_fencing_token bigint, target_envelope_id text, target_idempotency_key text, target_command_sha256 text, target_recorded_at timestamp with time zone)
 RETURNS SETOF private.governance_mutation_receipt
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  target_document_sha256 text := target_manifest ->> 'document_sha256';
  target_status text := target_manifest ->> 'status';
  content_sha256 text := private.governance_jsonb_sha256(target_manifest);
  expected_work_kind text;
  expected_purpose text;
  expected_role text;
  expected_reviewer text;
  expected_action text;
  actor_id text := 'ground.truth.system';
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
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
     or target_expected_workflow_revision < 0 or target_document_sha256 !~ '^[a-f0-9]{64}$'
     or target_event_kind not in (
       'annotation_1_signed', 'annotation_2_signed', 'disagreement_recorded',
       'adjudication_signed', 'ground_truth_locked', 'correction_started'
     ) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_GT_MANIFEST_INVALID';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    private.governance_jsonb_canonical_text(pg_catalog.jsonb_build_object(
      'tenant_id', target_tenant, 'document_sha256', target_document_sha256
    )), 0
  ));
  select * into prior from private.governance_gt_manifest_versions item
  where item.tenant_id = target_tenant and item.manifest_id = target_manifest_id
  order by item.workflow_revision desc limit 1 for update;
  if coalesce(prior.workflow_revision, 0) is distinct from target_expected_workflow_revision then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_GT_WORKFLOW_REVISION_CONFLICT';
  end if;
  if prior.workflow_revision is not null and (
       prior.document_sha256 is distinct from target_document_sha256
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
    where active.tenant_id = target_tenant and active.document_sha256 = target_document_sha256
      and active.manifest_id = target_manifest ->> 'supersedes_manifest_id'
    for update of active;
    select * into strict superseded_manifest
    from private.governance_gt_manifest_versions version
    where version.tenant_id = target_tenant
      and version.manifest_id = active_lock.manifest_id
      and version.workflow_revision = active_lock.workflow_revision;
    if target_manifest_revision is distinct from active_lock.manifest_revision + 1
       or superseded_manifest.document_sha256 is distinct from target_document_sha256
       or superseded_manifest.manifest_json ->> 'schema_version' is distinct from target_manifest ->> 'schema_version'
       or superseded_manifest.manifest_json -> 'sections' is distinct from target_manifest -> 'sections' then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_GT_CORRECTION_BINDING_MISMATCH';
    end if;
    delete from private.governance_gt_active_locks active
    where active.tenant_id = target_tenant and active.document_sha256 = target_document_sha256
      and active.manifest_id = active_lock.manifest_id;
    insert into private.governance_gt_lock_supersessions(
      tenant_id, document_sha256, prior_manifest_id, superseding_manifest_id, superseded_at
    ) values (
      target_tenant, target_document_sha256, active_lock.manifest_id,
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
         where active.tenant_id = target_tenant and active.document_sha256 = target_document_sha256
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
       or claim.document_sha256 is distinct from target_document_sha256 or claim.required_role is distinct from expected_role
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
      'document_sha256', target_document_sha256,
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
    target_event_kind, target_document_sha256, target_status, target_manifest,
    content_sha256, target_envelope_id, target_recorded_at
  );
  if target_event_kind = 'ground_truth_locked' then
    insert into private.governance_gt_locks(
      tenant_id, document_sha256, manifest_id, manifest_revision,
      workflow_revision, locked_sha256, envelope_id, locked_at
    ) values (
      target_tenant, target_document_sha256, target_manifest_id, target_manifest_revision,
      next_workflow_revision, target_manifest ->> 'locked_sha256', target_envelope_id,
      target_recorded_at
    );
    insert into private.governance_gt_active_locks(
      tenant_id, document_sha256, manifest_id, activated_at
    ) values (
      target_tenant, target_document_sha256, target_manifest_id, target_recorded_at
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
$function$;
