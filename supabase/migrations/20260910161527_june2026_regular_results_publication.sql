-- Full versioned Finding v2 and its admission remain attached to the ordinary
-- analysis run. The legacy Finding v1 mapper/bytes are not rewritten.
create table private.june2026_regular_results (
 analysis_run_id uuid primary key references public.analysis_runs(id),case_id uuid not null references public.cases(id),
 projection_id uuid not null unique references public.case_report_projections(id),assessment_id uuid not null references private.june2026_regular_assessments(id),
 input_revision integer not null,input_sha256 text not null,namespace text not null check(namespace in ('real','isolated_test')),
 execution jsonb not null,finding jsonb,created_at timestamptz not null default transaction_timestamp()
);
alter table private.june2026_regular_results enable row level security;
revoke all on private.june2026_regular_results from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger june_regular_results_immutable before update on private.june2026_regular_results for each row execute function private.dev_financial_immutable();

create function private.june2026_regular_result_save(target_case uuid,target_order uuid,target_revision integer,target_sha text,target_run text,execution jsonb,document jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare auth jsonb;ar public.analysis_runs;diagnostic jsonb;artifact jsonb;prior private.june2026_regular_results;
 ns text;projection jsonb:=document->'projection';owner_id uuid;
begin
 auth:=private.june2026_regular_authority(target_case,target_order,target_revision,target_sha);
 if auth is null or auth->>'state'<>'loaded' then raise exception 'REGULAR_CURRENT_AUTHORITY_REQUIRED';end if;
 ns:=auth#>>'{registry,registry,namespace}';
 select * into ar from public.analysis_runs where canonical_analysis_run_id=target_run and canonical_case_id=target_case::text
  and tenant_id='saved-case:'||target_case::text and status='completed';
 if not found or ar.command_payload->>'mode' is distinct from (case when ns='real' then 'real' else 'synthetic_test' end)
  or ar.command_payload->>'document_snapshot_id' is distinct from 'saved-documents:2026-06:'||target_sha
  or ar.command_payload->'requested_topics' is distinct from '["minimum_wage"]'::jsonb
  or ar.completion_payload#>>'{selections,0,catalog_id}' is distinct from 'tivdoc.june2026.regular.'||ns
  then raise exception 'REGULAR_COMPLETED_RUN_REQUIRED';end if;
 select payload->'diagnostics' into diagnostic from public.engine_analysis_stage_versions where analysis_run_id=ar.id and stage='review_pending';
 if diagnostic->>'schema_version' is distinct from 'saved-june2026-regular-diagnostics-v1'
  or diagnostic->>'registry_sha256' is distinct from auth->>'registry_sha256'
  or diagnostic->>'assessment_sha256' is distinct from auth->>'assessment_sha256'
  or diagnostic->>'namespace' is distinct from ns or diagnostic->'execution' is distinct from execution
  or diagnostic->'admission' is distinct from execution->'admission'
  or execution#>>'{admission,execution_allowed}' is distinct from 'true'
  or execution->>'case_id' is distinct from target_case::text or execution->>'analysis_run_id' is distinct from target_run
  or execution->>'order_id' is distinct from target_order::text or execution->>'input_sha256' is distinct from target_sha
  or (execution->>'input_revision')::integer is distinct from target_revision
  or execution->'trace' is distinct from ar.completion_payload#>'{bundle,topic_results,0,trace}'
  or execution#>>'{admission,facts_snapshot_sha256}' is distinct from ar.completion_payload#>>'{bundle,facts_snapshot_sha256}'
  then raise exception 'REGULAR_EXECUTION_STAGE_BINDING';end if;
 artifact:=convert_from(decode(ar.completion_payload#>>'{report,json_base64}','base64'),'UTF8')::jsonb;
 if artifact->>'schema_version' is distinct from 'june2026-regular-service-report-v1'
  or artifact->'execution' is distinct from execution or artifact->'document' is distinct from document
  or artifact->'bundle' is distinct from ar.completion_payload->'bundle'
  or document->>'id' is distinct from ar.completion_payload#>>'{report,report_id}'
  or document->>'case_id' is distinct from target_case::text or document->>'order_id' is distinct from target_order::text
  or document->>'input_sha256' is distinct from target_sha or (document->>'revision')::integer is distinct from target_revision
  or document#>>'{execution_authority,namespace}' is distinct from ns
  or document#>>'{execution_authority,analysis_run_id}' is distinct from target_run
  or document#>>'{execution_authority,authority_sha256}' is distinct from execution->>'authority_sha256'
  or document->>'projection_sha256' is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(projection),'UTF8')),'hex')
  or document->'publication' is distinct from '{"state":"draft","approval_actor_kind":"automation","approved_input_sha256":null,"published_at":null}'::jsonb
  or document->>'order_offer_sha256' is distinct from (select offer_sha256 from private.product_orders where id=target_order and case_id=target_case)
  or projection->>'report_kind' is distinct from (select kind from private.product_orders where id=target_order and case_id=target_case)
  then raise exception 'REGULAR_REPORT_SAME_RUN_REQUIRED';end if;
 if execution->'finding'<>'null'::jsonb and (execution#>>'{finding,schema_version}' is distinct from 'tivdoc-source-finding-v2'
  or execution#>>'{finding,analysis_run_id}' is distinct from target_run or execution#>>'{finding,case_id}' is distinct from target_case::text
  or execution#>'{finding,comparison}' is distinct from execution->'comparison'
  or execution#>'{finding,calculation_trace}' is distinct from execution->'trace'
  or execution#>>'{finding,authority,namespace}' is distinct from ns) then raise exception 'REGULAR_FINDING_BINDING';end if;
 select identity_id into owner_id from public.case_identity_cases where case_id=target_case order by identity_id limit 1;
 if owner_id is null then raise exception 'REGULAR_REPORT_OWNER_REQUIRED';end if;
 select * into prior from private.june2026_regular_results where analysis_run_id=ar.id;
 if found then
  if prior.execution is distinct from execution or prior.projection_id::text<>document->>'id'
   or not exists(select 1 from public.case_report_projections where id=prior.projection_id and report_document=document) then raise exception 'REGULAR_REPORT_RETRY_MISMATCH';end if;
  return jsonb_build_object('projection_id',prior.projection_id,'identity_id',owner_id);
 end if;
 insert into public.case_report_projections(id,case_id,schema_version,report_kind,check_period_month,projection,projection_sha256,legal_basis,generated_at,input_revision,report_document)
 values((document->>'id')::uuid,target_case,projection->>'schema_version',projection->>'report_kind','2026-06-01',projection,
  document->>'projection_sha256',projection->>'legal_basis',(projection->>'generated_at')::timestamptz,target_revision,document);
 insert into private.june2026_regular_results values(ar.id,target_case,(document->>'id')::uuid,(auth#>>'{assessment,payload,assessment_id}')::uuid,
  target_revision,target_sha,ns,execution,nullif(execution->'finding','null'::jsonb),transaction_timestamp());
 return jsonb_build_object('projection_id',document->>'id','identity_id',owner_id);
end;$$;
revoke all on function private.june2026_regular_result_save(uuid,uuid,integer,text,text,jsonb,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.june2026_regular_result_save(uuid,uuid,integer,text,text,jsonb,jsonb) to tivdoc_worker_runtime;

-- Add a namespace fence to the existing publication guard, retaining every
-- existing entitlement, source, certainty and cost ceiling check.
do $migration$ declare definition text;needle text;begin
 definition:=pg_get_functiondef('private.case_report_current_input()'::regprocedure);
 needle:='  actual:=p.input_revision;';
 if position(needle in definition)=0 then raise exception 'REGULAR_PUBLICATION_GUARD_BASE';end if;
 execute replace(definition,needle,$guard$
  if p.report_document ? 'execution_authority' then
   if not exists(select 1 from private.june2026_regular_results r join public.analysis_runs a on a.id=r.analysis_run_id
    where r.projection_id=p.id and r.case_id=p.case_id and r.namespace=p.report_document#>>'{execution_authority,namespace}'
     and a.canonical_analysis_run_id=p.report_document#>>'{execution_authority,analysis_run_id}'
     and r.execution->>'authority_sha256'=p.report_document#>>'{execution_authority,authority_sha256}')
    then raise exception 'REGULAR_PUBLICATION_EXECUTION_REQUIRED';end if;
   if not exists(select 1 from private.june2026_regular_results r join private.june2026_regular_assessments s on s.id=r.assessment_id
    join public.engine_analysis_stage_versions v on v.analysis_run_id=r.analysis_run_id and v.stage='review_pending'
    cross join lateral (select private.june2026_regular_authority(r.case_id,s.order_id,r.input_revision,r.input_sha256) value) auth
    where r.projection_id=p.id and auth.value->>'state'='loaded'
     and auth.value->>'registry_sha256'=v.payload#>>'{diagnostics,registry_sha256}'
     and auth.value->>'assessment_sha256'=v.payload#>>'{diagnostics,assessment_sha256}') then raise exception 'REGULAR_PUBLICATION_CURRENT_AUTHORITY_REQUIRED';end if;
   if p.report_document#>>'{execution_authority,namespace}'='isolated_test' and (current_database()<>'tivdoc_release_replay_20260907'
    or not exists(select 1 from public.cases where id=p.case_id and is_qa)) then raise exception 'REGULAR_PUBLICATION_TEST_FORBIDDEN';end if;
  end if;
  actual:=p.input_revision;$guard$);
end $migration$;

create function public.june2026_regular_report_artifact(target_case uuid,target_identity uuid,target_projection uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if session_user<>'tivdoc_web_runtime' or not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'REGULAR_REPORT_FORBIDDEN';end if;
 select jsonb_build_object('completion',a.completion_payload,'execution',r.execution,'namespace',r.namespace,
  'current',h.revision=r.input_revision and h.input_sha256=r.input_sha256,'projection_id',p.id)
 into result from private.june2026_regular_results r join public.analysis_runs a on a.id=r.analysis_run_id
 join public.case_report_projections p on p.id=r.projection_id and p.case_id=r.case_id
 join private.case_input_heads h on h.case_id=r.case_id
 where r.case_id=target_case and r.projection_id=target_projection
  and a.canonical_case_id=target_case::text and a.tenant_id='saved-case:'||target_case::text
  and exists(select 1 from public.case_report_qa q where q.projection_id=p.id and q.case_id=p.case_id and q.published_at is not null)
  and (r.namespace='real' or current_database()='tivdoc_release_replay_20260907' and exists(select 1 from public.cases where id=target_case and is_qa));
 return result;
end;$$;
revoke all on function public.june2026_regular_report_artifact(uuid,uuid,uuid) from public,anon,authenticated,service_role,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.june2026_regular_report_artifact(uuid,uuid,uuid) to tivdoc_web_runtime;
