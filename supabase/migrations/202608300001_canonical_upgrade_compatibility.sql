-- Tivdoc V0.9.1 upgrade compatibility bridge.
--
-- The original history guard intentionally rejects same-status updates.  The
-- canonical composition migration must enrich legacy analysis rows with new
-- ownership/command metadata without changing their existing domain history.
-- Install this bridge before the platform and canonical composition migrations
-- so that metadata-only enrichment is possible on non-empty upgrade databases.

create or replace function private.enforce_engine_analysis_run_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  parent_case_id uuid;
  old_metadata jsonb;
  new_metadata jsonb;
  metadata_enrichment_count integer;
begin
  if new.parent_run_id is not null then
    select run.case_id into parent_case_id
    from public.analysis_runs run
    where run.id = new.parent_run_id;

    if parent_case_id is null or parent_case_id <> new.case_id then
      raise exception 'Parent analysis run must belong to the same case';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    -- Later forward migrations add canonical metadata columns.  A same-status
    -- UPDATE may populate those columns only when every column that existed in
    -- the foundation schema remains byte-for-byte/domain-value equivalent.
    if old.status is not distinct from new.status then
      if old.id is distinct from new.id
        or old.case_id is distinct from new.case_id
        or old.parent_run_id is distinct from new.parent_run_id
        or old.run_type is distinct from new.run_type
        or old.trigger_reason is distinct from new.trigger_reason
        or old.engine_version is distinct from new.engine_version
        or old.engine_git_sha is distinct from new.engine_git_sha
        or old.contract_version is distinct from new.contract_version
        or old.ontology_version is distinct from new.ontology_version
        or old.rule_set_hash is distinct from new.rule_set_hash
        or old.input_snapshot is distinct from new.input_snapshot
        or old.input_snapshot_hash is distinct from new.input_snapshot_hash
        or old.idempotency_key is distinct from new.idempotency_key
        or old.started_at is distinct from new.started_at
        or old.completed_at is distinct from new.completed_at
        or old.created_at is distinct from new.created_at
        or old.error_code is distinct from new.error_code
        or old.error_stage is distinct from new.error_stage then
        raise exception 'Same-status analysis run updates may enrich canonical metadata only';
      end if;

      old_metadata := to_jsonb(old) - array[
        'id', 'case_id', 'parent_run_id', 'run_type', 'status', 'trigger_reason',
        'engine_version', 'engine_git_sha', 'contract_version', 'ontology_version',
        'rule_set_hash', 'input_snapshot', 'input_snapshot_hash', 'idempotency_key',
        'started_at', 'completed_at', 'created_at', 'error_code', 'error_stage'
      ];
      new_metadata := to_jsonb(new) - array[
        'id', 'case_id', 'parent_run_id', 'run_type', 'status', 'trigger_reason',
        'engine_version', 'engine_git_sha', 'contract_version', 'ontology_version',
        'rule_set_hash', 'input_snapshot', 'input_snapshot_hash', 'idempotency_key',
        'started_at', 'completed_at', 'created_at', 'error_code', 'error_stage'
      ];
      if exists (
        select 1
        from jsonb_each(old_metadata) prior
        full join jsonb_each(new_metadata) enriched using (key)
        where prior.key is null
          or enriched.key is null
          or (
            prior.value is distinct from enriched.value
            and (
              prior.key not in (
                'tenant_id', 'canonical_case_id', 'canonical_analysis_run_id',
                'command_sha256', 'command_payload', 'case_revision'
              )
              or prior.value <> 'null'::jsonb
              or enriched.value = 'null'::jsonb
            )
          )
      ) then
        raise exception 'Only canonical analysis ownership and command metadata may be enriched from null';
      end if;

      select count(*) into metadata_enrichment_count
      from jsonb_each(old_metadata) prior
      join jsonb_each(new_metadata) enriched using (key)
      where prior.value is distinct from enriched.value;
      if metadata_enrichment_count = 0 then
        raise exception 'Same-status analysis run updates require canonical metadata enrichment';
      end if;
      return new;
    end if;

    if old.id is distinct from new.id
      or old.case_id is distinct from new.case_id
      or old.parent_run_id is distinct from new.parent_run_id
      or old.run_type is distinct from new.run_type
      or old.trigger_reason is distinct from new.trigger_reason
      or old.engine_version is distinct from new.engine_version
      or old.engine_git_sha is distinct from new.engine_git_sha
      or old.contract_version is distinct from new.contract_version
      or old.ontology_version is distinct from new.ontology_version
      or old.rule_set_hash is distinct from new.rule_set_hash
      or old.input_snapshot is distinct from new.input_snapshot
      or old.input_snapshot_hash is distinct from new.input_snapshot_hash
      or old.idempotency_key is distinct from new.idempotency_key
      or old.created_at is distinct from new.created_at then
      raise exception 'Analysis run identity and inputs are immutable';
    end if;

    if old.status in ('blocked', 'completed', 'failed') then
      raise exception 'Terminal analysis runs are immutable';
    end if;

    if not (
      (old.status = 'queued' and new.status in ('running', 'failed'))
      or (old.status = 'running' and new.status in ('waiting_for_customer', 'partial', 'blocked', 'completed', 'failed'))
      or (old.status = 'waiting_for_customer' and new.status in ('running', 'blocked', 'failed'))
      or (old.status = 'partial' and new.status in ('running', 'waiting_for_customer', 'blocked', 'completed', 'failed'))
    ) then
      raise exception 'Invalid analysis run state transition';
    end if;
  end if;

  return new;
end;
$$;
