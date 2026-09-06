-- Site S6.1/S6.3 (long run 11). Every report that reached the gate gets a row,
-- including the ones the gate published by itself.
--
-- Why this is not just bookkeeping. Three separate things need it:
--
--   "who published this report" must have an answer for every report, and for
--   an automatically published one the honest answer is the gate, by name —
--   not an absent row that has to be interpreted.
--
--   D-11.2's first cost number is the share of reports on the automatic track.
--   A table that stored only the queued ones holds the numerator and not the
--   denominator, and a percentage computed against a missing denominator is
--   how a dashboard lies.
--
--   R-8 (S6.2) must be able to reach an automatically published report. A
--   parameter that changed does not care whether a person read the report.
--
-- The queue itself is unaffected: it lists the open states, and an automatic
-- row is born published.

create or replace function public.case_report_qa_enqueue(
  target_case uuid, target_projection uuid, target_report_kind text, target_document_track text,
  target_reasons text[], target_state text, target_actor text
) returns setof public.case_report_qa
language plpgsql security invoker set search_path = '' as $$
declare
  row_id uuid;
begin
  if target_state not in ('queued', 'published') then
    raise exception using errcode = 'P0001', message = 'CASE_REPORT_QA_STATE_UNKNOWN';
  end if;
  insert into public.case_report_qa (
    case_id, projection_id, report_kind, document_track, state, queue_reasons,
    operator_identity, decided_at, published_at
  )
  values (
    target_case, target_projection, target_report_kind, target_document_track, target_state, target_reasons,
    case when target_state = 'published' then target_actor else null end,
    case when target_state = 'published' then now() else null end,
    case when target_state = 'published' then now() else null end
  )
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

grant execute on function public.case_report_qa_enqueue(uuid, uuid, text, text, text[], text, text) to tivdoc_operations_runtime, tivdoc_worker_runtime;

-- S6.3 / M01. The two cost numbers, counted where the rows are rather than in
-- the application: the share of reports that never needed a person, and the
-- human review seconds those that did consumed.
create or replace function public.case_report_qa_track_summary()
returns table (
  reports bigint,
  automatic_reports bigint,
  reviewed_reports bigint,
  review_seconds_total bigint,
  cases_reviewed bigint
)
language sql security invoker set search_path = '' as $$
  select
    count(*)::bigint,
    count(*) filter (where cardinality(queue_reasons) = 0)::bigint,
    count(*) filter (where cardinality(queue_reasons) > 0)::bigint,
    coalesce(sum(review_seconds), 0)::bigint,
    count(distinct case_id) filter (where review_seconds is not null)::bigint
  from public.case_report_qa;
$$;

grant execute on function public.case_report_qa_track_summary() to tivdoc_operations_runtime, tivdoc_worker_runtime, tivdoc_web_runtime;

comment on function public.case_report_qa_track_summary() is
  'S6.3 / D-11.2: the denominator and numerator of the automatic-track share, and the review seconds behind the minutes-per-case number.';
