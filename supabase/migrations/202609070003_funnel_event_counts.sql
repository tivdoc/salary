-- Site S4 / D-11 (long run 12). The six conversions, counted where the events
-- are.
--
-- M01 was built in S6.3 and then fed an empty event list, so every conversion
-- read as a dash whatever had happened. This is the missing half: the counts
-- themselves.
--
-- Counted as DISTINCT CASES, not as events. A person who reloads the landing
-- five times is one person considering one check; counting rows would make the
-- first conversion look five times worse than it is, and the whole point of
-- D-11.3 showing only eight numbers is that each one can be trusted without a
-- footnote.
--
-- `landing_view` and `start_check` happen before a case exists, so they are
-- counted by session; everything after is counted by case. Mixing the two
-- denominators in one query is deliberate and is exactly how the funnel is
-- shaped — a session becomes a case at step two.

create or replace function public.case_funnel_event_counts(target_since timestamptz)
returns table (event_name text, cases bigint)
language sql
security invoker
set search_path = ''
as $$
  select
    event.event_name,
    case
      when event.event_name in ('landing_view', 'start_check')
        then count(distinct event.session_id)
      else count(distinct event.case_id)
    end as cases
  from public.funnel_events event
  where target_since is null or event.created_at >= target_since
  group by event.event_name;
$$;

grant execute on function public.case_funnel_event_counts(timestamptz) to tivdoc_web_runtime, tivdoc_operations_runtime, tivdoc_worker_runtime;

comment on function public.case_funnel_event_counts(timestamptz) is
  'S4 / D-11.1: distinct sessions (before a case exists) or distinct cases (after) per funnel event, which is what M01 divides.';
