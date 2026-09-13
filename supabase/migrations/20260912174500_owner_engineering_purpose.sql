-- Additive isolated owner purpose. Old policies, report bytes and grants remain
-- immutable. Execution, provider expense and financial publication stay separate.
do $constraint$
declare item record;begin
 for item in select conname from pg_constraint where conrelid='private.ai_release_configurations'::regclass
  and contype='c' and pg_get_constraintdef(oid) like '%tivdoc-ai-release-configuration-v1%' loop
  execute format('alter table private.ai_release_configurations drop constraint %I',item.conname);
 end loop;
 alter table private.ai_release_configurations add constraint ai_release_configuration_purpose_integrity check(coalesce(
  payload->>'schema_version' in ('tivdoc-ai-release-configuration-v1','tivdoc-owner-engineering-configuration-v1')
  and payload->>'configuration_id'=configuration_id::text and (payload->>'revision')::integer=revision
  and payload->>'sha256'=payload_sha256
  and payload_sha256=encode(sha256(convert_to(private.governance_jsonb_compact_text(payload-'sha256'),'UTF8')),'hex'),false));
end;$constraint$;

create function private.owner_engineering_case(target_case uuid) returns boolean language sql stable security invoker set search_path='' as $$
 select exists(select 1 from private.ai_release_enrollment_events e join private.ai_release_configurations c on c.payload_sha256=e.configuration_sha256
  where e.case_id=target_case and e.sequence=(select max(sequence) from private.ai_release_enrollment_events where case_id=target_case)
  and c.payload->>'schema_version'='tivdoc-owner-engineering-configuration-v1');
$$;
create function private.owner_engineering_enrollment_guard() returns trigger language plpgsql security invoker set search_path='' as $$
declare config jsonb;begin
 select payload into config from private.ai_release_configurations where payload_sha256=new.configuration_sha256;
 if config->>'schema_version'='tivdoc-owner-engineering-configuration-v1' and new.kind='granted' then
  if current_database()<>'tivdoc_release_replay_20260907' or session_user<>'tivdoc_dev_migrator'
   or config#>>'{policy,owner_scope,case_id}' is distinct from new.case_id::text
   or config#>>'{policy,owner_scope,enrollment_id}' is distinct from new.event_id::text
   or config#>>'{policy,purpose}' is distinct from 'owner_engineering_review'
   or config#>>'{policy,namespace}' is distinct from 'isolated_test'
   or config#>'{policy,allowed_environments}' is distinct from '["development"]'::jsonb
   or not exists(select 1 from public.cases c join public.case_identity_cases ic on ic.case_id=c.id
    join public.case_identities i on i.id=ic.identity_id where c.id=new.case_id and c.is_qa and c.contact_verified_at is not null
     and i.id::text=config#>>'{policy,owner_scope,identity_id}' and i.channel='email'
     and i.contact_normalized in ('tivdoc.com@gmail.com','info@tivdoc.com')) then raise exception 'OWNER_ENGINEERING_ENROLLMENT_SCOPE';end if;
 end if;return new;
end;$$;
create trigger owner_engineering_enrollment_guard before insert on private.ai_release_enrollment_events
 for each row execute function private.owner_engineering_enrollment_guard();

-- Use the policy's preselected event ID when granting this case-specific
-- purpose. Revocations still get new IDs; a retry cannot revive or extend one.
do $operator$
declare body text;needle text;begin
 body:=pg_get_functiondef('private.ai_release_enrollment_record(uuid,text,text,text,timestamptz,timestamptz,text)'::regprocedure);
 needle:='values(gen_random_uuid(),target_case';
 if length(body)-length(replace(body,needle,''))<>length(needle) then raise exception 'OWNER_ENGINEERING_OPERATOR_BASE';end if;
 execute replace(body,needle,'values(case when event_kind=''granted'' and (select payload->>''schema_version'' from private.ai_release_configurations where payload_sha256=configuration_sha)=''tivdoc-owner-engineering-configuration-v1'' then (select (payload#>>''{policy,owner_scope,enrollment_id}'')::uuid from private.ai_release_configurations where payload_sha256=configuration_sha) else gen_random_uuid() end,target_case');
 body:=pg_get_functiondef('private.ai_release_context_read(uuid,integer,text)'::regprocedure);
 needle:='''environment'',''development'')';
 if length(body)-length(replace(body,needle,''))<>length(needle) then raise exception 'OWNER_ENGINEERING_CONTEXT_BASE';end if;
 execute replace(body,needle,needle||' || case when c.payload->>''schema_version''=''tivdoc-owner-engineering-configuration-v1'' then jsonb_build_object(''owner_identity_id'',c.payload#>>''{policy,owner_scope,identity_id}'') else ''{}''::jsonb end');
end;$operator$;

create function private.owner_engineering_report_context(target_case uuid,target_run text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare e private.ai_release_enrollment_events;c private.ai_release_configurations;source_time timestamptz;token text;
begin
 if current_database()<>'tivdoc_release_replay_20260907' or not exists(select 1 from public.cases where id=target_case and is_qa) then return jsonb_build_object('state','absent');end if;
 select v.created_at into source_time from public.analysis_runs r join private.case_input_versions v
  on v.case_id=target_case and v.revision=(r.completion_payload#>>'{bundle,owner_engineering,binding,source_journal,input_revision}')::integer
  and v.input_sha256=r.completion_payload#>>'{bundle,owner_engineering,binding,source_journal,input_sha256}'
  where r.canonical_case_id=target_case::text and r.tenant_id='saved-case:'||target_case::text and r.canonical_analysis_run_id=target_run;
 if source_time is null then return jsonb_build_object('state','absent');end if;
 select * into e from private.ai_release_enrollment_events where case_id=target_case order by sequence desc limit 1;
 if not found then return jsonb_build_object('state','absent');end if;
 token:=private.ai_release_dependency(target_case);
 if e.kind='revoked' or e.expires_at<=statement_timestamp() or e.issued_at>statement_timestamp() then
  return jsonb_build_object('state','unavailable','reason',case when e.kind='revoked' then 'revoked' else 'expired' end,'dependency_sha256',token);end if;
 select * into c from private.ai_release_configurations where payload_sha256=e.configuration_sha256;
 return jsonb_build_object('state','configured','configuration',c.payload,'configuration_sha256',c.payload_sha256,'enrollment_id',e.event_id,
  'dependency_sha256',token,'evaluated_at',statement_timestamp(),'source_created_at',source_time,'expires_at',e.expires_at,'is_qa',true,'environment','development','owner_identity_id',c.payload#>>'{policy,owner_scope,identity_id}');
end;$$;

create function private.owner_engineering_run_current(target_case uuid,target_run text) returns boolean
language plpgsql stable security invoker set search_path='' as $$
declare ar public.analysis_runs;ctx jsonb;envelope jsonb;scope jsonb;admission jsonb;operation jsonb;decision jsonb;required text;at_time timestamptz:=statement_timestamp();
begin
 select * into ar from public.analysis_runs r where r.canonical_case_id=target_case::text and r.tenant_id='saved-case:'||target_case::text
  and r.canonical_analysis_run_id=target_run and r.status='completed';
 if not found then return false;end if;
 envelope:=ar.completion_payload#>'{bundle,owner_engineering}';scope:=envelope#>'{input,assessment_input,current,scope}';
 if envelope->>'schema_version' is distinct from 'case-analysis-owner-engineering-v1' then return false;end if;
 ctx:=private.owner_engineering_report_context(target_case,target_run);
 if ar.completion_payload#>'{bundle,ai_release}' is not null
  or ctx#>>'{configuration,schema_version}' is distinct from 'tivdoc-owner-engineering-configuration-v1'
  or envelope#>'{input,assessment_input,current,owner_scope}' is distinct from ctx#>'{configuration,policy,owner_scope}'
  or envelope#>>'{result,owner_scope,case_id}' is distinct from target_case::text
  or envelope#>>'{result,owner_scope,enrollment_id}' is distinct from ctx->>'enrollment_id'
  or envelope#>>'{result,owner_scope,identity_id}' is distinct from ctx->>'owner_identity_id'
  or envelope#>>'{result,claim_kind}' is distinct from 'owner_engineering_review'
  or envelope#>'{result,publication_allowed}' is distinct from 'false'::jsonb
  or envelope#>'{result,notification_allowed}' is distinct from 'false'::jsonb
  or envelope#>'{result,release_authorized}' is distinct from 'false'::jsonb then return false;end if;
 if ctx->>'state' is distinct from 'configured' or scope->>'case_id' is distinct from target_case::text
  or scope->>'authority_dependency_sha256' is distinct from ctx->>'dependency_sha256'
  or envelope#>'{input,assessment_input,policy}' is distinct from ctx#>'{configuration,policy}'
  or envelope#>'{input,assessment_input,registry}' is distinct from ctx#>'{configuration,registry}' then return false;end if;
 if not coalesce((ctx#>>'{configuration,policy,issued_at}')::timestamptz<=at_time and (ctx#>>'{configuration,policy,expires_at}')::timestamptz>at_time
  and (ctx#>>'{configuration,registry,issued_at}')::timestamptz<=at_time and (ctx#>>'{configuration,registry,expires_at}')::timestamptz>at_time,false) then return false;end if;
 if not exists(select 1 from private.case_input_heads h where h.case_id=target_case and h.revision=(scope->>'input_revision')::integer and h.input_sha256=scope->>'input_sha256') then return false;end if;
 if not (exists(select 1 from private.product_orders o join private.order_entitlements e on e.order_id=o.id
   where o.case_id=target_case and o.id::text=scope->>'order_id' and o.offer_sha256=scope->>'order_receipt_sha256'
    and o.state='paid' and o.refund_state<>'refunded' and e.state='active')
  or exists(select 1 from jsonb_array_elements(private.legacy_paid_scopes_internal(target_case)) r
   where r->>'id'=scope->>'order_id' and r->>'receipt_sha256'=scope->>'order_receipt_sha256')) then return false;end if;
 if exists(select 1 from public.analysis_runs newer where newer.case_id=ar.case_id and newer.tenant_id=ar.tenant_id and newer.status='completed'
  and newer.completion_payload#>>'{bundle,document_review,purchased_scope,order_id}'=scope->>'order_id'
  and newer.command_payload->'period'=ar.command_payload->'period' and (newer.created_at,newer.id)>(ar.created_at,ar.id)) then return false;end if;
 admission:=envelope#>'{result,admission}';
 if admission->>'state'='admitted' then
  -- This expiry is the minimum of consumed source/interpretation/test/reviewer
  -- validity and scheduled revocations, not just the enrollment expiry.
  if not coalesce((admission#>>'{receipt,evaluated_at}')::timestamptz<=at_time and (admission#>>'{receipt,expires_at}')::timestamptz>at_time,false) then return false;end if;
 elsif admission->>'state' is distinct from 'blocked' then return false;end if;
 for operation in select c#>'{calculation,input,operation}' from jsonb_array_elements(envelope#>'{result,review,checks}') c
  where exists(select 1 from jsonb_array_elements(envelope#>'{result,checks}') r where r->>'check_id'=c->>'check_id' and r->>'state'='calculated') loop
  if operation->>'kind' is distinct from 'candidate_rule' then return false;end if;
  for required in select jsonb_array_elements_text(operation->'required_decision_ids') loop
   select d into decision from jsonb_array_elements(operation->'decisions') d where d->>'decision_id'=required;
   if decision is null or decision->>'state' is distinct from 'accepted' or (decision->>'valid_until')::timestamptz<=at_time then return false;end if;
  end loop;
 end loop;
 return true;
end;$$;

-- Owner findings are saved from the completed ordinary analysis only. This
-- receipt cannot supply findings, regenerate a report or publish one.
create table private.owner_engineering_run_receipts(
 report_id uuid primary key,case_id uuid not null references public.cases(id),analysis_run_id text not null,
 report_sha256 text not null check(report_sha256~'^[a-f0-9]{64}$'),envelope_sha256 text not null check(envelope_sha256~'^[a-f0-9]{64}$'),
 findings jsonb not null check(jsonb_typeof(findings)='array'),findings_sha256 text not null,
 recorded_at timestamptz not null default clock_timestamp(),unique(case_id,analysis_run_id),
 check(findings_sha256=encode(sha256(convert_to(private.governance_jsonb_compact_text(findings),'UTF8')),'hex')));
alter table private.owner_engineering_run_receipts enable row level security;
alter table private.owner_engineering_run_receipts force row level security;
create policy tivdoc_owner_access on private.owner_engineering_run_receipts for all to tivdoc_dev_migrator using(true) with check(true);
revoke all on private.owner_engineering_run_receipts from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger owner_engineering_receipts_immutable before update or delete on private.owner_engineering_run_receipts
 for each row execute function private.ai_release_immutable();

create function private.owner_engineering_report_current(target_case uuid,target_report uuid) returns boolean
language sql stable security invoker set search_path='' as $$
 select exists(select 1 from private.owner_engineering_run_receipts p join public.analysis_runs ar
  on ar.canonical_case_id=p.case_id::text and ar.tenant_id='saved-case:'||p.case_id::text and ar.canonical_analysis_run_id=p.analysis_run_id
  and ar.completion_payload#>>'{report,report_id}'=p.report_id::text and ar.completion_payload#>>'{report,report_sha256}'=p.report_sha256
  and ar.completion_payload#>>'{bundle,owner_engineering,sha256}'=p.envelope_sha256
  and ar.completion_payload#>'{bundle,owner_engineering,result,findings}'=p.findings
  where p.case_id=target_case and p.report_id=target_report and private.owner_engineering_run_current(target_case,p.analysis_run_id));
$$;

create function private.owner_engineering_finding_valid(f jsonb,target_case uuid,target_run text) returns boolean
language sql immutable security invoker set search_path='' as $$
 select coalesce(f->>'schema_version'='tivdoc-owner-engineering-check-v1' and f->>'case_id'=target_case::text
  and f->>'analysis_run_id'=target_run and f->>'claim_kind'='owner_engineering_review' and f->>'state'='calculated'
  and f->'verified_debt'='false'::jsonb and f->'actual_transfer_proven'='false'::jsonb and f->'release_authorized'='false'::jsonb
  and f->'publication_allowed'='false'::jsonb and f->'notification_allowed'='false'::jsonb
  and f#>>'{expected,kind}'='money'
  and f#>>'{human_law_review,human_by_law,state}' in ('unresolved','not_required_for_supported_branch')
  and f->>'sha256'=encode(sha256(convert_to(private.governance_jsonb_compact_text(f-'sha256'),'UTF8')),'hex'),false);
$$;

create function private.owner_engineering_run_record(target_case uuid,target_run text,target_report uuid,expected_report_sha256 text,expected_envelope_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ar public.analysis_runs;prior private.owner_engineering_run_receipts;was_replayed boolean;envelope jsonb;f jsonb;findings jsonb;begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text
  or current_database()<>'tivdoc_release_replay_20260907' then raise exception 'OWNER_ENGINEERING_RECORD_SCOPE';end if;
 perform 1 from public.cases where id=target_case and is_qa for update;
 if not found then raise exception 'OWNER_ENGINEERING_RECORD_SCOPE';end if;
 select * into ar from public.analysis_runs where canonical_case_id=target_case::text and tenant_id=private.runtime_verified_tenant()
  and canonical_analysis_run_id=target_run and status='completed' for update;
 if not found or ar.completion_payload#>>'{report,report_id}' is distinct from target_report::text
  or ar.completion_payload#>>'{report,report_sha256}' is distinct from expected_report_sha256
  or ar.completion_payload#>>'{bundle,owner_engineering,sha256}' is distinct from expected_envelope_sha256
  or ar.completion_payload#>>'{dependencies,code_version}' is distinct from 'case-analysis@0.6.9'
  or ar.completion_payload#>>'{dependencies,template_version}' is distinct from 'saved-owner-engineering-analysis-v1'
  or not private.owner_engineering_run_current(target_case,target_run) then raise exception 'OWNER_ENGINEERING_RECORD_CURRENT_BINDING';end if;
 if not exists(select 1 from public.engine_report_versions r where r.analysis_run_id=ar.id and r.tenant_id=ar.tenant_id and r.case_id=ar.case_id
  and r.report_id=target_report::text and r.report_sha256=expected_report_sha256
  and r.analysis_result_sha256=ar.completion_payload#>>'{bundle,result_sha256}') then raise exception 'OWNER_ENGINEERING_RECORD_ARTIFACT';end if;
 envelope:=ar.completion_payload#>'{bundle,owner_engineering}';findings:=envelope#>'{result,findings}';
 if jsonb_typeof(findings) is distinct from 'array'
  or expected_envelope_sha256 is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(envelope-'sha256'),'UTF8')),'hex')
  or envelope#>>'{result,sha256}' is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text((envelope->'result')-'sha256'),'UTF8')),'hex')
  or envelope#>>'{result,analysis_run_id}' is distinct from target_run then raise exception 'OWNER_ENGINEERING_RECORD_HASH';end if;
 if findings is distinct from (select coalesce(jsonb_agg(c order by ordinal),'[]'::jsonb)
  from jsonb_array_elements(envelope#>'{result,checks}') with ordinality entries(c,ordinal)
  where c->>'state'='calculated' and c#>>'{expected,kind}'='money') then raise exception 'OWNER_ENGINEERING_FINDING_SET';end if;
 for f in select value from jsonb_array_elements(findings) loop
  if not private.owner_engineering_finding_valid(f,target_case,target_run)
   or not exists(select 1 from jsonb_array_elements(envelope#>'{result,checks}') c where c=f) then raise exception 'OWNER_ENGINEERING_FINDING_SCOPE';end if;
 end loop;
 select * into prior from private.owner_engineering_run_receipts where report_id=target_report;was_replayed:=found;
 if was_replayed then
  if prior.case_id<>target_case or prior.analysis_run_id<>target_run or prior.report_sha256<>expected_report_sha256
   or prior.envelope_sha256<>expected_envelope_sha256 or prior.findings<>findings then raise exception 'OWNER_ENGINEERING_RECORD_RETRY_MISMATCH';end if;
 else
  insert into private.owner_engineering_run_receipts(report_id,case_id,analysis_run_id,report_sha256,envelope_sha256,findings,findings_sha256)
   values(target_report,target_case,target_run,expected_report_sha256,expected_envelope_sha256,findings,
    encode(sha256(convert_to(private.governance_jsonb_compact_text(findings),'UTF8')),'hex')) returning * into prior;
 end if;
 return jsonb_build_object('report_id',prior.report_id,'analysis_run_id',prior.analysis_run_id,'recorded_at',prior.recorded_at,'replayed',was_replayed);
end;$$;
revoke all on function private.owner_engineering_case(uuid),private.owner_engineering_enrollment_guard(),
 private.owner_engineering_report_context(uuid,text),private.owner_engineering_run_current(uuid,text),private.owner_engineering_run_record(uuid,text,uuid,text,text)
 ,private.owner_engineering_report_current(uuid,uuid)
 ,private.owner_engineering_finding_valid(jsonb,uuid,text)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.owner_engineering_run_record(uuid,text,uuid,text,text) to tivdoc_worker_runtime;

-- Defense in depth: even an old pending notification cannot become a route
-- from owner engineering to financial publication or delivery.
do $gates$
declare body text;needle text;begin
 body:=pg_get_functiondef('private.ai_release_run_current(uuid,text)'::regprocedure);
 needle:=' ctx:=private.ai_release_report_context(target_case,target_run);';
 if length(body)-length(replace(body,needle,''))<>length(needle) then raise exception 'OWNER_ENGINEERING_QUALIFIED_BASE';end if;
 execute replace(body,needle,needle||E'\n if ar.completion_payload#>''{bundle,owner_engineering}'' is not null or ctx#>>''{configuration,schema_version}'' is distinct from ''tivdoc-ai-release-configuration-v1'' then return false;end if;');
 body:=pg_get_functiondef('private.managed_dev_notification_event_current(uuid,text)'::regprocedure);
 needle:=' select case';
 if length(body)-length(replace(body,needle,''))<>length(needle) then raise exception 'OWNER_ENGINEERING_NOTIFICATION_BASE';end if;
 -- Preserve factual request currentness for internal readiness/status callers.
 -- Only delivery callers use the purpose-gated original public boundary.
 execute replace(body,'private.managed_dev_notification_event_current(', 'private.managed_dev_event_source_current_before_owner_v1(');
 revoke all on function private.managed_dev_event_source_current_before_owner_v1(uuid,text)
  from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
 execute replace(body,needle,' select not private.owner_engineering_case(target_case) and case');
 body:=pg_get_functiondef('private.managed_completion_ready(uuid)'::regprocedure);
 execute replace(body,'private.managed_dev_notification_event_current(', 'private.managed_dev_event_source_current_before_owner_v1(');
 body:=pg_get_functiondef('public.case_report_private_review_list(uuid,uuid)'::regprocedure);
 needle:='''ai_context'',case when';
 if length(body)-length(replace(body,needle,''))<>length(needle) then raise exception 'OWNER_ENGINEERING_LIST_CONTEXT_BASE';end if;
 body:=replace(body,needle,'''ai_context'',case when ar.completion_payload#>''{bundle,owner_engineering}'' is not null then private.owner_engineering_report_context(target_case,ar.canonical_analysis_run_id) when');
 needle:='''current'',(ar.completion_payload';
 if length(body)-length(replace(body,needle,''))<>length(needle) then raise exception 'OWNER_ENGINEERING_LIST_CURRENT_BASE';end if;
 body:=replace(body,needle,'''current'',(ar.completion_payload#>''{bundle,owner_engineering}'' is null or private.owner_engineering_report_current(target_case,(ar.completion_payload#>>''{report,report_id}'')::uuid)) and (ar.completion_payload');
 needle:='and ar.completion_payload#>>''{bundle,document_review,schema_version}''=';
 if length(body)-length(replace(body,needle,''))<>length(needle) then raise exception 'OWNER_ENGINEERING_LIST_OWNER_BASE';end if;
 body:=replace(body,needle,'and (ar.completion_payload#>''{bundle,owner_engineering}'' is null or ar.completion_payload#>>''{bundle,owner_engineering,result,owner_scope,identity_id}''=target_identity::text) '||needle);
 execute body;
end;$gates$;

-- Operational completion is independent of publication. Reuse the existing
-- all-month terminal manifest joins and currentness checks for owner drafts.
do $status$
declare body text;first_at integer;last_at integer;part text;owner_part text;begin
 body:=pg_get_functiondef('private.managed_dev_worker_status_before_ai_build_v1(text)'::regprocedure);
 first_at:=position('left join lateral(select p.report_id,ar.id run_id from private.ai_release_report_publications' in body);
 last_at:=position(') ai on true where r.capability_sha256=digest' in body);
 if first_at=0 or last_at<=first_at then raise exception 'OWNER_ENGINEERING_STATUS_BASE';end if;
 part:=substring(body from first_at for last_at-first_at)||') ai on true';
 owner_part:=replace(replace(part,'private.ai_release_report_publications','private.owner_engineering_run_receipts'),
  'private.ai_release_report_current(','private.owner_engineering_report_current(');
 owner_part:=replace(replace(owner_part,'p.published_at','p.recorded_at'),') ai on true',') ownerreview on true');
 body:=replace(body,part,part||' '||owner_part);
 body:=replace(body,'when j.state=''succeeded'' and ai.report_id is not null','when j.state=''succeeded'' and ownerreview.report_id is not null then ''complete'' when j.state=''succeeded'' and ai.report_id is not null');
 body:=replace(body,'coalesce(ai.run_id,regular.analysis_run_id,f.id)','coalesce(ownerreview.run_id,ai.run_id,regular.analysis_run_id,f.id)');
 body:=replace(body,'and ai.report_id is null','and ai.report_id is null and ownerreview.report_id is null');
 body:=replace(body,'private.managed_dev_notification_event_current(', 'private.managed_dev_event_source_current_before_owner_v1(');
 execute body;
end;$status$;
