-- Versioned transactional notification policy for the existing REAL prepare path.
-- Registration is separate from installation; no existing purchase terms qualify implicitly.
-- No policy, evidence, customer authority, payment, grant or outbox row seeded.
-- Exact policy16 / parent16 / source10 contracts from notification-policy.ts.

create table private.real_ai_service_notification_policies(
 payload_sha256 text primary key,payload jsonb not null,policy_id uuid not null,
 revision integer not null check(revision>0),activation_plan_id uuid not null,
 plan_sha256 text not null references private.real_service_activation_plans(payload_sha256),
 predecessor_sha256 text references private.real_ai_service_notification_policies(payload_sha256),
 evidence_sha256 text not null references private.real_ai_service_evidence_artifacts(sha256),
 recorded_at timestamptz not null default clock_timestamp(),recorded_by name not null default session_user,
 unique(policy_id,revision),unique(activation_plan_id,revision),
 check((revision=1)=(predecessor_sha256 is null))
);
alter table private.real_ai_service_notification_policies enable row level security;
alter table private.real_ai_service_notification_policies force row level security;
create policy tivdoc_owner_access on private.real_ai_service_notification_policies for all to tivdoc_dev_migrator using(true) with check(true);
revoke all on private.real_ai_service_notification_policies from public,anon,authenticated,service_role,tivdoc_identity_runtime,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger real_ai_service_notification_policies_immutable before update or delete on private.real_ai_service_notification_policies
 for each row execute function private.ai_release_immutable();

create function private.real_ai_service_notification_policy_register(p_policy jsonb,p_predecessor_sha256 text) returns text
language plpgsql security invoker set search_path='' as $$
declare x jsonb:=p_policy;plan_row private.real_service_activation_plans;prior private.real_ai_service_notification_policies;
 existing private.real_ai_service_notification_policies;decision jsonb;term jsonb;at_time timestamptz;begin
 if session_user<>'tivdoc_dev_migrator' then raise exception 'REAL_SERVICE_OPERATOR_REQUIRED';end if;
 if not coalesce(jsonb_typeof(x)='object' and (select count(*) from jsonb_object_keys(x))=16
  and x ?& array['schema_version','policy_id','revision','state','namespace','purpose','plan_sha256','service_decision_sha256','template','origin',
   'purchase_terms','evidence_sha256','issued_at','expires_at','sha256','predecessor_policy_sha256']
  and x->>'schema_version'='tivdoc-real-service-notification-policy-v1' and x->>'namespace'='real'
  and x->>'purpose'='real_service_report_notifications' and x->>'state' in ('active','revoked')
  and x->>'template'='real-ai-report-ready-v1'
  and x->>'origin'~'^https://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?[.])*[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(:[1-9][0-9]{0,4})?/?$'
  and length(substring(x->>'origin' from '^https://([^/:]+)'))<=253
  and coalesce(substring(x->>'origin' from ':([1-9][0-9]{0,4})/?$')::integer,443) between 1 and 65535
  and x->>'sha256'~'^[a-f0-9]{64}$' and x->>'sha256'=private.real_ai_service_json_sha(x-'sha256')
  and x->>'plan_sha256'~'^[a-f0-9]{64}$' and x->>'service_decision_sha256'~'^[a-f0-9]{64}$'
  and x->>'evidence_sha256'~'^[a-f0-9]{64}$' and jsonb_typeof(x->'revision')='number'
  and x->>'issued_at'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
  and x->>'expires_at'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
  and (x->>'revision')::numeric=(x->>'revision')::integer and (x->>'revision')::integer>0
  and ((x->>'revision')::integer=1)=(x->'predecessor_policy_sha256'='null'::jsonb)
  and (x->'predecessor_policy_sha256'='null'::jsonb or x->>'predecessor_policy_sha256'~'^[a-f0-9]{64}$')
  and jsonb_typeof(x->'purchase_terms')='array' and jsonb_array_length(x->'purchase_terms') between 1 and 8
  and (x->>'issued_at')::timestamptz<(x->>'expires_at')::timestamptz,false)
  then raise exception 'REAL_NOTIFICATION_POLICY_INVALID';end if;
 perform (x->>'policy_id')::uuid;
 if x->>'predecessor_policy_sha256' is distinct from p_predecessor_sha256 then raise exception 'REAL_NOTIFICATION_POLICY_PREDECESSOR';end if;
 select * into plan_row from private.real_service_activation_plans where payload_sha256=x->>'plan_sha256';
 if plan_row.plan_id is null then raise exception 'REAL_NOTIFICATION_POLICY_PLAN';end if;
 -- One lineage for an activation plan ID; a different policy UUID cannot reset it.
 -- Registration never takes case/outbox locks while holding this advisory lock.
 perform pg_advisory_xact_lock(hashtextextended('real-notification-policy:'||plan_row.plan_id::text,0));
 select * into existing from private.real_ai_service_notification_policies where payload_sha256=x->>'sha256';
 if found then
  if existing.payload<>x or existing.predecessor_sha256 is distinct from p_predecessor_sha256 then raise exception 'REAL_NOTIFICATION_POLICY_RETRY';end if;
  return existing.payload_sha256;
 end if;
 select * into prior from private.real_ai_service_notification_policies where activation_plan_id=plan_row.plan_id order by revision desc limit 1;
 if prior.payload_sha256 is distinct from p_predecessor_sha256 or (x->>'revision')::integer<>coalesce(prior.revision,0)+1
  or (prior.policy_id is not null and prior.policy_id<>(x->>'policy_id')::uuid)
  or exists(select 1 from private.real_ai_service_notification_policies n where n.policy_id=(x->>'policy_id')::uuid and n.activation_plan_id<>plan_row.plan_id)
  then raise exception 'REAL_NOTIFICATION_POLICY_SUPERSEDED';end if;
 if prior.payload->>'state'='revoked' then raise exception 'REAL_NOTIFICATION_POLICY_NO_RESURRECTION';end if;
 select payload into decision from private.real_ai_service_decisions where payload_sha256=plan_row.decision_sha256;
 if x->>'service_decision_sha256' is distinct from plan_row.decision_sha256
  or plan_row.payload->>'database_name' is distinct from current_database()
  or plan_row.payload->>'namespace' is distinct from 'real' or decision->>'namespace' is distinct from 'real'
  or not exists(select 1 from private.real_ai_service_evidence_artifacts where sha256=x->>'evidence_sha256')
  then raise exception 'REAL_NOTIFICATION_POLICY_EVIDENCE';end if;
 if (select count(distinct t->>'version') from jsonb_array_elements(x->'purchase_terms') t)<>jsonb_array_length(x->'purchase_terms')
  then raise exception 'REAL_NOTIFICATION_POLICY_DUPLICATE_TERMS';end if;
 for term in select value from jsonb_array_elements(x->'purchase_terms') loop
  if not coalesce(jsonb_typeof(term)='object' and (select count(*) from jsonb_object_keys(term))=2
   and jsonb_typeof(term->'version')='string' and length(term->>'version') between 4 and 40
   and term->>'evidence_sha256'~'^[a-f0-9]{64}$' and plan_row.payload#>'{purchase,terms_versions}' ? (term->>'version')
   and exists(select 1 from private.real_ai_service_evidence_artifacts where sha256=term->>'evidence_sha256'),false)
   then raise exception 'REAL_NOTIFICATION_POLICY_TERMS';end if;
 end loop;
 at_time:=clock_timestamp();
 if x->>'state'='active' then
  if plan_row.payload->>'state' is distinct from 'active' or decision->>'status' is distinct from 'active'
   or plan_row.revision<>(select max(n.revision) from private.real_service_activation_plans n where n.plan_id=plan_row.plan_id)
   or (x->>'issued_at')::timestamptz>at_time or (x->>'issued_at')::timestamptz<greatest((plan_row.payload->>'issued_at')::timestamptz,(decision->>'issued_at')::timestamptz)
   or (x->>'expires_at')::timestamptz<=at_time or (x->>'expires_at')::timestamptz>least((plan_row.payload->>'expires_at')::timestamptz,(decision->>'expires_at')::timestamptz)
   or (prior.plan_sha256 is not null and prior.plan_sha256<>plan_row.payload_sha256 and prior.plan_sha256 is distinct from plan_row.predecessor_sha256)
   then raise exception 'REAL_NOTIFICATION_POLICY_WINDOW_SCOPE';end if;
 elsif prior.payload->>'state' is distinct from 'active'
  or prior.payload-'sha256'-'revision'-'predecessor_policy_sha256'-'state'<>x-'sha256'-'revision'-'predecessor_policy_sha256'-'state'
  then raise exception 'REAL_NOTIFICATION_POLICY_REVOKE_SCOPE';end if;
 insert into private.real_ai_service_notification_policies(payload_sha256,payload,policy_id,revision,activation_plan_id,plan_sha256,predecessor_sha256,evidence_sha256)
 values(x->>'sha256',x,(x->>'policy_id')::uuid,(x->>'revision')::integer,plan_row.plan_id,plan_row.payload_sha256,p_predecessor_sha256,x->>'evidence_sha256');
 return x->>'sha256';
end;$$;

-- Read-only common v2 currentness. p_successor_check is private to derivation:
-- it may ignore ONLY the old notification parent/policy natural expiry/head.
-- It still checks historical denial dependencies, paid evidence and live service.
-- No worker-only call here: webhook/late-event callers use this without a worker.
create function private.real_ai_service_notification_policy_parent_check(p_case uuid,p_identity uuid,p_authorization text,p_successor_check boolean default false) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare current_binding private.real_service_activation_enrollments;current_event private.real_ai_service_enrollment_events;
 parent_row private.real_ai_service_notification_authorizations;history_row private.real_ai_service_notification_authorizations;
 policy_row private.real_ai_service_notification_policies;plan_row private.real_service_activation_plans;
 old_event private.real_ai_service_enrollment_events;order_row private.product_orders;identity_row public.case_identities;case_row public.cases;
 head private.case_input_heads;paid jsonb;source jsonb;revocations jsonb;targets text[]:='{}';at_time timestamptz:=clock_timestamp();begin
 select * into parent_row from private.real_ai_service_notification_authorizations where case_id=p_case and identity_id=p_identity and payload_sha256=p_authorization;
 if parent_row.authorization_id is null then return jsonb_build_object('state','not_authorized','reason','not_authorized');end if;
 select * into current_binding from private.real_service_activation_enrollments where case_id=p_case order by sequence desc limit 1;
 select * into current_event from private.real_ai_service_enrollment_events where case_id=p_case order by sequence desc limit 1;
 if current_binding.event_id is null or current_event.event_id is distinct from current_binding.event_id or current_event.identity_id is distinct from p_identity
  or current_event.kind is distinct from 'granted' or not private.real_service_activation_parent_current(p_case)
  then return jsonb_build_object('state','not_authorized','reason','revoked');end if;
 if current_event.issued_at>at_time or current_event.expires_at<=at_time then return jsonb_build_object('state','not_authorized','reason','expired');end if;
 select * into identity_row from public.case_identities where id=p_identity;select * into case_row from public.cases where id=p_case;
 if case_row.is_qa is distinct from false or case_row.contact_verified_at is null or not exists(select 1 from public.case_identity_cases where case_id=p_case and identity_id=p_identity)
  then return jsonb_build_object('state','not_authorized','reason','contact_changed');end if;
 if case_row.reminder_opted_out_at is not null or exists(select 1 from private.case_notification_suppression where recipient_sha256=identity_row.contact_hash)
  then return jsonb_build_object('state','not_authorized','reason','opted_out');end if;
 select * into head from private.case_input_heads where case_id=p_case;
 paid:=private.real_ai_service_paid_scope(p_case,head.revision,head.input_sha256);
 if paid is distinct from current_event.purchased_scope then return jsonb_build_object('state','not_authorized','reason','revoked');end if;
 -- Every automatic ancestor remains a denial dependency after explicit renewal.
 -- Manual history cannot become an automatic lineage, including via operator RPC.
 for history_row in select * from private.real_ai_service_notification_authorizations
  where case_id=p_case and identity_id=p_identity and sequence<=parent_row.sequence order by sequence loop
  source:=history_row.payload->'authorization_source';
  if history_row.payload->>'schema_version' is distinct from 'tivdoc-real-ai-service-notification-authorization-v2'
   or history_row.payload->>'state' is distinct from 'active' or source->>'kind' is distinct from 'registered_transactional_policy'
   or (history_row.payload->>'issued_at')::timestamptz>at_time
   then return jsonb_build_object('state','not_authorized','reason','revoked');end if;
  if identity_row.channel is distinct from 'email' or identity_row.contact_hash is distinct from history_row.payload->>'recipient_sha256'
   or identity_row.contact_hash is distinct from encode(sha256(convert_to('email|'||lower(btrim(identity_row.contact_normalized)),'UTF8')),'hex')
   or case_row.contact_verified_at is distinct from (source->>'contact_verified_at')::timestamptz
   then return jsonb_build_object('state','not_authorized','reason','contact_changed');end if;
  select * into policy_row from private.real_ai_service_notification_policies where payload_sha256=source->>'policy_sha256';
  select * into plan_row from private.real_service_activation_plans where payload_sha256=policy_row.plan_sha256;
  select * into old_event from private.real_ai_service_enrollment_events where event_id=(source->>'enrollment_id')::uuid and case_id=p_case;
  if policy_row.payload_sha256 is null or policy_row.payload->>'state' is distinct from 'active'
   or old_event.kind is distinct from 'granted' or old_event.identity_id is distinct from p_identity or old_event.expires_at<=at_time
   or old_event.service_decision_sha256 is distinct from history_row.payload->>'service_decision_sha256'
   or policy_row.payload->>'service_decision_sha256' is distinct from old_event.service_decision_sha256
   or policy_row.evidence_sha256 is distinct from source->>'evidence_sha256'
   or history_row.payload->>'origin' is distinct from policy_row.payload->>'origin'
   or not exists(select 1 from private.real_ai_service_evidence_artifacts where sha256=policy_row.evidence_sha256)
   or exists(select 1 from private.real_ai_service_notification_policies n where n.activation_plan_id=policy_row.activation_plan_id and n.payload->>'state'='revoked')
   then return jsonb_build_object('state','not_authorized','reason','revoked');end if;
  -- A pinned enrollment must be in the actual immutable predecessor chain.
  if not exists(with recursive chain as (
   select b.* from private.real_service_activation_enrollments b where b.event_id=current_binding.event_id and b.case_id=p_case
   union all select b.* from private.real_service_activation_enrollments b join chain n on n.predecessor_event_id=b.event_id where b.case_id=p_case and b.sequence<n.sequence
  ) select 1 from chain where event_id=old_event.event_id and plan_sha256=policy_row.plan_sha256)
   then return jsonb_build_object('state','not_authorized','reason','revoked');end if;
  select * into order_row from private.product_orders where case_id=p_case and id=(source->>'order_id')::uuid;
  if order_row.offer_sha256 is distinct from source->>'order_offer_sha256' or order_row.terms_version is distinct from source->>'terms_version'
   or order_row.terms_accepted_at is distinct from (source->>'terms_accepted_at')::timestamptz
   or order_row.terms_accepted_at is null or order_row.verified_at is null or order_row.terms_accepted_at>order_row.verified_at
   or order_row.terms_accepted_at>at_time or order_row.refund_state<>'none'
   or not exists(select 1 from public.payments payment_row where payment_row.order_id=order_row.id and payment_row.case_id=p_case
    and payment_row.status='verified' and payment_row.verified_at>=order_row.terms_accepted_at)
   or not exists(select 1 from jsonb_array_elements(paid) s where s->>'id'=order_row.id::text and s->>'offer_sha256'=order_row.offer_sha256)
   or not exists(select 1 from jsonb_array_elements(policy_row.payload->'purchase_terms') t where t->>'version'=order_row.terms_version and t->>'evidence_sha256'=source->>'terms_evidence_sha256')
   or not exists(select 1 from private.real_ai_service_evidence_artifacts where sha256=source->>'terms_evidence_sha256')
   then return jsonb_build_object('state','not_authorized','reason','not_authorized');end if;
  targets:=targets||array[history_row.payload_sha256,policy_row.payload_sha256,policy_row.evidence_sha256,source->>'terms_evidence_sha256',
   identity_row.contact_hash,order_row.offer_sha256,plan_row.payload_sha256,plan_row.payload->>'machine_issuer_sha256',plan_row.payload->>'provider_budget_policy_sha256',plan_row.payload->>'activation_evidence_sha256'];
  targets:=targets||array(select t.sha256 from private.ai_release_configurations c join private.real_ai_service_decisions d on d.configuration_sha256=c.payload_sha256,
   lateral private.real_ai_service_dependency_targets(c.payload,d.payload) t where c.payload_sha256=old_event.configuration_sha256 and d.payload_sha256=old_event.service_decision_sha256);
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object('target_sha256',r.target_sha256,'effective_at',r.effective_at) order by r.id),'[]'::jsonb) into revocations
  from private.real_ai_service_revocations r where r.case_id=p_case and r.target_sha256=any(targets);
 if exists(select 1 from jsonb_array_elements(revocations) r where (r->>'effective_at')::timestamptz<=at_time)
  then return jsonb_build_object('state','not_authorized','reason','revoked');end if;
 -- Re-read this parent policy: the loop deliberately covered all ancestors.
 select * into policy_row from private.real_ai_service_notification_policies where payload_sha256=parent_row.payload#>>'{authorization_source,policy_sha256}';
 if not p_successor_check then
  if policy_row.plan_sha256 is distinct from current_binding.plan_sha256 or parent_row.payload->>'service_decision_sha256' is distinct from current_event.service_decision_sha256
   or policy_row.revision<>(select max(n.revision) from private.real_ai_service_notification_policies n where n.activation_plan_id=policy_row.activation_plan_id)
   then return jsonb_build_object('state','not_authorized','reason','revoked');end if;
  if (parent_row.payload->>'expires_at')::timestamptz<=at_time or (policy_row.payload->>'issued_at')::timestamptz>at_time
   or (policy_row.payload->>'expires_at')::timestamptz<=at_time
   then return jsonb_build_object('state','not_authorized','reason','expired');end if;
 end if;
 return jsonb_build_object('state','authorized','authorization',parent_row.payload,'revocations',revocations);
end;$$;

-- Preserve v1 bytes under a private name, and retain the ORIGINAL material OID
-- for every existing SQL/PLpgSQL dependency by replacing rather than renaming it.
do $preserve_manual$ declare body text;needle text;begin
 if to_regprocedure('private.real_ai_service_notification_manual_parent_material_v1(uuid,uuid,text,text)') is not null
  then raise exception 'REAL_NOTIFICATION_POLICY_MANUAL_COPY_EXISTS';end if;
 body:=pg_get_functiondef('private.real_ai_service_notification_parent_material(uuid,uuid,text,text)'::regprocedure);
 needle:='FUNCTION private.real_ai_service_notification_parent_material(';
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then raise exception 'REAL_NOTIFICATION_POLICY_MANUAL_COPY_MISSING';end if;
 execute replace(body,needle,'FUNCTION private.real_ai_service_notification_manual_parent_material_v1(');
end;$preserve_manual$;
create or replace function private.real_ai_service_notification_parent_material(p_case uuid,p_identity uuid,p_decision text,p_expected text default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare a private.real_ai_service_notification_authorizations;begin
 select * into a from private.real_ai_service_notification_authorizations where case_id=p_case and identity_id=p_identity order by sequence desc limit 1;
 if a.payload->>'schema_version'='tivdoc-real-ai-service-notification-authorization-v2' then
  if (p_expected is not null and p_expected is distinct from a.payload_sha256) or a.payload->>'service_decision_sha256' is distinct from p_decision
   then return jsonb_build_object('state','not_authorized','reason','revoked');end if;
  return private.real_ai_service_notification_policy_parent_check(p_case,p_identity,a.payload_sha256,false);
 end if;
 return private.real_ai_service_notification_manual_parent_material_v1(p_case,p_identity,p_decision,p_expected);
end;$$;

-- Called only from prepare AFTER its existing-report child branch. No new RPC.
create function private.real_ai_service_notification_policy_parent_prepare(p_case uuid,p_identity uuid,p_report uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare d jsonb;ctx jsonb;current_parent jsonb;checked jsonb;prior private.real_ai_service_notification_authorizations;
 binding private.real_service_activation_enrollments;plan_row private.real_service_activation_plans;policy_row private.real_ai_service_notification_policies;
 identity_row public.case_identities;case_row public.cases;order_row private.product_orders;term jsonb;source jsonb;body jsonb;
 revocations jsonb;until_time timestamptz;at_time timestamptz;parent_sha text;targets text[];begin
 perform private.real_ai_service_assert_worker(p_case);
 d:=private.real_ai_service_delivery_material(p_case,p_identity,p_report);
 if d->>'state' is distinct from 'configured' or d->'publication'='null'::jsonb then return jsonb_build_object('state','not_authorized','reason','not_authorized');end if;
 perform 1 from public.case_identities where id=p_identity for share;
 -- Defense in depth: even internal invocation cannot renew an existing child.
 if exists(select 1 from private.real_ai_service_notification_grants where case_id=p_case and identity_id=p_identity and report_id=p_report)
  then return private.real_ai_service_notification_parent_material(p_case,p_identity,d#>>'{service_decision,sha256}');end if;
 select * into prior from private.real_ai_service_notification_authorizations where case_id=p_case and identity_id=p_identity order by sequence desc limit 1;
 current_parent:=private.real_ai_service_notification_parent_material(p_case,p_identity,d#>>'{service_decision,sha256}');
 if prior.authorization_id is not null and (prior.payload->>'schema_version'<>'tivdoc-real-ai-service-notification-authorization-v2' or current_parent->>'state'='authorized')
  then return current_parent;end if;
 select * into binding from private.real_service_activation_enrollments where case_id=p_case order by sequence desc limit 1;
 select * into plan_row from private.real_service_activation_plans where payload_sha256=binding.plan_sha256;
 if binding.event_id is null or plan_row.plan_id is null then return jsonb_build_object('state','not_authorized','reason','not_authorized');end if;
 ctx:=private.real_service_activation_worker_context(p_case,binding.plan_sha256,plan_row.payload->>'build_manifest_sha256');
 if ctx->>'state' is distinct from 'authorized' or ctx->>'identity_id' is distinct from p_identity::text
  or ctx->>'enrollment_id' is distinct from binding.event_id::text or ctx#>>'{plan,service_decision_sha256}' is distinct from d#>>'{service_decision,sha256}'
  then return jsonb_build_object('state','not_authorized','reason','revoked');end if;
 -- Shared policy lock matches registration; no writer takes case/outbox locks.
 perform pg_advisory_xact_lock_shared(hashtextextended('real-notification-policy:'||plan_row.plan_id::text,0));
 select * into policy_row from private.real_ai_service_notification_policies where activation_plan_id=plan_row.plan_id order by revision desc limit 1;
 if policy_row.payload_sha256 is null then return jsonb_build_object('state','not_authorized','reason','not_authorized');end if;
 if policy_row.payload->>'state' is distinct from 'active' or policy_row.plan_sha256 is distinct from binding.plan_sha256
  or policy_row.payload->>'service_decision_sha256' is distinct from d#>>'{service_decision,sha256}'
  then return jsonb_build_object('state','not_authorized','reason','revoked');end if;
 at_time:=clock_timestamp();
 if (ctx->>'expires_at')::timestamptz<=at_time or (policy_row.payload->>'issued_at')::timestamptz>at_time or (policy_row.payload->>'expires_at')::timestamptz<=at_time
  then return jsonb_build_object('state','not_authorized','reason','expired');end if;
 checked:=jsonb_build_object('revocations','[]'::jsonb);
 if prior.authorization_id is not null then
  if prior.payload->>'state' is distinct from 'active' or policy_row.predecessor_sha256 is distinct from prior.payload#>>'{authorization_source,policy_sha256}'
   then return current_parent;end if;
  checked:=private.real_ai_service_notification_policy_parent_check(p_case,p_identity,prior.payload_sha256,true);
  if checked->>'state' is distinct from 'authorized' then return checked;end if;
 end if;
 -- The qualifying order is the actual published analysis order, not a caller hint.
 select * into order_row from private.product_orders where case_id=p_case and id::text=d#>>'{current,assessment,scope,order_id}';
 select * into identity_row from public.case_identities where id=p_identity;select * into case_row from public.cases where id=p_case;
 select t into term from jsonb_array_elements(policy_row.payload->'purchase_terms') t where t->>'version'=order_row.terms_version;
 if order_row.id is null or order_row.offer->>'version' is distinct from 'tivdoc-order-offer-v3'
  or order_row.offer->>'purchase_topics_version' is distinct from 'tivdoc-purchase-topics-v2'
  or order_row.offer_sha256 is distinct from d#>>'{current,assessment,scope,order_receipt_sha256}'
  or order_row.state<>'paid' or order_row.refund_state<>'none' or order_row.terms_accepted_at is null or order_row.verified_at is null
  or order_row.terms_accepted_at>order_row.verified_at or order_row.terms_accepted_at>at_time or term is null
  or not exists(select 1 from public.payments payment_row where payment_row.order_id=order_row.id and payment_row.case_id=p_case
   and payment_row.status='verified' and payment_row.verified_at>=order_row.terms_accepted_at)
  or not exists(select 1 from private.real_ai_service_evidence_artifacts where sha256=term->>'evidence_sha256')
  or not exists(select 1 from private.real_ai_service_evidence_artifacts where sha256=policy_row.evidence_sha256)
  then return jsonb_build_object('state','not_authorized','reason','not_authorized');end if;
 if case_row.contact_verified_at is null or case_row.contact_verified_at>at_time or identity_row.channel is distinct from 'email'
  or identity_row.contact_hash is distinct from encode(sha256(convert_to('email|'||lower(btrim(identity_row.contact_normalized)),'UTF8')),'hex')
  or not exists(select 1 from public.case_identity_cases where case_id=p_case and identity_id=p_identity)
  then return jsonb_build_object('state','not_authorized','reason','contact_changed');end if;
 if case_row.reminder_opted_out_at is not null or exists(select 1 from private.case_notification_suppression where recipient_sha256=identity_row.contact_hash)
  then return jsonb_build_object('state','not_authorized','reason','opted_out');end if;
 targets:=array[policy_row.payload_sha256,policy_row.evidence_sha256,term->>'evidence_sha256',identity_row.contact_hash,order_row.offer_sha256];
 select coalesce(jsonb_agg(jsonb_build_object('target_sha256',r.target_sha256,'effective_at',r.effective_at) order by r.id),'[]'::jsonb) into revocations
  from private.real_ai_service_revocations r where r.case_id=p_case and r.target_sha256=any(targets);
 revocations:=revocations||(checked->'revocations');
 if exists(select 1 from jsonb_array_elements(revocations) r where (r->>'effective_at')::timestamptz<=at_time)
  then return jsonb_build_object('state','not_authorized','reason','revoked');end if;
 select least((policy_row.payload->>'expires_at')::timestamptz,(ctx->>'expires_at')::timestamptz,(d->>'enrollment_expires_at')::timestamptz,
  min((r->>'effective_at')::timestamptz)) into until_time from jsonb_array_elements(revocations) r;
 if until_time<=at_time then return jsonb_build_object('state','not_authorized','reason','expired');end if;
 source:=jsonb_build_object('kind','registered_transactional_policy','policy_sha256',policy_row.payload_sha256,'evidence_sha256',policy_row.evidence_sha256,
  'enrollment_id',binding.event_id,'order_id',order_row.id,'order_offer_sha256',order_row.offer_sha256,'terms_version',order_row.terms_version,
  'terms_evidence_sha256',term->>'evidence_sha256','terms_accepted_at',to_char(order_row.terms_accepted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'contact_verified_at',to_char(case_row.contact_verified_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 body:=jsonb_build_object('schema_version','tivdoc-real-ai-service-notification-authorization-v2','authorization_id',gen_random_uuid(),'state','active','namespace','real',
  'purpose','real_service_report_notifications','scope','current_real_reports','case_id',p_case,'identity_id',p_identity,
  'service_decision_sha256',policy_row.payload->>'service_decision_sha256','recipient_sha256',identity_row.contact_hash,'origin',policy_row.payload->>'origin',
  'template','real-ai-report-ready-v1','authorization_source',source,'issued_at',to_char(at_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'expires_at',to_char(until_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 parent_sha:=private.real_ai_service_json_sha(body);
 -- Existing case lock serializes first insert and predecessor CAS. No old rows updated.
 insert into private.real_ai_service_notification_authorizations(authorization_id,payload_sha256,payload,case_id,identity_id,sequence,predecessor_sha256,evidence_sha256)
 values((body->>'authorization_id')::uuid,parent_sha,body||jsonb_build_object('sha256',parent_sha),p_case,p_identity,coalesce(prior.sequence,0)+1,prior.payload_sha256,policy_row.evidence_sha256);
 current_parent:=private.real_ai_service_notification_parent_material(p_case,p_identity,d#>>'{service_decision,sha256}',parent_sha);
 if current_parent->>'state' is distinct from 'authorized' then raise exception 'REAL_NOTIFICATION_POLICY_PARENT_CHANGED';end if;
 return current_parent;
end;$$;

-- Hook exact installed prepare after its existing-child branch. SQL202 stays
-- immutable. Fail closed if actual body no longer has exactly this call site.
do $prepare_hook$ declare body text;needle text;begin
 body:=pg_get_functiondef('private.real_ai_service_notification_prepare(uuid,uuid,uuid)'::regprocedure);
 needle:=$needle$p:=private.real_ai_service_notification_parent_material(p_case,p_identity,d#>>'{service_decision,sha256}');$needle$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 or position('-- Existing history wins forever:' in body)=0
  then raise exception 'REAL_NOTIFICATION_POLICY_PREPARE_HOOK_MISSING';end if;
 execute replace(body,needle,'p:=private.real_ai_service_notification_policy_parent_prepare(p_case,p_identity,p_report);');
end;$prepare_hook$;

-- Supported manual recorder may neither adopt nor overwrite an automatic lineage.
do $manual_guard$ declare body text;needle text;begin
 body:=pg_get_functiondef('private.real_ai_service_notification_authorization_record(jsonb,text)'::regprocedure);
 needle:=$needle$if prior.payload_sha256 is distinct from p_predecessor_sha256 then raise exception 'REAL_SERVICE_NOTIFICATION_AUTHORIZATION_SUPERSEDED';end if;$needle$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then raise exception 'REAL_NOTIFICATION_POLICY_MANUAL_HOOK_MISSING';end if;
 execute replace(body,needle,needle||E'\n if prior.payload->>''schema_version''=''tivdoc-real-ai-service-notification-authorization-v2'' then raise exception ''REAL_NOTIFICATION_POLICY_MANUAL_CONVERSION_FORBIDDEN'';end if;');
end;$manual_guard$;

revoke all on function private.real_ai_service_notification_policy_register(jsonb,text),
 private.real_ai_service_notification_policy_parent_check(uuid,uuid,text,boolean),
 private.real_ai_service_notification_policy_parent_prepare(uuid,uuid,uuid),
 private.real_ai_service_notification_parent_material(uuid,uuid,text,text),
 private.real_ai_service_notification_manual_parent_material_v1(uuid,uuid,text,text)
 from public,anon,authenticated,service_role,tivdoc_identity_runtime,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.real_ai_service_notification_policy_register(jsonb,text) to tivdoc_dev_migrator;

-- Required root validation before migration acceptance:
-- 1. SQL202 prepare/manual body anchors, schema/column resolution, all new ACLs.
-- 2. Strict16/16/10 parser parity and canonical hashes; no existing terms mapping.
-- 3. Genuine current paid/report/plan/worker -> one v2 parent and unchanged child;
--    exact retry, current manual child without parent, current manual parent preserved.
-- 4. Missing/foreign/unpaid/refunded/changed offer or terms/unverified contact/QA
--    denied; absent policy is ordinary skip, malformed trusted rows are errors.
-- 5. Queue then revoke policy/head/evidence/terms evidence/recipient; expiry,
--    contact replacement/reverification and opt-out refuse claim/dispatch; late
--    callbacks retain transport evidence but cannot revive send/delivered state.
-- 6. Existing expired/revoked child terminal; manual parent never auto converted.
--    Same-policy retry never renews. Explicit direct policy successor/new report
--    may create a new parent ONLY within independently live service authority;
--    old effective/future revocations survive, old enrollment expiry is terminal.
-- 7. Concurrent first prepare / policy CAS; preserve case->identity->outbox order;
--    late material takes no new locks. Existing provider calls remain outside DB.
