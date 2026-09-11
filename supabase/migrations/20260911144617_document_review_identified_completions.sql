-- Identified document review completions; preserves all historical requests.
-- Existing factual request UI/journal/queue; no notification or publication changes.
-- Document targets stay in the report with an upload action. No new bound
-- document row is created until verified batch fulfillment is integrated.
create table private.document_review_request_targets (
 request_id uuid primary key references public.case_requests(id) deferrable initially deferred,
 case_id uuid not null references public.cases(id),
 target_sha256 text not null check(target_sha256 ~ '^[a-f0-9]{64}$'),
 target jsonb not null, dependent_check_ids jsonb not null,
 origin_analysis_run_id uuid not null references public.analysis_runs(id),
 review_result_sha256 text not null check(review_result_sha256 ~ '^[a-f0-9]{64}$'),
 order_id uuid not null references private.product_orders(id),offer_sha256 text not null,
 purchased_topics jsonb not null,created_at timestamptz not null default transaction_timestamp(),
 unique(case_id,target_sha256)
);
alter table private.document_review_request_targets enable row level security;
revoke all on private.document_review_request_targets from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger document_review_target_immutable before update or delete on private.document_review_request_targets
 for each row execute function private.reject_engine_append_only_mutation();

create function private.document_review_question(target jsonb) returns text
 language sql immutable security invoker set search_path='' as $$
 select (target->>'question')||case when target->>'answer_kind'='document' then '' else E'\nאפשר להשיב "לא יודע".' end
$$;
revoke all on function private.document_review_question(jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.document_review_answer_value(target jsonb,answer_text text) returns jsonb
 language plpgsql immutable security invoker set search_path='' as $$
declare answer text:=btrim(answer_text); kind text:=target->>'answer_kind'; value jsonb;
begin
 if answer is null or char_length(answer) not between 1 and 2000 or kind is null or kind='document' then raise exception 'REVIEW_REQUEST_ANSWER_INVALID';end if;
 if answer='לא יודע' then return jsonb_build_object('state','unknown','value',null);end if;
 if answer='יש סתירה' then return jsonb_build_object('state','conflicted','value',null);end if;
 if kind='boolean' then
  if answer not in ('כן','לא') then raise exception 'REVIEW_REQUEST_ANSWER_INVALID';end if;
  value:=to_jsonb(answer='כן');
 elsif kind='number' then
  if answer!~'^-?(0|[1-9][0-9]{0,12})([.][0-9]{1,6})?$' then raise exception 'REVIEW_REQUEST_ANSWER_INVALID';end if;
  if abs(answer::numeric)>1000000000000 then raise exception 'REVIEW_REQUEST_ANSWER_INVALID';end if;
  value:=to_jsonb(answer::numeric);
 elsif kind='choice' then
  if not coalesce(target->'options' @> jsonb_build_array(answer),false) then raise exception 'REVIEW_REQUEST_ANSWER_INVALID';end if;
  value:=to_jsonb(answer);
 elsif kind='text' then value:=to_jsonb(answer);
 else raise exception 'REVIEW_REQUEST_ANSWER_INVALID';end if;
 return jsonb_build_object('state','provided','value',value);
end;$$;
revoke all on function private.document_review_answer_value(jsonb,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.document_review_request_current(target_case uuid,target_request uuid) returns boolean
 language plpgsql stable security definer set search_path='' as $$
declare t private.document_review_request_targets;from_date date;to_date date;
begin
 select * into t from private.document_review_request_targets where case_id=target_case and request_id=target_request;
 if not found or t.target->>'case_id' is distinct from target_case::text then return false;end if;
 from_date:=(t.target#>>'{period,from}')::date;to_date:=(t.target#>>'{period,to}')::date;
 if from_date is null or to_date is null or date_trunc('month',from_date)::date<>from_date
  or (date_trunc('month',from_date)+interval '1 month - 1 day')::date<>to_date then return false;end if;
 if not exists(select 1 from private.product_orders o join private.order_entitlements e on e.order_id=o.id
  where o.id=t.order_id and o.case_id=target_case and o.state='paid' and o.refund_state<>'refunded' and e.state='active'
   and o.offer_sha256=t.offer_sha256 and to_jsonb(o.topics)=t.purchased_topics and o.period_from<=from_date and o.period_to>=from_date) then return false;end if;
 if jsonb_typeof(t.target->'source_pins') is distinct from 'array' then return false;end if;
 if exists(select 1 from jsonb_array_elements(t.target->'source_pins') p where p->>'case_id' is distinct from target_case::text
  or not exists(select 1 from public.documents d where d.case_id=target_case
   and (d.id::text=p->>'document_id' or d.version_id::text=p->>'document_id')
   and d.version_id::text=p->>'version_id' and d.content_sha256=p->>'source_sha256')) then return false;end if;
 return true;
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then return false;
end;$$;
revoke all on function private.document_review_request_current(uuid,uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.document_review_request_open(target_case uuid,expected_revision integer,expected_input_sha256 text,
 target_run text,target_hash text,expected_dependency_sha256 text default null) returns uuid
 language plpgsql security definer set search_path='' as $$
declare h private.case_input_heads; ar public.analysis_runs;saved_stage public.engine_analysis_stage_versions;
 review jsonb; req jsonb;target jsonb;prior private.document_review_request_targets;request_id uuid;question text;
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'REVIEW_REQUEST_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;if not found then raise exception 'REVIEW_REQUEST_FORBIDDEN';end if;
 select * into h from private.case_input_heads where case_id=target_case;
 if h.revision is distinct from expected_revision or h.input_sha256 is distinct from expected_input_sha256
  or not exists(select 1 from private.case_analysis_dispatch d where d.case_id=target_case and d.revision=h.revision and d.mode='draft'
   and d.authority_dependency_sha256 is not distinct from expected_dependency_sha256) then raise exception 'REVIEW_REQUEST_SOURCE_CHANGED';end if;
 select * into ar from public.analysis_runs where canonical_analysis_run_id=target_run and canonical_case_id=target_case::text
  and tenant_id='saved-case:'||target_case::text;
 if not found or ar.status not in ('running','completed') then raise exception 'REVIEW_REQUEST_STAGE_REQUIRED';end if;
 select * into saved_stage from public.engine_analysis_stage_versions s where s.analysis_run_id=ar.id and s.stage='topic_results' and s.tenant_id=ar.tenant_id and s.case_id=ar.case_id;
 if not found or saved_stage.payload_sha256 is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(saved_stage.payload),'UTF8')),'hex') then raise exception 'REVIEW_REQUEST_STAGE_HASH';end if;
 review:=saved_stage.payload#>'{bundle,document_review}';
 if review->>'schema_version' is distinct from 'document-review-product-v1' or review->>'case_id' is distinct from target_case::text
  or review->>'analysis_run_id' is distinct from target_run or review#>>'{purchased_scope,origin}' is distinct from 'saved_order'
  or review->>'input_sha256' is distinct from ar.command_payload->>'document_review_sha256'
  or ar.command_payload->>'document_snapshot_id' is distinct from 'saved-documents:'||left(review#>>'{period,from}',7)||':'||expected_input_sha256
  or review->>'result_sha256' is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(review-'result_sha256'),'UTF8')),'hex')
  then raise exception 'REVIEW_REQUEST_STAGE_SCOPE';end if;
 if (select count(*) from jsonb_array_elements(review#>'{completions,customer_requests}') r where r#>>'{target,target_sha256}'=target_hash)<>1 then raise exception 'REVIEW_REQUEST_TARGET_REQUIRED';end if;
 select r into req from jsonb_array_elements(review#>'{completions,customer_requests}') r where r#>>'{target,target_sha256}'=target_hash;
 target:=req->'target';question:=private.document_review_question(target);
 if target->>'schema_version' is distinct from 'document-review-completion-v1' or target->>'case_id' is distinct from target_case::text
  or target->'period' is distinct from review->'period' or target->>'kind' is distinct from 'factual'
  or not coalesce(target->>'answer_kind' in ('text','number','boolean','choice'),false)
  or req->>'code' is distinct from 'document_review:'||target_hash or target_hash is null
  or target_hash is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(target-'target_sha256'),'UTF8')),'hex')
  or question is null or char_length(question) not between 4 and 400
  or jsonb_typeof(req->'dependent_check_ids') is distinct from 'array' or jsonb_array_length(req->'dependent_check_ids')=0 then raise exception 'REVIEW_REQUEST_TARGET_INVALID';end if;
 if exists(select 1 from jsonb_array_elements_text(req->'dependent_check_ids') dep where not exists(
  select 1 from jsonb_array_elements((review->'checks')||(review->'coverage_gaps')) c
   where c->>'check_id'=dep and review#>'{purchased_scope,topics}' @> jsonb_build_array(c->>'topic'))) then raise exception 'REVIEW_REQUEST_DEPENDENCY_SCOPE';end if;
 -- Entire review source manifest is pinned to the same current journal on open.
 if exists(select 1 from jsonb_array_elements(review->'documents') p where p->>'case_id' is distinct from target_case::text
  or not exists(select 1 from public.documents d join private.case_input_versions v on v.case_id=d.case_id and v.revision=expected_revision
   cross join lateral jsonb_array_elements(v.input->'documents') j
   where d.case_id=target_case and v.input_sha256=expected_input_sha256 and d.id::text=j->>'id' and d.version_id::text=j->>'version_id'
    and d.content_sha256=j->>'sha256' and (d.id::text=p->>'document_id' or d.version_id::text=p->>'document_id')
    and d.version_id::text=p->>'version_id' and d.content_sha256=p->>'file_sha256')) then raise exception 'REVIEW_REQUEST_SOURCE_CHANGED';end if;
 select * into prior from private.document_review_request_targets t where t.case_id=target_case and t.target_sha256=target_hash;
 if found then
  if prior.target is distinct from target or prior.order_id::text is distinct from review#>>'{purchased_scope,order_id}'
   or prior.offer_sha256 is distinct from review#>>'{purchased_scope,receipt_sha256}' then raise exception 'REVIEW_REQUEST_TARGET_CONFLICT';end if;
  if not private.document_review_request_current(target_case,prior.request_id) then raise exception 'REVIEW_REQUEST_SOURCE_CHANGED';end if;
  if exists(select 1 from public.case_requests q where q.id=prior.request_id and q.answered_at is null and (q.expired_at is not null or q.expires_at<=clock_timestamp())) then return null;end if;
  return prior.request_id;
 end if;
 request_id:=gen_random_uuid();
 insert into private.document_review_request_targets(request_id,case_id,target_sha256,target,dependent_check_ids,origin_analysis_run_id,review_result_sha256,order_id,offer_sha256,purchased_topics)
 values(request_id,target_case,target_hash,target,req->'dependent_check_ids',ar.id,review->>'result_sha256',(review#>>'{purchased_scope,order_id}')::uuid,review#>>'{purchased_scope,receipt_sha256}',review#>'{purchased_scope,topics}');
 if not private.document_review_request_current(target_case,request_id) then raise exception 'REVIEW_REQUEST_SOURCE_CHANGED';end if;
 insert into public.case_requests(id,case_id,code,question,answer_kind,options,field_crop,blocking,expires_at)
 values(request_id,target_case,'document_review:'||target_hash,question,case when target->>'answer_kind'='document' then 'document' else 'text' end,null,null,false,clock_timestamp()+interval '10 days');
 return request_id;
end;$$;
revoke all on function private.document_review_request_open(uuid,integer,text,text,text,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.document_review_request_open(uuid,integer,text,text,text,text) to tivdoc_worker_runtime;

create function private.guard_document_review_request() returns trigger
 language plpgsql security definer set search_path='' as $$
declare r public.case_requests;t private.document_review_request_targets;actor uuid;answer text;
begin
 if tg_table_schema='public' then
  if new.code not like 'document_review:%' and (tg_op='INSERT' or old.code not like 'document_review:%') then return new;end if;
  if tg_op='UPDATE' then
   if (to_jsonb(new)-array['answered_at','answer_text','answered_by_identity','expired_at']) is distinct from (to_jsonb(old)-array['answered_at','answer_text','answered_by_identity','expired_at']) then raise exception 'REVIEW_REQUEST_TARGET_IMMUTABLE';end if;
   if old.answered_at is not null then
    if (new.answer_text,new.answered_at,new.answered_by_identity) is distinct from (old.answer_text,old.answered_at,old.answered_by_identity) then raise exception 'REVIEW_REQUEST_ORIGINAL_IMMUTABLE';end if;
    return new;
   end if;
   if new.answered_at is null then return new;end if;
  else
   if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||new.case_id::text
    or new.answer_text is not null or new.answered_at is not null or new.answered_by_identity is not null then raise exception 'REVIEW_REQUEST_FORBIDDEN';end if;
  end if;
  r:=new;actor:=new.answered_by_identity;answer:=new.answer_text;
 else
  select * into r from public.case_requests where id=new.request_id;
  if r.code not like 'document_review:%' then return new;end if;
  actor:=new.identity_id;answer:=new.answer_text;
 end if;
 perform 1 from public.cases where id=r.case_id for update;
 select * into t from private.document_review_request_targets where request_id=r.id and case_id=r.case_id;
 if not found or r.code is distinct from 'document_review:'||t.target_sha256 or not private.document_review_request_current(r.case_id,r.id) then raise exception 'REVIEW_REQUEST_SOURCE_CHANGED';end if;
 if r.question is distinct from private.document_review_question(t.target) or r.options is not null
  or r.answer_kind is distinct from (case when t.target->>'answer_kind'='document' then 'document' else 'text' end) then raise exception 'REVIEW_REQUEST_TARGET_INVALID';end if;
 if tg_table_schema='public' and tg_op='INSERT' then return new;end if;
 if actor is null or not exists(select 1 from public.case_identity_cases where case_id=r.case_id and identity_id=actor) then raise exception 'REVIEW_REQUEST_FORBIDDEN';end if;
 if r.expired_at is not null or (r.answered_at is null and r.expires_at<=clock_timestamp()) then raise exception 'REVIEW_REQUEST_CLOSED';end if;
 if tg_table_name='case_request_drafts' and answer='' then return new;end if;
 perform private.document_review_answer_value(t.target,answer);
 return new;
end;$$;
revoke all on function private.guard_document_review_request() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger guard_document_review_request before insert or update on public.case_requests for each row execute function private.guard_document_review_request();
create trigger guard_document_review_revision before insert on private.case_request_answer_versions for each row execute function private.guard_document_review_request();
create trigger guard_document_review_draft before insert or update on private.case_request_drafts for each row execute function private.guard_document_review_request();

create function public.case_request_review_states(target_case uuid,target_identity uuid) returns table(request_id uuid,source_current boolean,target jsonb)
 language plpgsql security definer set search_path='' as $$
begin
 if target_identity is null or not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'REVIEW_REQUEST_FORBIDDEN';end if;
 return query select r.id,coalesce(private.document_review_request_current(target_case,r.id),false),t.target from public.case_requests r
  left join private.document_review_request_targets t on t.request_id=r.id and t.case_id=r.case_id
  where r.case_id=target_case and r.code like 'document_review:%';
end;$$;
revoke all on function public.case_request_review_states(uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_request_review_states(uuid,uuid) to tivdoc_web_runtime,service_role;

create function private.document_review_answer_history(target_case uuid,target_revision integer,target_input_sha256 text) returns jsonb
 language plpgsql stable security definer set search_path='' as $$
declare journal jsonb;j jsonb;t private.document_review_request_targets;a private.case_request_answer_versions;
 result jsonb:='[]'::jsonb;answers jsonb;latest private.case_request_answer_versions;
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'REVIEW_REQUEST_FORBIDDEN';end if;
 select v.input into journal from private.case_input_versions v where v.case_id=target_case and v.revision=target_revision and v.input_sha256=target_input_sha256
  and v.input_sha256=encode(sha256(convert_to(v.input::text,'UTF8')),'hex');
 if journal is null then raise exception 'REVIEW_REQUEST_JOURNAL_REQUIRED';end if;
 for j in select value from jsonb_array_elements(journal->'answers') where value->>'code' like 'document_review:%' loop
  select * into t from private.document_review_request_targets where case_id=target_case and request_id=(j->>'id')::uuid;
  if not found or j->>'case_id' is distinct from target_case::text or j->>'code' is distinct from 'document_review:'||t.target_sha256
   or j->'review_target' is distinct from t.target then raise exception 'REVIEW_REQUEST_JOURNAL_TARGET';end if;
  select * into latest from private.case_request_answer_versions where request_id=t.request_id and revision=(j->>'answer_revision')::integer;
  if not found or latest.answer_text is distinct from j->>'answer' or latest.identity_id::text is distinct from j->>'answer_identity_id'
   or latest.created_at is distinct from (j->>'answer_created_at')::timestamptz then raise exception 'REVIEW_REQUEST_JOURNAL_ANSWER';end if;
  answers:='[]'::jsonb;
  for a in select * from private.case_request_answer_versions where request_id=t.request_id and revision<=latest.revision order by revision loop
   if a.identity_id is null then raise exception 'REVIEW_REQUEST_IDENTIFIED_ANSWER_REQUIRED';end if;
   perform private.document_review_answer_value(t.target,a.answer_text);
   answers:=answers||jsonb_build_array(jsonb_build_object('request_id',a.request_id,'revision',a.revision,'identity_id',a.identity_id,
    'answered_at',to_char(a.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'answer_text',a.answer_text));
  end loop;
  result:=result||jsonb_build_array(jsonb_build_object('request',jsonb_build_object('code','document_review:'||t.target_sha256,'target',t.target,'dependent_check_ids',t.dependent_check_ids),
   'source_current',private.document_review_request_current(target_case,t.request_id),'answers',answers));
 end loop;
 return result;
end;$$;
revoke all on function private.document_review_answer_history(uuid,integer,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.document_review_answer_history(uuid,integer,text) to tivdoc_worker_runtime;

-- Existing append-only answer tables/capture triggers remain the authority.
-- Only the new namespace gains explicit source target in new journal versions.
do $upgrade$ declare definition text;needle text;begin
 definition:=pg_get_functiondef('private.pin_request_statement_month()'::regprocedure);
 needle:='  elsif new.code like ''document_field:%'' then';
 if position(needle in definition)=0 then raise exception 'REVIEW_REQUEST_MONTH_BASE';end if;
 execute replace(definition,needle,$new$  elsif new.code like 'document_review:%' then
   select left(t.target#>>'{period,from}',7) into new.statement_month from private.document_review_request_targets t
    where t.request_id=new.id and t.case_id=new.case_id and new.code='document_review:'||t.target_sha256;
   if not found then raise exception 'REVIEW_REQUEST_TARGET_REQUIRED';end if;
  elsif new.code like 'document_field:%' then$new$);
 definition:=pg_get_functiondef('private.capture_case_input(uuid,text)'::regprocedure);
 needle:='''field_target'',(select t.target from private.document_field_targets t where t.request_id=r.id and t.case_id=r.case_id),';
 if position(needle in definition)=0 then raise exception 'REVIEW_REQUEST_CAPTURE_BASE';end if;
 execute replace(definition,needle,needle||E'\n ''review_target'',(select t.target from private.document_review_request_targets t where t.request_id=r.id and t.case_id=r.case_id),');
end $upgrade$;
