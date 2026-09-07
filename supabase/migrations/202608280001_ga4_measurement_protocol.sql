-- Tivdoc Salary: GA4 dual-event delivery and QA-safe recovery.

create index if not exists payments_ga4_delivery_pending_idx
  on public.payments(status, ga4_purchase_sent_at)
  where status = 'verified' and ga4_purchase_sent_at is null;

comment on column public.payments.ga4_purchase_sent_at is
  'Set only after GA4 Measurement Protocol accepts payment_completed and purchase together.';

create or replace function public.claim_salary_ga4_purchase(target_case_id uuid)
returns table (
  payment_id uuid,
  event_id text,
  payment_status text,
  payment_amount numeric,
  payment_currency text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  payment_row public.payments%rowtype;
begin
  select payment.*
  into payment_row
  from public.payments payment
  join public.cases salary_case on salary_case.id = payment.case_id
  where payment.case_id = target_case_id
    and payment.idempotency_key = target_case_id::text || ':initial-check'
    and salary_case.is_qa = false
  for update of payment;

  if not found or payment_row.status <> 'verified' then
    return;
  end if;

  if payment_row.amount <> 9.99 or upper(payment_row.currency::text) <> 'ILS' then
    raise exception 'Verified payment amount or currency is invalid for GA4';
  end if;

  if payment_row.ga4_purchase_sent_at is not null then
    return;
  end if;

  if payment_row.ga4_purchase_claimed_at is not null
    and payment_row.ga4_purchase_claimed_at >= now() - interval '5 minutes' then
    return;
  end if;

  payment_row.ga4_purchase_event_id := coalesce(
    payment_row.ga4_purchase_event_id,
    'tivdoc:payment_completed:' || payment_row.id::text
  );

  update public.payments payment
  set ga4_purchase_event_id = payment_row.ga4_purchase_event_id,
      ga4_purchase_claimed_at = now()
  where payment.id = payment_row.id;

  return query
  select
    payment_row.id,
    payment_row.ga4_purchase_event_id,
    payment_row.status,
    payment_row.amount,
    upper(payment_row.currency::text);
end;
$$;

revoke all on function public.claim_salary_ga4_purchase(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_salary_ga4_purchase(uuid) to service_role;
