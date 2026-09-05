-- Site S1.5 / U2 (long run 10). A recipient outside the allowlist is REFUSED,
-- and a refusal is not a failure.
--
-- Why this needs its own state rather than reusing 'failed'. The reconcile
-- sweep looks for a verified payment with no token in state 'sent' and sends
-- again — which is exactly right for a transient failure, and exactly wrong for
-- a recipient the policy forbids. Recorded as 'failed', a refused recipient
-- would be retried on every sweep, forever, each retry another chance for the
-- provider to be called with an address that must never receive anything. So
-- 'refused' is a terminal state of its own, and the sweep skips it.
--
-- What it protects: the seven dummy cases carry real-looking contacts. Outside
-- production the allowlist is the owner's two channels and nothing else, so a
-- dummy case's contact can never be reached even if some code path tries.

alter table public.case_access_tokens
  drop constraint case_access_tokens_send_state_check,
  add constraint case_access_tokens_send_state_check
    check (send_state in ('pending', 'sent', 'failed', 'refused'));

alter table public.case_notifications
  drop constraint case_notifications_state_check,
  add constraint case_notifications_state_check
    check (state in ('sent', 'failed', 'refused'));

-- The sweep: a token already sent is done; a token refused is also done, by
-- decision. Only 'pending' and 'failed' are worth another attempt.
create or replace function public.case_access_pending_links(
  target_limit integer
) returns table (case_id uuid)
language sql
security invoker
set search_path = ''
as $$
  select distinct payment.case_id
  from public.payments payment
  join public.cases salary_case on salary_case.id = payment.case_id
  where payment.status = 'verified'
    and salary_case.contact_verified_at is not null
    and not exists (
      select 1 from public.case_access_tokens token
      where token.case_id = payment.case_id and token.purpose = 'payment_verified' and token.send_state in ('sent', 'refused')
    )
  limit greatest(1, least(target_limit, 200));
$$;

comment on function public.case_access_pending_links(integer) is
  'Cases with a verified payment and a verified contact whose payment_verified link has not been sent and was not refused. A refusal is terminal: the recipient is outside the delivery allowlist, and retrying would call the provider again for an address that must never receive anything.';
