-- R-14. The rule executor's trace becomes durable, and replayable from the
-- database rather than from memory or a file.
--
-- Why a new table rather than public.engine_calculation_trace_versions: that
-- one is keyed by a customer case and an analysis run, both foreign keys into
-- the case tables. A synthetic rule-runtime execution has no case and must
-- never acquire one to be persisted — inventing a case row to hold a synthetic
-- trace would put synthetic material on the customer path, which is precisely
-- what every control in this system exists to prevent. This table is
-- tenant-scoped, case-free, append-only, and structurally non-operative.
--
-- What is stored is not only the trace. The exact inputs the trace was produced
-- from are stored beside it, because "replay from the database" means the
-- replaying process reconstructs the computation from persisted state and
-- compares — not that it reads back a blob and agrees with itself. A tampered
-- input row therefore produces a trace that no longer matches the stored hash,
-- and the replay refuses.
create table private.legal_operations_execution_traces (
  tenant_id text not null,
  execution_id text not null check (execution_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'),
  topic text not null check (topic in (
    'minimum_wage', 'working_time', 'pension', 'travel', 'convalescence', 'vacation', 'sick_leave'
  )),
  rule_spec_id text not null check (rule_spec_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'),
  rule_spec_version text not null check (rule_spec_version ~ '^[0-9]+(\.[0-9]+){0,2}$'),
  rule_content_sha256 text not null check (rule_content_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_sha256 text not null check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  execution_inputs jsonb not null check (jsonb_typeof(execution_inputs) = 'object'),
  execution_trace jsonb not null check (jsonb_typeof(execution_trace) = 'object'),
  -- The engine's own canonical hash of the trace, supplied by the caller. This
  -- is the one the replaying process must be able to reproduce.
  trace_sha256 text not null check (trace_sha256 ~ '^[0-9a-f]{64}$'),
  -- The database's independent hash of the same jsonb, computed here and never
  -- accepted from a caller. The two are deliberately different functions over
  -- different canonical forms, so they are two witnesses rather than one
  -- restated twice: an edit to the trace blob moves this one even if whoever
  -- made it also rewrote trace_sha256 to match their edit.
  trace_witness_sha256 text not null check (trace_witness_sha256 ~ '^[0-9a-f]{64}$'),
  result_sha256 text not null check (result_sha256 ~ '^[0-9a-f]{64}$'),
  -- Structural, not conventional: no row in this table can ever claim to be
  -- operative, the same way governance_aggregate_snapshots.activation_allowed
  -- cannot be true. A later migration that wants operative traces has to say so
  -- by dropping a named constraint, in a diff someone reads.
  operative boolean not null default false,
  recorded_at timestamptz not null,
  primary key (tenant_id, execution_id),
  constraint legal_operations_execution_traces_never_operative check (not operative)
);

alter table private.legal_operations_execution_traces owner to tivdoc_governance_owner;
alter table private.legal_operations_execution_traces enable row level security;
alter table private.legal_operations_execution_traces force row level security;

create policy legal_operations_execution_traces_verified_tenant on private.legal_operations_execution_traces
  for all to tivdoc_governance_owner
  using (tenant_id = private.runtime_verified_tenant())
  with check (tenant_id = private.runtime_verified_tenant());

-- Append-only in the strongest sense available: no column may ever change and
-- no row may ever be deleted. A trace that could be edited after the fact is
-- not evidence of anything.
create function private.legal_operations_execution_trace_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if pg_catalog.tg_op = 'DELETE' then
    raise exception using errcode = '42501', message = 'LEGAL_OPERATIONS_EXECUTION_TRACE_IMMUTABLE';
  end if;
  raise exception using errcode = '42501', message = 'LEGAL_OPERATIONS_EXECUTION_TRACE_IMMUTABLE';
end;
$$;

alter function private.legal_operations_execution_trace_guard() owner to tivdoc_governance_owner;

create trigger legal_operations_execution_traces_immutable
  before update or delete on private.legal_operations_execution_traces
  for each row execute function private.legal_operations_execution_trace_guard();

-- Appends one execution trace. Idempotent on (tenant, execution_id) through the
-- same ledger every other append uses, so a retried write is a replay rather
-- than a conflict, and a different command under the same key is refused.
create function private.legal_operations_execution_trace_append(
  target_tenant text, target_execution jsonb, target_idempotency_key text,
  target_command_sha256 text, target_recorded_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  target_execution_id text := target_execution ->> 'execution_id';
  target_topic text := target_execution ->> 'topic';
  target_rule_spec_id text := target_execution ->> 'rule_spec_id';
  target_rule_spec_version text := target_execution ->> 'rule_spec_version';
  target_rule_content_sha256 text := target_execution ->> 'rule_content_sha256';
  target_snapshot_sha256 text := target_execution ->> 'snapshot_sha256';
  target_inputs jsonb := target_execution -> 'execution_inputs';
  target_trace jsonb := target_execution -> 'execution_trace';
  target_trace_sha256 text := target_execution ->> 'trace_sha256';
  target_result_sha256 text := target_execution ->> 'result_sha256';
  content_sha256 text;
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = '42501', message = 'GOVERNANCE_VERIFIED_TENANT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'legal_operations_execution_trace_append', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  if pg_catalog.jsonb_typeof(target_execution) is distinct from 'object'
     or target_execution_id !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'
     or target_topic not in ('minimum_wage', 'working_time', 'pension', 'travel', 'convalescence', 'vacation', 'sick_leave')
     or target_rule_spec_id !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'
     or target_rule_spec_version !~ '^[0-9]+(\.[0-9]+){0,2}$'
     or target_rule_content_sha256 !~ '^[0-9a-f]{64}$'
     or target_snapshot_sha256 !~ '^[0-9a-f]{64}$'
     or target_trace_sha256 !~ '^[0-9a-f]{64}$'
     or target_result_sha256 !~ '^[0-9a-f]{64}$'
     or pg_catalog.jsonb_typeof(target_inputs) is distinct from 'object'
     or pg_catalog.jsonb_typeof(target_trace) is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'LEGAL_OPERATIONS_EXECUTION_TRACE_INVALID';
  end if;
  insert into private.legal_operations_execution_traces(
    tenant_id, execution_id, topic, rule_spec_id, rule_spec_version, rule_content_sha256,
    snapshot_sha256, execution_inputs, execution_trace, trace_sha256, trace_witness_sha256,
    result_sha256, operative, recorded_at
  ) values (
    target_tenant, target_execution_id, target_topic, target_rule_spec_id, target_rule_spec_version,
    target_rule_content_sha256, target_snapshot_sha256, target_inputs, target_trace,
    -- Caller's hash and the database's own, side by side. The witness is
    -- computed here from the row being written; there is no parameter for it.
    target_trace_sha256, private.governance_jsonb_sha256(target_trace),
    target_result_sha256, false, target_recorded_at
  );
  content_sha256 := private.governance_jsonb_sha256(pg_catalog.jsonb_build_object(
    'execution_id', target_execution_id, 'topic', target_topic,
    'rule_spec_id', target_rule_spec_id, 'rule_spec_version', target_rule_spec_version,
    'rule_content_sha256', target_rule_content_sha256, 'snapshot_sha256', target_snapshot_sha256,
    'trace_sha256', target_trace_sha256, 'result_sha256', target_result_sha256
  ));
  result := private.governance_finish_mutation(
    target_tenant, 'legal_operations_execution_trace_append', target_idempotency_key, target_command_sha256,
    'parameter_approval', target_execution_id, '1', 1, 'draft',
    target_execution, content_sha256, 'legal_operations_execution_trace_appended',
    'system_import', target_recorded_at, false
  );
  return next result;
end;
$$;

alter function private.legal_operations_execution_trace_append(text, jsonb, text, text, timestamptz)
  owner to tivdoc_governance_owner;
revoke all on function private.legal_operations_execution_trace_append(text, jsonb, text, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function private.legal_operations_execution_trace_append(text, jsonb, text, text, timestamptz)
  to tivdoc_operations_runtime, tivdoc_worker_runtime;

-- Reads one trace back. The replaying process gets the inputs, the trace and
-- the hashes; it recomputes and compares for itself. Nothing here asserts the
-- trace is correct — that is the replayer's job, and a read that also verified
-- would be marking its own homework.
create function private.legal_operations_execution_trace_read(
  target_tenant text, target_execution_id text
) returns table (
  execution_id text, topic text, rule_spec_id text, rule_spec_version text,
  rule_content_sha256 text, snapshot_sha256 text,
  execution_inputs jsonb, execution_trace jsonb,
  trace_sha256 text, trace_witness_sha256 text, live_trace_witness_sha256 text,
  result_sha256 text, operative boolean, recorded_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = '42501', message = 'GOVERNANCE_VERIFIED_TENANT_MISMATCH';
  end if;
  return query
    select t.execution_id, t.topic, t.rule_spec_id, t.rule_spec_version,
           t.rule_content_sha256, t.snapshot_sha256,
           t.execution_inputs, t.execution_trace,
           t.trace_sha256, t.trace_witness_sha256,
           -- Recomputed from the row as it stands right now, so the replayer
           -- can see for itself whether the stored witness still describes the
           -- stored blob. Comparing the two is the replayer's job.
           private.governance_jsonb_sha256(t.execution_trace),
           t.result_sha256, t.operative, t.recorded_at
      from private.legal_operations_execution_traces t
     where t.tenant_id = target_tenant
       and t.execution_id = target_execution_id;
end;
$$;

alter function private.legal_operations_execution_trace_read(text, text)
  owner to tivdoc_governance_owner;
revoke all on function private.legal_operations_execution_trace_read(text, text)
  from public, anon, authenticated, service_role;
grant execute on function private.legal_operations_execution_trace_read(text, text)
  to tivdoc_operations_runtime, tivdoc_worker_runtime;

comment on function private.legal_operations_execution_trace_append(text, jsonb, text, text, timestamptz) is
  'Appends one synthetic rule-execution trace with the inputs it was produced from; executable only by the explicitly granted least-privilege operations and worker principals.';
comment on function private.legal_operations_execution_trace_read(text, text) is
  'Reads one execution trace back for replay; verification is the replayer''s job, never this function''s.';
