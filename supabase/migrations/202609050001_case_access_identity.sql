-- UX Run 1 / U1 (design authority v1.1, D-1.1..D-1.5): one access system for a
-- case. A verified payment sends an opaque 128-bit link token (30 days) to the
-- contact channel on file; opening it asks for a six-digit code (10 minutes,
-- five attempts); a valid code opens a rolling 30-day session bound to the
-- contact IDENTITY, not the case, so one identity reaches every case it paid
-- for. No password exists anywhere. Tokens, codes and sessions are stored
-- hashed; nothing here holds a value a log line could leak.
--
-- Every function is SECURITY INVOKER and executed by the product's own
-- roles: service_role in production (PostgREST) and the web/worker runtime
-- roles on the local runtime (pg). RLS is on for every new table; the two
-- runtime roles get permissive policies on them and a read policy on the two
-- MVP tables a case view needs, which the MVP granted to service_role only.

-- 1. Identities: a contact channel, hashed and normalized, and its cases.
create table public.case_identities (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('email', 'phone')),
  contact_hash text not null check (contact_hash ~ '^[0-9a-f]{64}$'),
  contact_normalized text not null check (char_length(contact_normalized) between 3 and 180),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (channel, contact_hash)
);

create table public.case_identity_cases (
  identity_id uuid not null references public.case_identities(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (identity_id, case_id)
);
create index case_identity_cases_case_idx on public.case_identity_cases(case_id);

-- 2. Link tokens: one per (case, purpose='payment_verified'), the exactly-once
-- guarantee the five-minute reconcile cron relies on.
create table public.case_access_tokens (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  identity_id uuid not null references public.case_identities(id) on delete cascade,
  purpose text not null check (purpose in ('payment_verified', 'resend', 'report_ready')),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  send_state text not null default 'pending' check (send_state in ('pending', 'sent', 'failed')),
  send_attempts integer not null default 0 check (send_attempts >= 0),
  sent_at timestamptz,
  send_error_code text
);
create unique index case_access_tokens_payment_verified_once
  on public.case_access_tokens(case_id) where purpose = 'payment_verified';
create index case_access_tokens_case_idx on public.case_access_tokens(case_id, created_at desc);
create index case_access_tokens_pending_send_idx on public.case_access_tokens(send_state, created_at) where send_state <> 'sent';

-- 3. Codes: hashed with the identity, ten minutes, five attempts; the request
-- row itself is the rate-limit ledger (per identity and per requester IP hash).
create table public.case_access_codes (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references public.case_identities(id) on delete cascade,
  token_id uuid references public.case_access_tokens(id) on delete set null,
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  consumed_at timestamptz,
  locked_at timestamptz,
  requester_ip_hash text check (requester_ip_hash is null or requester_ip_hash ~ '^[0-9a-f]{64}$')
);
create index case_access_codes_identity_idx on public.case_access_codes(identity_id, created_at desc);
create index case_access_codes_ip_idx on public.case_access_codes(requester_ip_hash, created_at desc);

-- 4. Sessions: rolling, bound to the identity.
create table public.case_access_sessions (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references public.case_identities(id) on delete cascade,
  session_hash text not null unique check (session_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index case_access_sessions_identity_idx on public.case_access_sessions(identity_id, created_at desc);

-- 5. Notifications: what was sent, to which channel, by which provider, and
-- a digest of the payload — never the payload, never a token or a code.
create table public.case_notifications (
  id uuid primary key default gen_random_uuid(),
  case_id uuid references public.cases(id) on delete cascade,
  identity_id uuid references public.case_identities(id) on delete cascade,
  channel text not null check (channel in ('email', 'phone')),
  template text not null check (template in ('case_link', 'access_code', 'report_ready')),
  state text not null check (state in ('sent', 'failed')),
  provider text not null check (char_length(provider) between 1 and 40),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  error_code text,
  created_at timestamptz not null default now()
);
create index case_notifications_case_idx on public.case_notifications(case_id, created_at desc);

-- 6. Functions. All SECURITY INVOKER; the caller's grants and policies apply.

create or replace function public.case_access_identity_upsert(
  target_channel text,
  target_contact_hash text,
  target_contact_normalized text
) returns uuid
language sql
security invoker
set search_path = ''
as $$
  insert into public.case_identities (channel, contact_hash, contact_normalized)
  values (target_channel, target_contact_hash, target_contact_normalized)
  on conflict (channel, contact_hash) do update set last_seen_at = now()
  returning id;
$$;

create or replace function public.case_access_identity_find(
  target_channel text,
  target_contact_hash text
) returns table (identity_id uuid, contact_normalized text)
language sql
security invoker
set search_path = ''
as $$
  select identity.id, identity.contact_normalized
  from public.case_identities identity
  where identity.channel = target_channel and identity.contact_hash = target_contact_hash;
$$;

create or replace function public.case_access_identity_link(
  target_identity uuid,
  target_case uuid
) returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.case_identity_cases (identity_id, case_id)
  values (target_identity, target_case)
  on conflict do nothing;
$$;

-- The link token. For purpose 'payment_verified' the partial unique index makes
-- a second issue for the same case a no-op: issued=false, the existing id.
create or replace function public.case_access_token_issue(
  target_case uuid,
  target_identity uuid,
  target_purpose text,
  target_token_hash text,
  target_ttl_seconds integer
) returns table (token_id uuid, issued boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  new_id uuid;
begin
  if target_purpose = 'payment_verified' then
    insert into public.case_access_tokens (case_id, identity_id, purpose, token_hash, expires_at)
    values (target_case, target_identity, target_purpose, target_token_hash, now() + make_interval(secs => target_ttl_seconds))
    on conflict (case_id) where purpose = 'payment_verified' do nothing
    returning id into new_id;
    if new_id is null then
      return query
        select existing.id, false from public.case_access_tokens existing
        where existing.case_id = target_case and existing.purpose = 'payment_verified';
      return;
    end if;
    return query select new_id, true;
    return;
  end if;
  insert into public.case_access_tokens (case_id, identity_id, purpose, token_hash, expires_at)
  values (target_case, target_identity, target_purpose, target_token_hash, now() + make_interval(secs => target_ttl_seconds))
  returning id into new_id;
  return query select new_id, true;
end;
$$;

create or replace function public.case_access_token_mark_send(
  target_token uuid,
  target_state text,
  target_error_code text
) returns void
language sql
security invoker
set search_path = ''
as $$
  update public.case_access_tokens
  set send_state = target_state,
      send_attempts = send_attempts + 1,
      sent_at = case when target_state = 'sent' then now() else sent_at end,
      send_error_code = target_error_code
  where id = target_token;
$$;

-- Resolves a presented token to its case and identity; valid says whether it
-- may still open a challenge (not expired, not revoked).
create or replace function public.case_access_token_resolve(
  target_token_hash text
) returns table (
  token_id uuid, case_id uuid, identity_id uuid, channel text, contact_normalized text,
  public_id text, valid boolean
)
language sql
security invoker
set search_path = ''
as $$
  select token.id, token.case_id, token.identity_id, identity.channel, identity.contact_normalized,
    salary_case.public_id,
    (token.revoked_at is null and token.expires_at > now()) as valid
  from public.case_access_tokens token
  join public.case_identities identity on identity.id = token.identity_id
  join public.cases salary_case on salary_case.id = token.case_id
  where token.token_hash = target_token_hash;
$$;

create or replace function public.case_access_token_mark_used(
  target_token uuid
) returns void
language sql
security invoker
set search_path = ''
as $$
  update public.case_access_tokens set used_at = coalesce(used_at, now()) where id = target_token;
$$;

-- Issues a code unless a limit is hit. refused is null, 'identity_rate_limited'
-- or 'ip_rate_limited'; the caller answers 202 either way for the identity
-- limit (a contact's existence is never revealed) and 429 for the IP limit.
create or replace function public.case_access_code_issue(
  target_identity uuid,
  target_token uuid,
  target_code_hash text,
  target_ttl_seconds integer,
  target_max_attempts integer,
  target_ip_hash text,
  identity_limit integer,
  identity_window_seconds integer,
  ip_limit integer,
  ip_window_seconds integer
) returns table (code_id uuid, refused text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  identity_recent integer;
  ip_recent integer;
  new_id uuid;
begin
  if target_ip_hash is not null then
    select count(*) into ip_recent from public.case_access_codes recent
    where recent.requester_ip_hash = target_ip_hash
      and recent.created_at > now() - make_interval(secs => ip_window_seconds);
    if ip_recent >= ip_limit then
      return query select null::uuid, 'ip_rate_limited'::text;
      return;
    end if;
  end if;
  select count(*) into identity_recent from public.case_access_codes recent
  where recent.identity_id = target_identity
    and recent.created_at > now() - make_interval(secs => identity_window_seconds);
  if identity_recent >= identity_limit then
    return query select null::uuid, 'identity_rate_limited'::text;
    return;
  end if;
  -- One live code per identity: every earlier unconsumed code, locked or not, is superseded.
  update public.case_access_codes
  set consumed_at = now()
  where identity_id = target_identity and consumed_at is null;
  insert into public.case_access_codes (identity_id, token_id, code_hash, expires_at, max_attempts, requester_ip_hash)
  values (target_identity, target_token, target_code_hash, now() + make_interval(secs => target_ttl_seconds), target_max_attempts, target_ip_hash)
  returning id into new_id;
  return query select new_id, null::text;
end;
$$;

-- Verifies a code against the identity's live code. outcome: ok, invalid,
-- expired, locked, none. Every attempt counts; the sixth is refused as locked
-- regardless of the digits presented.
create or replace function public.case_access_code_verify(
  target_identity uuid,
  target_code_hash text
) returns table (outcome text, code_id uuid, token_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  live public.case_access_codes%rowtype;
begin
  select * into live from public.case_access_codes candidate
  where candidate.identity_id = target_identity and candidate.consumed_at is null
  order by candidate.created_at desc, candidate.id desc limit 1
  for update;
  if not found then
    return query select 'none'::text, null::uuid, null::uuid;
    return;
  end if;
  if live.locked_at is not null or live.attempts >= live.max_attempts then
    update public.case_access_codes set locked_at = coalesce(locked_at, now()) where id = live.id;
    return query select 'locked'::text, live.id, live.token_id;
    return;
  end if;
  update public.case_access_codes set attempts = attempts + 1 where id = live.id;
  if live.expires_at <= now() then
    return query select 'expired'::text, live.id, live.token_id;
    return;
  end if;
  if live.code_hash = target_code_hash then
    update public.case_access_codes set consumed_at = now() where id = live.id;
    return query select 'ok'::text, live.id, live.token_id;
    return;
  end if;
  if live.attempts + 1 >= live.max_attempts then
    update public.case_access_codes set locked_at = now() where id = live.id;
    return query select 'locked'::text, live.id, live.token_id;
    return;
  end if;
  return query select 'invalid'::text, live.id, live.token_id;
end;
$$;

create or replace function public.case_access_session_create(
  target_identity uuid,
  target_session_hash text,
  target_ttl_seconds integer
) returns uuid
language sql
security invoker
set search_path = ''
as $$
  insert into public.case_access_sessions (identity_id, session_hash, expires_at)
  values (target_identity, target_session_hash, now() + make_interval(secs => target_ttl_seconds))
  returning id;
$$;

-- Resolves a presented session and rolls it: the expiry moves forward once the
-- session has been idle for rolling_after_seconds, never on every request.
create or replace function public.case_access_session_resolve(
  target_session_hash text,
  target_ttl_seconds integer,
  rolling_after_seconds integer
) returns table (session_id uuid, identity_id uuid, channel text, contact_normalized text, expires_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  live public.case_access_sessions%rowtype;
begin
  select * into live from public.case_access_sessions candidate
  where candidate.session_hash = target_session_hash
    and candidate.revoked_at is null and candidate.expires_at > now();
  if not found then
    return;
  end if;
  if live.last_seen_at < now() - make_interval(secs => rolling_after_seconds) then
    update public.case_access_sessions
    set last_seen_at = now(), expires_at = now() + make_interval(secs => target_ttl_seconds)
    where id = live.id
    returning * into live;
  end if;
  return query
    select live.id, live.identity_id, identity.channel, identity.contact_normalized, live.expires_at
    from public.case_identities identity where identity.id = live.identity_id;
end;
$$;

create or replace function public.case_access_session_revoke(
  target_session_hash text
) returns void
language sql
security invoker
set search_path = ''
as $$
  update public.case_access_sessions set revoked_at = coalesce(revoked_at, now()) where session_hash = target_session_hash;
$$;

-- The identity's cases, newest first: what /cases lists and what /case/[id] checks.
create or replace function public.case_access_identity_cases(
  target_identity uuid
) returns table (
  case_id uuid, public_id text, status text, payment_status text, created_at timestamptz,
  payment_verified boolean
)
language sql
security invoker
set search_path = ''
as $$
  select salary_case.id, salary_case.public_id, salary_case.status, salary_case.payment_status, salary_case.created_at,
    exists (
      select 1 from public.payments payment
      where payment.case_id = salary_case.id and payment.status = 'verified'
    ) as payment_verified
  from public.case_identity_cases link
  join public.cases salary_case on salary_case.id = link.case_id
  where link.identity_id = target_identity
  order by salary_case.created_at desc;
$$;

-- The contact channel of a case, for the link a verified payment sends.
create or replace function public.case_access_case_contact(
  target_case uuid
) returns table (case_id uuid, public_id text, email text, phone text, first_name text, payment_verified boolean)
language sql
security invoker
set search_path = ''
as $$
  select salary_case.id, salary_case.public_id, salary_case.email, salary_case.phone, salary_case.first_name,
    exists (
      select 1 from public.payments payment
      where payment.case_id = salary_case.id and payment.status = 'verified'
    ) as payment_verified
  from public.cases salary_case
  where salary_case.id = target_case;
$$;

-- Verified payments with no payment_verified link yet: the catch-up sweep the
-- reconcile cron runs, so a send that failed at verification time is retried
-- and a verification that happened elsewhere still sends exactly once.
create or replace function public.case_access_pending_links(
  target_limit integer
) returns table (case_id uuid)
language sql
security invoker
set search_path = ''
as $$
  select distinct payment.case_id
  from public.payments payment
  where payment.status = 'verified'
    and not exists (
      select 1 from public.case_access_tokens token
      where token.case_id = payment.case_id and token.purpose = 'payment_verified' and token.send_state = 'sent'
    )
  limit greatest(1, least(target_limit, 200));
$$;

-- Failed or never-sent link tokens, for the retry inside the sweep.
create or replace function public.case_access_token_for_case(
  target_case uuid,
  target_purpose text
) returns table (token_id uuid, send_state text, send_attempts integer, identity_id uuid)
language sql
security invoker
set search_path = ''
as $$
  select token.id, token.send_state, token.send_attempts, token.identity_id
  from public.case_access_tokens token
  where token.case_id = target_case and token.purpose = target_purpose
  order by token.created_at desc limit 1;
$$;

create or replace function public.case_notification_record(
  target_case uuid,
  target_identity uuid,
  target_channel text,
  target_template text,
  target_state text,
  target_provider text,
  target_payload_sha256 text,
  target_error_code text
) returns uuid
language sql
security invoker
set search_path = ''
as $$
  insert into public.case_notifications (case_id, identity_id, channel, template, state, provider, payload_sha256, error_code)
  values (target_case, target_identity, target_channel, target_template, target_state, target_provider, target_payload_sha256, target_error_code)
  returning id;
$$;

create or replace function public.case_notification_count(
  target_case uuid,
  target_template text
) returns table (sent integer, failed integer)
language sql
security invoker
set search_path = ''
as $$
  select count(*) filter (where state = 'sent')::integer, count(*) filter (where state = 'failed')::integer
  from public.case_notifications
  where case_id = target_case and template = target_template;
$$;

-- 7. Access. RLS on every new table; service_role bypasses it as it does on the
-- MVP tables; the runtime roles the local runtime connects as get permissive
-- policies here and a read policy on the two MVP tables the case view joins.
alter table public.case_identities enable row level security;
alter table public.case_identity_cases enable row level security;
alter table public.case_access_tokens enable row level security;
alter table public.case_access_codes enable row level security;
alter table public.case_access_sessions enable row level security;
alter table public.case_notifications enable row level security;

revoke all on table public.case_identities, public.case_identity_cases, public.case_access_tokens,
  public.case_access_codes, public.case_access_sessions, public.case_notifications from public, anon, authenticated;

grant select, insert, update on table public.case_identities, public.case_identity_cases, public.case_access_tokens,
  public.case_access_codes, public.case_access_sessions, public.case_notifications
  to service_role, tivdoc_web_runtime, tivdoc_worker_runtime;

create policy case_access_runtime_all on public.case_identities for all to tivdoc_web_runtime, tivdoc_worker_runtime using (true) with check (true);
create policy case_access_runtime_all on public.case_identity_cases for all to tivdoc_web_runtime, tivdoc_worker_runtime using (true) with check (true);
create policy case_access_runtime_all on public.case_access_tokens for all to tivdoc_web_runtime, tivdoc_worker_runtime using (true) with check (true);
create policy case_access_runtime_all on public.case_access_codes for all to tivdoc_web_runtime, tivdoc_worker_runtime using (true) with check (true);
create policy case_access_runtime_all on public.case_access_sessions for all to tivdoc_web_runtime, tivdoc_worker_runtime using (true) with check (true);
create policy case_access_runtime_all on public.case_notifications for all to tivdoc_web_runtime, tivdoc_worker_runtime using (true) with check (true);

grant select on table public.cases, public.payments to tivdoc_web_runtime, tivdoc_worker_runtime;
create policy case_access_runtime_read on public.cases for select to tivdoc_web_runtime, tivdoc_worker_runtime using (true);
create policy case_access_runtime_read on public.payments for select to tivdoc_web_runtime, tivdoc_worker_runtime using (true);

do $$
declare
  signature text;
begin
  foreach signature in array array[
    'public.case_access_identity_upsert(text,text,text)',
    'public.case_access_identity_find(text,text)',
    'public.case_access_identity_link(uuid,uuid)',
    'public.case_access_token_issue(uuid,uuid,text,text,integer)',
    'public.case_access_token_mark_send(uuid,text,text)',
    'public.case_access_token_resolve(text)',
    'public.case_access_token_mark_used(uuid)',
    'public.case_access_code_issue(uuid,uuid,text,integer,integer,text,integer,integer,integer,integer)',
    'public.case_access_code_verify(uuid,text)',
    'public.case_access_session_create(uuid,text,integer)',
    'public.case_access_session_resolve(text,integer,integer)',
    'public.case_access_session_revoke(text)',
    'public.case_access_identity_cases(uuid)',
    'public.case_access_case_contact(uuid)',
    'public.case_access_pending_links(integer)',
    'public.case_access_token_for_case(uuid,text)',
    'public.case_notification_record(uuid,uuid,text,text,text,text,text,text)',
    'public.case_notification_count(uuid,text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', signature);
    execute format('grant execute on function %s to service_role, tivdoc_web_runtime, tivdoc_worker_runtime', signature);
  end loop;
end;
$$;

comment on table public.case_access_tokens is
  'UX Run 1 / D-1.2: the opaque link a verified payment sends, hashed; exactly one per case for purpose payment_verified.';
comment on table public.case_access_sessions is
  'UX Run 1 / D-1.3: the rolling identity session that is the whole "account"; no password exists.';
