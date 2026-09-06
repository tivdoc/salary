-- Site S2.4 (long run 11). The two transitions of "אמצא אחר כך", as SQL.
--
-- They are functions rather than updates the route writes because each one has
-- a guard that must hold no matter who calls it, and a guard in application
-- code is a guard one caller can forget:
--
--   `case_documents_await` moves a case to `awaiting_document` only from the
--   two states the funnel can be in when the customer says they have no
--   payslip. A paid case, a case under review, a completed case: never. It
--   returns the status the case actually has afterwards, so a caller that
--   assumed the move happened can see that it did not.
--
--   `case_documents_arrived` closes the blocking request when the payslip
--   turns up. It answers rather than deletes — the thread is a record of what
--   was asked and what came back (D-2), and a request that vanished when it was
--   satisfied would leave the customer's own history with a gap. It answers
--   only unanswered ones, because an answer is written once.
--
-- Both are security invoker: they touch only rows the calling runtime role can
-- already reach through the policies on `cases` and `case_requests`, so a
-- definer here would widen the definer surface for nothing.

create or replace function public.case_documents_await(target_case uuid)
returns text
language sql
security invoker
set search_path = ''
as $$
  with moved as (
    update public.cases
    set status = 'awaiting_document', updated_at = now()
    where id = target_case and status in ('started', 'questionnaire_completed')
    returning status
  )
  select coalesce(
    (select status from moved),
    (select status from public.cases where id = target_case)
  );
$$;

create or replace function public.case_documents_arrived(target_case uuid, target_answer text)
returns integer
language sql
security invoker
set search_path = ''
as $$
  with answered as (
    update public.case_requests
    set answered_at = now(), answer_text = target_answer
    where case_id = target_case and code = 'document_missing' and answered_at is null
    returning id
  )
  select count(*)::integer from answered;
$$;

grant execute on function public.case_documents_await(uuid) to tivdoc_web_runtime, tivdoc_operations_runtime, tivdoc_worker_runtime;
grant execute on function public.case_documents_arrived(uuid, text) to tivdoc_web_runtime, tivdoc_operations_runtime, tivdoc_worker_runtime;

comment on function public.case_documents_await(uuid) is
  'S2.4: the customer said they would find the payslip later. Moves a funnel case to awaiting_document and returns the status it ends with — never moving a case that has already gone past the funnel.';
comment on function public.case_documents_arrived(uuid, text) is
  'S2.4: the payslip arrived. Answers the open document_missing request (D-2 keeps the record; the answer is written once) and returns how many were closed.';
