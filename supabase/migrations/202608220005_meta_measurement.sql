alter table public.payments
  add column if not exists meta_checkout_event_id text,
  add column if not exists meta_checkout_sent_at timestamptz,
  add column if not exists meta_purchase_event_id text,
  add column if not exists meta_purchase_claimed_at timestamptz,
  add column if not exists meta_purchase_sent_at timestamptz;

update public.payments
set meta_checkout_event_id = 'tivdoc:InitiateCheckout:' || id::text
where meta_checkout_event_id is null;

update public.payments
set meta_purchase_event_id = 'tivdoc:Purchase:' || id::text
where meta_purchase_event_id is null;

create unique index if not exists payments_meta_checkout_event_id_unique_idx
  on public.payments(meta_checkout_event_id)
  where meta_checkout_event_id is not null;

create unique index if not exists payments_meta_purchase_event_id_unique_idx
  on public.payments(meta_purchase_event_id)
  where meta_purchase_event_id is not null;

comment on column public.payments.meta_purchase_claimed_at is
  'Short-lived atomic lease for delivery to Meta Conversions API.';

comment on column public.payments.meta_purchase_sent_at is
  'Set only after Meta accepts the verified Purchase event.';

create or replace function public.claim_salary_meta_purchase(target_case_id uuid)
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
  where payment.case_id = target_case_id
    and payment.idempotency_key = target_case_id::text || ':initial-check'
  for update;

  if not found or payment_row.status <> 'verified' then
    return;
  end if;

  if payment_row.amount <> 9.99 or upper(payment_row.currency::text) <> 'ILS' then
    raise exception 'Verified payment amount or currency is invalid for Meta Purchase';
  end if;

  if payment_row.meta_purchase_sent_at is not null then
    return;
  end if;

  if payment_row.meta_purchase_claimed_at is not null
    and payment_row.meta_purchase_claimed_at >= now() - interval '5 minutes' then
    return;
  end if;

  payment_row.meta_purchase_event_id := coalesce(
    payment_row.meta_purchase_event_id,
    'tivdoc:Purchase:' || payment_row.id::text
  );

  update public.payments payment
  set meta_purchase_event_id = payment_row.meta_purchase_event_id,
      meta_purchase_claimed_at = now()
  where payment.id = payment_row.id;

  return query
  select
    payment_row.id,
    payment_row.meta_purchase_event_id,
    payment_row.status,
    payment_row.amount,
    upper(payment_row.currency::text);
end;
$$;

create or replace function public.complete_salary_meta_purchase(
  target_payment_id uuid,
  target_event_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.payments payment
  set meta_purchase_sent_at = coalesce(payment.meta_purchase_sent_at, now()),
      meta_purchase_claimed_at = null
  where payment.id = target_payment_id
    and payment.status = 'verified'
    and payment.amount = 9.99
    and upper(payment.currency::text) = 'ILS'
    and payment.meta_purchase_event_id = target_event_id;

  return found;
end;
$$;

create or replace function public.release_salary_meta_purchase(
  target_payment_id uuid,
  target_event_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.payments payment
  set meta_purchase_claimed_at = null
  where payment.id = target_payment_id
    and payment.meta_purchase_event_id = target_event_id
    and payment.meta_purchase_sent_at is null;

  return found;
end;
$$;

revoke all on function public.claim_salary_meta_purchase(uuid)
  from public, anon, authenticated;
revoke all on function public.complete_salary_meta_purchase(uuid, text)
  from public, anon, authenticated;
revoke all on function public.release_salary_meta_purchase(uuid, text)
  from public, anon, authenticated;

grant execute on function public.claim_salary_meta_purchase(uuid) to service_role;
grant execute on function public.complete_salary_meta_purchase(uuid, text) to service_role;
grant execute on function public.release_salary_meta_purchase(uuid, text) to service_role;
