-- One identified source-link question per contractual clause. No legal
-- allocation, classification or entitlement is granted by a customer answer.
-- Prior field targets and journals retain their versioned readers.
create function private.obligation_payment_pair_current(target_case uuid,t jsonb,p jsonb) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare v jsonb;deps jsonb;expected_deps jsonb;src jsonb;d public.documents;
begin
 if t->>'schema_version' is distinct from 'obligation-payment-choice-v1'
  or t->>'case_id' is distinct from target_case::text or p->>'case_id' is distinct from target_case::text
  or t->>'target_sha256' is distinct from private.source_intake_journal_sha(t-'target_sha256')
  or p->>'schema_version' is distinct from 'obligation-payment-link-v1'
  or p->>'target_sha256' is distinct from private.source_intake_journal_sha(p-'target_sha256')
  or not coalesce(t->'candidates' @> jsonb_build_array(p),false)
  or p->>'month' is distinct from t->>'month' or t->>'month' !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  or p#>>'{amount,source,version_id}' is distinct from p->>'version_id'
  or p#>>'{amount,source,file_sha256}' is distinct from p->>'source_sha256'
  or p#>>'{amount,source,reading}' is distinct from 'identified_document_reading'
  or p#>>'{clause,source,reading}' is distinct from 'identified_document_reading'
  or p#>>'{amount,state}' is distinct from 'observed' or p#>>'{amount,representation}' is distinct from 'money_ils'
  or not coalesce(t->'purchased_topics' ?| array['contract','bonuses'],false)
  or not private.document_review_paid_scope_current(target_case,(t->>'order_id')::uuid,t->>'order_origin',t->>'order_receipt_sha256',t->'purchased_topics',to_date(t->>'month','YYYY-MM')) then return false;end if;
 select x.input into v from private.case_input_heads h join private.case_input_versions x
  on x.case_id=h.case_id and x.revision=h.revision and x.input_sha256=h.input_sha256 where h.case_id=target_case;
 if v is null then return false;end if;
 if not exists(select 1 from jsonb_array_elements(case when t->>'order_origin'='saved_order' then v->'orders' else v->'legacy_orders' end) o
  where o->>'id'=t->>'order_id' and coalesce(o->>'offer_sha256',o->>'receipt_sha256')=t->>'order_receipt_sha256'
   and o->'topics'=t->'purchased_topics') then return false;end if;
 foreach src in array array[p#>'{amount,source}',p#>'{clause,source}'] loop
  select x.* into d from public.documents x where x.case_id=target_case and x.version_id::text=src->>'version_id'
   and (x.id::text=src->>'document_id' or x.version_id::text=src->>'document_id') and x.content_sha256=src->>'file_sha256'
   and exists(select 1 from jsonb_array_elements(v->'documents') pin where pin->>'id'=x.id::text
    and pin->>'version_id'=x.version_id::text and pin->>'sha256'=x.content_sha256);
  if d.id is null or (src->>'page')::integer<1 then return false;end if;
 end loop;
 if not exists(select 1 from private.case_extraction_checkpoints c where c.case_id=target_case
  and c.version_id::text=p->>'version_id' and c.input_sha256=p->>'source_sha256' and c.policy_version=p->>'policy_version'
  and c.result_sha256=p->>'checkpoint_sha256' and c.result->>'product_document_id'=p->>'product_document_id'
  and c.result->>'expected_month'=t->>'month' and c.result->>'case_id'=target_case::text
  and private.source_intake_journal_sha(c.result#>'{run,result}')=c.result_sha256) then return false;end if;
 -- The complete current identified-reading set for these two sources is
 -- compared, including newly added readings. Own link answers are excluded.
 select coalesce(jsonb_agg(jsonb_build_object('version_id',a#>>'{field_target,version_id}','request_id',a->>'id',
  'answer_revision',a->'answer_revision','answer_sha256',private.source_intake_journal_sha(to_jsonb(a->>'answer'))) order by a->>'id'),'[]'::jsonb)
 into deps from jsonb_array_elements(v->'answers') a where a->>'code' like 'document_field:%'
  and a#>>'{field_target,version_id}' in (p->>'version_id',p#>>'{clause,source,version_id}')
  and a#>>'{field_target,schema_version}' not in ('obligation-payment-choice-v1','obligation-payment-link-v1');
 select coalesce(jsonb_agg(x order by x->>'request_id'),'[]'::jsonb) into expected_deps from jsonb_array_elements(t->'reading_dependencies') x
  where x->>'version_id' in (p->>'version_id',p#>>'{clause,source,version_id}');
 return deps=expected_deps;
exception when invalid_text_representation or invalid_parameter_value or datetime_field_overflow or numeric_value_out_of_range then return false;
end;$$;
revoke all on function private.obligation_payment_pair_current(uuid,jsonb,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

create function private.obligation_payment_target_current(target_case uuid,t jsonb) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_typeof(t->'candidates')='array' and jsonb_array_length(t->'candidates') between 1 and 16
  and exists(select 1 from jsonb_array_elements(t->'candidates') p where private.obligation_payment_pair_current(target_case,t,p)),false);
$$;
revoke all on function private.obligation_payment_target_current(uuid,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

create function private.obligation_payment_answer_valid(target_case uuid,t jsonb,answer_text text) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare a jsonb;p jsonb;b jsonb;
begin
 if answer_text is null or length(answer_text)>2000 then return false;end if;a:=answer_text::jsonb;
 if a->>'action' in ('unknown','unreadable') then return a=jsonb_build_object('action',a->>'action') and private.obligation_payment_target_current(target_case,t);end if;
 if a->>'action' is distinct from 'correct' or (select count(*) from jsonb_object_keys(a))<>3 then return false;end if;
 select x into p from jsonb_array_elements(t->'candidates') x where x->>'target_sha256'=a->>'candidate_target_sha256';
 if p is null or not private.obligation_payment_pair_current(target_case,t,p) then return false;end if;b:=a#>'{value,basis}';
 return coalesce((select count(*) from jsonb_object_keys(a->'value'))=2 and a#>>'{value,relationship}' in ('same_obligation','different_obligation')
  and (select count(*) from jsonb_object_keys(b))=3 and b->'page'=p#>'{amount,source,page}'
  and jsonb_typeof(b->'locator')='string' and char_length(b->>'locator') between 1 and 120 and b->>'locator'=btrim(b->>'locator')
  and jsonb_typeof(b->'text')='string' and char_length(b->>'text') between 1 and 160 and b->>'text'=btrim(b->>'text'),false);
exception when invalid_text_representation or invalid_parameter_value then return false;
end;$$;
revoke all on function private.obligation_payment_answer_valid(uuid,jsonb,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

do $upgrade$
declare b text;anchor text;
begin
 if to_regprocedure('private.document_field_current_before_obligation_v1(uuid,jsonb)') is not null then raise exception 'OBLIGATION_ALREADY_INSTALLED';end if;
 b:=pg_get_functiondef('private.document_field_current(uuid,jsonb)'::regprocedure);
 execute replace(b,'FUNCTION private.document_field_current(','FUNCTION private.document_field_current_before_obligation_v1(');
 b:=pg_get_functiondef('private.document_field_request_open(uuid,integer,text,jsonb,text)'::regprocedure);
 execute replace(b,'FUNCTION private.document_field_request_open(','FUNCTION private.document_field_request_open_before_obligation_v1(');
 b:=pg_get_functiondef('private.document_field_request_answer_valid(uuid,uuid,text)'::regprocedure);
 execute replace(b,'FUNCTION private.document_field_request_answer_valid(','FUNCTION private.document_field_request_answer_valid_before_obligation_v1(');
 select pg_get_constraintdef(oid) into b from pg_constraint where conrelid='private.document_field_targets'::regclass and conname='document_field_targets_check';
 anchor:='''document-source-period-intake-v1''::text';
 if position(anchor in b)=0 then raise exception 'OBLIGATION_TARGET_CHECK_BASE';end if;
 alter table private.document_field_targets drop constraint document_field_targets_check;
 execute 'alter table private.document_field_targets add constraint document_field_targets_check '||replace(b,anchor,anchor||', ''obligation-payment-choice-v1''::text');
 b:=pg_get_functiondef('private.guard_document_cell_decision()'::regprocedure);
 anchor:='case when t->>''schema_version''=''document-source-period-intake-v1''';
 if position(anchor in b)=0 then raise exception 'OBLIGATION_ANSWER_GUARD_BASE';end if;
 execute replace(b,anchor,'case when t->>''schema_version''=''obligation-payment-choice-v1'' then private.obligation_payment_answer_valid(r.case_id,t,answer) when t->>''schema_version''=''document-source-period-intake-v1''');
end;$upgrade$;
revoke all on function private.document_field_current_before_obligation_v1(uuid,jsonb),private.document_field_request_open_before_obligation_v1(uuid,integer,text,jsonb,text),private.document_field_request_answer_valid_before_obligation_v1(uuid,uuid,text)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

create or replace function private.document_field_current(target_case uuid,target jsonb) returns boolean
language sql security definer set search_path='' as $$
 select case when target->>'schema_version'='obligation-payment-choice-v1' then private.obligation_payment_target_current(target_case,target)
 else private.document_field_current_before_obligation_v1(target_case,target) end;
$$;
create or replace function private.document_field_request_answer_valid(target_case uuid,target_request uuid,answer text) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare t jsonb;
begin
 select target into t from private.document_field_targets where case_id=target_case and request_id=target_request;
 if t->>'schema_version'='obligation-payment-choice-v1' then return private.obligation_payment_answer_valid(target_case,t,answer);end if;
 return private.document_field_request_answer_valid_before_obligation_v1(target_case,target_request,answer);
end;$$;

create or replace function private.document_field_request_open(target_case uuid,expected_revision integer,expected_input_sha256 text,target_payload jsonb,target_question text) returns uuid
language plpgsql security definer set search_path='' as $$
declare h private.case_input_heads;r public.case_requests;next_id uuid;generation integer:=0;p jsonb;
begin
 if target_payload->>'schema_version' is distinct from 'obligation-payment-choice-v1' then
  return private.document_field_request_open_before_obligation_v1(target_case,expected_revision,expected_input_sha256,target_payload,target_question);end if;
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;if not found then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 select * into h from private.case_input_heads where case_id=target_case;
 if h.revision is distinct from expected_revision or h.input_sha256 is distinct from expected_input_sha256 then raise exception 'REQUEST_FIELD_SOURCE_CHANGED';end if;
 if not private.obligation_payment_target_current(target_case,target_payload) then raise exception 'REQUEST_FIELD_SOURCE_CHANGED';end if;
 for p in select x from jsonb_array_elements(target_payload->'candidates') x loop
  if not private.obligation_payment_pair_current(target_case,target_payload,p) or p->'clause' is distinct from target_payload#>'{candidates,0,clause}'
   or p->>'obligation_id' is distinct from target_payload#>>'{candidates,0,obligation_id}' then raise exception 'REQUEST_FIELD_TARGET_INVALID';end if;
 end loop;
 if target_question is null or char_length(target_question) not between 4 and 400 then raise exception 'REQUEST_FIELD_TARGET_INVALID';end if;
 select f.request_id,f.renewal_index into next_id,generation from public.case_requests q join private.document_field_targets f on f.request_id=q.id
  where f.case_id=target_case and f.target_sha256=target_payload->>'target_sha256' order by f.renewal_index desc limit 1;
 if next_id is not null then select * into r from public.case_requests where id=next_id for update;end if;
 if r.id is not null then
  if r.answered_at is not null or r.expired_at is null and r.expires_at>clock_timestamp() then return r.id;end if;
  update public.case_requests set expired_at=coalesce(expired_at,clock_timestamp()) where id=r.id and answered_at is null;generation:=generation+1;
 else generation:=0;end if;
 next_id:=gen_random_uuid();
 insert into private.document_field_targets(request_id,case_id,target_sha256,target,renewal_index,predecessor_request_id)
 values(next_id,target_case,target_payload->>'target_sha256',target_payload,generation,r.id);
 insert into public.case_requests(id,case_id,code,question,answer_kind,options,field_crop,blocking,expires_at)
 values(next_id,target_case,'document_field:'||(target_payload->>'target_sha256'),target_question,'choice',
  array['קיימת הפניה לאותה התחייבות','השורה מתייחסת לתשלום אחר','לא קריא','לא יודע/ת'],'obligation.payment_link',false,clock_timestamp()+interval '10 days');
 return next_id;
end;$$;

-- Explicit selected row / clause source only. Foreign and nonexistent targets
-- share NULL; no metadata nor existence leaks through an authorization error.
create function public.case_request_obligation_source(target_case uuid,target_identity uuid,target_request uuid,target_candidate text,target_linked text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t jsonb;p jsonb;s jsonb;
begin
 if target_linked not in ('payroll','clause') or not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then return null;end if;
 select target into t from private.document_field_targets where case_id=target_case and request_id=target_request;
 if t->>'schema_version' is distinct from 'obligation-payment-choice-v1' then return null;end if;
 select x into p from jsonb_array_elements(t->'candidates') x where (x->>'target_sha256'=target_candidate
  or target_candidate is null and (jsonb_array_length(t->'candidates')=1 or target_linked='clause'))
  and private.obligation_payment_pair_current(target_case,t,x) order by x->>'target_sha256' limit 1;
 if p is null or not private.obligation_payment_pair_current(target_case,t,p) then return null;end if;
 s:=case when target_linked='clause' then p#>'{clause,source}' else p#>'{amount,source}' end;
 return (select jsonb_build_object('path',d.storage_path,'mime',d.mime_type,'size',d.size,'sha256',d.content_sha256,'version',d.version_id,'page',(s->>'page')::integer)
  from public.documents d where d.case_id=target_case and d.version_id::text=s->>'version_id' and d.content_sha256=s->>'file_sha256');
end;$$;
revoke all on function public.case_request_obligation_source(uuid,uuid,uuid,text,text) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function public.case_request_obligation_source(uuid,uuid,uuid,text,text) to tivdoc_web_runtime,service_role;
