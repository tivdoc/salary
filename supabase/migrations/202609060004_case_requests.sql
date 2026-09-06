-- Site S3.4 / D-2 (long run 11). The thread: where a refusal becomes a question.
--
-- A row here exists because the engine refused something it could answer if the
-- case told it one more fact. That is the only way one is created — there is no
-- path from a screen, and the open function takes the refusal's own code.
--
-- Two properties the table enforces rather than trusts:
--
--   one open request per code per case. A sweep that ran twice, or two refusals
--   naming the same missing fact, must not ask the customer the same question
--   twice — the partial unique index makes a second one impossible while the
--   first is unanswered.
--
--   answered is terminal. `answered_at` and `answer_text` move together and
--   only once; the guard refuses an update that would change an answer already
--   given, because a thread the customer can watch being rewritten is not a
--   record of what they said.
--
-- D-7.2: a blocking request pauses the SLA clock while it is open.
-- D-9: `expires_at` is ten days from opening; an expired request stops holding
-- the case and is not deleted, so the case's history still shows it was asked.

create table if not exists public.case_requests (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  -- The refusal code this came from. S3.3 maps it to the question below.
  code text not null check (code ~ '^[a-z][a-z0-9_.:]{2,119}$'),
  question text not null check (char_length(question) between 4 and 400),
  answer_kind text not null check (answer_kind in ('choice', 'number', 'text', 'document')),
  options text[] null,
  field_crop text null,
  blocking boolean not null,
  opened_at timestamptz not null default now(),
  expires_at timestamptz not null,
  answered_at timestamptz null,
  answer_text text null check (answer_text is null or char_length(answer_text) between 1 and 2000),
  constraint case_requests_answer_pairing_check
    check ((answered_at is null and answer_text is null) or (answered_at is not null and answer_text is not null)),
  constraint case_requests_expiry_after_opening_check check (expires_at > opened_at)
);

-- One open question per code per case: the customer is never asked twice.
create unique index if not exists case_requests_one_open_per_code
  on public.case_requests (case_id, code) where answered_at is null;

create index if not exists case_requests_case_idx on public.case_requests (case_id, opened_at desc);

alter table public.case_requests enable row level security;
alter table public.case_requests force row level security;

-- An answer is written once. Re-answering, or editing an answer, is refused.
-- SECURITY INVOKER on purpose: this trigger only refuses, so it needs no rights
-- the caller does not already have, and a definer here would widen the definer
-- surface for nothing.
create or replace function public.case_requests_answer_is_final() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if OLD.answered_at is not null then
    raise exception using errcode = 'P0001', message = 'CASE_REQUEST_ALREADY_ANSWERED';
  end if;
  if NEW.code is distinct from OLD.code or NEW.question is distinct from OLD.question
     or NEW.case_id is distinct from OLD.case_id or NEW.opened_at is distinct from OLD.opened_at then
    raise exception using errcode = 'P0001', message = 'CASE_REQUEST_IS_APPEND_ONLY';
  end if;
  return NEW;
end;
$$;

drop trigger if exists case_requests_answer_is_final on public.case_requests;
create trigger case_requests_answer_is_final
  before update on public.case_requests
  for each row execute function public.case_requests_answer_is_final();

revoke all on table public.case_requests from anon, authenticated;
grant select, insert, update on table public.case_requests to tivdoc_web_runtime, tivdoc_operations_runtime, tivdoc_worker_runtime;

drop policy if exists case_requests_runtime on public.case_requests;
create policy case_requests_runtime on public.case_requests
  for all to tivdoc_web_runtime, tivdoc_operations_runtime, tivdoc_worker_runtime
  using (true) with check (true);

-- --- the three functions the product calls -----------------------------------

create or replace function public.case_request_list(target_case uuid)
returns setof public.case_requests
language sql security invoker set search_path = '' as $$
  select * from public.case_requests where case_id = target_case order by opened_at desc;
$$;

create or replace function public.case_request_open(
  target_case uuid, target_code text, target_question text, target_answer_kind text,
  target_options text[], target_field_crop text, target_blocking boolean, target_expires_at timestamptz
) returns setof public.case_requests
language sql security invoker set search_path = '' as $$
  insert into public.case_requests (case_id, code, question, answer_kind, options, field_crop, blocking, expires_at)
  values (target_case, target_code, target_question, target_answer_kind, target_options, target_field_crop, target_blocking, target_expires_at)
  on conflict do nothing
  returning *;
$$;

create or replace function public.case_request_answer(target_request uuid, target_case uuid, target_answer text)
returns setof public.case_requests
language sql security invoker set search_path = '' as $$
  update public.case_requests
  set answered_at = now(), answer_text = target_answer
  where id = target_request and case_id = target_case and answered_at is null
  returning *;
$$;

comment on table public.case_requests is
  'D-2: the thread. A row exists because a refusal opened it — never because a screen did. One open request per code per case; an answer is written once and never edited; a blocking request pauses the SLA clock (D-7.2) and expires ten days after opening (D-9).';
