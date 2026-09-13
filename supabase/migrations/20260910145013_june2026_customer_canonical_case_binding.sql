-- analysis_runs.case_id is the internal engine case key; bind the public case explicitly.
create or replace function private.june2026_canonical_test_customer(target_case uuid,target_identity uuid,target_run uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if current_database()<>'tivdoc_release_replay_20260907' or session_user<>'tivdoc_web_runtime'
  or not exists(select 1 from public.cases c join public.case_identity_cases i on i.case_id=c.id where c.id=target_case and c.is_qa
   and i.identity_id=target_identity and c.contact_verified_at is not null)
  then raise exception 'JUNE_TEST_REPORT_FORBIDDEN';end if;
 select jsonb_build_object('completion',ar.completion_payload,'comparison',r.comparison,'admission',r.admission,
  'current',h.revision=r.input_revision and h.input_sha256=r.input_sha256)
 into result from private.june2026_canonical_test_results r join public.analysis_runs ar on ar.id=r.analysis_run_id and ar.canonical_case_id=r.case_id::text and ar.tenant_id='saved-case:'||r.case_id::text
 join private.case_input_heads h on h.case_id=r.case_id
 where r.case_id=target_case and ar.canonical_analysis_run_id=target_run::text;
 return result;
end;$$;
revoke all on function private.june2026_canonical_test_customer(uuid,uuid,uuid) from public,anon,authenticated,service_role,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.june2026_canonical_test_customer(uuid,uuid,uuid) to tivdoc_web_runtime;

