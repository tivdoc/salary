-- A committed dispatch is an uncertain external outcome until its immutable
-- response is recorded. Never delete/expire it merely to retry a provider call.
create table private.case_extraction_invocations (
 invocation_id uuid primary key,
 case_id uuid not null references public.cases(id) on delete cascade,
 version_id uuid not null,
 policy_version text not null,
 expected_month text not null check(expected_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
 input_sha256 text not null check(input_sha256 ~ '^[a-f0-9]{64}$'),
 source_revision integer not null check(source_revision > 0),
 job_id text not null,
 fencing_token bigint not null check(fencing_token > 0),
 dispatched_at timestamptz not null default clock_timestamp(),
 result jsonb,
 result_sha256 text check(result_sha256 ~ '^[a-f0-9]{64}$'),
 recorded_at timestamptz,
 unique(case_id,version_id,policy_version,expected_month),
 check ((result is null and result_sha256 is null and recorded_at is null) or
        (result is not null and result_sha256 is not null and recorded_at is not null)),
 check(result is null or coalesce(result->>'case_id'=case_id::text
  and result->>'version_id'=version_id::text and result->>'input_sha256'=input_sha256
  and result->>'expected_month'=expected_month and result->>'result_sha256'=result_sha256,false))
);
alter table private.case_extraction_invocations enable row level security;
alter table private.case_extraction_invocations force row level security;
revoke all on private.case_extraction_invocations from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime,tivdoc_worker_runtime;
grant select,insert on private.case_extraction_invocations to tivdoc_worker_runtime;
grant update(result,result_sha256,recorded_at) on private.case_extraction_invocations to tivdoc_worker_runtime;
create policy saved_extraction_machine_scope on private.case_extraction_invocations
 for all to tivdoc_worker_runtime
 using(private.runtime_verified_tenant()='saved-case:'||case_id::text)
 with check(private.runtime_verified_tenant()='saved-case:'||case_id::text);

create function private.preserve_extraction_invocation() returns trigger
 language plpgsql security invoker set search_path='' as $$
begin
 if old.result is not null or
  (to_jsonb(new)-array['result','result_sha256','recorded_at']) is distinct from
  (to_jsonb(old)-array['result','result_sha256','recorded_at']) then
  raise exception 'SAVED_EXTRACTION_RECEIPT_IMMUTABLE';
 end if;
 return new;
end;
$$;
revoke all on function private.preserve_extraction_invocation() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger preserve_extraction_invocation before update on private.case_extraction_invocations
 for each row execute function private.preserve_extraction_invocation();
