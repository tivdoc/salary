-- E3-3, the corrective-append half of D3.
--
-- The one genuinely withdrawn legal decision — the vacation "200 vs 240"
-- question — carries `topic: "test"`, because A7-3's proof script registered it
-- through the same helper as its throwaway fixtures. The row is append-only and
-- `topic` is one of the columns the guard refuses to move, correctly: a topic
-- that could be edited after the fact is not evidence of what was decided about
-- what.
--
-- So the correction is an append. This writes an audit event against the
-- decision recording what is wrong and what is right, and touches no column of
-- the row. A reader following the audit trail sees the correction; a reader
-- looking only at the row sees the original mistake, which is the honest state
-- of affairs and better than a row that quietly disagrees with its own history.
create function private.governance_legal_open_decision_annotate(
  target_tenant text, target_decision_id text, target_annotation text,
  target_idempotency_key text, target_command_sha256 text, target_recorded_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  current_decision private.legal_open_decisions;
  payload jsonb;
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = '42501', message = 'GOVERNANCE_VERIFIED_TENANT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'legal_open_decision_annotate', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  if target_annotation is null or char_length(target_annotation) not between 20 and 2000 then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_OPEN_DECISION_ANNOTATION_REQUIRED';
  end if;
  select * into current_decision from private.legal_open_decisions decision
  where decision.tenant_id = target_tenant and decision.decision_id = target_decision_id;
  if current_decision.decision_id is null then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_OPEN_DECISION_UNKNOWN';
  end if;
  payload := pg_catalog.jsonb_build_object(
    'decision_id', target_decision_id,
    'annotation', target_annotation,
    'row_topic_at_annotation_time', current_decision.topic,
    'row_resolution_state_at_annotation_time', current_decision.resolution_state,
    'row_unchanged', true
  );
  result := private.governance_finish_mutation(
    target_tenant, 'legal_open_decision_annotate', target_idempotency_key, target_command_sha256,
    'parameter_approval', target_decision_id, '1', 1, current_decision.resolution_state,
    payload, private.governance_jsonb_sha256(payload),
    'legal_open_decision_annotated', 'system_import', target_recorded_at, false
  );
  return next result;
end;
$$;

alter function private.governance_legal_open_decision_annotate(text, text, text, text, text, timestamptz)
  owner to tivdoc_governance_owner;
revoke all on function private.governance_legal_open_decision_annotate(text, text, text, text, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function private.governance_legal_open_decision_annotate(text, text, text, text, text, timestamptz)
  to tivdoc_operations_runtime, tivdoc_worker_runtime;

comment on function private.governance_legal_open_decision_annotate(text, text, text, text, text, timestamptz) is
  'Appends a correction against a decision without editing it. For facts about a row that are wrong and cannot be changed, because the row is evidence.';
