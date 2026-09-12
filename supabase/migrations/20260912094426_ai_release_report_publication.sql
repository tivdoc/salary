-- Same-run DEV publication. No human approval, customer activation, alternate
-- calculation or report projection is created by this receipt.
create table private.ai_release_report_publications(
 report_id uuid primary key,case_id uuid not null references public.cases(id),analysis_run_id text not null,
 report_sha256 text not null check(report_sha256~'^[a-f0-9]{64}$'),
 envelope_sha256 text not null check(envelope_sha256~'^[a-f0-9]{64}$'),published_at timestamptz not null default clock_timestamp(),
 unique(case_id,analysis_run_id));
alter table private.ai_release_report_publications enable row level security;
alter table private.ai_release_report_publications force row level security;
create policy tivdoc_owner_access on private.ai_release_report_publications for all to tivdoc_dev_migrator using(true) with check(true);
revoke all on private.ai_release_report_publications from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger ai_release_publication_immutable before update or delete on private.ai_release_report_publications
 for each row execute function private.ai_release_immutable();

-- Internal only: callers authenticate the owner or verified worker tenant.
-- Uses the DB clock and current grant, while preserving the source's original
-- timestamp so TypeScript can replay the immutable evaluation anchor.
create function private.ai_release_report_context(target_case uuid,target_run text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare e private.ai_release_enrollment_events;c private.ai_release_configurations;source_time timestamptz;token text;
begin
 if current_database()<>'tivdoc_release_replay_20260907' or not exists(select 1 from public.cases where id=target_case and is_qa) then return jsonb_build_object('state','absent');end if;
 select v.created_at into source_time from public.analysis_runs r join private.case_input_versions v
  on v.case_id=target_case and v.revision=(r.completion_payload#>>'{bundle,ai_release,binding,source_journal,input_revision}')::integer
  and v.input_sha256=r.completion_payload#>>'{bundle,ai_release,binding,source_journal,input_sha256}'
  where r.canonical_case_id=target_case::text and r.tenant_id='saved-case:'||target_case::text and r.canonical_analysis_run_id=target_run;
 if source_time is null then return jsonb_build_object('state','absent');end if;
 select * into e from private.ai_release_enrollment_events where case_id=target_case order by sequence desc limit 1;
 if not found then return jsonb_build_object('state','absent');end if;
 token:=private.ai_release_dependency(target_case);
 if e.kind='revoked' or e.expires_at<=statement_timestamp() or e.issued_at>statement_timestamp() then
  return jsonb_build_object('state','unavailable','reason',case when e.kind='revoked' then 'revoked' else 'expired' end,'dependency_sha256',token);end if;
 select * into c from private.ai_release_configurations where payload_sha256=e.configuration_sha256;
 return jsonb_build_object('state','configured','configuration',c.payload,'configuration_sha256',c.payload_sha256,'enrollment_id',e.event_id,
  'dependency_sha256',token,'evaluated_at',statement_timestamp(),'source_created_at',source_time,'expires_at',e.expires_at,'is_qa',true,'environment','development');
end;$$;

create function private.ai_release_run_current(target_case uuid,target_run text) returns boolean
language plpgsql stable security invoker set search_path='' as $$
declare ar public.analysis_runs;ctx jsonb;envelope jsonb;scope jsonb;admission jsonb;operation jsonb;decision jsonb;required text;at_time timestamptz:=statement_timestamp();
begin
 select * into ar from public.analysis_runs r where r.canonical_case_id=target_case::text and r.tenant_id='saved-case:'||target_case::text
  and r.canonical_analysis_run_id=target_run and r.status='completed';
 if not found then return false;end if;
 envelope:=ar.completion_payload#>'{bundle,ai_release}';scope:=envelope#>'{input,assessment_input,current,scope}';
 if envelope->>'schema_version' is distinct from 'case-analysis-ai-release-v1' then return false;end if;
 ctx:=private.ai_release_report_context(target_case,target_run);
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

create function private.ai_release_report_current(target_case uuid,target_report uuid) returns boolean
language sql stable security invoker set search_path='' as $$
 select exists(select 1 from private.ai_release_report_publications p join public.analysis_runs ar
  on ar.canonical_case_id=p.case_id::text and ar.tenant_id='saved-case:'||p.case_id::text and ar.canonical_analysis_run_id=p.analysis_run_id
  and ar.completion_payload#>>'{report,report_id}'=p.report_id::text and ar.completion_payload#>>'{report,report_sha256}'=p.report_sha256
  and ar.completion_payload#>>'{bundle,ai_release,sha256}'=p.envelope_sha256
  where p.case_id=target_case and p.report_id=target_report and private.ai_release_run_current(target_case,p.analysis_run_id));
$$;

create function private.ai_release_report_publish(target_case uuid,target_run text,target_report uuid,expected_report_sha256 text,expected_envelope_sha256 text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ar public.analysis_runs;prior private.ai_release_report_publications;replayed boolean;finding_receipt jsonb;
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text
  or current_database()<>'tivdoc_release_replay_20260907' then raise exception 'AI_RELEASE_PUBLICATION_SCOPE';end if;
 perform 1 from public.cases where id=target_case and is_qa for update;
 if not found then raise exception 'AI_RELEASE_PUBLICATION_SCOPE';end if;
 select * into ar from public.analysis_runs r where r.canonical_case_id=target_case::text and r.tenant_id=private.runtime_verified_tenant()
  and r.canonical_analysis_run_id=target_run and r.status='completed' for update;
 if not found or ar.completion_payload#>>'{report,report_id}' is distinct from target_report::text
  or ar.completion_payload#>>'{report,report_sha256}' is distinct from expected_report_sha256
  or ar.completion_payload#>>'{bundle,ai_release,sha256}' is distinct from expected_envelope_sha256
  or not private.ai_release_run_current(target_case,target_run) then raise exception 'AI_RELEASE_PUBLICATION_CURRENT_BINDING';end if;
 if not exists(select 1 from public.engine_report_versions r where r.analysis_run_id=ar.id and r.tenant_id=ar.tenant_id and r.case_id=ar.case_id
  and r.report_id=target_report::text and r.report_sha256=expected_report_sha256
  and r.analysis_result_sha256=ar.completion_payload#>>'{bundle,result_sha256}') then raise exception 'AI_RELEASE_PUBLICATION_ARTIFACT';end if;
 -- Reuses the normal persisted stages, actual Findings and immutable set check.
 finding_receipt:=private.ai_release_findings_record(target_run,ar.completion_payload#>>'{bundle,result_sha256}',expected_envelope_sha256);
 if finding_receipt is null then raise exception 'AI_RELEASE_PUBLICATION_FINDINGS';end if;
 select * into prior from private.ai_release_report_publications where report_id=target_report;
 replayed:=found;
 if replayed then
  if prior.case_id<>target_case or prior.analysis_run_id<>target_run or prior.report_sha256<>expected_report_sha256 or prior.envelope_sha256<>expected_envelope_sha256 then raise exception 'AI_RELEASE_PUBLICATION_RETRY_MISMATCH';end if;
 else
  insert into private.ai_release_report_publications(report_id,case_id,analysis_run_id,report_sha256,envelope_sha256)
   values(target_report,target_case,target_run,expected_report_sha256,expected_envelope_sha256) returning * into prior;
 end if;
 return jsonb_build_object('report_id',prior.report_id,'analysis_run_id',prior.analysis_run_id,'published_at',prior.published_at,'replayed',replayed);
end;$$;
revoke all on function private.ai_release_report_context(uuid,text),private.ai_release_run_current(uuid,text),private.ai_release_report_current(uuid,uuid),private.ai_release_report_publish(uuid,text,uuid,text,text)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.ai_release_report_publish(uuid,text,uuid,text,text) to tivdoc_worker_runtime;

-- Preserve old bytes/ACLs and owner access. New metadata is server-only and
-- stripped before returning summaries to a browser. Unpublished AI is history.
do $migration$
declare definition text;needle text;
begin
 definition:=pg_get_functiondef('public.case_report_private_review_list(uuid,uuid)'::regprocedure);
 needle:='''current'',ar.command_payload';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'AI_RELEASE_REPORT_LIST_BASE';end if;
 definition:=replace(definition,needle,'''ai_context'',case when ar.completion_payload#>''{bundle,ai_release}'' is not null then private.ai_release_report_context(target_case,ar.canonical_analysis_run_id) else null end,
  ''current'',(ar.completion_payload#>''{bundle,ai_release}'' is null or private.ai_release_report_current(target_case,(ar.completion_payload#>>''{report,report_id}'')::uuid)) and ar.command_payload');
 execute definition;
 definition:=pg_get_functiondef('public.case_report_private_review_artifact(uuid,uuid,uuid)'::regprocedure);
 needle:='''current'',summary->''current'',''completion''';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'AI_RELEASE_REPORT_ARTIFACT_BASE';end if;
 definition:=replace(definition,needle,'''current'',summary->''current'',''ai_context'',summary->''ai_context'',''completion''');execute definition;
end;$migration$;

-- Machine/owner/mail scope is distinct from calculation authority. This check
-- does not renew either one or authorize a provider expense.
create function private.managed_ai_release_scope(target_digest text,target_case uuid) returns boolean
language sql stable security invoker set search_path='' as $$
 select current_database()='tivdoc_release_replay_20260907' and exists(
  select 1 from private.managed_dev_worker_cases m join private.managed_dev_worker_capabilities cap on cap.capability_sha256=m.capability_sha256
  join public.cases c on c.id=m.case_id and c.is_qa
  join public.case_identity_cases ic on ic.case_id=c.id and ic.identity_id=m.identity_id
  join public.case_identities i on i.id=ic.identity_id and i.channel='email'
  join public.product_identity_sessions s on s.sid=m.session_sid and s.tenant_id='saved-case:'||c.id::text
  join lateral(select * from private.ai_release_enrollment_events where case_id=c.id order by sequence desc limit 1) a on true
  where m.case_id=target_case and m.capability_sha256=target_digest and m.enabled and cap.enabled
   and cap.expires_at>statement_timestamp() and i.contact_hash=any(cap.notification_recipients)
   and c.contact_verified_at is not null and s.revoked_at is null and s.valid_after<=statement_timestamp()
   and s.expires_at>statement_timestamp() and s.reviewer_org_id is null
   and a.kind='granted' and a.issued_at<=statement_timestamp() and a.expires_at>statement_timestamp());
$$;
revoke all on function private.managed_ai_release_scope(text,uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

do $notifications$
declare definition text;needle text;
begin
 definition:=pg_get_functiondef('public.case_notification_managed_pending(text)'::regprocedure);
 needle:=' select x.key,x.kind,x.case_id,x.public_id,x.identity_id,x.contact,x.request_id,x.report_id from events x';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'AI_RELEASE_PENDING_BASE';end if;
 definition:=replace(definition,needle,' select x.key,x.kind,x.case_id,x.public_id,x.identity_id,x.contact,x.request_id,x.report_id from (
  select * from events union all select ''qualified_ai:''||p.report_id::text,''qualified_ai_report_ready'',e.*,null::uuid,p.report_id
  from eligible e join private.ai_release_report_publications p on p.case_id=e.case_id
  where private.managed_ai_release_scope(digest,e.case_id) and private.ai_release_report_current(e.case_id,p.report_id)) x');execute definition;
 definition:=pg_get_functiondef('private.managed_dev_notification_event_current(uuid,text)'::regprocedure);
 needle:=' select case';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'AI_RELEASE_EVENT_BASE';end if;
 definition:=replace(definition,needle,needle||E'\n when target_event like ''qualified_ai:%'' then exists(select 1 from private.ai_release_report_publications p where p.case_id=target_case and target_event=''qualified_ai:''||p.report_id::text and private.ai_release_report_current(target_case,p.report_id))');execute definition;
 definition:=pg_get_functiondef('private.managed_notification_product_mirror(text,uuid,text)'::regprocedure);
 needle:='n.event_key like ''report:%'' or n.event_key like ''engineering:%''';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'AI_RELEASE_MIRROR_BASE';end if;
 definition:=replace(definition,needle,needle||' or n.event_key like ''qualified_ai:%''');execute definition;
 definition:=pg_get_functiondef('public.case_notification_outbox_claim(uuid)'::regprocedure);
 needle:='ce.event_key like ''completion:%''';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'AI_RELEASE_GENERIC_CLAIM_BASE';end if;
 definition:=replace(definition,needle,'(ce.event_key like ''completion:%'' or ce.event_key like ''qualified_ai:%'')');execute definition;
 definition:=pg_get_functiondef('private.managed_completion_scope(text,uuid)'::regprocedure);
 needle:='select current_database()=';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'AI_RELEASE_COMPLETION_SCOPE_BASE';end if;
 definition:=replace(definition,needle,'select private.managed_ai_release_scope(target_digest,target_case) or current_database()=');execute definition;
 -- The existing aggregate completion round also accepts a fully committed AI
 -- job, across all its paid months. Every month must have a current same-run
 -- publication receipt; the first run ID merely identifies the round history.
 definition:=pg_get_functiondef('private.managed_completion_ready(uuid)'::regprocedure);
 needle:=' ), current_questions as (';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'AI_RELEASE_COMPLETION_READY_BASE';end if;
 definition:=replace(definition,needle,' union all
  select j.job_id,h.revision,h.input_sha256,j.terminal_effect_sha256,e.payload,ar.canonical_analysis_run_id
  from public.cases c join private.case_input_heads h on h.case_id=c.id
  join private.case_analysis_dispatch d on d.case_id=h.case_id and d.revision=h.revision and d.mode=''draft'' and d.processing_profile=''qualified_ai_v1''
  join public.engine_durable_jobs j on j.job_id=d.job_id and j.canonical_case_id=c.id::text and j.tenant_id=''saved-case:''||c.id::text
  join public.engine_outbox_events e on e.outbox_id=''saved-draft:''||j.job_id and e.logical_effect_id=j.job_id
   and e.tenant_id=j.tenant_id and e.canonical_case_id=j.canonical_case_id and e.effect_kind=''saved_analysis_draft_ready_v1'' and e.payload_sha256=j.terminal_effect_sha256
  join public.analysis_runs ar on ar.canonical_analysis_run_id=e.payload#>>''{months,0,analysis_run_id}'' and ar.tenant_id=j.tenant_id and ar.canonical_case_id=j.canonical_case_id
  where c.id=target_case and c.is_qa and j.state=''succeeded'' and not j.cancellation_requested
   and j.payload->>''processing_profile''=''qualified_ai_v1'' and e.payload->>''schema_version''=''saved_analysis_draft_ready_v1''
   and e.payload->>''publication''=''draft'' and e.payload->>''job_id''=j.job_id and e.payload->''source''=j.payload
   and (j.payload->>''revision'')::bigint=h.revision and j.payload->>''input_sha256''=h.input_sha256
   and j.payload->>''authority_dependency_sha256''=d.authority_dependency_sha256 and jsonb_array_length(e.payload->''months'')>0
   and not exists(select 1 from jsonb_array_elements(e.payload->''months'') m left join public.analysis_runs r
    on r.canonical_analysis_run_id=m->>''analysis_run_id'' and r.tenant_id=j.tenant_id and r.canonical_case_id=j.canonical_case_id
    where r.id is null or r.status<>''completed'' or r.completion_payload#>>''{bundle,result_sha256}'' is distinct from m->>''result_sha256''
     or r.completion_payload#>>''{report,report_sha256}'' is distinct from m->>''report_sha256''
     or not private.ai_release_report_current(c.id,(r.completion_payload#>>''{report,report_id}'')::uuid))
 ) , current_questions as (');execute definition;
end;$notifications$;

-- A queued report from a different application build cannot be sent merely
-- because its older configuration has time left. Preserve the old signature
-- for legacy messages, but require a compiled application pin for new AI mail.
alter function public.case_notification_managed_dispatch(text,text,uuid,integer) rename to case_notification_managed_dispatch_before_ai_build_v1;
revoke all on function public.case_notification_managed_dispatch_before_ai_build_v1(text,text,uuid,integer)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create function public.case_notification_managed_dispatch(target_capability text,target_delivery text,target_worker uuid,target_fence integer,expected_ai_build_sha256 text)
returns table(state text) language plpgsql security definer set search_path='' as $$
declare target_case uuid;config_sha text;
begin
 perform private.managed_dev_worker_capability(target_capability);
 select o.case_id into target_case from private.case_notification_outbox o where o.delivery_id=target_delivery;
 if target_case is not null then perform 1 from public.cases where id=target_case for update;end if;
 if exists(select 1 from private.managed_dev_notification_events e where e.delivery_id=target_delivery and e.event_key like 'qualified_ai:%') then
  select c.payload->>'build_manifest_sha256' into config_sha from private.ai_release_configurations c
   join lateral(select a.configuration_sha256 from private.ai_release_enrollment_events a where a.case_id=target_case order by sequence desc limit 1) a on a.configuration_sha256=c.payload_sha256;
  if expected_ai_build_sha256 is null or expected_ai_build_sha256!~'^[a-f0-9]{64}$' or config_sha is distinct from expected_ai_build_sha256
   then raise exception 'AI_RELEASE_NOTIFICATION_BUILD_CHANGED';end if;
 end if;
 return query select * from public.case_notification_managed_dispatch_before_ai_build_v1(target_capability,target_delivery,target_worker,target_fence);
end;$$;
create function public.case_notification_managed_dispatch(target_capability text,target_delivery text,target_worker uuid,target_fence integer)
returns table(state text) language sql security definer set search_path='' as $$
 select * from public.case_notification_managed_dispatch(target_capability,target_delivery,target_worker,target_fence,null);
$$;
revoke all on function public.case_notification_managed_dispatch(text,text,uuid,integer,text),public.case_notification_managed_dispatch(text,text,uuid,integer)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_notification_managed_dispatch(text,text,uuid,integer,text),public.case_notification_managed_dispatch(text,text,uuid,integer) to tivdoc_worker_runtime;
