-- UX Run 1 / U1 correction, found by the service tests: the per-IP ceiling
-- counted issued codes, so a request throttled by the identity limit or aimed
-- at an unknown contact left no trace and the ceiling could not be reached.
-- Every request now writes one row to a ledger — known or unknown contact,
-- allowed or refused — and both limits count from it. The identity limit
-- counts every request naming the identity; the IP limit counts every
-- request from the address. An unknown contact is refused 'unknown_identity'
-- inside the function, without a code and without an error, so the caller
-- answers it exactly like a known one.

create table public.case_access_requests (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid references public.case_identities(id) on delete set null,
  requester_ip_hash text check (requester_ip_hash is null or requester_ip_hash ~ '^[0-9a-f]{64}$'),
  outcome text not null check (outcome in ('issued', 'identity_rate_limited', 'ip_rate_limited', 'unknown_identity')),
  created_at timestamptz not null default now()
);
create index case_access_requests_ip_idx on public.case_access_requests(requester_ip_hash, created_at desc);
create index case_access_requests_identity_idx on public.case_access_requests(identity_id, created_at desc);

alter table public.case_access_requests enable row level security;
revoke all on table public.case_access_requests from public, anon, authenticated;
grant select, insert on table public.case_access_requests to service_role, tivdoc_web_runtime, tivdoc_worker_runtime;
create policy case_access_runtime_all on public.case_access_requests for all to tivdoc_web_runtime, tivdoc_worker_runtime using (true) with check (true);

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
    select count(*) into ip_recent from public.case_access_requests recent
    where recent.requester_ip_hash = target_ip_hash
      and recent.created_at > now() - make_interval(secs => ip_window_seconds);
    if ip_recent >= ip_limit then
      insert into public.case_access_requests (identity_id, requester_ip_hash, outcome) values (target_identity, target_ip_hash, 'ip_rate_limited');
      return query select null::uuid, 'ip_rate_limited'::text;
      return;
    end if;
  end if;
  if target_identity is null then
    insert into public.case_access_requests (identity_id, requester_ip_hash, outcome) values (null, target_ip_hash, 'unknown_identity');
    return query select null::uuid, 'unknown_identity'::text;
    return;
  end if;
  select count(*) into identity_recent from public.case_access_requests recent
  where recent.identity_id = target_identity
    and recent.created_at > now() - make_interval(secs => identity_window_seconds);
  if identity_recent >= identity_limit then
    insert into public.case_access_requests (identity_id, requester_ip_hash, outcome) values (target_identity, target_ip_hash, 'identity_rate_limited');
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
  insert into public.case_access_requests (identity_id, requester_ip_hash, outcome) values (target_identity, target_ip_hash, 'issued');
  return query select new_id, null::text;
end;
$$;

comment on table public.case_access_requests is
  'UX Run 1 / D-1.2: one row per code request, whatever its outcome; the per-identity and per-IP rate limits count from here.';
