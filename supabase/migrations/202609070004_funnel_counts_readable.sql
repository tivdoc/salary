-- Site S4 / D-11 (long run 12). The counter could not read what it counts.
--
-- `case_funnel_event_counts` was added as security invoker — correctly, since a
-- definer here would widen the definer surface for a read that needs no
-- elevation. But `funnel_events` was granted to `service_role` alone, so the
-- runtime roles that actually call the function got 42501 and M01's board came
-- back as a rejected command. The operations journey found it.
--
-- The fix is the grant, not the definer. Counting how many distinct sessions
-- reached a step needs no privilege the runtimes should not have: the table
-- holds no personal data by construction (its own comment says so), and read is
-- all that is given here — nothing may write a funnel event through this path.
--
-- Row-level security stays enabled. A policy is added for the same three roles,
-- because a grant without a policy on an RLS table is a table that answers
-- every query with zero rows — which would have been worse than the error: the
-- board would have shown a confident zero instead of failing loudly.

grant select on table public.funnel_events to tivdoc_web_runtime, tivdoc_operations_runtime, tivdoc_worker_runtime;
grant select on table public.funnel_sessions to tivdoc_web_runtime, tivdoc_operations_runtime, tivdoc_worker_runtime;

drop policy if exists funnel_events_runtime_read on public.funnel_events;
create policy funnel_events_runtime_read on public.funnel_events
  for select to tivdoc_web_runtime, tivdoc_operations_runtime, tivdoc_worker_runtime
  using (true);

drop policy if exists funnel_sessions_runtime_read on public.funnel_sessions;
create policy funnel_sessions_runtime_read on public.funnel_sessions
  for select to tivdoc_web_runtime, tivdoc_operations_runtime, tivdoc_worker_runtime
  using (true);

comment on policy funnel_events_runtime_read on public.funnel_events is
  'S4 / D-11: the runtimes may count funnel events for M01. Read only; no runtime writes an event through this path.';
