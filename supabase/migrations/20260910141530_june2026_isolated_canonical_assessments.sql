-- Isolated DEV test assumptions. No human attestation, active legal catalog,
-- ordinary finding publication or production grant is created by this migration.
create table private.june2026_test_assessments (
 id uuid primary key, case_id uuid not null references public.cases(id),
 order_id uuid not null references private.product_orders(id), input_revision integer not null,
 input_sha256 text not null, payload jsonb not null, payload_sha256 text not null,
 expires_at timestamptz not null, revoked_at timestamptz,
 unique(case_id,order_id,input_revision),
 check(payload_sha256 ~ '^[a-f0-9]{64}$' and input_sha256 ~ '^[a-f0-9]{64}$'),
 check(coalesce(payload->>'schema_version'='june2026-isolated-test-assessment-v1'
  and payload->>'authority'='isolated_dev_test_assumptions' and payload->>'human_approval'='false'
  and payload->>'assessment_id'=id::text and payload->>'case_id'=case_id::text
  and payload->>'order_id'=order_id::text and (payload->>'input_revision')::integer=input_revision
  and payload->>'input_sha256'=input_sha256 and (payload->>'expires_at')::timestamptz=expires_at,false))
);
alter table private.june2026_test_assessments enable row level security;
revoke all on private.june2026_test_assessments from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.june2026_test_assessment(target_case uuid,target_order uuid,target_revision integer,target_sha text) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare a private.june2026_test_assessments; source jsonb;
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text
  then raise exception 'JUNE_TEST_WORKER_FORBIDDEN';end if;
 -- No matching assessment is ordinary blocked service, never implicit approval.
 select * into a from private.june2026_test_assessments where case_id=target_case and order_id=target_order and input_revision=target_revision;
 if not found then return null;end if;
 if current_database()<>'tivdoc_release_replay_20260907' or a.revoked_at is not null
  or a.expires_at<=transaction_timestamp() or (a.payload->>'issued_at')::timestamptz>transaction_timestamp()
  or a.input_sha256<>target_sha then raise exception 'JUNE_TEST_ASSESSMENT_STALE';end if;
 source:=private.dev_financial_admit(target_case,target_order,target_revision,target_sha);
 if a.payload->>'document_version_id' is distinct from source->>'version_id'
  or a.payload->>'document_sha256' is distinct from source->>'source_sha256'
  or a.payload_sha256<>encode(sha256(convert_to(private.governance_jsonb_compact_text(a.payload),'UTF8')),'hex')
  then raise exception 'JUNE_TEST_ASSESSMENT_BINDING';end if;
 return jsonb_build_object('assessment',a.payload,'assessment_sha256',a.payload_sha256,'evaluated_at',transaction_timestamp());
end;$$;
revoke all on function private.june2026_test_assessment(uuid,uuid,integer,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.june2026_test_assessment(uuid,uuid,integer,text) to tivdoc_worker_runtime;

-- The result is derived from a completed ordinary CaseAnalysisService run.
-- Keep engineering findings separate from customer debt/publication tables.
create table private.june2026_canonical_test_results (
 analysis_run_id uuid primary key references public.analysis_runs(id),
 case_id uuid not null references public.cases(id),assessment_id uuid not null references private.june2026_test_assessments(id),
 input_revision integer not null,input_sha256 text not null,comparison jsonb,admission jsonb not null,
 created_at timestamptz not null default transaction_timestamp()
);
alter table private.june2026_canonical_test_results enable row level security;
revoke all on private.june2026_canonical_test_results from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger june2026_canonical_test_immutable before update on private.june2026_canonical_test_results
 for each row execute function private.dev_financial_immutable();

create function private.june2026_canonical_test_save(target_case uuid,target_order uuid,target_revision integer,target_sha text,target_run text,comparison jsonb,admission jsonb) returns void
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
   and s.stage='review_pending' and s.payload#>'{diagnostics,admission}'=admission)
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

create function private.june2026_canonical_test_customer(target_case uuid,target_identity uuid,target_run uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if current_database()<>'tivdoc_release_replay_20260907' or session_user<>'tivdoc_web_runtime'
  or not exists(select 1 from public.cases c join public.case_identity_cases i on i.case_id=c.id where c.id=target_case and c.is_qa
   and i.identity_id=target_identity and c.contact_verified_at is not null)
  then raise exception 'JUNE_TEST_REPORT_FORBIDDEN';end if;
 select jsonb_build_object('completion',ar.completion_payload,'comparison',r.comparison,'admission',r.admission,
  'current',h.revision=r.input_revision and h.input_sha256=r.input_sha256)
 into result from private.june2026_canonical_test_results r join public.analysis_runs ar on ar.id=r.analysis_run_id and ar.case_id=r.case_id
 join private.case_input_heads h on h.case_id=r.case_id
 where r.case_id=target_case and ar.canonical_analysis_run_id=target_run::text;
 return result;
end;$$;
revoke all on function private.june2026_canonical_test_customer(uuid,uuid,uuid) from public,anon,authenticated,service_role,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.june2026_canonical_test_customer(uuid,uuid,uuid) to tivdoc_web_runtime;

create function public.case_report_june_canonical_test(target_case uuid,target_identity uuid,target_run uuid) returns jsonb
 language sql security invoker set search_path='' as $$select private.june2026_canonical_test_customer(target_case,target_identity,target_run);$$;
revoke all on function public.case_report_june_canonical_test(uuid,uuid,uuid) from public,anon,authenticated,service_role,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_report_june_canonical_test(uuid,uuid,uuid) to tivdoc_web_runtime;
