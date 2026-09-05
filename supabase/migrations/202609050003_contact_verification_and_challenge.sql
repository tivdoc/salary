-- External review #1 (5.9.2026), findings 1 and 8.
--
-- Finding 1: verifying a channel proved nothing about a payslip that was
-- already bound to a typed contact — a mistyped address would have handed
-- someone else's case to whoever owns that address. From here the channel
-- is verified in the funnel, before any document is bound and before any
-- payment: a case carries `contact_verified_at`, an identity is linked to a
-- case only by that verification, the link a verified payment sends goes
-- only to a verified contact, and `/login` reaches only cases so linked.
--
-- Finding 8: the link token rode the first request's path and stayed valid
-- for thirty days. It is now exchanged once — the exchange marks it used and
-- opens a short-lived challenge bound to a cookie — and the customer is
-- redirected to the case id at once, so the token appears in exactly one
-- request and in no later Referer.

alter table public.cases
  add column contact_verified_at timestamptz,
  add column contact_verified_channel text check (contact_verified_channel is null or contact_verified_channel in ('email', 'phone'));

alter table public.case_identities
  add column verified_at timestamptz;

alter table public.case_access_codes
  add column challenge_hash text unique check (challenge_hash is null or challenge_hash ~ '^[0-9a-f]{64}$'),
  add column case_id uuid references public.cases(id) on delete cascade;
create index case_access_codes_challenge_idx on public.case_access_codes(challenge_hash) where challenge_hash is not null;

-- The case's contact, with whether it was verified: the link goes only to a verified one. The row widens, so the
-- function is dropped and created (a replace cannot change a return type); its grants are re-issued below.
drop function public.case_access_case_contact(uuid);
create function public.case_access_case_contact(
  target_case uuid
) returns table (case_id uuid, public_id text, email text, phone text, first_name text, payment_verified boolean, contact_verified boolean, contact_verified_channel text)
language sql
security invoker
set search_path = ''
as $$
  select salary_case.id, salary_case.public_id, salary_case.email, salary_case.phone, salary_case.first_name,
    exists (
      select 1 from public.payments payment
      where payment.case_id = salary_case.id and payment.status = 'verified'
    ) as payment_verified,
    salary_case.contact_verified_at is not null as contact_verified,
    salary_case.contact_verified_channel
  from public.cases salary_case
  where salary_case.id = target_case;
$$;

-- The sweep considers only cases whose contact was verified.
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
      where token.case_id = payment.case_id and token.purpose = 'payment_verified' and token.send_state = 'sent'
    )
  limit greatest(1, least(target_limit, 200));
$$;

-- A used token no longer opens anything: the exchange is one-time.
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
    (token.revoked_at is null and token.used_at is null and token.expires_at > now()) as valid
  from public.case_access_tokens token
  join public.case_identities identity on identity.id = token.identity_id
  join public.cases salary_case on salary_case.id = token.case_id
  where token.token_hash = target_token_hash;
$$;

-- The funnel's own contact change, allowed only while the contact is unverified.
create or replace function public.case_access_funnel_contact_update(
  target_case uuid,
  target_channel text,
  target_value text
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  changed integer;
begin
  if target_channel = 'email' then
    update public.cases set email = target_value where id = target_case and contact_verified_at is null;
  elsif target_channel = 'phone' then
    update public.cases set phone = target_value where id = target_case and contact_verified_at is null;
  else
    return false;
  end if;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

-- The verification itself: the case is marked, the identity is marked, and only now is the identity linked to the case.
create or replace function public.case_access_funnel_verify(
  target_case uuid,
  target_identity uuid,
  target_channel text
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  changed integer;
begin
  update public.cases
  set contact_verified_at = coalesce(contact_verified_at, now()), contact_verified_channel = coalesce(contact_verified_channel, target_channel)
  where id = target_case;
  get diagnostics changed = row_count;
  if changed <> 1 then
    return false;
  end if;
  update public.case_identities set verified_at = coalesce(verified_at, now()), last_seen_at = now() where id = target_identity;
  insert into public.case_identity_cases (identity_id, case_id) values (target_identity, target_case) on conflict do nothing;
  return true;
end;
$$;

-- The challenge a link exchange opens: a code row that also carries the challenge cookie's hash and the case.
create or replace function public.case_access_challenge_open(
  target_identity uuid,
  target_token uuid,
  target_case uuid,
  target_code_hash text,
  target_challenge_hash text,
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
  issued record;
begin
  select * into issued from public.case_access_code_issue(
    target_identity, target_token, target_code_hash, target_ttl_seconds, target_max_attempts, target_ip_hash,
    identity_limit, identity_window_seconds, ip_limit, ip_window_seconds
  );
  if issued.code_id is null then
    return query select issued.code_id, issued.refused;
    return;
  end if;
  -- A resend re-binds the challenge to the fresh code; the superseded code lets go of it first.
  update public.case_access_codes set challenge_hash = null where challenge_hash = target_challenge_hash;
  update public.case_access_codes set challenge_hash = target_challenge_hash, case_id = target_case where id = issued.code_id;
  if target_token is not null then
    update public.case_access_tokens set used_at = coalesce(used_at, now()) where id = target_token;
  end if;
  return query select issued.code_id, issued.refused;
end;
$$;

-- What a challenge cookie names: the identity, the case and whether the challenge is still live.
create or replace function public.case_access_challenge_resolve(
  target_challenge_hash text
) returns table (code_id uuid, identity_id uuid, case_id uuid, public_id text, channel text, contact_normalized text, live boolean)
language sql
security invoker
set search_path = ''
as $$
  select code.id, code.identity_id, code.case_id, salary_case.public_id, identity.channel, identity.contact_normalized,
    (code.consumed_at is null and code.locked_at is null and code.expires_at > now()) as live
  from public.case_access_codes code
  join public.case_identities identity on identity.id = code.identity_id
  left join public.cases salary_case on salary_case.id = code.case_id
  where code.challenge_hash = target_challenge_hash;
$$;

grant update (email, phone, contact_verified_at, contact_verified_channel) on table public.cases to tivdoc_web_runtime, tivdoc_worker_runtime;
create policy case_access_runtime_update on public.cases for update to tivdoc_web_runtime, tivdoc_worker_runtime using (true) with check (true);

do $$
declare
  signature text;
begin
  foreach signature in array array[
    'public.case_access_case_contact(uuid)',
    'public.case_access_funnel_contact_update(uuid,text,text)',
    'public.case_access_funnel_verify(uuid,uuid,text)',
    'public.case_access_challenge_open(uuid,uuid,uuid,text,text,integer,integer,text,integer,integer,integer,integer)',
    'public.case_access_challenge_resolve(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', signature);
    execute format('grant execute on function %s to service_role, tivdoc_web_runtime, tivdoc_worker_runtime', signature);
  end loop;
end;
$$;

comment on column public.cases.contact_verified_at is
  'External review #1 finding 1: set by the funnel''s code verification; no document or payment binds to an unverified contact, and the case link goes only to a verified one.';
