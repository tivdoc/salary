create extension if not exists pgcrypto;

create table if not exists public.cases (
  id uuid primary key default gen_random_uuid(),
  public_id text not null unique default (
    'TV-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
  ),
  first_name text not null,
  email text not null,
  phone text not null,
  status text not null default 'started' check (
    status in (
      'started',
      'questionnaire_completed',
      'documents_uploaded',
      'payment_pending',
      'paid',
      'under_review',
      'completed'
    )
  ),
  payment_status text not null default 'not_started' check (
    payment_status in ('not_started', 'pending', 'paid', 'verified', 'failed', 'refunded')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.questionnaire_responses (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null unique references public.cases(id) on delete cascade,
  payload jsonb not null,
  suspected_issue text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  document_type text not null check (document_type in ('payslip', 'contract', 'attendance')),
  storage_path text not null unique,
  original_filename text not null,
  mime_type text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
  size bigint not null check (size > 0 and size <= 10485760),
  created_at timestamptz not null default now(),
  unique (case_id, document_type)
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  provider text not null,
  amount numeric(10, 2) not null check (amount >= 0),
  currency char(3) not null default 'ILS',
  status text not null default 'pending' check (
    status in ('pending', 'paid', 'verified', 'failed', 'refunded')
  ),
  provider_reference text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists documents_case_id_idx on public.documents(case_id);
create index if not exists payments_case_id_created_at_idx on public.payments(case_id, created_at desc);
create index if not exists cases_status_created_at_idx on public.cases(status, created_at desc);

alter table public.cases enable row level security;
alter table public.questionnaire_responses enable row level security;
alter table public.documents enable row level security;
alter table public.payments enable row level security;

-- No anon/authenticated policies are created. All MVP access is mediated by
-- server-side route handlers using the service role.
revoke all on table public.cases from anon, authenticated;
revoke all on table public.questionnaire_responses from anon, authenticated;
revoke all on table public.documents from anon, authenticated;
revoke all on table public.payments from anon, authenticated;

grant select, insert, update, delete on table public.cases to service_role;
grant select, insert, update, delete on table public.questionnaire_responses to service_role;
grant select, insert, update, delete on table public.documents to service_role;
grant select, insert, update, delete on table public.payments to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'salary-documents',
  'salary-documents',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists cases_touch_updated_at on public.cases;
create trigger cases_touch_updated_at
before update on public.cases
for each row execute function public.touch_updated_at();

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.mark_salary_case_paid(
  target_case_id uuid,
  payment_reference text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.payments
  set status = 'verified',
      provider_reference = coalesce(payment_reference, provider_reference)
  where case_id = target_case_id
    and idempotency_key = target_case_id::text || ':initial-check';

  if not found then
    raise exception 'Pending payment was not found for case %', target_case_id;
  end if;

  update public.cases
  set payment_status = 'verified',
      status = 'under_review'
  where id = target_case_id;
end;
$$;

revoke all on function private.mark_salary_case_paid(uuid, text) from public, anon, authenticated;
