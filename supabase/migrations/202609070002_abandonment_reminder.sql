-- Site S4 (ב.12, long run 12). One message to someone who uploaded a payslip
-- and did not pay, and the opt-out that stops it.
--
-- The design constraint that shapes everything here: **one**. Not a sequence,
-- not a drip, not a second attempt if the first was not opened. A person who
-- uploaded a payslip and walked away has told us something, and the product's
-- answer is a single message saying the case is saved and where it is. A
-- product that chases people is a product that has stopped believing its own
-- offer.
--
-- Three columns, each answering a question that would otherwise be guessed:
--
--   `reminder_opted_out_at` — the person said no more. Checked before the
--   sweep looks at anything else, because an opt-out that can be overridden by
--   a later rule is not an opt-out.
--
--   `abandonment_reminder_sent_at` — the one message went. Its presence is
--   what makes the sweep idempotent: a cron that runs twice sends once, the
--   same property U4's link sweep has.
--
--   `abandonment_reminder_state` — what happened to it. A send that the
--   delivery allowlist REFUSED is terminal and must never be retried (S1.5's
--   distinction between refused and failed); a send that failed for a provider
--   reason may be retried by a later sweep.

alter table public.cases
  add column if not exists reminder_opted_out_at timestamptz null,
  add column if not exists abandonment_reminder_sent_at timestamptz null,
  add column if not exists abandonment_reminder_state text null;

alter table public.cases
  drop constraint if exists cases_abandonment_reminder_state_check;

alter table public.cases
  add constraint cases_abandonment_reminder_state_check check (
    abandonment_reminder_state is null
    or abandonment_reminder_state in ('sent', 'failed', 'refused')
  );

create index if not exists cases_abandonment_sweep_idx
  on public.cases (status, created_at)
  where abandonment_reminder_sent_at is null and reminder_opted_out_at is null;

-- The token purpose the reminder's link is issued under. Fifth and last of the
-- purposes: the case link, its resend, the report, the document request, and
-- now the reminder. Each says why a link exists, which is what makes an audit
-- of "who was sent what" answerable.
alter table public.case_access_tokens
  drop constraint case_access_tokens_purpose_check;

alter table public.case_access_tokens
  add constraint case_access_tokens_purpose_check check (
    purpose in ('payment_verified', 'resend', 'report_ready', 'document_request', 'abandonment_reminder')
  );

-- The sweep's own query, as a function, so the rule lives next to the data
-- rather than in whichever caller ran last.
--
-- `target_after_hours` is the wait — 24 by default (ב.12), passed in so the
-- configuration is the caller's and the boundary is not hard-coded twice.
create or replace function public.case_abandonment_candidates(target_after_hours integer, target_limit integer)
returns table (case_id uuid, public_id text, created_at timestamptz)
language sql
security invoker
set search_path = ''
as $$
  select salary_case.id, salary_case.public_id, salary_case.created_at
  from public.cases salary_case
  where salary_case.status = 'documents_uploaded'
    and salary_case.payment_status not in ('paid', 'verified')
    and salary_case.contact_verified_at is not null
    and salary_case.reminder_opted_out_at is null
    and salary_case.abandonment_reminder_sent_at is null
    -- A refused send is terminal: the allowlist will refuse it again, and a
    -- sweep that retried it would spin forever against a policy decision.
    and (salary_case.abandonment_reminder_state is null or salary_case.abandonment_reminder_state = 'failed')
    and salary_case.created_at < now() - make_interval(hours => greatest(target_after_hours, 1))
  order by salary_case.created_at
  limit greatest(1, least(coalesce(target_limit, 50), 200));
$$;

create or replace function public.case_abandonment_mark(target_case uuid, target_state text)
returns setof public.cases
language sql
security invoker
set search_path = ''
as $$
  update public.cases
  set abandonment_reminder_state = target_state,
      -- Only a send that actually went out closes the case for the sweep. A
      -- failure leaves it open for a later run; a refusal is closed by the
      -- state check in the candidate query, not by pretending it was sent.
      abandonment_reminder_sent_at = case when target_state = 'sent' then now() else abandonment_reminder_sent_at end,
      updated_at = now()
  where id = target_case
  returning *;
$$;

create or replace function public.case_reminder_opt_out(target_case uuid)
returns setof public.cases
language sql
security invoker
set search_path = ''
as $$
  update public.cases
  set reminder_opted_out_at = coalesce(reminder_opted_out_at, now()), updated_at = now()
  where id = target_case
  returning *;
$$;

grant execute on function public.case_abandonment_candidates(integer, integer) to tivdoc_web_runtime, tivdoc_operations_runtime, tivdoc_worker_runtime;
grant execute on function public.case_abandonment_mark(uuid, text) to tivdoc_web_runtime, tivdoc_operations_runtime, tivdoc_worker_runtime;
grant execute on function public.case_reminder_opt_out(uuid) to tivdoc_web_runtime, tivdoc_operations_runtime, tivdoc_worker_runtime;

comment on column public.cases.reminder_opted_out_at is
  'S4 ב.12: the customer asked for no reminders. Checked first, and nothing overrides it.';
comment on column public.cases.abandonment_reminder_sent_at is
  'S4 ב.12: the one reminder went out. Its presence is what makes the sweep idempotent.';
comment on column public.cases.abandonment_reminder_state is
  'S4 ב.12: sent, failed (a later sweep may retry) or refused (terminal — the delivery allowlist said no).';
