-- Site S6.1/S6.2 (long run 11). The human review a report passes before a
-- customer sees it, and the record of who did it.
--
-- Two tables rather than one, because they answer different questions and have
-- different lifetimes:
--
--   `case_report_qa` is the queue's current state — one live row per report,
--   the reasons it is here (D-10.2/D-10.3), the operator's own wording, and
--   what was decided. It is mutable by design: a queue nobody can move is not a
--   queue.
--
--   `case_report_qa_log` is what happened, append-only, with the operator's
--   identity on every line. "הכל בלוג עם זהות המפעיל" — every state change is a
--   line here, and no update or delete can reach it, so the answer to "who
--   published this and when" cannot be edited afterwards.
--
-- What is NOT here, on purpose: any number. `wording` holds the operator's
-- phrasing of a finding and nothing else, and the report a customer receives is
-- the engine's projection plus these sentences — never a projection this table
-- rewrote. A number changes only by the engine writing a new projection row.
--
-- The queue can hold a report twice over its life (published, then invalidated
-- by R-8 and queued again as `recheck_required`); the partial unique index only
-- forbids two rows waiting for a person at the same time.

create table if not exists public.case_report_qa (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  projection_id uuid not null references public.case_report_projections(id) on delete cascade,
  report_kind text not null check (report_kind in ('initial', 'full')),
  document_track text not null check (document_track in ('automatic', 'human')),
  state text not null check (state in ('queued', 'approved', 'published', 'rejected', 'recheck_required')),
  -- Why a person is looking at this: D-10.2's four conditions and D-10.3.
  queue_reasons text[] not null default '{}',
  -- The operator's sentences, keyed by topic. Text only; see the header.
  wording jsonb not null default '{}'::jsonb,
  operator_identity text null,
  -- D-11.2's second cost number: human review minutes per paid case.
  review_seconds integer null check (review_seconds is null or review_seconds between 0 and 86400),
  queued_at timestamptz not null default now(),
  decided_at timestamptz null,
  published_at timestamptz null,
  constraint case_report_qa_wording_is_object_check check (jsonb_typeof(wording) = 'object'),
  constraint case_report_qa_decided_has_operator_check
    check (state in ('queued', 'recheck_required') or (operator_identity is not null and decided_at is not null)),
  constraint case_report_qa_published_pairing_check
    check ((state = 'published') = (published_at is not null))
);

-- One report may wait for a person once at a time.
create unique index if not exists case_report_qa_one_open_per_projection
  on public.case_report_qa (projection_id) where state in ('queued', 'recheck_required');

create index if not exists case_report_qa_queue_idx
  on public.case_report_qa (state, queued_at);
create index if not exists case_report_qa_case_idx
  on public.case_report_qa (case_id, queued_at desc);

create table if not exists public.case_report_qa_log (
  id uuid primary key default gen_random_uuid(),
  qa_id uuid not null references public.case_report_qa(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  action text not null check (action in ('queued', 'wording_edited', 'approved', 'published', 'rejected', 'recheck_required')),
  -- Never null: a line without an operator is a line that answers nothing. The
  -- automatic enqueue records the runtime that did it, by name.
  operator_identity text not null check (char_length(operator_identity) between 2 and 200),
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);

create index if not exists case_report_qa_log_qa_idx on public.case_report_qa_log (qa_id, at);

-- Append-only, enforced rather than trusted.
create or replace function public.case_report_qa_log_is_append_only() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'CASE_REPORT_QA_LOG_IS_APPEND_ONLY';
end;
$$;

drop trigger if exists case_report_qa_log_no_update on public.case_report_qa_log;
create trigger case_report_qa_log_no_update
  before update or delete on public.case_report_qa_log
  for each row execute function public.case_report_qa_log_is_append_only();

alter table public.case_report_qa enable row level security;
alter table public.case_report_qa force row level security;
alter table public.case_report_qa_log enable row level security;
alter table public.case_report_qa_log force row level security;

revoke all on table public.case_report_qa from anon, authenticated;
revoke all on table public.case_report_qa_log from anon, authenticated;
grant select, insert, update on table public.case_report_qa to tivdoc_operations_runtime, tivdoc_worker_runtime;
grant select on table public.case_report_qa to tivdoc_web_runtime;
grant select, insert on table public.case_report_qa_log to tivdoc_operations_runtime, tivdoc_worker_runtime;
grant select on table public.case_report_qa_log to tivdoc_web_runtime;

drop policy if exists case_report_qa_runtime on public.case_report_qa;
create policy case_report_qa_runtime on public.case_report_qa
  for all to tivdoc_operations_runtime, tivdoc_worker_runtime
  using (true) with check (true);
drop policy if exists case_report_qa_web_read on public.case_report_qa;
create policy case_report_qa_web_read on public.case_report_qa
  for select to tivdoc_web_runtime using (true);

drop policy if exists case_report_qa_log_runtime on public.case_report_qa_log;
create policy case_report_qa_log_runtime on public.case_report_qa_log
  for all to tivdoc_operations_runtime, tivdoc_worker_runtime
  using (true) with check (true);
drop policy if exists case_report_qa_log_web_read on public.case_report_qa_log;
create policy case_report_qa_log_web_read on public.case_report_qa_log
  for select to tivdoc_web_runtime using (true);

-- --- the functions the operations surface calls -------------------------------

create or replace function public.case_report_qa_enqueue(
  target_case uuid, target_projection uuid, target_report_kind text, target_document_track text,
  target_reasons text[], target_state text, target_actor text
) returns setof public.case_report_qa
language plpgsql security invoker set search_path = '' as $$
declare
  row_id uuid;
begin
  insert into public.case_report_qa (case_id, projection_id, report_kind, document_track, state, queue_reasons)
  values (target_case, target_projection, target_report_kind, target_document_track, target_state, target_reasons)
  on conflict do nothing
  returning id into row_id;
  if row_id is null then
    return query select * from public.case_report_qa
      where projection_id = target_projection and state in ('queued', 'recheck_required');
    return;
  end if;
  insert into public.case_report_qa_log (qa_id, case_id, action, operator_identity, detail)
  values (row_id, target_case, target_state, target_actor, jsonb_build_object('reasons', to_jsonb(target_reasons)));
  return query select * from public.case_report_qa where id = row_id;
end;
$$;

create or replace function public.case_report_qa_list(target_states text[], target_limit integer)
returns setof public.case_report_qa
language sql security invoker set search_path = '' as $$
  select * from public.case_report_qa
  where state = any (target_states)
  order by queued_at
  limit greatest(1, least(coalesce(target_limit, 50), 500));
$$;

create or replace function public.case_report_qa_wording_set(
  target_qa uuid, target_wording jsonb, target_actor text
) returns setof public.case_report_qa
language plpgsql security invoker set search_path = '' as $$
begin
  update public.case_report_qa
  set wording = target_wording
  where id = target_qa and state in ('queued', 'recheck_required');
  if not found then return; end if;
  insert into public.case_report_qa_log (qa_id, case_id, action, operator_identity, detail)
  select target_qa, case_id, 'wording_edited', target_actor, jsonb_build_object('topics', (select jsonb_agg(key) from jsonb_object_keys(target_wording) as key))
  from public.case_report_qa where id = target_qa;
  return query select * from public.case_report_qa where id = target_qa;
end;
$$;

create or replace function public.case_report_qa_decide(
  target_qa uuid, target_state text, target_actor text, target_review_seconds integer
) returns setof public.case_report_qa
language plpgsql security invoker set search_path = '' as $$
begin
  if target_state not in ('approved', 'published', 'rejected') then
    raise exception using errcode = 'P0001', message = 'CASE_REPORT_QA_STATE_UNKNOWN';
  end if;
  update public.case_report_qa
  set state = target_state,
      operator_identity = target_actor,
      review_seconds = coalesce(target_review_seconds, review_seconds),
      decided_at = now(),
      published_at = case when target_state = 'published' then now() else published_at end
  where id = target_qa and state in ('queued', 'recheck_required', 'approved');
  if not found then return; end if;
  insert into public.case_report_qa_log (qa_id, case_id, action, operator_identity, detail)
  select target_qa, case_id, target_state, target_actor, jsonb_build_object('review_seconds', target_review_seconds)
  from public.case_report_qa where id = target_qa;
  return query select * from public.case_report_qa where id = target_qa;
end;
$$;

-- S6.2. A parameter changed (R-8) and the reports that leaned on it are no
-- longer trustworthy: they go back in the queue. Published rows only — a report
-- nobody received needs no re-check, it needs finishing.
create or replace function public.case_report_qa_recheck(target_qa_ids uuid[], target_actor text, target_reason text)
returns integer
language plpgsql security invoker set search_path = '' as $$
declare
  moved integer;
begin
  with reopened as (
    update public.case_report_qa
    set state = 'recheck_required',
        queue_reasons = array(select distinct unnest(queue_reasons || array[target_reason])),
        decided_at = null
    where id = any (target_qa_ids) and state = 'published'
    returning id, case_id
  ), logged as (
    insert into public.case_report_qa_log (qa_id, case_id, action, operator_identity, detail)
    select id, case_id, 'recheck_required', target_actor, jsonb_build_object('reason', target_reason) from reopened
    returning 1
  )
  select count(*)::integer into moved from logged;
  return moved;
end;
$$;

grant execute on function public.case_report_qa_enqueue(uuid, uuid, text, text, text[], text, text) to tivdoc_operations_runtime, tivdoc_worker_runtime;
grant execute on function public.case_report_qa_list(text[], integer) to tivdoc_operations_runtime, tivdoc_worker_runtime, tivdoc_web_runtime;
grant execute on function public.case_report_qa_wording_set(uuid, jsonb, text) to tivdoc_operations_runtime, tivdoc_worker_runtime;
grant execute on function public.case_report_qa_decide(uuid, text, text, integer) to tivdoc_operations_runtime, tivdoc_worker_runtime;
grant execute on function public.case_report_qa_recheck(uuid[], text, text) to tivdoc_operations_runtime, tivdoc_worker_runtime;

comment on table public.case_report_qa is
  'S6.1: the human review queue. D-10.2 sends a report here when it did not pass all four automatic conditions; D-10.3 sends every full report. The operator edits wording only — no column here can carry a number into a report.';
comment on table public.case_report_qa_log is
  'S6.1: what happened to a report in review, append-only, with the operator identity on every line.';
