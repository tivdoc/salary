alter table public.payments
  add column if not exists provider_payment_id text,
  add column if not exists provider_order_id text,
  add column if not exists provider_redirect_url text,
  add column if not exists provider_clearing_log_id text,
  add column if not exists provider_confirmation_number text,
  add column if not exists verified_at timestamptz,
  add column if not exists analytics_reported_at timestamptz;

create unique index if not exists payments_provider_payment_id_unique_idx
  on public.payments(provider_payment_id)
  where provider_payment_id is not null;

create unique index if not exists payments_provider_reference_unique_idx
  on public.payments(provider_reference)
  where provider_reference is not null;

create unique index if not exists payments_provider_clearing_log_id_unique_idx
  on public.payments(provider_clearing_log_id)
  where provider_clearing_log_id is not null;

update public.payments payment
set provider_payment_id = null,
    provider_redirect_url = null
where payment.provider_payment_id = '0'
  and payment.status = 'pending'
  and payment.provider_clearing_log_id is null
  and exists (
    select 1 from public.cases salary_case
    where salary_case.id = payment.case_id
      and salary_case.email like 'qa+invoice4u-%@tivdoc.com'
  );

drop function if exists public.verify_salary_payment(uuid, text, text, text, numeric, text);

create function public.verify_salary_payment(
  target_case_id uuid,
  expected_clearing_log_id text,
  observed_payment_id text,
  observed_confirmation_number text,
  observed_amount numeric,
  observed_currency text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  payment_row public.payments%rowtype;
  case_public_id text;
begin
  if expected_clearing_log_id is null or btrim(expected_clearing_log_id) = ''
    or observed_payment_id is null or btrim(observed_payment_id) in ('', '0')
    or observed_confirmation_number is null or btrim(observed_confirmation_number) = '' then
    raise exception 'Invoice4u transaction identifiers are required';
  end if;

  if observed_amount <> 9.99 or upper(observed_currency) <> 'ILS' then
    raise exception 'Invoice4u transaction amount or currency does not match';
  end if;

  select public_id
  into case_public_id
  from public.cases
  where id = target_case_id;

  if not found then
    raise exception 'Salary case was not found';
  end if;

  select *
  into payment_row
  from public.payments
  where case_id = target_case_id
    and idempotency_key = target_case_id::text || ':initial-check'
  for update;

  if not found then
    raise exception 'Pending payment was not found';
  end if;

  if payment_row.provider <> 'invoice4u'
    or payment_row.amount <> 9.99
    or upper(payment_row.currency::text) <> 'ILS'
    or payment_row.provider_clearing_log_id is distinct from expected_clearing_log_id
    or payment_row.provider_order_id is distinct from 'tivdoc-salary:' || case_public_id then
    raise exception 'Stored payment does not match the Invoice4u transaction';
  end if;

  if exists (
    select 1
    from public.payments other_payment
    where other_payment.case_id <> target_case_id
      and (
        other_payment.provider_payment_id = observed_payment_id
        or other_payment.provider_reference = expected_clearing_log_id
        or other_payment.provider_clearing_log_id = expected_clearing_log_id
      )
  ) then
    raise exception 'Invoice4u transaction is already assigned to another case';
  end if;

  if payment_row.status = 'verified' then
    if payment_row.provider_reference = expected_clearing_log_id
      and payment_row.provider_clearing_log_id = expected_clearing_log_id
      and payment_row.provider_payment_id = observed_payment_id then
      return false;
    end if;
    raise exception 'A different transaction already verified this payment';
  end if;

  update public.payments
  set status = 'verified',
      provider_payment_id = observed_payment_id,
      provider_reference = expected_clearing_log_id,
      provider_clearing_log_id = expected_clearing_log_id,
      provider_confirmation_number = observed_confirmation_number,
      verified_at = now()
  where id = payment_row.id;

  update public.cases
  set payment_status = 'verified',
      status = 'under_review'
  where id = target_case_id;

  if not found then
    raise exception 'Salary case was not found';
  end if;

  return true;
end;
$$;

revoke all on function public.verify_salary_payment(uuid, text, text, text, numeric, text)
  from public, anon, authenticated;
grant execute on function public.verify_salary_payment(uuid, text, text, text, numeric, text)
  to service_role;

create or replace function public.claim_salary_payment_completed(target_case_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed boolean := false;
begin
  update public.payments
  set analytics_reported_at = now()
  where case_id = target_case_id
    and idempotency_key = target_case_id::text || ':initial-check'
    and status = 'verified'
    and analytics_reported_at is null;

  claimed := found;
  return claimed;
end;
$$;

revoke all on function public.claim_salary_payment_completed(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_salary_payment_completed(uuid)
  to service_role;

drop function if exists private.mark_salary_case_paid(uuid, text);
