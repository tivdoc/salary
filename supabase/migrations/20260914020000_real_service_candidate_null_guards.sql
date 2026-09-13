-- Additive correction: nullable selector inputs cannot weaken cap2/build pins.
-- Exact installed207 definition after210 regex and212 canonical-text fix.
-- No data, grants, enrollment, provider, pricing or engine changes.
DO $candidate_nulls$
DECLARE before_definition text;after_definition text;before_acl aclitem[];after_acl aclitem[];before_owner oid;after_owner oid;
 old_fragment text:=$old$ if session_user<>'tivdoc_worker_runtime' or p_limit not between 1 and 2 or p_capability is null
  or (length(p_capability) not between 32 and 256 or p_capability!~'^[A-Za-z0-9._-]+$') then raise exception 'REAL_ACTIVATION_CONTROLLER_FORBIDDEN';end if;
 select * into control from private.real_service_activation_controllers where capability_sha256=encode(sha256(convert_to(p_capability,'UTF8')),'hex') for share;
 if control.plan_sha256 is distinct from p_plan or control.expires_at<=at_time or exists(select 1 from private.real_service_activation_controller_revocations r
  where r.capability_sha256=control.capability_sha256 and r.effective_at<=at_time) then raise exception 'REAL_ACTIVATION_CONTROLLER_FORBIDDEN';end if;
 select * into plan from private.real_service_activation_plans where payload_sha256=p_plan;p:=plan.payload;
 if p is null then raise exception 'REAL_ACTIVATION_PLAN_INVALID';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended('real-service-plan:'||plan.plan_id::text,0));
 if p->>'state'<>'active' or plan.revision<>(select max(x.revision) from private.real_service_activation_plans x where x.plan_id=plan.plan_id)
  or p->>'database_name'<>current_database() or p->>'deployment_sha256'<>control.deployment_sha256
  or p->>'build_manifest_sha256'<>p_build then raise exception 'REAL_ACTIVATION_DEPLOYMENT_CHANGED';end if;$old$;
 new_fragment text:=$new$ if session_user<>'tivdoc_worker_runtime' or p_limit is null or p_limit not between 1 and 2 or p_capability is null
  or (length(p_capability) not between 32 and 256 or p_capability!~'^[A-Za-z0-9._-]+$') then raise exception 'REAL_ACTIVATION_CONTROLLER_FORBIDDEN';end if;
 select * into control from private.real_service_activation_controllers where capability_sha256=encode(sha256(convert_to(p_capability,'UTF8')),'hex') for share;
 if control.plan_sha256 is distinct from p_plan or control.expires_at<=at_time or exists(select 1 from private.real_service_activation_controller_revocations r
  where r.capability_sha256=control.capability_sha256 and r.effective_at<=at_time) then raise exception 'REAL_ACTIVATION_CONTROLLER_FORBIDDEN';end if;
 select * into plan from private.real_service_activation_plans where payload_sha256=p_plan;p:=plan.payload;
 if p is null then raise exception 'REAL_ACTIVATION_PLAN_INVALID';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended('real-service-plan:'||plan.plan_id::text,0));
 if p->>'state'<>'active' or plan.revision<>(select max(x.revision) from private.real_service_activation_plans x where x.plan_id=plan.plan_id)
  or p->>'database_name'<>current_database() or p->>'deployment_sha256'<>control.deployment_sha256
  or p_build is null or p_build!~'^[a-f0-9]{64}$'
  or p->>'build_manifest_sha256' is distinct from p_build then raise exception 'REAL_ACTIVATION_DEPLOYMENT_CHANGED';end if;$new$;
BEGIN
 SELECT pg_get_functiondef(p.oid),p.proacl,p.proowner INTO before_definition,before_acl,before_owner
 FROM pg_proc p WHERE p.oid='private.real_service_candidates(text,text,text,jsonb,integer)'::regprocedure;
 IF encode(sha256(convert_to(before_definition,'UTF8')),'hex') IS DISTINCT FROM '1988df59a91f78a7c3fa6464c1ce66487b4b86b218e01c3a1ecab7d76addbc6d'
 OR (length(before_definition)-length(replace(before_definition,old_fragment,'')))/length(old_fragment) <> 1
 THEN RAISE EXCEPTION 'REAL_CANDIDATE_NULL_GUARD_PREIMAGE_CHANGED'; END IF;
 after_definition:=replace(before_definition,old_fragment,new_fragment);
 IF encode(sha256(convert_to(after_definition,'UTF8')),'hex') IS DISTINCT FROM 'd324a5791f5f31c75079cdba942839a5cec46f14b438544f1280948f86bd208b'
 THEN RAISE EXCEPTION 'REAL_CANDIDATE_NULL_GUARD_PATCH_CHANGED'; END IF;
 EXECUTE after_definition;
 SELECT p.proacl,p.proowner INTO after_acl,after_owner FROM pg_proc p
 WHERE p.oid='private.real_service_candidates(text,text,text,jsonb,integer)'::regprocedure;
 IF before_acl IS DISTINCT FROM after_acl OR before_owner IS DISTINCT FROM after_owner
 THEN RAISE EXCEPTION 'REAL_CANDIDATE_NULL_GUARD_ACL_CHANGED'; END IF;
END;
$candidate_nulls$;
