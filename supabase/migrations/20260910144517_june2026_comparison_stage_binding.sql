-- Bind the entire monetary comparison to its same-run saved stage, before INSERT.
create or replace function private.june2026_canonical_test_save(target_case uuid,target_order uuid,target_revision integer,target_sha text,target_run text,comparison jsonb,admission jsonb) returns void
 language plpgsql security definer set search_path='' as $$
declare auth jsonb; ar public.analysis_runs; trace jsonb; old private.june2026_canonical_test_results;
begin
 auth:=private.june2026_test_assessment(target_case,target_order,target_revision,target_sha);
 if auth is null then raise exception 'JUNE_TEST_ASSESSMENT_REQUIRED';end if;
 select * into ar from public.analysis_runs where canonical_analysis_run_id=target_run and canonical_case_id=target_case::text
  and tenant_id='saved-case:'||target_case::text and status='completed';
 if not found or ar.command_payload->>'mode'<>'synthetic_test'
  or ar.command_payload->>'document_snapshot_id'<>'saved-documents:2026-06:'||target_sha
  or ar.completion_payload#>>'{selections,0,catalog_id}'<>'tivdoc.june2026.isolated-test'
  or admission->>'assessment_sha256' is distinct from auth->>'assessment_sha256'
  or admission->>'legal_activation' is distinct from 'false' or admission->>'human_approval' is distinct from 'false'
  or not exists(select 1 from public.engine_analysis_stage_versions s where s.analysis_run_id=ar.id and s.case_id=ar.case_id
   and s.stage='review_pending' and s.payload#>'{diagnostics,admission}'=admission
   and s.payload#>'{diagnostics,comparison}' is not distinct from coalesce(comparison,'null'::jsonb))
  then raise exception 'JUNE_TEST_CANONICAL_RUN_REQUIRED';end if;
 trace:=ar.completion_payload#>'{bundle,topic_results,0,trace}';
 if comparison is not null then
  if admission->>'execution_allowed' is distinct from 'true'
   or comparison->>'schema_version'<>'tivdoc-source-monetary-comparison-v2'
   or comparison#>>'{trace,analysis_run_id}'<>target_run or comparison#>>'{trace,case_id}'<>target_case::text
   or comparison->'trace' is distinct from trace
   or comparison->>'is_finding' is distinct from 'false'
   then raise exception 'JUNE_TEST_COMPARISON_BINDING';end if;
 elsif trace is not null and trace<>'null'::jsonb then raise exception 'JUNE_TEST_COMPARISON_REQUIRED';end if;
 insert into private.june2026_canonical_test_results(analysis_run_id,case_id,assessment_id,input_revision,input_sha256,comparison,admission)
 values(ar.id,target_case,(auth#>>'{assessment,assessment_id}')::uuid,target_revision,target_sha,comparison,admission)
 on conflict(analysis_run_id) do nothing;
 select * into old from private.june2026_canonical_test_results r where r.analysis_run_id=ar.id;
 if old.comparison is distinct from comparison or old.admission is distinct from admission then raise exception 'JUNE_TEST_RETRY_MISMATCH';end if;
end;$$;
revoke all on function private.june2026_canonical_test_save(uuid,uuid,integer,text,text,jsonb,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.june2026_canonical_test_save(uuid,uuid,integer,text,text,jsonb,jsonb) to tivdoc_worker_runtime;

