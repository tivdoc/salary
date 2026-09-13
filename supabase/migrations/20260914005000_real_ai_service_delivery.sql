-- Explicit versioned runtime connection; no activation, charge or service grant seeded.
-- CLI-generated timestamp resequenced after existing applied migrations.


create table private.real_ai_service_report_publications (
 report_id uuid primary key,case_id uuid not null references public.cases(id),identity_id uuid not null references public.case_identities(id),
 analysis_run_id text not null,report_sha256 text not null,envelope_sha256 text not null,service_decision_sha256 text not null references private.real_ai_service_decisions(payload_sha256),
 delivery_binding_sha256 text not null unique,admission jsonb not null,admission_sha256 text not null,published_at timestamptz not null default clock_timestamp(),
 unique(case_id,analysis_run_id),check(report_sha256~'^[a-f0-9]{64}$' and envelope_sha256~'^[a-f0-9]{64}$' and delivery_binding_sha256~'^[a-f0-9]{64}$')
);
create table private.real_ai_service_notification_grants (
 grant_id uuid primary key,payload_sha256 text not null unique,payload jsonb not null,
 case_id uuid not null references public.cases(id),identity_id uuid not null references public.case_identities(id),
 report_id uuid not null references private.real_ai_service_report_publications(report_id),sequence integer not null check(sequence>0),
 predecessor_sha256 text references private.real_ai_service_notification_grants(payload_sha256),
 recorded_at timestamptz not null default clock_timestamp(),recorded_by name not null default session_user,
 unique(case_id,identity_id,report_id,sequence),check((sequence=1)=(predecessor_sha256 is null))
);
create table private.real_ai_service_notification_bindings (
 delivery_id text primary key references private.case_notification_outbox(delivery_id),
 case_id uuid not null references public.cases(id),identity_id uuid not null references public.case_identities(id),
 report_id uuid not null references private.real_ai_service_report_publications(report_id),
 grant_sha256 text not null references private.real_ai_service_notification_grants(payload_sha256),
 delivery_binding_sha256 text not null references private.real_ai_service_report_publications(delivery_binding_sha256),
 delivery_context_sha256 text not null,notification_context_sha256 text not null,expires_at timestamptz not null,
 created_at timestamptz not null default clock_timestamp(),unique(report_id,identity_id)
);
do $acl$ declare t text;begin
 foreach t in array array['real_ai_service_report_publications','real_ai_service_notification_grants','real_ai_service_notification_bindings'] loop
  execute format('alter table private.%I enable row level security',t);execute format('alter table private.%I force row level security',t);
  execute format('create policy tivdoc_owner_access on private.%I for all to tivdoc_dev_migrator using(true) with check(true)',t);
  execute format('revoke all on private.%I from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime',t);
  execute format('create trigger %I before update or delete on private.%I for each row execute function private.ai_release_immutable()',t||'_immutable',t);
 end loop;
end;$acl$;
create function private.real_ai_service_json_sha(value jsonb) returns text language sql immutable security invoker set search_path='' as $$
 select encode(sha256(convert_to(private.governance_jsonb_compact_text(value),'UTF8')),'hex')
$$;
create function private.real_ai_service_assert_worker(p_case uuid) returns void language plpgsql security invoker set search_path='' as $$
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||p_case::text then raise exception 'REAL_SERVICE_WORKER_FORBIDDEN';end if;
end;$$;
create function public.case_access_real_service_context_install(target_case uuid,target_session_hash text) returns uuid
language plpgsql security definer set search_path='' as $$
declare identity uuid;begin
 if session_user<>'tivdoc_web_runtime' or target_session_hash is null or target_session_hash!~'^[a-f0-9]{64}$' then raise exception 'REAL_SERVICE_SESSION_FORBIDDEN';end if;
 select s.identity_id into identity from public.case_access_sessions s join public.case_identity_cases ic on ic.identity_id=s.identity_id
  join public.cases c on c.id=ic.case_id where s.session_hash=target_session_hash and s.revoked_at is null and s.expires_at>clock_timestamp()
  and c.id=target_case and c.is_qa is false and c.contact_verified_at is not null;
 if identity is null then raise exception 'REAL_SERVICE_SESSION_FORBIDDEN';end if;
 perform set_config('tivdoc.real_service_session_hash',target_session_hash,true);perform set_config('tivdoc.real_service_case',target_case::text,true);
 return identity;
end;$$;
create function private.real_ai_service_assert_web(p_case uuid,p_identity uuid) returns void
language plpgsql security invoker set search_path='' as $$
begin
 if session_user<>'tivdoc_web_runtime' or current_setting('tivdoc.real_service_case',true) is distinct from p_case::text
  or not exists(select 1 from public.case_access_sessions s join public.case_identity_cases ic on ic.identity_id=s.identity_id
   where s.session_hash=nullif(current_setting('tivdoc.real_service_session_hash',true),'') and s.identity_id=p_identity and ic.case_id=p_case
   and s.revoked_at is null and s.expires_at>clock_timestamp()) then raise exception 'REAL_SERVICE_SESSION_FORBIDDEN';end if;
 -- GUC values alone never authorize: every call rechecks the durable session.
end;$$;

-- Internal materializer: entry points authenticate before calling. It reads
-- exact saved bytes; TypeScript independently verifies compiled config,
-- replays ordinary engine and rerenders. SQL does no alternative calculation.
-- p_lock=false is reserved for outbox late-event checks, which already own an
-- outbox lock and must not acquire a case lock in the reverse order.
create function private.real_ai_service_delivery_material(p_case uuid,p_identity uuid,p_report uuid,p_lock boolean default true) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare ar public.analysis_runs;rv public.engine_report_versions;e private.real_ai_service_enrollment_events;
 pub private.real_ai_service_report_publications;config jsonb;decision jsonb;bundle jsonb;report jsonb;envelope jsonb;a jsonb;scope jsonb;
 purchased jsonb;order_scope jsonb;artifacts jsonb;current_context jsonb;publication jsonb;binding jsonb;token text;context_sha text;source_at timestamptz;
 at_time timestamptz:=clock_timestamp();until_time timestamptz;revocations jsonb;evidence jsonb;part text;action jsonb;receipt jsonb;operation jsonb;needed text;method jsonb;
begin
 if p_lock then perform 1 from public.cases where id=p_case for update;end if;
 if not exists(select 1 from public.cases c join public.case_identity_cases ic on ic.case_id=c.id
  where c.id=p_case and c.is_qa is false and c.contact_verified_at is not null and ic.identity_id=p_identity) then return jsonb_build_object('state','unavailable','reason','forbidden');end if;
 select * into e from private.real_ai_service_enrollment_events where case_id=p_case order by sequence desc limit 1;
 if not found then return jsonb_build_object('state','unavailable','reason','not_enrolled');end if;
 if e.kind='revoked' then return jsonb_build_object('state','unavailable','reason','revoked');end if;
 if e.identity_id<>p_identity or e.database_name<>current_database() or exists(select 1 from private.ai_release_enrollment_events where case_id=p_case) then return jsonb_build_object('state','unavailable','reason','forbidden');end if;
 if e.issued_at>at_time or e.expires_at<=at_time then return jsonb_build_object('state','unavailable','reason','expired');end if;
 select c.payload,d.payload into config,decision from private.ai_release_configurations c join private.real_ai_service_decisions d on d.configuration_sha256=c.payload_sha256
  where c.payload_sha256=e.configuration_sha256 and d.payload_sha256=e.service_decision_sha256;
 if not coalesce(config->>'schema_version'='tivdoc-ai-release-configuration-v1' and config#>>'{policy,namespace}'='real' and config#>>'{registry,namespace}'='real'
  and decision->>'status'='active' and decision->>'purpose'='real_customer_service' and config#>'{policy,allowed_environments}' ? e.environment,false) then raise exception 'REAL_SERVICE_CONFIGURATION_SCOPE';end if;
 if not coalesce((config#>>'{policy,issued_at}')::timestamptz<=at_time and (config#>>'{registry,issued_at}')::timestamptz<=at_time
  and (decision->>'issued_at')::timestamptz<=at_time and least((config#>>'{policy,expires_at}')::timestamptz,(config#>>'{registry,expires_at}')::timestamptz,(decision->>'expires_at')::timestamptz)>at_time,false)
  then return jsonb_build_object('state','unavailable','reason','expired');end if;
 if (select count(*) from public.analysis_runs r where r.canonical_case_id=p_case::text and r.tenant_id='saved-case:'||p_case::text and r.status='completed'
  and r.completion_payload#>>'{report,report_id}'=p_report::text)>1 then raise exception 'REAL_SERVICE_REPORT_AMBIGUOUS';end if;
 select * into ar from public.analysis_runs r where r.canonical_case_id=p_case::text and r.tenant_id='saved-case:'||p_case::text and r.status='completed'
  and r.completion_payload#>>'{report,report_id}'=p_report::text;
 if ar.id is null then return jsonb_build_object('state','unavailable','reason','unpublished');end if;
 bundle:=ar.completion_payload->'bundle';report:=ar.completion_payload->'report';envelope:=bundle->'ai_release';a:=envelope#>'{input,assessment_input}';scope:=a#>'{current,scope}';
 if envelope->>'schema_version' is distinct from 'case-analysis-ai-release-v1' or bundle->'owner_engineering' is not null
  or a#>>'{current,namespace}' is distinct from 'real' or a#>'{current,is_qa}' is distinct from 'false'::jsonb
  or a#>>'{current,environment}' is distinct from e.environment or ar.command_payload->>'mode' is distinct from 'real'
  or scope->>'case_id' is distinct from p_case::text or scope->>'order_origin' is distinct from 'saved_order'
  or envelope#>>'{input,analysis_run_id}' is distinct from ar.canonical_analysis_run_id or bundle->>'analysis_run_id' is distinct from ar.canonical_analysis_run_id
  or envelope#>'{binding,source_journal}' is distinct from jsonb_build_object('case_id',p_case,'input_revision',(scope->>'input_revision')::integer,'input_sha256',scope->>'input_sha256')
  then raise exception 'REAL_SERVICE_REAL_ENVELOPE_REQUIRED';end if;
 token:=private.real_ai_service_dependency(p_case);
 if scope->>'authority_dependency_sha256' is distinct from token or not exists(select 1 from private.case_input_heads h join private.case_analysis_dispatch d
  on d.case_id=h.case_id and d.revision=h.revision and d.mode='draft' where h.case_id=p_case and h.revision=(scope->>'input_revision')::integer
  and h.input_sha256=scope->>'input_sha256' and d.authority_dependency_sha256=token and d.processing_profile='qualified_ai_v1') then return jsonb_build_object('state','unavailable','reason','superseded');end if;
 purchased:=private.real_ai_service_paid_scope(p_case,(scope->>'input_revision')::integer,scope->>'input_sha256');
 if purchased<>e.purchased_scope then return jsonb_build_object('state','unavailable','reason','superseded');end if;
 select value into order_scope from jsonb_array_elements(purchased) where value->>'id'=scope->>'order_id' and value->>'offer_sha256'=scope->>'order_receipt_sha256';
 if order_scope is null or order_scope->'topics' is distinct from envelope#>'{input,source,purchased_scope,topics}'
  or envelope#>>'{input,source,purchased_scope,order_id}' is distinct from scope->>'order_id'
  or envelope#>>'{input,source,purchased_scope,receipt_sha256}' is distinct from scope->>'order_receipt_sha256'
  or (scope#>>'{period,from}')::date<(order_scope->>'from')::date
  or (scope#>>'{period,to}')::date>((order_scope->>'to')::date+interval '1 month - 1 day')::date then raise exception 'REAL_SERVICE_ORDER_BINDING';end if;
 if exists(select 1 from public.analysis_runs n where n.canonical_case_id=p_case::text and n.tenant_id=ar.tenant_id and n.status='completed'
  and n.command_payload->'period'=ar.command_payload->'period' and n.completion_payload#>>'{bundle,document_review,purchased_scope,order_id}'=scope->>'order_id'
  and (n.created_at,n.id)>(ar.created_at,ar.id)) then return jsonb_build_object('state','unavailable','reason','superseded');end if;
 foreach part in array array['policy','registry','source_receipts','interpretation_receipts','test_receipts'] loop
  if a->part is distinct from config->part then raise exception 'REAL_SERVICE_CONFIGURATION_CHANGED';end if;
 end loop;
 if scope->>'population' is distinct from config->>'population' or scope->>'facts_sha256' is distinct from bundle->>'facts_snapshot_sha256'
  or private.real_ai_service_json_sha(envelope-'sha256') is distinct from envelope->>'sha256'
  or private.real_ai_service_json_sha(bundle-'result_sha256') is distinct from bundle->>'result_sha256'
  or private.real_ai_service_json_sha(envelope#>'{input,source}') is distinct from ar.command_payload->>'document_review_sha256' then raise exception 'REAL_SERVICE_IMMUTABLE_BINDING';end if;
 -- Every consumed document pin must still be an actual current saved document
 -- and occur in this immutable source journal. The full source-head digest
 -- above also catches additional/removed documents and answer revisions.
 if exists(select 1 from jsonb_array_elements(a#>'{current,source_pins}') pin where pin->>'case_id'<>p_case::text or not exists(
  select 1 from public.documents d join private.case_input_versions v on v.case_id=d.case_id
  where d.case_id=p_case and d.id::text=pin->>'document_id' and d.version_id::text=pin->>'version_id' and d.content_sha256=pin->>'source_sha256'
   and v.revision=(scope->>'input_revision')::integer and v.input_sha256=scope->>'input_sha256'
   and exists(select 1 from jsonb_array_elements(v.input->'documents') j where j->>'id'=d.id::text and j->>'version_id'=d.version_id::text and j->>'sha256'=d.content_sha256))) then return jsonb_build_object('state','unavailable','reason','superseded');end if;
 select * into rv from public.engine_report_versions r where r.analysis_run_id=ar.id and r.case_id=ar.case_id and r.tenant_id=ar.tenant_id
  and r.report_id=p_report::text and r.revision=(report->>'report_revision')::integer and r.report_sha256=report->>'report_sha256'
  and r.canonical_case_id=p_case::text and r.canonical_analysis_run_id=ar.canonical_analysis_run_id and r.analysis_result_sha256=bundle->>'result_sha256';
 if rv.report_id is null or rv.artifacts_payload is distinct from report then raise exception 'REAL_SERVICE_REPORT_STORAGE_BINDING';end if;
 foreach part in array array['json','html','pdf','manifest'] loop
  if encode(sha256(decode(report->>(part||'_base64'),'base64')),'hex') is distinct from report->>(part||'_sha256') then raise exception 'REAL_SERVICE_REPORT_BYTES_CHANGED';end if;
 end loop;
 if private.real_ai_service_json_sha(report-'json_base64'-'html_base64'-'pdf_base64'-'manifest_base64'-'report_sha256') is distinct from report->>'report_sha256'
  or report->>'analysis_result_sha256' is distinct from bundle->>'result_sha256' then raise exception 'REAL_SERVICE_REPORT_HASH';end if;
 receipt:=envelope#>'{result,admission,receipt}';
 if envelope#>>'{result,admission,state}' is distinct from 'admitted' or not coalesce((receipt->>'evaluated_at')::timestamptz<=at_time and (receipt->>'expires_at')::timestamptz>at_time,false)
  then return jsonb_build_object('state','unavailable','reason','expired');end if;
 for action in select value from jsonb_array_elements(decision->'action_reviews') loop
  if not exists(select 1 from jsonb_array_elements(config->'interpretation_receipts') i join lateral jsonb_array_elements(config#>'{policy,branches}') b on b->>'interpretation_receipt_sha256'=i->>'sha256'
   where i->>'sha256'=action->>'interpretation_receipt_sha256' and i#>>'{human_by_law,basis_sha256}'=action->>'basis_sha256'
    and i#>>'{human_by_law,state}'='not_required_for_supported_branch' and receipt->'admitted_branch_ids' ? (b->>'branch_id')) then raise exception 'REAL_SERVICE_ACTION_NOT_ADMITTED';end if;
 end loop;
 if exists(select 1 from unnest(array['A01','A03','A05','A06','A07','A11']) required(action) where not exists(select 1 from jsonb_array_elements(decision->'action_reviews') r where r->>'action'=required.action)) then raise exception 'REAL_SERVICE_ACTION_SCOPE';end if;
 until_time:=least(e.expires_at,(receipt->>'expires_at')::timestamptz,(decision->>'expires_at')::timestamptz);
 for operation in select c#>'{calculation,input,operation}' from jsonb_array_elements(envelope#>'{result,review,checks}') c
  where exists(select 1 from jsonb_array_elements(envelope#>'{result,checks}') r where r->>'check_id'=c->>'check_id' and r->>'state'='calculated') loop
  if operation->>'kind' is distinct from 'candidate_rule' then raise exception 'REAL_SERVICE_OPERATION_SCOPE';end if;
  for needed in select jsonb_array_elements_text(operation->'required_decision_ids') loop
   select value into method from jsonb_array_elements(operation->'decisions') where value->>'decision_id'=needed;
   if method->>'state' is distinct from 'accepted' or (method->>'valid_until')::timestamptz<=at_time then return jsonb_build_object('state','unavailable','reason','expired');end if;
   until_time:=least(until_time,(method->>'valid_until')::timestamptz);
  end loop;
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object('target_sha256',r.target_sha256,'effective_at',r.effective_at) order by r.target_sha256,r.effective_at),'[]'::jsonb) into revocations
 from(select target_sha256,effective_at from private.real_ai_service_revocations where case_id=p_case
  union select value->>'target_sha256',(value->>'effective_at')::timestamptz from jsonb_array_elements(config#>'{registry,revocations}')) r
 join private.real_ai_service_dependency_targets(config,decision) t on t.sha256=r.target_sha256;
 if exists(select 1 from jsonb_array_elements(revocations) r where (r->>'effective_at')::timestamptz<=at_time) then return jsonb_build_object('state','unavailable','reason','revoked');end if;
 select least(until_time,min((r->>'effective_at')::timestamptz)) into until_time from jsonb_array_elements(revocations) r;
 if exists(select 1 from private.real_ai_service_evidence_refs(decision) ref where not exists(select 1 from private.real_ai_service_evidence_artifacts x where x.sha256=ref.sha256)) then raise exception 'REAL_SERVICE_EVIDENCE_UNAVAILABLE';end if;
 select jsonb_agg(jsonb_build_object('sha256',x.sha256,'content_base64',replace(encode(x.content,'base64'),E'\n','')) order by x.sha256) into evidence
 from private.real_ai_service_evidence_artifacts x join private.real_ai_service_evidence_refs(decision) ref on ref.sha256=x.sha256;
 select created_at into source_at from private.case_input_versions where case_id=p_case and revision=(scope->>'input_revision')::integer and input_sha256=scope->>'input_sha256';
 artifacts:=jsonb_build_object('case_id',p_case,'report_id',p_report,'analysis_run_id',ar.canonical_analysis_run_id,'envelope_sha256',envelope->>'sha256',
  'renderer_template',decision#>>'{renderer,template}','renderer_code_sha256',decision#>>'{renderer,code_sha256}',
  'html_sha256',report->>'html_sha256','pdf_sha256',report->>'pdf_sha256','purchased_topics',order_scope->'topics','represented_topics',order_scope->'topics');
 current_context:=jsonb_build_object('evaluated_at',at_time,'environment',e.environment,'namespace','real','is_qa',false,
  'policy_sha256',config#>>'{policy,sha256}','registry_sha256',config#>>'{registry,sha256}','registry_revision',config#>'{registry,revision}',
  'assessment_sha256',a#>>'{assessment,sha256}','scope',scope,'source_pins',a#>'{current,source_pins}','expected_generated_rules',receipt->'expected_generated_rules');
 binding:=jsonb_build_object('case_id',p_case,'identity_id',p_identity,'report_id',p_report,'analysis_run_id',ar.canonical_analysis_run_id,
  'report_sha256',report->>'report_sha256','envelope_sha256',envelope->>'sha256','service_decision_sha256',decision->>'sha256');
 binding:=binding||jsonb_build_object('delivery_binding_sha256',private.real_ai_service_json_sha(binding||jsonb_build_object('schema_version','tivdoc-real-ai-service-delivery-binding-v1')));
 select * into pub from private.real_ai_service_report_publications where report_id=p_report;
 publication:=case when pub.report_id is null then null else to_jsonb(pub)-'admission'-'admission_sha256' end;
 if publication is not null and publication-'published_at'<>binding then raise exception 'REAL_SERVICE_PUBLICATION_BINDING';end if;
 -- CAS excludes clocks and publication existence so a successful publication
 -- retry can return its original receipt. Every validity bound is rechecked.
 context_sha:=private.real_ai_service_json_sha(jsonb_build_object('schema_version','real-ai-service-delivery-context-v1','binding',binding,
  'authority_dependency_sha256',token,'source_journal',envelope#>'{binding,source_journal}','purchased_scope_sha256',e.purchased_scope_sha256,
  'configuration_sha256',e.configuration_sha256,'artifacts',artifacts));
 return jsonb_build_object('state','configured','configuration',config,'configuration_sha256',e.configuration_sha256,'service_decision',decision,
  'current',jsonb_build_object('assessment',current_context,'identity_id',p_identity,'service_decision_sha256',decision->>'sha256','artifacts',artifacts,'revocations',revocations),
  'context_sha256',context_sha,'source_created_at',source_at,'enrollment_expires_at',until_time,'evidence',evidence,
  'completion',jsonb_build_object('bundle',bundle,'report',report),'publication',publication);
end;$$;
create function private.real_ai_service_delivery_context(p_case uuid,p_identity uuid,p_report uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin perform private.real_ai_service_assert_worker(p_case);return private.real_ai_service_delivery_material(p_case,p_identity,p_report);end;$$;
create function public.case_report_real_ai_context(target_case uuid,target_identity uuid,target_report uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare material jsonb;begin
 perform private.real_ai_service_assert_web(target_case,target_identity);material:=private.real_ai_service_delivery_material(target_case,target_identity,target_report);
 perform private.real_ai_service_assert_web(target_case,target_identity);
 if material->>'state'='configured' and material->'publication'='null'::jsonb then return jsonb_build_object('state','unavailable','reason','unpublished');end if;return material;
end;$$;
create function private.real_ai_service_report_publish(p_case uuid,p_identity uuid,p_report uuid,p_context_sha256 text,p_binding jsonb,p_admission jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m jsonb;expected jsonb;prior private.real_ai_service_report_publications;at_time timestamptz:=clock_timestamp();replayed boolean;begin
 perform private.real_ai_service_assert_worker(p_case);m:=private.real_ai_service_delivery_material(p_case,p_identity,p_report);
 if m->>'state' is distinct from 'configured' or m->>'context_sha256' is distinct from p_context_sha256 then raise exception 'REAL_SERVICE_PUBLICATION_CHANGED';end if;
 expected:=jsonb_build_object('case_id',p_case,'identity_id',p_identity,'report_id',p_report,'analysis_run_id',m#>>'{completion,bundle,analysis_run_id}',
  'report_sha256',m#>>'{completion,report,report_sha256}','envelope_sha256',m#>>'{completion,bundle,ai_release,sha256}','service_decision_sha256',m#>>'{service_decision,sha256}');
 expected:=expected||jsonb_build_object('delivery_binding_sha256',private.real_ai_service_json_sha(expected||jsonb_build_object('schema_version','tivdoc-real-ai-service-delivery-binding-v1')));
 if p_binding is distinct from expected or p_admission->>'schema_version' is distinct from 'tivdoc-real-ai-service-delivery-admission-v1'
  or p_admission->>'sha256' is distinct from private.real_ai_service_json_sha(p_admission-'sha256')
  or p_admission->>'identity_id' is distinct from p_identity::text or p_admission->>'namespace' is distinct from 'real'
  or p_admission->>'service_decision_sha256' is distinct from m#>>'{service_decision,sha256}'
  or p_admission->>'policy_sha256' is distinct from m#>>'{configuration,policy,sha256}' or p_admission->>'registry_sha256' is distinct from m#>>'{configuration,registry,sha256}'
  or p_admission->>'admission_sha256' is distinct from m#>>'{completion,bundle,ai_release,result,admission,receipt,sha256}'
  or p_admission->'artifacts' is distinct from m#>'{current,artifacts}' or p_admission->'allowed_actions' is distinct from '["A01","A03","A05","A06","A07","A11"]'::jsonb
  or p_admission->'human_attestation' is distinct from 'null'::jsonb or p_admission->'legal_debt_total' is distinct from 'null'::jsonb or p_admission->'combined_amount' is distinct from 'null'::jsonb
  or p_admission->'publication_performed' is distinct from 'false'::jsonb or p_admission->'notification_allowed' is distinct from 'false'::jsonb or p_admission->'commercial_charge_allowed' is distinct from 'false'::jsonb
  or not coalesce((p_admission->>'evaluated_at')::timestamptz<=at_time and (p_admission->>'expires_at')::timestamptz>at_time and (m->>'enrollment_expires_at')::timestamptz>at_time,false)
  then raise exception 'REAL_SERVICE_PUBLICATION_ADMISSION';end if;
 select * into prior from private.real_ai_service_report_publications where report_id=p_report;replayed:=found;
 if not replayed then
  insert into private.real_ai_service_report_publications(report_id,case_id,identity_id,analysis_run_id,report_sha256,envelope_sha256,service_decision_sha256,delivery_binding_sha256,admission,admission_sha256,published_at)
  values(p_report,p_case,p_identity,expected->>'analysis_run_id',expected->>'report_sha256',expected->>'envelope_sha256',expected->>'service_decision_sha256',expected->>'delivery_binding_sha256',p_admission,p_admission->>'sha256',at_time) returning * into prior;
 elsif to_jsonb(prior)-'admission'-'admission_sha256'-'published_at'<>expected then raise exception 'REAL_SERVICE_PUBLICATION_RETRY_MISMATCH';end if;
 return (to_jsonb(prior)-'admission'-'admission_sha256')||jsonb_build_object('replayed',replayed);
end;$$;

-- Notification authority is a separately supplied immutable grant, not a side
-- effect of publishing. Revocations use a new grant payload with state=revoked
-- and predecessor CAS; neither expiry nor retries manufacture a new active one.
create function private.real_ai_service_notification_grant_record(p_grant jsonb,p_predecessor_sha256 text) returns text
language plpgsql security invoker set search_path='' as $$
declare prior private.real_ai_service_notification_grants;existing private.real_ai_service_notification_grants;pub private.real_ai_service_report_publications;
 e private.real_ai_service_enrollment_events;target_case uuid;begin
 if session_user<>'tivdoc_dev_migrator' then raise exception 'REAL_SERVICE_OPERATOR_REQUIRED';end if;
 target_case:=(p_grant->>'case_id')::uuid;perform 1 from public.cases where id=target_case for update;
 if not coalesce(p_grant->>'schema_version'='tivdoc-real-ai-service-notification-grant-v1' and p_grant->>'namespace'='real'
  and p_grant->>'state' in ('active','revoked') and p_grant->>'template'='real-ai-report-ready-v1'
  and p_grant->>'sha256'=private.real_ai_service_json_sha(p_grant-'sha256')
  and p_grant->>'origin'~'^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$'
  and (p_grant->>'issued_at')::timestamptz<(p_grant->>'expires_at')::timestamptz,false) then raise exception 'REAL_SERVICE_NOTIFICATION_GRANT_INVALID';end if;
 select * into existing from private.real_ai_service_notification_grants where grant_id=(p_grant->>'grant_id')::uuid;
 if found then
  if existing.payload<>p_grant or existing.predecessor_sha256 is distinct from p_predecessor_sha256 then raise exception 'REAL_SERVICE_NOTIFICATION_GRANT_RETRY';end if;return existing.payload_sha256;
 end if;
 select * into prior from private.real_ai_service_notification_grants where case_id=target_case and identity_id::text=p_grant->>'identity_id' and report_id::text=p_grant->>'report_id' order by sequence desc limit 1;
 if prior.payload_sha256 is distinct from p_predecessor_sha256 then raise exception 'REAL_SERVICE_NOTIFICATION_GRANT_SUPERSEDED';end if;
 select * into pub from private.real_ai_service_report_publications where report_id::text=p_grant->>'report_id' and case_id=target_case and identity_id::text=p_grant->>'identity_id';
 if pub.report_id is null or pub.service_decision_sha256 is distinct from p_grant->>'service_decision_sha256' then raise exception 'REAL_SERVICE_NOTIFICATION_PUBLICATION';end if;
 if p_grant->>'state'='active' then
  select * into e from private.real_ai_service_enrollment_events where case_id=target_case order by sequence desc limit 1;
  if e.kind is distinct from 'granted' or e.service_decision_sha256<>pub.service_decision_sha256 or e.identity_id<>pub.identity_id
   or (p_grant->>'issued_at')::timestamptz<greatest(e.issued_at,pub.published_at)
   or (p_grant->>'issued_at')::timestamptz>clock_timestamp() or (p_grant->>'expires_at')::timestamptz>e.expires_at
   or (p_grant->>'expires_at')::timestamptz<=clock_timestamp() then raise exception 'REAL_SERVICE_NOTIFICATION_GRANT_WINDOW';end if;
  if not exists(select 1 from public.case_identities i join public.case_identity_cases ic on ic.identity_id=i.id join public.cases c on c.id=ic.case_id
   where c.id=target_case and c.is_qa is false and c.contact_verified_at is not null and c.reminder_opted_out_at is null and i.id=pub.identity_id
   and i.channel='email' and i.contact_hash=p_grant->>'recipient_sha256'
   and i.contact_hash=encode(sha256(convert_to('email|'||lower(btrim(i.contact_normalized)),'UTF8')),'hex')) then raise exception 'REAL_SERVICE_NOTIFICATION_RECIPIENT';end if;
  if exists(select 1 from private.case_notification_suppression where recipient_sha256=p_grant->>'recipient_sha256') then raise exception 'REAL_SERVICE_NOTIFICATION_OPTED_OUT';end if;
 elsif prior.payload->>'state' is distinct from 'active' or prior.payload-'sha256'-'grant_id'-'state'<>p_grant-'sha256'-'grant_id'-'state' then raise exception 'REAL_SERVICE_NOTIFICATION_REVOKE_SCOPE';end if;
 insert into private.real_ai_service_notification_grants(grant_id,payload_sha256,payload,case_id,identity_id,report_id,sequence,predecessor_sha256)
 values((p_grant->>'grant_id')::uuid,p_grant->>'sha256',p_grant,target_case,pub.identity_id,pub.report_id,coalesce(prior.sequence,0)+1,p_predecessor_sha256);
 return p_grant->>'sha256';
end;$$;

create function private.real_ai_service_notification_material(p_case uuid,p_identity uuid,p_report uuid,p_lock boolean default true) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare d jsonb;g private.real_ai_service_notification_grants;i public.case_identities;c public.cases;revocations jsonb;context_sha text;at_time timestamptz:=clock_timestamp();begin
 d:=private.real_ai_service_delivery_material(p_case,p_identity,p_report,p_lock);
 if d->>'state' is distinct from 'configured' or d->'publication'='null'::jsonb then return jsonb_build_object('state','unavailable','reason','not_authorized');end if;
 select * into g from private.real_ai_service_notification_grants where case_id=p_case and identity_id=p_identity and report_id=p_report order by sequence desc limit 1;
 if g.grant_id is null then return jsonb_build_object('state','unavailable','reason','not_authorized');end if;
 if g.payload->>'state'<>'active' then return jsonb_build_object('state','unavailable','reason','revoked');end if;
 if (g.payload->>'issued_at')::timestamptz>at_time or (g.payload->>'expires_at')::timestamptz<=at_time then return jsonb_build_object('state','unavailable','reason','expired');end if;
 if g.payload->>'service_decision_sha256' is distinct from d#>>'{service_decision,sha256}' then return jsonb_build_object('state','unavailable','reason','revoked');end if;
 if p_lock then perform 1 from public.case_identities where id=p_identity for share;end if;
 select * into i from public.case_identities where id=p_identity;select * into c from public.cases where id=p_case;
 if i.channel is distinct from 'email' or i.contact_hash is distinct from g.payload->>'recipient_sha256'
  or encode(sha256(convert_to('email|'||lower(btrim(i.contact_normalized)),'UTF8')),'hex') is distinct from i.contact_hash then return jsonb_build_object('state','unavailable','reason','contact_changed');end if;
 if c.reminder_opted_out_at is not null or exists(select 1 from private.case_notification_suppression where recipient_sha256=i.contact_hash) then return jsonb_build_object('state','unavailable','reason','opted_out');end if;
 select coalesce(jsonb_agg(jsonb_build_object('target_sha256',r.target_sha256,'effective_at',r.effective_at) order by r.id),'[]'::jsonb) into revocations
 from private.real_ai_service_revocations r where r.case_id=p_case and r.target_sha256 in (g.payload_sha256,g.payload->>'service_decision_sha256',i.contact_hash);
 if exists(select 1 from jsonb_array_elements(revocations) r where (r->>'effective_at')::timestamptz<=at_time) then return jsonb_build_object('state','unavailable','reason','revoked');end if;
 context_sha:=private.real_ai_service_json_sha(jsonb_build_object('schema_version','real-ai-service-notification-context-v1','grant_sha256',g.payload_sha256,
  'delivery_context_sha256',d->>'context_sha256','recipient_sha256',i.contact_hash,'public_id',c.public_id,'revocations',revocations));
 return jsonb_build_object('state','authorized','grant',g.payload,'grant_sha256',g.payload_sha256,'context_sha256',context_sha,
  'evaluated_at',clock_timestamp(),'contact',lower(btrim(i.contact_normalized)),'public_id',c.public_id,'revocations',revocations);
end;$$;
create function private.real_ai_service_notification_context(p_case uuid,p_identity uuid,p_report uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin perform private.real_ai_service_assert_worker(p_case);return private.real_ai_service_notification_material(p_case,p_identity,p_report);end;$$;

-- Fixed transport digest exactly matches current renderReportReady and
-- payloadDigest, not JSON stringify/canonical hashing. No arbitrary content or
-- URL is accepted. TS still decrypts and compares the complete message before
-- send. Template/body edits require a version change and these compatibility tests.
create function private.real_ai_service_notification_payload_sha(p_context jsonb,p_report uuid) returns text
language sql immutable security invoker set search_path='' as $$
 select encode(sha256(convert_to('report_ready|email|'||(p_context->>'contact')||'|Tivdoc — הדוח לתיק '||(p_context->>'public_id')||' מוכן|'
  ||'הדוח הראשוני לתיק '||(p_context->>'public_id')||' מוכן.'||E'\n'
  ||'לצפייה: '||regexp_replace(p_context#>>'{grant,origin}','/$','')||'/case/'||(p_context->>'public_id')||'/reports?report='||p_report::text||E'\n'
  ||'הדוח מציג מה נבדק, מה לא נבדק ומדוע, ורמת ודאות לכל נקודה.','UTF8')),'hex')
$$;
create function private.real_ai_service_notification_enqueue(p_case uuid,p_identity uuid,p_report uuid,p_delivery_context_sha256 text,p_notification_context_sha256 text,
 p_delivery_id text,p_recipient_sha256 text,p_encrypted jsonb,p_expires_at timestamptz) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d jsonb;n jsonb;b private.real_ai_service_notification_bindings;o private.case_notification_outbox;until_time timestamptz;replayed boolean;begin
 perform private.real_ai_service_assert_worker(p_case);d:=private.real_ai_service_delivery_material(p_case,p_identity,p_report);n:=private.real_ai_service_notification_material(p_case,p_identity,p_report);
 if d->>'state' is distinct from 'configured' or n->>'state' is distinct from 'authorized' or d->>'context_sha256' is distinct from p_delivery_context_sha256
  or n->>'context_sha256' is distinct from p_notification_context_sha256 or n#>>'{grant,recipient_sha256}' is distinct from p_recipient_sha256
  or private.real_ai_service_notification_payload_sha(n,p_report) is distinct from p_delivery_id then raise exception 'REAL_SERVICE_NOTIFICATION_ENQUEUE_CHANGED';end if;
 select least((d->>'enrollment_expires_at')::timestamptz,(n#>>'{grant,expires_at}')::timestamptz,min((value->>'effective_at')::timestamptz)) into until_time from jsonb_array_elements(n->'revocations');
 if p_expires_at is null or p_expires_at<=clock_timestamp() or p_expires_at>until_time or p_expires_at>clock_timestamp()+interval '20 hours'
  or not coalesce(jsonb_typeof(p_encrypted)='object' and p_encrypted->'version'='1'::jsonb and octet_length(decode(p_encrypted->>'iv','base64'))=12
   and octet_length(decode(p_encrypted->>'tag','base64'))=16 and octet_length(decode(p_encrypted->>'ciphertext','base64')) between 1 and 20000,false)
  then raise exception 'REAL_SERVICE_NOTIFICATION_ENQUEUE_INVALID';end if;
 select * into b from private.real_ai_service_notification_bindings where report_id=p_report and identity_id=p_identity;replayed:=found;
 if replayed then
  if b.delivery_id<>p_delivery_id or b.case_id<>p_case or b.grant_sha256<>n->>'grant_sha256' or b.delivery_binding_sha256<>d#>>'{publication,delivery_binding_sha256}' then raise exception 'REAL_SERVICE_NOTIFICATION_RETRY_SCOPE';end if;
 else
  -- Do not adopt a generic caller's preexisting ciphertext with a guessed digest.
  if exists(select 1 from private.case_notification_outbox where delivery_id=p_delivery_id) then raise exception 'REAL_SERVICE_NOTIFICATION_UNBOUND_COLLISION';end if;
  perform public.case_notification_outbox_enqueue(p_delivery_id,p_case,p_identity,p_recipient_sha256,'report_ready',p_encrypted,p_expires_at);
  insert into private.real_ai_service_notification_bindings(delivery_id,case_id,identity_id,report_id,grant_sha256,delivery_binding_sha256,delivery_context_sha256,notification_context_sha256,expires_at)
  values(p_delivery_id,p_case,p_identity,p_report,n->>'grant_sha256',d#>>'{publication,delivery_binding_sha256}',p_delivery_context_sha256,p_notification_context_sha256,p_expires_at) returning * into b;
 end if;
 select * into o from private.case_notification_outbox where delivery_id=b.delivery_id;
 if o.case_id is distinct from p_case or o.identity_id is distinct from p_identity or o.recipient_sha256 is distinct from p_recipient_sha256 or o.template is distinct from 'report_ready' then raise exception 'REAL_SERVICE_NOTIFICATION_OUTBOX_BINDING';end if;
 return jsonb_build_object('delivery_id',b.delivery_id,'grant_sha256',b.grant_sha256,'delivery_binding_sha256',b.delivery_binding_sha256,'replayed',replayed);
end;$$;

-- Stable currentness for outbox transitions. No locks are taken in this helper
-- because provider receipt/webhook code already holds the outbox row. Broken
-- or unavailable authority is false; it never creates a release or receipt.
create function private.real_ai_service_notification_binding_current(p_delivery text) returns boolean language plpgsql security invoker set search_path='' as $$
declare b private.real_ai_service_notification_bindings;d jsonb;n jsonb;begin
 select * into b from private.real_ai_service_notification_bindings where delivery_id=p_delivery;if b.delivery_id is null or b.expires_at<=clock_timestamp() then return false;end if;
 d:=private.real_ai_service_delivery_material(b.case_id,b.identity_id,b.report_id,false);n:=private.real_ai_service_notification_material(b.case_id,b.identity_id,b.report_id,false);
 return coalesce(d->>'state'='configured' and n->>'state'='authorized' and d#>>'{publication,delivery_binding_sha256}'=b.delivery_binding_sha256
  and d->>'context_sha256'=b.delivery_context_sha256 and n->>'context_sha256'=b.notification_context_sha256 and n->>'grant_sha256'=b.grant_sha256
  and private.real_ai_service_notification_payload_sha(n,b.report_id)=p_delivery,false);
exception when others then return false;
end;$$;
-- Exact new claim path: same outbox and existing attempt/lease/fence columns.
-- Root uses this RPC for REAL; no second queue or provider worker is necessary.
create function private.real_ai_service_notification_claim(p_case uuid,p_worker uuid) returns table(delivery_id text,encrypted_payload jsonb,fencing_token integer,case_id uuid,identity_id uuid,report_id uuid)
language plpgsql security definer set search_path='' as $$
declare target text;begin
 perform private.real_ai_service_assert_worker(p_case);if p_worker is null then raise exception 'NOTIFICATION_WORKER_INVALID';end if;
 perform 1 from public.cases where id=p_case for update;
 update private.case_notification_outbox o set state='dead_letter',encrypted_payload=null,last_error='real_service_unavailable',lease_owner=null,lease_expires_at=null
 where o.case_id=p_case and exists(select 1 from private.real_ai_service_notification_bindings b where b.delivery_id=o.delivery_id)
  and (o.state='queued' or o.state='leased' and o.lease_expires_at<=clock_timestamp())
  and (o.expires_at<=clock_timestamp() or o.attempts>=6 or not private.real_ai_service_notification_binding_current(o.delivery_id));
 select o.delivery_id into target from private.case_notification_outbox o join private.real_ai_service_notification_bindings b on b.delivery_id=o.delivery_id
 where b.case_id=p_case and o.case_id=p_case and (o.state='queued' or o.state='leased' and o.lease_expires_at<=clock_timestamp())
  and o.available_at<=clock_timestamp() and o.expires_at>clock_timestamp() and o.attempts<6 and private.real_ai_service_notification_binding_current(o.delivery_id)
 order by o.created_at,o.delivery_id limit 1 for update of o skip locked;
 if target is null then return;end if;
 update private.case_notification_outbox o set state='leased',attempts=o.attempts+1,fencing_token=o.fencing_token+1,lease_owner=p_worker,lease_expires_at=clock_timestamp()+interval '1 minute' where o.delivery_id=target;
 return query select o.delivery_id,o.encrypted_payload,o.fencing_token,b.case_id,b.identity_id,b.report_id from private.case_notification_outbox o join private.real_ai_service_notification_bindings b on b.delivery_id=o.delivery_id where o.delivery_id=target;
end;$$;
create function private.real_ai_service_notification_dispatch(p_case uuid,p_delivery text,p_worker uuid,p_fence integer) returns text
language plpgsql security definer set search_path='' as $$
declare o private.case_notification_outbox;begin
 perform private.real_ai_service_assert_worker(p_case);perform 1 from public.cases where id=p_case for update;
 select * into o from private.case_notification_outbox where delivery_id=p_delivery and case_id=p_case for update;
 if o.delivery_id is null or o.state<>'leased' or o.lease_owner is distinct from p_worker or o.fencing_token is distinct from p_fence or o.lease_expires_at<=clock_timestamp() then raise exception 'NOTIFICATION_LEASE_LOST';end if;
 if not private.real_ai_service_notification_binding_current(p_delivery) then
  update private.case_notification_outbox set state='dead_letter',encrypted_payload=null,last_error='real_service_unavailable',lease_owner=null,lease_expires_at=null where delivery_id=p_delivery;return 'cancelled';
 end if;return 'ready';
end;$$;
create function private.real_ai_service_notification_finish(p_case uuid,p_delivery text,p_worker uuid,p_fence integer,p_provider_id uuid,p_error text) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform private.real_ai_service_assert_worker(p_case);perform 1 from public.cases where id=p_case for update;
 if not exists(select 1 from private.real_ai_service_notification_bindings where delivery_id=p_delivery and case_id=p_case) then raise exception 'REAL_SERVICE_NOTIFICATION_SCOPE';end if;
 perform public.case_notification_outbox_finish(p_delivery,p_worker,p_fence,p_provider_id,p_error);
end;$$;
-- Prevent late transport events from promoting a cancelled/expired delivery.
-- Provider IDs/webhooks still persist as actual transport evidence. Neither
-- state here nor an email.delivered webhook activates publication/authority.
create function private.real_ai_service_outbox_transition() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from private.real_ai_service_notification_bindings where delivery_id=new.delivery_id) then return new;end if;
 if old.state in ('dead_letter','suppressed') and new.state in ('queued','leased','sent','delivered') then
  new.state:=old.state;new.last_error:=old.last_error;new.encrypted_payload:=null;new.delivered_at:=old.delivered_at;new.lease_owner:=null;new.lease_expires_at:=null;return new;
 end if;
 if new.state in ('leased','queued','sent') and old.state='leased' then perform private.real_ai_service_assert_worker(new.case_id);end if;
 if new.state in ('leased','sent','delivered') and not private.real_ai_service_notification_binding_current(new.delivery_id) then
  new.state:='dead_letter';new.last_error:='real_service_unavailable';new.encrypted_payload:=null;new.delivered_at:=old.delivered_at;new.lease_owner:=null;new.lease_expires_at:=null;
 end if;return new;
end;$$;
create trigger real_ai_service_outbox_transition before update on private.case_notification_outbox for each row execute function private.real_ai_service_outbox_transition();

-- Preserve generic claim behavior for all existing messages, but REAL items
-- must use the scoped claim above. Exact known anchor, fail if baseline drifted.
do $generic_claim$ declare body text;needle text;begin
 body:=pg_get_functiondef('public.case_notification_outbox_claim(uuid)'::regprocedure);
 needle:='and not exists(select 1 from private.case_notification_suppression s where s.recipient_sha256=o.recipient_sha256)';
 if length(body)-length(replace(body,needle,''))<>length(needle) then raise exception 'REAL_SERVICE_GENERIC_CLAIM_BASE_CHANGED';end if;
 execute replace(body,needle,'and not exists(select 1 from private.real_ai_service_notification_bindings real_binding where real_binding.delivery_id=o.delivery_id) '||needle);
end;$generic_claim$;

do $functions_acl$ declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='private' and p.proname like 'real_ai_service_%') or(n.nspname='public' and p.proname in ('case_access_real_service_context_install','case_report_real_ai_context')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime',f.signature);
 end loop;
end;$functions_acl$;
-- The broad revocation above includes processing helpers; explicitly restore
-- only the two existing processing worker entry points as well.
grant execute on function private.real_ai_service_processing_enrolled(uuid,integer,text),private.real_ai_service_processing_context(uuid,integer,text),
 private.real_ai_service_delivery_context(uuid,uuid,uuid),private.real_ai_service_report_publish(uuid,uuid,uuid,text,jsonb,jsonb),
 private.real_ai_service_notification_context(uuid,uuid,uuid),private.real_ai_service_notification_enqueue(uuid,uuid,uuid,text,text,text,text,jsonb,timestamptz),
 private.real_ai_service_notification_claim(uuid,uuid),private.real_ai_service_notification_dispatch(uuid,text,uuid,integer),
 private.real_ai_service_notification_finish(uuid,text,uuid,integer,uuid,text) to tivdoc_worker_runtime;
grant execute on function public.case_access_real_service_context_install(uuid,text),public.case_report_real_ai_context(uuid,uuid,uuid) to tivdoc_web_runtime;

-- Recent history is retained as metadata; each current flag uses the same live
-- source/entitlement/authority fences as downloading. No report bytes/evidence
-- are returned by this list, and the session is checked again before return.
create function public.case_report_real_ai_list(target_case uuid,target_identity uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare publication private.real_ai_service_report_publications;material jsonb;result jsonb:='[]'::jsonb;period jsonb;
begin
 perform private.real_ai_service_assert_web(target_case,target_identity);
 for publication in select p.* from private.real_ai_service_report_publications p where p.case_id=target_case and p.identity_id=target_identity order by p.published_at desc,p.report_id desc limit 20 loop
  material:=private.real_ai_service_delivery_material(target_case,target_identity,publication.report_id);
  select a.command_payload->'period' into period from public.analysis_runs a where a.canonical_case_id=target_case::text
   and a.tenant_id='saved-case:'||target_case::text and a.canonical_analysis_run_id=publication.analysis_run_id;
  if period is null then raise exception 'REAL_SERVICE_REPORT_PERIOD_REQUIRED';end if;
  result:=result||jsonb_build_array(jsonb_build_object('report_id',publication.report_id,'analysis_run_id',publication.analysis_run_id,
   'published_at',publication.published_at,'from',period->>'start_date','to',period->>'end_date',
   'current',material->>'state'='configured','reason',case when material->>'state'='configured' then null else material->>'reason' end));
 end loop;
 perform private.real_ai_service_assert_web(target_case,target_identity);return result;
end;$$;
revoke all on function public.case_report_real_ai_list(uuid,uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_report_real_ai_list(uuid,uuid) to tivdoc_web_runtime;

-- Root integration/verification requirements:
-- * Keep TIVDOC_REAL_AI_SERVICE_ENABLED off until matching code/config/evidence
--   exists. Loading the migration alone creates no active decision/grant.
-- * Install web session context on same transaction client. Existing routes
--   still resolve cookie + identity + public case ID before this SQL boundary.
-- * Real sender must call claim above, decrypt existing envelope, then call TS
--   revalidateRealAiReportNotification with exact selector and configured HTTPS
--   origin, then dispatch above before the existing sendNotification(provider).
--   Call REAL finish wrapper afterwards. Generic deliverClaimedNotification
--   currently lacks this guard; root must wire explicit REAL branch, not call
--   it unchanged and assume SQL claim performed deterministic message checks.
-- * Existing provider idempotency key is payloadDigest; preserve attempts and
--   six-attempt/24-hour provider limitations. Never renew an expired intention.
-- * No case_report_delivery row/projection/QA approval is created; its FK is for
--   legacy projection reports. REAL bindings attach directly to this outbox.
-- * Source/refund/suspension and session/contact/opt-out mutations must retain
--   existing case-first lock order. Pre-send and downloads always revalidate.
-- * Parent dry-run must verify current engine_report_versions.artifacts_payload
--   exactly equals encoded completion.report, canonical report hash, admission
--   generated-rule pins, generic-claim anchor, prepared parameter types, and
--   actual expiry/null behavior. No PostgreSQL parser was installed locally;
--   this draft has not been syntax-checked or run against a database.
