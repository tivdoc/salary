-- Tivdoc Salary engine persistence foundation (Phase A only).
-- Review/apply to local or Preview after approval. This migration deliberately
-- preserves the legacy document uniqueness and upload behavior.

-- Add future immutable-document metadata without changing existing writes.
alter table public.documents
  add column if not exists declared_type text,
  add column if not exists detected_type text,
  add column if not exists classification_confidence numeric(5, 4),
  add column if not exists content_sha256 text,
  add column if not exists period_start date,
  add column if not exists period_end date,
  add column if not exists supersedes_document_id uuid,
  add column if not exists processing_status text not null default 'uploaded',
  add column if not exists storage_layout text not null default 'legacy_slot';

alter table public.documents
  add constraint documents_declared_type_code_check
    check (declared_type is null or declared_type ~ '^[a-z][a-z0-9]*([._:-][a-z0-9]+)*$'),
  add constraint documents_detected_type_code_check
    check (detected_type is null or detected_type ~ '^[a-z][a-z0-9]*([._:-][a-z0-9]+)*$'),
  add constraint documents_classification_confidence_check
    check (classification_confidence is null or classification_confidence between 0 and 1),
  add constraint documents_content_sha256_check
    check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint documents_period_check
    check (period_end is null or (period_start is not null and period_end >= period_start)),
  add constraint documents_processing_status_check
    check (processing_status in ('uploaded', 'queued', 'processing', 'ready', 'partial', 'failed', 'rejected')),
  add constraint documents_storage_layout_check
    check (storage_layout in ('legacy_slot', 'immutable_v1')),
  add constraint documents_immutable_metadata_check
    check (
      storage_layout = 'legacy_slot'
      or (
        declared_type is not null
        and content_sha256 is not null
        and storage_path like (
          'cases/' || case_id::text || '/documents/' || id::text || '/original.%'
        )
      )
    );

alter table public.documents
  add constraint documents_supersedes_document_id_fkey
  foreign key (supersedes_document_id)
  references public.documents(id)
  on delete set null;

create index if not exists documents_case_created_id_idx
  on public.documents(case_id, created_at, id);
create index if not exists documents_supersedes_idx
  on public.documents(supersedes_document_id)
  where supersedes_document_id is not null;
create index if not exists documents_content_sha256_idx
  on public.documents(content_sha256)
  where content_sha256 is not null;

create table public.analysis_runs (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  parent_run_id uuid references public.analysis_runs(id) on delete set null,
  run_type text not null check (run_type in ('initial_scan', 'full_investigation', 'shadow')),
  status text not null check (
    status in ('queued', 'running', 'waiting_for_customer', 'partial', 'blocked', 'completed', 'failed')
  ),
  trigger_reason text not null check (
    trigger_reason ~ '^[a-z][a-z0-9]*([._:-][a-z0-9]+)*$'
  ),
  engine_version text not null,
  engine_git_sha text not null check (engine_git_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  contract_version text not null,
  ontology_version text not null,
  rule_set_hash text check (rule_set_hash is null or rule_set_hash ~ '^[0-9a-f]{64}$'),
  input_snapshot jsonb not null check (jsonb_typeof(input_snapshot) = 'object'),
  input_snapshot_hash text not null check (input_snapshot_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key text not null,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  error_code text check (
    error_code is null or error_code ~ '^[a-z][a-z0-9]*([._:-][a-z0-9]+)*$'
  ),
  error_stage text check (
    error_stage is null or error_stage ~ '^[a-z][a-z0-9]*([._:-][a-z0-9]+)*$'
  ),
  constraint analysis_runs_idempotency_unique unique (case_id, idempotency_key),
  constraint analysis_runs_parent_not_self check (parent_run_id is null or parent_run_id <> id),
  constraint analysis_runs_started_check check (
    (status = 'queued' and started_at is null)
    or (status <> 'queued' and started_at is not null)
  ),
  constraint analysis_runs_completed_check check (
    (status in ('blocked', 'completed', 'failed')) = (completed_at is not null)
  ),
  constraint analysis_runs_failed_check check (
    (status = 'failed') = (error_code is not null)
  ),
  constraint analysis_runs_time_order_check check (
    (started_at is null or started_at >= created_at)
    and (completed_at is null or started_at is null or completed_at >= started_at)
  )
);

create index analysis_runs_case_created_idx on public.analysis_runs(case_id, created_at desc);
create index analysis_runs_parent_idx on public.analysis_runs(parent_run_id) where parent_run_id is not null;
create index analysis_runs_status_created_idx on public.analysis_runs(status, created_at);

create table public.employment_snapshots (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null unique references public.analysis_runs(id) on delete cascade,
  schema_version text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create table public.analysis_hypotheses (
  id uuid primary key,
  analysis_run_id uuid not null references public.analysis_runs(id) on delete cascade,
  hypothesis_key text not null,
  category text not null,
  status text not null check (
    status in ('open', 'ready_for_analysis', 'needs_information', 'confirmed', 'rejected', 'not_applicable', 'blocked')
  ),
  priority text not null check (priority in ('low', 'medium', 'high', 'critical')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  constraint analysis_hypotheses_key_unique unique (analysis_run_id, hypothesis_key),
  constraint analysis_hypotheses_idempotency_unique unique (analysis_run_id, idempotency_key)
);

create index analysis_hypotheses_run_status_idx
  on public.analysis_hypotheses(analysis_run_id, status, priority);

create table public.case_conversations (
  id uuid primary key,
  case_id uuid not null references public.cases(id) on delete cascade,
  analysis_run_id uuid references public.analysis_runs(id) on delete set null,
  status text not null check (status in ('open', 'waiting_for_customer', 'closed')),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint case_conversations_id_case_unique unique (id, case_id),
  constraint case_conversations_idempotency_unique unique (case_id, idempotency_key),
  constraint case_conversations_closed_check check (
    (status = 'closed') = (closed_at is not null)
  )
);

create index case_conversations_case_created_idx
  on public.case_conversations(case_id, created_at desc);
create index case_conversations_run_idx
  on public.case_conversations(analysis_run_id)
  where analysis_run_id is not null;

create table public.case_messages (
  id uuid primary key,
  case_id uuid not null references public.cases(id) on delete cascade,
  conversation_id uuid not null,
  analysis_run_id uuid references public.analysis_runs(id) on delete set null,
  role text not null check (role in ('system', 'assistant', 'customer')),
  agent text,
  question_id text,
  question_version integer check (question_version is null or question_version > 0),
  selected_option_ids text[] not null default '{}',
  free_text_answer text,
  content text,
  model_provider text,
  model_identifier text,
  prompt_version text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  constraint case_messages_conversation_case_fkey
    foreign key (conversation_id, case_id)
    references public.case_conversations(id, case_id)
    on delete cascade,
  constraint case_messages_idempotency_unique unique (conversation_id, idempotency_key),
  constraint case_messages_question_check check (
    (question_id is null) = (question_version is null)
    and (question_id is not null or (cardinality(selected_option_ids) = 0 and free_text_answer is null))
  ),
  constraint case_messages_content_check check (
    content is not null or cardinality(selected_option_ids) > 0 or free_text_answer is not null
  ),
  constraint case_messages_assistant_provenance_check check (
    role <> 'assistant' or (agent is not null and model_provider is not null and model_identifier is not null and prompt_version is not null)
  ),
  constraint case_messages_customer_provenance_check check (
    role <> 'customer' or (agent is null and model_provider is null and model_identifier is null and prompt_version is null)
  )
);

create index case_messages_conversation_created_idx
  on public.case_messages(conversation_id, created_at, id);
create index case_messages_run_idx
  on public.case_messages(analysis_run_id)
  where analysis_run_id is not null;

create table public.analysis_findings (
  id uuid primary key,
  analysis_run_id uuid not null references public.analysis_runs(id) on delete cascade,
  category text not null,
  status text not null check (status in ('candidate', 'needs_confirmation', 'verified', 'rejected', 'blocked')),
  period_start date,
  period_end date,
  currency char(3),
  paid_minor_units bigint,
  expected_minor_units bigint,
  potential_gap_minor_units bigint,
  confidence numeric(5, 4) not null check (confidence between 0 and 1),
  confidence_tier text not null check (confidence_tier in ('low', 'medium', 'high')),
  rule_id text not null,
  rule_version text not null,
  calculation_payload jsonb,
  fact_references uuid[] not null,
  evidence_references jsonb not null check (
    jsonb_typeof(evidence_references) = 'array' and jsonb_array_length(evidence_references) > 0
  ),
  requires_confirmation boolean not null,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  constraint analysis_findings_idempotency_unique unique (analysis_run_id, idempotency_key),
  constraint analysis_findings_period_check check (
    period_end is null or (period_start is not null and period_end >= period_start)
  ),
  constraint analysis_findings_currency_check check (
    currency is null or currency ~ '^[A-Z]{3}$'
  ),
  constraint analysis_findings_facts_check check (cardinality(fact_references) > 0),
  constraint analysis_findings_money_check check (
    (paid_minor_units is null or paid_minor_units between 0 and 9007199254740991)
    and (expected_minor_units is null or expected_minor_units between 0 and 9007199254740991)
    and (potential_gap_minor_units is null or potential_gap_minor_units between 0 and 9007199254740991)
    and (
      currency is not null
      or (paid_minor_units is null and expected_minor_units is null and potential_gap_minor_units is null)
    )
  ),
  constraint analysis_findings_calculation_check check (
    (expected_minor_units is null and potential_gap_minor_units is null)
    or calculation_payload is not null
  ),
  constraint analysis_findings_confirmation_check check (
    status <> 'verified' or requires_confirmation = false
  )
);

create index analysis_findings_run_status_idx
  on public.analysis_findings(analysis_run_id, status, category);

create table public.document_extractions (
  id uuid primary key,
  document_id uuid not null references public.documents(id) on delete cascade,
  analysis_run_id uuid references public.analysis_runs(id) on delete set null,
  extractor_id text not null,
  extractor_version text not null,
  model_version text,
  source_content_sha256 text not null check (source_content_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('queued', 'running', 'partial', 'completed', 'failed')),
  payload jsonb check (payload is null or jsonb_typeof(payload) = 'object'),
  quality_metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(quality_metrics) = 'object'),
  raw_artifact_path text check (
    raw_artifact_path is null
    or (
      raw_artifact_path like 'cases/%'
      and raw_artifact_path not like '%..%'
      and raw_artifact_path not like '%://%'
    )
  ),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  error_code text check (
    error_code is null or error_code ~ '^[a-z][a-z0-9]*([._:-][a-z0-9]+)*$'
  ),
  constraint document_extractions_idempotency_unique unique (document_id, idempotency_key),
  constraint document_extractions_completed_check check (
    (status in ('partial', 'completed', 'failed')) = (completed_at is not null)
  ),
  constraint document_extractions_completed_payload_check check (
    status <> 'completed' or payload is not null
  ),
  constraint document_extractions_error_check check (
    (status = 'failed') = (error_code is not null)
  )
);

create index document_extractions_document_created_idx
  on public.document_extractions(document_id, created_at desc);
create index document_extractions_run_idx
  on public.document_extractions(analysis_run_id)
  where analysis_run_id is not null;

create table public.case_confirmations (
  id uuid primary key,
  case_id uuid not null references public.cases(id) on delete cascade,
  source_analysis_run_id uuid not null references public.analysis_runs(id) on delete cascade,
  target_fact_path text not null,
  question_id text not null,
  question_version integer not null check (question_version > 0),
  proposed_value jsonb,
  answer jsonb,
  status text not null check (status in ('pending', 'confirmed', 'rejected', 'corrected')),
  source_message_id uuid references public.case_messages(id) on delete set null,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  constraint case_confirmations_idempotency_unique unique (case_id, idempotency_key),
  constraint case_confirmations_answered_check check (
    (status = 'pending' and answered_at is null and source_message_id is null and answer is null)
    or (status <> 'pending' and answered_at is not null and source_message_id is not null and answer is not null)
  )
);

create index case_confirmations_case_created_idx
  on public.case_confirmations(case_id, created_at desc);
create index case_confirmations_run_idx
  on public.case_confirmations(source_analysis_run_id);

create table public.analysis_jobs (
  id uuid primary key,
  analysis_run_id uuid not null references public.analysis_runs(id) on delete cascade,
  document_id uuid references public.documents(id) on delete cascade,
  extraction_id uuid references public.document_extractions(id) on delete set null,
  stage text not null check (
    stage in (
      'classify_document',
      'extract_document',
      'normalize',
      'resolve_facts',
      'investigate',
      'calculate',
      'build_findings',
      'generate_report'
    )
  ),
  status text not null check (
    status in ('queued', 'running', 'retry_scheduled', 'completed', 'failed', 'cancelled')
  ),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  idempotency_key text not null,
  retry_count integer not null default 0 check (retry_count >= 0),
  max_attempts integer not null default 3 check (max_attempts > 0),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  completed_at timestamptz,
  error_code text check (
    error_code is null or error_code ~ '^[a-z][a-z0-9]*([._:-][a-z0-9]+)*$'
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint analysis_jobs_idempotency_unique unique (analysis_run_id, idempotency_key),
  constraint analysis_jobs_retry_limit_check check (
    retry_count < max_attempts or status in ('completed', 'failed', 'cancelled')
  ),
  constraint analysis_jobs_completed_check check (
    (status in ('completed', 'failed', 'cancelled')) = (completed_at is not null)
  ),
  constraint analysis_jobs_error_check check (
    status <> 'failed' or error_code is not null
  )
);

create index analysis_jobs_claim_idx
  on public.analysis_jobs(status, available_at, created_at)
  where status in ('queued', 'retry_scheduled');
create index analysis_jobs_run_stage_idx
  on public.analysis_jobs(analysis_run_id, stage, status);
create index analysis_jobs_document_idx
  on public.analysis_jobs(document_id)
  where document_id is not null;

-- Enforce same-case lineage and prevent completed runs from being repurposed.
create or replace function private.enforce_engine_analysis_run_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  parent_case_id uuid;
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

create trigger analysis_runs_history_guard
before insert or update on public.analysis_runs
for each row execute function private.enforce_engine_analysis_run_history();

-- Extraction attempts can progress, but completed history cannot be overwritten.
create or replace function private.enforce_document_extraction_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status in ('partial', 'completed', 'failed') then
    raise exception 'Terminal document extractions are immutable';
  end if;

  if old.id is distinct from new.id
    or old.document_id is distinct from new.document_id
    or old.analysis_run_id is distinct from new.analysis_run_id
    or old.extractor_id is distinct from new.extractor_id
    or old.extractor_version is distinct from new.extractor_version
    or old.model_version is distinct from new.model_version
    or old.source_content_sha256 is distinct from new.source_content_sha256
    or old.idempotency_key is distinct from new.idempotency_key
    or old.created_at is distinct from new.created_at then
    raise exception 'Document extraction identity is immutable';
  end if;

  return new;
end;
$$;

create trigger document_extractions_history_guard
before update on public.document_extractions
for each row execute function private.enforce_document_extraction_history();

create or replace function private.enforce_case_conversation_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'closed' then
    raise exception 'Closed conversations are immutable';
  end if;
  if old.id is distinct from new.id
    or old.case_id is distinct from new.case_id
    or old.analysis_run_id is distinct from new.analysis_run_id
    or old.idempotency_key is distinct from new.idempotency_key
    or old.created_at is distinct from new.created_at then
    raise exception 'Conversation identity is immutable';
  end if;
  if not (
    (old.status = 'open' and new.status in ('waiting_for_customer', 'closed'))
    or (old.status = 'waiting_for_customer' and new.status in ('open', 'closed'))
  ) then
    raise exception 'Invalid conversation state transition';
  end if;
  return new;
end;
$$;

create trigger case_conversations_history_guard
before update on public.case_conversations
for each row execute function private.enforce_case_conversation_history();

create or replace function private.enforce_case_confirmation_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status <> 'pending' then
    raise exception 'Answered confirmations are immutable';
  end if;
  if old.id is distinct from new.id
    or old.case_id is distinct from new.case_id
    or old.source_analysis_run_id is distinct from new.source_analysis_run_id
    or old.target_fact_path is distinct from new.target_fact_path
    or old.question_id is distinct from new.question_id
    or old.question_version is distinct from new.question_version
    or old.proposed_value is distinct from new.proposed_value
    or old.idempotency_key is distinct from new.idempotency_key
    or old.created_at is distinct from new.created_at then
    raise exception 'Confirmation identity is immutable';
  end if;
  if new.status not in ('confirmed', 'rejected', 'corrected') then
    raise exception 'Invalid confirmation state transition';
  end if;
  return new;
end;
$$;

create trigger case_confirmations_history_guard
before update on public.case_confirmations
for each row execute function private.enforce_case_confirmation_history();

create or replace function private.enforce_analysis_job_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status in ('completed', 'failed', 'cancelled') then
    raise exception 'Terminal analysis jobs are immutable';
  end if;
  if old.id is distinct from new.id
    or old.analysis_run_id is distinct from new.analysis_run_id
    or old.document_id is distinct from new.document_id
    or old.extraction_id is distinct from new.extraction_id
    or old.stage is distinct from new.stage
    or old.payload is distinct from new.payload
    or old.idempotency_key is distinct from new.idempotency_key
    or old.max_attempts is distinct from new.max_attempts
    or old.created_at is distinct from new.created_at then
    raise exception 'Analysis job identity and input are immutable';
  end if;
  if not (
    (old.status = 'queued' and new.status in ('running', 'cancelled'))
    or (old.status = 'running' and new.status in ('retry_scheduled', 'completed', 'failed', 'cancelled'))
    or (old.status = 'retry_scheduled' and new.status in ('running', 'cancelled'))
  ) then
    raise exception 'Invalid analysis job state transition';
  end if;
  if new.status = 'retry_scheduled' and new.retry_count <> old.retry_count + 1 then
    raise exception 'Scheduling a retry must increment the retry count once';
  end if;
  if new.status <> 'retry_scheduled' and new.retry_count <> old.retry_count then
    raise exception 'Retry count changes only when a retry is scheduled';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger analysis_jobs_history_guard
before update on public.analysis_jobs
for each row execute function private.enforce_analysis_job_history();

-- Cross-table references must never join evidence from different cases.
create or replace function private.enforce_engine_case_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected_case_id uuid;
  referenced_case_id uuid;
  extraction_document_id uuid;
begin
  if tg_table_name = 'case_conversations' then
    expected_case_id := new.case_id;
    if new.analysis_run_id is not null then
      select run.case_id into referenced_case_id from public.analysis_runs run where run.id = new.analysis_run_id;
      if referenced_case_id is null or referenced_case_id <> expected_case_id then
        raise exception 'Conversation analysis run must belong to the same case';
      end if;
    end if;
  elsif tg_table_name = 'case_messages' then
    expected_case_id := new.case_id;
    if new.analysis_run_id is not null then
      select run.case_id into referenced_case_id from public.analysis_runs run where run.id = new.analysis_run_id;
      if referenced_case_id is null or referenced_case_id <> expected_case_id then
        raise exception 'Message analysis run must belong to the same case';
      end if;
    end if;
  elsif tg_table_name = 'case_confirmations' then
    expected_case_id := new.case_id;
    select run.case_id into referenced_case_id from public.analysis_runs run where run.id = new.source_analysis_run_id;
    if referenced_case_id is null or referenced_case_id <> expected_case_id then
      raise exception 'Confirmation analysis run must belong to the same case';
    end if;
    if new.source_message_id is not null then
      select message.case_id into referenced_case_id from public.case_messages message where message.id = new.source_message_id;
      if referenced_case_id is null or referenced_case_id <> expected_case_id then
        raise exception 'Confirmation message must belong to the same case';
      end if;
    end if;
  elsif tg_table_name = 'document_extractions' then
    if new.analysis_run_id is not null then
      select document.case_id into expected_case_id from public.documents document where document.id = new.document_id;
      select run.case_id into referenced_case_id from public.analysis_runs run where run.id = new.analysis_run_id;
      if expected_case_id is null or referenced_case_id is null or referenced_case_id <> expected_case_id then
        raise exception 'Extraction document and analysis run must belong to the same case';
      end if;
    end if;
  elsif tg_table_name = 'analysis_jobs' then
    select run.case_id into expected_case_id from public.analysis_runs run where run.id = new.analysis_run_id;
    if new.document_id is not null then
      select document.case_id into referenced_case_id from public.documents document where document.id = new.document_id;
      if referenced_case_id is null or referenced_case_id <> expected_case_id then
        raise exception 'Job document and analysis run must belong to the same case';
      end if;
    end if;
    if new.extraction_id is not null then
      select document.case_id, extraction.document_id
        into referenced_case_id, extraction_document_id
      from public.document_extractions extraction
      join public.documents document on document.id = extraction.document_id
      where extraction.id = new.extraction_id;
      if referenced_case_id is null or referenced_case_id <> expected_case_id then
        raise exception 'Job extraction and analysis run must belong to the same case';
      end if;
      if new.document_id is not null and extraction_document_id <> new.document_id then
        raise exception 'Job extraction must belong to the referenced document';
      end if;
    end if;
  end if;

  return new;
end;
$$;

create trigger case_conversations_case_scope_guard
before insert or update on public.case_conversations
for each row execute function private.enforce_engine_case_scope();
create trigger case_messages_case_scope_guard
before insert or update on public.case_messages
for each row execute function private.enforce_engine_case_scope();
create trigger case_confirmations_case_scope_guard
before insert or update on public.case_confirmations
for each row execute function private.enforce_engine_case_scope();
create trigger document_extractions_case_scope_guard
before insert or update on public.document_extractions
for each row execute function private.enforce_engine_case_scope();
create trigger analysis_jobs_case_scope_guard
before insert or update on public.analysis_jobs
for each row execute function private.enforce_engine_case_scope();

alter table public.analysis_runs enable row level security;
alter table public.employment_snapshots enable row level security;
alter table public.analysis_hypotheses enable row level security;
alter table public.case_conversations enable row level security;
alter table public.case_messages enable row level security;
alter table public.analysis_findings enable row level security;
alter table public.document_extractions enable row level security;
alter table public.case_confirmations enable row level security;
alter table public.analysis_jobs enable row level security;

revoke all on table public.analysis_runs from anon, authenticated;
revoke all on table public.employment_snapshots from anon, authenticated;
revoke all on table public.analysis_hypotheses from anon, authenticated;
revoke all on table public.case_conversations from anon, authenticated;
revoke all on table public.case_messages from anon, authenticated;
revoke all on table public.analysis_findings from anon, authenticated;
revoke all on table public.document_extractions from anon, authenticated;
revoke all on table public.case_confirmations from anon, authenticated;
revoke all on table public.analysis_jobs from anon, authenticated;

grant select, insert, update on table public.analysis_runs to service_role;
grant select, insert on table public.employment_snapshots to service_role;
grant select, insert on table public.analysis_hypotheses to service_role;
grant select, insert, update on table public.case_conversations to service_role;
grant select, insert on table public.case_messages to service_role;
grant select, insert on table public.analysis_findings to service_role;
grant select, insert, update on table public.document_extractions to service_role;
grant select, insert, update on table public.case_confirmations to service_role;
grant select, insert, update on table public.analysis_jobs to service_role;

revoke all on function private.enforce_engine_analysis_run_history() from public, anon, authenticated;
revoke all on function private.enforce_document_extraction_history() from public, anon, authenticated;
revoke all on function private.enforce_case_conversation_history() from public, anon, authenticated;
revoke all on function private.enforce_case_confirmation_history() from public, anon, authenticated;
revoke all on function private.enforce_analysis_job_history() from public, anon, authenticated;
revoke all on function private.enforce_engine_case_scope() from public, anon, authenticated;

comment on table public.analysis_runs is
  'Versioned engine executions. Lifecycle is independent from cases.status; terminal runs are historical.';
comment on column public.analysis_runs.input_snapshot is
  'Reference-only manifest of exact evidence inputs; validated and hashed by the server repository.';
comment on table public.employment_snapshots is
  'One schema-validated canonical fact snapshot per analysis run; individual facts remain JSON in V1.';
comment on table public.document_extractions is
  'Append-only extraction attempts. Payloads are sensitive and service-role only.';
comment on column public.document_extractions.raw_artifact_path is
  'Optional private Storage object path, never a public URL.';
comment on table public.analysis_jobs is
  'Durable idempotent work records only; no queue provider is introduced by Phase A.';
