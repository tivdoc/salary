-- Tivdoc Salary: autonomous payment reconciliation and privacy-safe first-touch attribution.

alter table public.cases
  add column if not exists funnel_session_id uuid,
  add column if not exists utm_source text,
  add column if not exists utm_medium text,
  add column if not exists utm_campaign text,
  add column if not exists utm_content text,
  add column if not exists utm_term text,
  add column if not exists fbclid text,
  add column if not exists fbp text,
  add column if not exists fbc text,
  add column if not exists ga_client_id text,
  add column if not exists landing_url text,
  add column if not exists referrer text,
  add column if not exists first_touch_at timestamptz,
  add column if not exists current_questionnaire_step integer,
  add column if not exists is_qa boolean not null default false,
  add column if not exists attribution_status text not null default 'legacy_unresolved';

alter table public.cases
  drop constraint if exists cases_attribution_status_check;
alter table public.cases
  add constraint cases_attribution_status_check
  check (attribution_status in ('captured', 'legacy_unresolved', 'internal_qa'));

update public.cases
set is_qa = true,
    attribution_status = 'internal_qa'
where public_id in ('TV-7A65BCA3', 'TV-480D7508');

alter table public.payments
  add column if not exists reconciliation_attempted_at timestamptz,
  add column if not exists reconciliation_error text,
  add column if not exists ga4_purchase_event_id text,
  add column if not exists ga4_purchase_claimed_at timestamptz,
  add column if not exists ga4_purchase_sent_at timestamptz;

update public.payments
set ga4_purchase_event_id = 'tivdoc:payment_completed:' || id::text
where ga4_purchase_event_id is null;

update public.payments
set ga4_purchase_sent_at = analytics_reported_at
where ga4_purchase_sent_at is null
  and analytics_reported_at is not null;

create unique index if not exists payments_ga4_purchase_event_id_unique_idx
  on public.payments(ga4_purchase_event_id)
  where ga4_purchase_event_id is not null;

create table if not exists public.funnel_sessions (
  id uuid primary key,
  case_id uuid references public.cases(id) on delete set null,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  fbclid text,
  fbp text,
  fbc text,
  ga_client_id text,
  landing_url text,
  referrer text,
  first_touch_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  current_questionnaire_step integer,
  questionnaire_started_at timestamptz,
  questionnaire_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint funnel_sessions_step_check
    check (current_questionnaire_step is null or current_questionnaire_step between 1 and 7)
);

create table if not exists public.funnel_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.funnel_sessions(id) on delete cascade,
  case_id uuid references public.cases(id) on delete set null,
  event_name text not null,
  step_number integer,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  constraint funnel_events_name_check check (
    event_name in (
      'landing_view',
      'start_check',
      'questionnaire_started',
      'questionnaire_step_viewed',
      'questionnaire_step_completed',
      'questionnaire_completed',
      'case_created',
      'document_uploaded',
      'checkout_started',
      'payment_verified'
    )
  ),
  constraint funnel_events_step_check
    check (step_number is null or step_number between 1 and 7)
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'cases_funnel_session_id_fkey'
  ) then
    alter table public.cases
      add constraint cases_funnel_session_id_fkey
      foreign key (funnel_session_id) references public.funnel_sessions(id)
      on delete set null;
  end if;
end;
$$;

create index if not exists funnel_sessions_case_id_idx on public.funnel_sessions(case_id);
create index if not exists funnel_sessions_first_touch_idx on public.funnel_sessions(first_touch_at);
create index if not exists funnel_events_session_created_idx
  on public.funnel_events(session_id, created_at);
create index if not exists funnel_events_case_created_idx
  on public.funnel_events(case_id, created_at);
create index if not exists cases_attribution_idx
  on public.cases(utm_source, utm_campaign, utm_content);
create index if not exists cases_real_payment_reporting_idx
  on public.cases(created_at, payment_status)
  where is_qa = false;

alter table public.funnel_sessions enable row level security;
alter table public.funnel_events enable row level security;

revoke all on table public.funnel_sessions from anon, authenticated;
revoke all on table public.funnel_events from anon, authenticated;
grant select, insert, update, delete on table public.funnel_sessions to service_role;
grant select, insert, update, delete on table public.funnel_events to service_role;

comment on table public.funnel_sessions is
  'Privacy-minimised first-touch funnel sessions; written only through server routes.';
comment on table public.funnel_events is
  'Idempotent, non-PII funnel events linked to session and case.';
comment on column public.payments.ga4_purchase_sent_at is
  'Set only after GA4 Measurement Protocol accepts payment_completed.';

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
  where payment.case_id = target_case_id
    and payment.idempotency_key = target_case_id::text || ':initial-check'
  for update;

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

create or replace function public.complete_salary_ga4_purchase(
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
  set ga4_purchase_sent_at = coalesce(payment.ga4_purchase_sent_at, now()),
      analytics_reported_at = coalesce(payment.analytics_reported_at, now()),
      ga4_purchase_claimed_at = null
  where payment.id = target_payment_id
    and payment.status = 'verified'
    and payment.amount = 9.99
    and upper(payment.currency::text) = 'ILS'
    and payment.ga4_purchase_event_id = target_event_id;

  return found;
end;
$$;

create or replace function public.release_salary_ga4_purchase(
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
  set ga4_purchase_claimed_at = null
  where payment.id = target_payment_id
    and payment.ga4_purchase_event_id = target_event_id
    and payment.ga4_purchase_sent_at is null;

  return found;
end;
$$;

revoke all on function public.claim_salary_ga4_purchase(uuid)
  from public, anon, authenticated;
revoke all on function public.complete_salary_ga4_purchase(uuid, text)
  from public, anon, authenticated;
revoke all on function public.release_salary_ga4_purchase(uuid, text)
  from public, anon, authenticated;

grant execute on function public.claim_salary_ga4_purchase(uuid) to service_role;
grant execute on function public.complete_salary_ga4_purchase(uuid, text) to service_role;
grant execute on function public.release_salary_ga4_purchase(uuid, text) to service_role;
