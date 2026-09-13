-- Actual paid/source enrollment discovery; no customer or authority records seeded.
-- authority, capability, issuer grant or customer enrollment is seeded here.
-- Existing payment_verify and source-capture triggers persist the durable work.

create function private.real_service_paid_source_selectors(p_capability text,p_plan text,p_build text,p_target jsonb,p_limit integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare controller private.real_service_activation_controllers;plan_record private.real_service_activation_plans;plan_json jsonb;
 at_time timestamptz:=clock_timestamp();items jsonb;begin
 if session_user<>'tivdoc_worker_runtime' or p_limit is null or p_limit not between 1 and 2 or p_capability is null
  or length(p_capability) not between 32 and 256 or p_capability!~'^[A-Za-z0-9._-]+$' then raise exception 'REAL_ACTIVATION_CONTROLLER_FORBIDDEN';end if;
 select * into controller from private.real_service_activation_controllers
  where capability_sha256=encode(sha256(convert_to(p_capability,'UTF8')),'hex') for share;
 if controller.capability_sha256 is null or controller.plan_sha256 is distinct from p_plan or controller.expires_at<=at_time
  or exists(select 1 from private.real_service_activation_controller_revocations r where r.capability_sha256=controller.capability_sha256 and r.effective_at<=at_time)
  then raise exception 'REAL_ACTIVATION_CONTROLLER_FORBIDDEN';end if;
 select * into plan_record from private.real_service_activation_plans where payload_sha256=p_plan;plan_json:=plan_record.payload;
 if plan_json is null then raise exception 'REAL_ACTIVATION_PLAN_INVALID';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended('real-service-plan:'||plan_record.plan_id::text,0));
 if plan_json->>'state'<>'active' or plan_record.revision<>(select max(x.revision) from private.real_service_activation_plans x where x.plan_id=plan_record.plan_id)
  or plan_json->>'database_name'<>current_database() or plan_json->>'deployment_sha256'<>controller.deployment_sha256
  or plan_json->>'build_manifest_sha256' is distinct from p_build then raise exception 'REAL_ACTIVATION_DEPLOYMENT_CHANGED';end if;
 if jsonb_typeof(p_target) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_target))<>6
  or p_target->>'database_name' is distinct from current_database() or p_target->>'database_name' is distinct from plan_json->>'database_name'
  or p_target->>'target_id' is distinct from plan_json->>'target_id' or p_target->>'environment' is distinct from plan_json->>'environment'
  or p_target->>'deployment_sha256' is distinct from plan_json->>'deployment_sha256'
  or p_target->>'machine_issuer_sha256' is distinct from plan_json->>'machine_issuer_sha256'
  or p_target->>'provider_budget_policy_sha256' is distinct from plan_json->>'provider_budget_policy_sha256' then raise exception 'REAL_ACTIVATION_DEPLOYMENT_CHANGED';end if;
 at_time:=clock_timestamp();
 if controller.expires_at<=at_time or (plan_json->>'issued_at')::timestamptz>at_time or (plan_json->>'expires_at')::timestamptz<=at_time then raise exception 'REAL_ACTIVATION_EXPIRED';end if;
 select coalesce(jsonb_agg(jsonb_build_object('case_id',selected.case_id,'identity_id',selected.identity_id,
  'source_revision',selected.revision,'source_sha256',selected.input_sha256,'plan_sha256',p_plan) order by selected.case_id),'[]'::jsonb) into items
 from (
  select ca.id case_id,identity_link.identity_id,h.revision,h.input_sha256
  from public.cases ca join private.case_input_heads h on h.case_id=ca.id
  join private.case_input_versions source on source.case_id=h.case_id and source.revision=h.revision and source.input_sha256=h.input_sha256
  left join lateral(select * from private.real_ai_service_enrollment_events x where x.case_id=ca.id order by sequence desc limit 1) prior on true
  left join lateral(select * from private.real_service_activation_enrollments x where x.case_id=ca.id order by sequence desc limit 1) binding on true
  join lateral(
   select coalesce(prior.identity_id,min(ic.identity_id::text)::uuid) identity_id
   from public.case_identity_cases ic join public.case_identities identity_record on identity_record.id=ic.identity_id
   where ic.case_id=ca.id and (prior.identity_id is null or ic.identity_id=prior.identity_id)
   having count(*)=1
  ) identity_link on true
  where ca.is_qa is false and ca.contact_verified_at is not null
   and encode(sha256(convert_to(source.input::text,'UTF8')),'hex')=h.input_sha256
   and not exists(select 1 from private.ai_release_enrollment_events qa where qa.case_id=ca.id)
   and exists(select 1 from private.product_orders initial_order join private.order_entitlements initial_entitlement on initial_entitlement.order_id=initial_order.id
    join public.payments payment on payment.order_id=initial_order.id and payment.case_id=ca.id
    where initial_order.case_id=ca.id and initial_order.kind='initial' and initial_order.state='paid' and initial_order.refund_state='none'
     and initial_entitlement.state='active' and payment.status='verified' and payment.verified_at is not null
     and initial_order.offer->>'version'='tivdoc-order-offer-v3' and initial_order.offer->>'purchase_topics_version'='tivdoc-purchase-topics-v2'
     and initial_order.terms_accepted_at is not null and plan_json#>'{purchase,terms_versions}' ? initial_order.terms_version)
   and not exists(select 1 from private.product_orders scope_order where scope_order.case_id=ca.id and scope_order.state='paid'
    and (scope_order.refund_state<>'none' or scope_order.offer->>'version' is distinct from 'tivdoc-order-offer-v3'
     or scope_order.offer->>'purchase_topics_version' is distinct from 'tivdoc-purchase-topics-v2' or scope_order.terms_accepted_at is null
     or not(plan_json#>'{purchase,terms_versions}' ? scope_order.terms_version)
     or to_char(scope_order.period_from,'YYYY-MM')<plan_json#>>'{period,from}' or to_char(scope_order.period_to,'YYYY-MM')>plan_json#>>'{period,to}'
     or not(to_jsonb(scope_order.topics)<@(plan_json->'topics'))))
   and (prior.event_id is null or (prior.kind='granted' and prior.expires_at>at_time and binding.event_id=prior.event_id and binding.plan_sha256=p_plan
    and exists(select 1 from private.product_orders full_order join private.order_entitlements full_entitlement on full_entitlement.order_id=full_order.id
     join public.payments payment on payment.order_id=full_order.id and payment.case_id=ca.id
     where full_order.case_id=ca.id and full_order.kind='full' and full_order.state='paid' and full_order.refund_state='none'
      and full_entitlement.state='active' and payment.status='verified' and payment.verified_at is not null and full_order.verified_at>prior.issued_at
      and not exists(select 1 from jsonb_array_elements(prior.purchased_scope) old_scope where old_scope->>'id'=full_order.id::text))))
  order by ca.id limit p_limit for update of ca skip locked
 ) selected;
 return items;
end;$$;

revoke all on function private.real_service_paid_source_selectors(text,text,text,jsonb,integer)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_identity_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
-- Root materialization grants only worker EXECUTE. The existing204 enrollment
-- RPC remains the sole writer, performs fresh exact source/context CAS and
-- permits initial enrollment or verified full-scope extension with no expiry
-- extension. Same-scope uploads/answers are intentionally not selectors here.

grant execute on function private.real_service_paid_source_selectors(text,text,text,jsonb,integer) to tivdoc_worker_runtime;
