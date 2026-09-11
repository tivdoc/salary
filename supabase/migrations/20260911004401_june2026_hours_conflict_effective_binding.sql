-- Forward-only v2 admission. Historical v1 bytes and validation remain intact.
-- The current identified journal answer is reloaded under the existing worker
-- ownership/revision/entitlement boundary, never trusted from execution JSON.
create function private.june2026_hours_conflict_effective_assert(target_case uuid,target_order uuid,target_revision integer,target_sha text,target_run uuid,execution jsonb,assessment jsonb) returns void
 language plpgsql security invoker set search_path='' as $$
declare source jsonb;a jsonb;answer jsonb;body jsonb;declaration jsonb;parent jsonb;effective jsonb;old_fact jsonb;fact_id text;
begin
 source:=private.june2026_hours_conflict_admit(target_case,target_order,target_revision,target_sha);
 a:=source->'answer';
 if source->'target' is null or source->'target'='null'::jsonb or a is null or a='null'::jsonb then raise exception 'REGULAR_CONFLICT_ANSWER_REQUIRED';end if;
 answer:=(a->>'answer')::jsonb;
 if answer->>'state' is distinct from 'declared' or not private.june2026_hours_conflict_current(target_case,source->'target') then raise exception 'REGULAR_CONFLICT_CURRENT_DECLARATION_REQUIRED';end if;
 body:=jsonb_build_object('schema_version','document-hours-conflict-declaration-v1','target',source->'target',
  'request_id',a->'request_id','answer_revision',a->'answer_revision','identity_id',a->'identity_id','answered_at',a->'answered_at','answer',answer,
  'provenance',jsonb_build_array(jsonb_build_object('source_type','declared','source_reference',jsonb_build_object('kind','case_request_answer','request_id',a->'request_id','answer_revision',a->'answer_revision'))));
 declaration:=body||jsonb_build_object('declaration_sha256',encode(sha256(convert_to(private.governance_jsonb_compact_text(body),'UTF8')),'hex'));
 if execution#>'{source_admission,hours_conflict_declaration}' is distinct from declaration
  or assessment#>'{payload,hours_acceptance,request_id}' is distinct from a->'request_id'
  or assessment#>'{payload,hours_acceptance,answer_revision}' is distinct from a->'answer_revision'
  or assessment#>'{payload,hours_acceptance,value}' is distinct from answer->'hours'
  or assessment#>>'{payload,hours_acceptance,provenance_sha256}' is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(body->'provenance'),'UTF8')),'hex')
  then raise exception 'REGULAR_CONFLICT_SIGNED_ANSWER_BINDING';end if;
 select payload->'facts' into parent from public.engine_analysis_stage_versions where analysis_run_id=target_run and stage='canonical_facts';
 fact_id:=execution#>>'{source_admission,fact_id}';
 if parent is null or (select count(*) from jsonb_array_elements(parent->'facts') f where f->>'path'='work.regular_hours')<>1 then raise exception 'REGULAR_CONFLICT_PARENT_REQUIRED';end if;
 select f into old_fact from jsonb_array_elements(parent->'facts') f where f->>'fact_id'=fact_id and f->>'path'='work.regular_hours';
 if old_fact is null or old_fact->>'status' not in ('missing','conflicted','needs_confirmation','candidate') then raise exception 'REGULAR_CONFLICT_PARENT_REQUIRED';end if;
 effective:=jsonb_set(parent,'{facts}',(select jsonb_agg(case when f->>'fact_id'=fact_id then f||jsonb_build_object(
  'value',jsonb_build_object('amount',answer->'hours','unit','hours_per_month'),'status','confirmed','provenance',body->'provenance','conflicting_fact_ids','[]'::jsonb,'resolution',null) else f end order by n)
  from jsonb_array_elements(parent->'facts') with ordinality x(f,n)));
 if execution#>'{trace,facts_snapshot}' is distinct from effective
  or execution#>>'{source_admission,parent_facts_sha256}' is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(parent),'UTF8')),'hex')
  or execution#>>'{source_admission,effective_facts_sha256}' is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(effective),'UTF8')),'hex')
  then raise exception 'REGULAR_CONFLICT_EFFECTIVE_FACTS_BINDING';end if;
end;$$;
revoke all on function private.june2026_hours_conflict_effective_assert(uuid,uuid,integer,text,uuid,jsonb,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

do $migration$ declare definition text;needle text;begin
 definition:=pg_get_functiondef('private.june2026_regular_result_save(uuid,uuid,integer,text,text,jsonb,jsonb)'::regprocedure);
 needle:='execution#>>''{source_admission,schema_version}'' is distinct from ''june2026-regular-source-admission-v1''';
 if position(needle in definition)=0 then raise exception 'REGULAR_CONFLICT_V1_BASE';end if;
 definition:=replace(definition,needle,'coalesce(execution#>>''{source_admission,schema_version}'','''') not in (''june2026-regular-source-admission-v1'',''june2026-regular-source-admission-v2'')');
 needle:=' artifact:=convert_from';
 if position(needle in definition)=0 then raise exception 'REGULAR_CONFLICT_SAVE_BASE';end if;
 definition:=replace(definition,needle,$new$
 if execution#>>'{source_admission,schema_version}'='june2026-regular-source-admission-v2' then
  perform private.june2026_hours_conflict_effective_assert(target_case,target_order,target_revision,target_sha,ar.id,execution,auth->'assessment');
 end if;
 artifact:=convert_from$new$);
 execute definition;
end $migration$;
