-- Scheduling source intake is not an executable financial month. Preserve the
-- existing DEV/QA/configuration/dispatch/capability gates and all spend limits.
create function private.legacy_source_intake_admission_ready(target_case uuid) returns boolean
language plpgsql stable security invoker set search_path='' as $$
declare paid jsonb;pinned jsonb;s jsonb;
begin
 if current_database()<>'tivdoc_release_replay_20260907' then return false;end if;
 paid:=private.legacy_paid_scopes_internal(target_case);
 if jsonb_array_length(paid) not between 1 and 12 then return false;end if;
 select v.input->'legacy_orders' into pinned from private.case_input_heads h join private.case_input_versions v
  on v.case_id=h.case_id and v.revision=h.revision and v.input_sha256=h.input_sha256 where h.case_id=target_case;
 if jsonb_typeof(pinned) is distinct from 'array' or jsonb_array_length(pinned)<>jsonb_array_length(paid) then return false;end if;
 if exists(select 1 from private.product_orders o join private.order_entitlements e on e.order_id=o.id
  where o.case_id=target_case and o.state='paid' and o.refund_state<>'refunded' and e.state='active') then return false;end if;
 for s in select * from jsonb_array_elements(paid) loop
  if s->>'case_id' is distinct from target_case::text or s->>'period_state' is distinct from 'missing'
   or s->'periods' is distinct from '[]'::jsonb
   or (select count(*) from jsonb_array_elements(pinned) p where p=s)<>1 then return false;end if;
 end loop;
 return true;
end;$$;
revoke all on function private.legacy_source_intake_admission_ready(uuid) from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

do $intake_admission$
declare b text;needle text:='return n between 1 and 12 and supported;';
begin
 b:=pg_get_functiondef('private.ai_release_managed_case_ready(uuid)'::regprocedure);
 if position(needle in b)=0 then raise exception 'SOURCE_INTAKE_ADMISSION_BASE';end if;
 execute replace(b,needle,'return n between 1 and 12 and (supported or coalesce(cardinality(months),0)=0 and private.legacy_source_intake_admission_ready(target_case));');
end;$intake_admission$;
