-- Follow-up to195: a clause has one current question even when the row
-- inventory changes. Original questions/answers remain immutable history.
create function private.obligation_payment_request_head(target_case uuid,t jsonb) returns uuid
language sql stable security definer set search_path='' as $$
 select x.request_id from private.document_field_targets x where x.case_id=target_case
  and x.target->>'schema_version'='obligation-payment-choice-v1'
  and x.target->>'order_id'=t->>'order_id' and x.target->>'order_receipt_sha256'=t->>'order_receipt_sha256'
  and x.target->>'month'=t->>'month' and x.target#>>'{candidates,0,obligation_id}'=t#>>'{candidates,0,obligation_id}'
 order by x.created_at desc,x.request_id desc limit 1;
$$;
revoke all on function private.obligation_payment_request_head(uuid,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

create or replace function private.obligation_payment_target_current(target_case uuid,t jsonb) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_typeof(t->'candidates')='array' and jsonb_array_length(t->'candidates') between 1 and 16
  and exists(select 1 from jsonb_array_elements(t->'candidates') p where private.obligation_payment_pair_current(target_case,t,p))
  and (not exists(select 1 from private.document_field_targets x where x.case_id=target_case and x.target_sha256=t->>'target_sha256')
   or exists(select 1 from private.document_field_targets x where x.request_id=private.obligation_payment_request_head(target_case,t)
    and x.target_sha256=t->>'target_sha256')),false);
$$;
create function private.obligation_payment_request_current(target_case uuid,target_request uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare t jsonb;a text;
begin
 select target into t from private.document_field_targets where case_id=target_case and request_id=target_request;
 if t is null or private.obligation_payment_request_head(target_case,t) is distinct from target_request
  or not private.obligation_payment_target_current(target_case,t) then return false;end if;
 select answer_text into a from private.case_request_answer_versions where request_id=target_request order by revision desc limit 1;
 if a is null then select answer_text into a from public.case_requests where case_id=target_case and id=target_request and answered_at is not null;end if;
 -- An affirmative answer refers to its SELECTED row; a surviving unrelated
 -- candidate cannot keep that answer current. Unknown invents no selection.
 return a is null or private.obligation_payment_answer_valid(target_case,t,a);
end;$$;
revoke all on function private.obligation_payment_request_current(uuid,uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

create function private.obligation_payment_request_states(target_case uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('request_id',x.request_id,'target_sha256',x.target_sha256,
  'current',private.obligation_payment_request_current(target_case,x.request_id)) order by x.request_id),'[]'::jsonb)
  from private.document_field_targets x where x.case_id=target_case and x.target->>'schema_version'='obligation-payment-choice-v1');
end;$$;
revoke all on function private.obligation_payment_request_states(uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function private.obligation_payment_request_states(uuid) to tivdoc_worker_runtime;

do $patch$
declare b text;needle text;
begin
 b:=pg_get_functiondef('private.obligation_payment_pair_current(uuid,jsonb,jsonb)'::regprocedure);
 needle:='or p#>>''{amount,source,reading}'' is distinct from ''identified_document_reading''';
 if position(needle in b)=0 then raise exception 'OBLIGATION_OBSERVED_AMOUNT_BASE';end if;
 execute replace(b,needle,'or not coalesce(p#>>''{amount,source,reading}'' in (''identified_document_reading'',''provider_extraction''),false)');
 b:=pg_get_functiondef('private.document_field_request_open(uuid,integer,text,jsonb,text)'::regprocedure);
 needle:='if not private.obligation_payment_target_current(target_case,target_payload) then';
 if position(needle in b)=0 then raise exception 'OBLIGATION_HEAD_OPEN_BASE';end if;
 b:=replace(b,needle,'if not exists(select 1 from jsonb_array_elements(target_payload->''candidates'') p where private.obligation_payment_pair_current(target_case,target_payload,p)) then');
 needle:='if r.answered_at is not null or r.expired_at is null and r.expires_at>clock_timestamp() then return r.id;end if;';
 if position(needle in b)=0 then raise exception 'OBLIGATION_HEAD_RETRY_BASE';end if;
 b:=replace(b,needle,'if private.obligation_payment_request_head(target_case,target_payload)=r.id and (r.answered_at is not null or r.expired_at is null and r.expires_at>clock_timestamp()) then return r.id;end if;');
 -- now() is the transaction start, so a waiting older transaction could
 -- otherwise appear older after acquiring the case lock. Preserve history and
 -- assign only the new target a strictly increasing timestamp under that lock.
 needle:='target,renewal_index,predecessor_request_id)';
 if position(needle in b)=0 then raise exception 'OBLIGATION_HEAD_INSERT_BASE';end if;
 b:=replace(b,needle,'target,renewal_index,predecessor_request_id,created_at)');
 needle:='target_payload,generation,r.id);';
 if position(needle in b)=0 then raise exception 'OBLIGATION_HEAD_INSERT_TIME_BASE';end if;
 execute replace(b,needle,'target_payload,generation,r.id,greatest(clock_timestamp(),(select max(f.created_at)+interval ''1 microsecond'' from private.document_field_targets f where f.case_id=target_case)));');
 b:=pg_get_functiondef('private.guard_document_cell_decision()'::regprocedure);
 needle:='if actor is null or not exists';
 if position(needle in b)=0 then raise exception 'OBLIGATION_HEAD_ANSWER_BASE';end if;
 execute replace(b,needle,E'if t->>''schema_version''=''obligation-payment-choice-v1'' and private.obligation_payment_request_head(r.case_id,t) is distinct from r.id then raise exception ''REQUEST_FIELD_SOURCE_CHANGED'';end if;\n '||needle);
 b:=pg_get_functiondef('public.case_request_field_states(uuid,uuid)'::regprocedure);
 needle:='coalesce(private.document_field_current(target_case,t.target),false)';
 if position(needle in b)=0 then raise exception 'OBLIGATION_SELECTED_STATE_BASE';end if;
 execute replace(b,needle,'case when t.target->>''schema_version''=''obligation-payment-choice-v1'' then private.obligation_payment_request_current(target_case,r.id) else '||needle||' end');
 b:=pg_get_functiondef('public.case_request_obligation_source(uuid,uuid,uuid,text,text)'::regprocedure);
 needle:='if t->>''schema_version'' is distinct from ''obligation-payment-choice-v1'' then return null;end if;';
 if position(needle in b)=0 then raise exception 'OBLIGATION_HEAD_SOURCE_BASE';end if;
 execute replace(b,needle,needle||E'\n if not private.obligation_payment_request_current(target_case,target_request) then return null;end if;');
end;$patch$;
