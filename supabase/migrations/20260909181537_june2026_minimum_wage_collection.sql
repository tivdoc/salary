-- June2026 customer declarations are evidence for review, never legal approval.
-- Reuse the request/revision/input-journal/outbox boundaries; no new queue.
create table private.june2026_collection_targets (
 request_id uuid primary key references public.case_requests(id) on delete cascade deferrable initially deferred,
 case_id uuid not null references public.cases(id) on delete cascade,
 target_sha256 text not null check(target_sha256 ~ '^[a-f0-9]{64}$'),
 target jsonb not null check(jsonb_typeof(target)='object'),
 created_at timestamptz not null default clock_timestamp(), unique(case_id,target_sha256),
 check(coalesce(target->>'schema_version'='minimum-wage-june2026-collection-v1' and target->>'case_id'=case_id::text and target->>'target_sha256'=target_sha256,false))
);
alter table private.june2026_collection_targets enable row level security;
revoke all on private.june2026_collection_targets from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant select on private.june2026_collection_targets to tivdoc_worker_runtime;
create policy june2026_collection_worker_read on private.june2026_collection_targets for select to tivdoc_worker_runtime
 using(private.runtime_verified_tenant()='saved-case:'||case_id::text);
create trigger preserve_june2026_collection_target before update on private.june2026_collection_targets for each row execute function private.preserve_document_field_target();

create function private.june2026_collection_current(target_case uuid,target jsonb) returns boolean
 language sql stable security definer set search_path='' as $$
 select coalesce(target->>'month'='2026-06'
  and target->>'case_id'=target_case::text
  and target->>'legal_policy_sha256'='7c37868d57537a143fd9bcb39071b2c707443bae85d610986f90c50f6bbda948'
  and exists(select 1 from public.documents d join public.cases pc on pc.id=d.case_id
   join private.case_extraction_checkpoints c on c.case_id=d.case_id and c.version_id=d.version_id
   where d.case_id=target_case and d.document_type='payslip' and d.id::text=target->>'product_document_id'
    and d.version_id::text=target->>'version_id' and d.content_sha256=target->>'source_sha256'
    and to_char(coalesce(d.period_month,pc.check_period_month),'YYYY-MM')='2026-06'
    and c.input_sha256=d.content_sha256 and c.policy_version=target->>'extraction_policy_version'
    and c.result_sha256=target->>'extraction_result_sha256'
    and c.result->>'schema_version'='tivdoc-saved-extraction-v1'
    and c.result->>'case_id'=target_case::text and c.result->>'product_document_id'=d.id::text
    and c.result->>'version_id'=d.version_id::text and c.result->>'input_sha256'=d.content_sha256
    and c.result->>'result_sha256'=c.result_sha256 and c.result->>'expected_month'='2026-06'
    and c.result->>'period_mismatch'='false'
    and not(c.result#>'{run,result,final_extraction}' ? 'customer_readings')
    and c.result#>>'{run,result,final_extraction,document_id}'=d.version_id::text
    and not exists(select 1 from private.case_extraction_checkpoints newer
     where newer.case_id=c.case_id and newer.version_id=c.version_id and newer.policy_version=c.policy_version and newer.revision>c.revision)
    and (select count(*)=1 and bool_and(f#>'{normalized_value}'=jsonb_build_object('year',2026,'month',6,'start_date','2026-06-01','end_date','2026-06-30') and f#>>'{source,document_id}'=d.version_id::text)
      from jsonb_array_elements(c.result#>'{run,result,final_extraction,fields}') f where f->>'field'='salary_period')
    and (target#>>'{subject,kind}' in ('applicability','earnings_completeness') or
     exists(select 1 from jsonb_array_elements(c.result#>'{run,result,final_extraction,additional_components}') component
      where jsonb_build_object('component_id',component->'component_id','source_label',component->'source_label','amount',component->'amount',
       'source',jsonb_build_object('document_id',component#>'{source,document_id}','page',component#>'{source,page}'))=target#>'{subject,component}'
       and component#>>'{source,document_id}'=d.version_id::text)))
  and exists(select 1 from private.case_input_heads h join private.case_input_versions v on v.case_id=h.case_id and v.revision=h.revision and v.input_sha256=h.input_sha256
   cross join lateral jsonb_array_elements(v.input->'orders') pinned
   join private.product_orders o on o.case_id=v.case_id and o.id::text=pinned->>'id'
   join private.order_entitlements e on e.order_id=o.id and e.state='active'
   where h.case_id=target_case and o.state='paid' and o.refund_state<>'refunded' and 'minimum_wage'=any(o.topics)
    and date '2026-06-01' between o.period_from and o.period_to
    and pinned=jsonb_build_object('id',o.id,'kind',o.kind,'from',o.period_from,'to',o.period_to,'topics',o.topics,'offer_sha256',o.offer_sha256)),false);
$$;
revoke all on function private.june2026_collection_current(uuid,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

-- Exact question semantics are part of the write boundary: a worker cannot
-- invert the displayed question while the answer materializer assumes yes=no.
create function private.june2026_collection_question(target jsonb) returns text
 language plpgsql immutable security invoker set search_path='' as $$
declare field text:=target#>>'{subject,field}'; label text:=target#>>'{subject,component,source_label}'; question text;
begin
 if target#>>'{subject,kind}'='component' then
  if char_length(label)>120 then label:=left(label,119)||'…';end if;
  return 'מה מהות הרכיב ״'||label||'״ בעמוד '||(target#>>'{subject,component,source,page}')||' בתלוש יוני 2026, לפי המידע שברשותך? התיאור יישמר כהצהרתך לצורך בירור הרכיב.';
 elsif target#>>'{subject,kind}'='earnings_completeness' then
  return 'לאחר בדיקת כל שורות התשלום בתלוש יוני 2026 ובקשות בירור רכיבי השכר, האם כל רכיב תשלום בתלוש מופיע בבקשות הבירור? אין לכלול ניכויים כשורות תשלום.';
 end if;
 question:=case field
  when 'age_18_entire_month' then 'האם מלאו לך 18 לפני 1 ביוני 2026?'
  when 'sector' then 'מה תחום הפעילות של המעסיק ביוני 2026, והאם ידוע לך על הסכם ענפי או קיבוצי שחל בעבודה? נא לתאר את המידע שברשותך.'
  when 'hours_rest_law_applies' then 'נא לתאר את התפקיד בפועל ביוני 2026, אופן הפיקוח על שעות העבודה והסמכויות בעבודה. המידע דרוש לבירור התחולה; אין צורך לקבוע בעצמך מסקנה משפטית.'
  when 'no_better_minimum_wage_arrangement' then 'האם ידוע לך על חוזה, הסכם או הסדר אחר שקובע עבורך שכר מינימום גבוה מהשכר הכללי ביוני 2026?'
  when 'no_adapted_minimum_wage' then 'האם נקבע עבורך שכר מינימום מותאם בהחלטה מוסמכת שחלה ביוני 2026?'
  when 'regular_hours_exclude_absence_overtime_rest' then 'האם השעות הרגילות בתלוש יוני 2026 כוללות רק עבודה רגילה, ללא היעדרות, שעות נוספות או עבודה במנוחה השבועית?'
  else null end;
 if field in ('sector','hours_rest_law_applies') then question:=question||' אפשר גם לכתוב ״איני יודע/ת״ או ״יש מידע סותר״.';end if;
 return question;
end;$$;
revoke all on function private.june2026_collection_question(jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.june2026_collection_request_open(target_case uuid,expected_revision integer,expected_input_sha256 text,target_payload jsonb,target_question text) returns uuid
 language plpgsql security definer set search_path='' as $$
declare head private.case_input_heads; new_request uuid; kind text:=target_payload#>>'{subject,kind}'; field text:=target_payload#>>'{subject,field}';
 answer_kind text:='choice'; choices text[]:=array['כן, לפי המידע שברשותי','לא, לפי המידע שברשותי','איני יודע/ת','יש מידע סותר'];
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'JUNE_COLLECTION_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;if not found then raise exception 'JUNE_COLLECTION_FORBIDDEN';end if;
 select * into head from private.case_input_heads where case_id=target_case;
 if head.revision is distinct from expected_revision or head.input_sha256 is distinct from expected_input_sha256 then raise exception 'JUNE_COLLECTION_SOURCE_CHANGED';end if;
 if not coalesce(target_payload->>'schema_version'='minimum-wage-june2026-collection-v1' and target_payload->>'case_id'=target_case::text
  and target_payload->>'month'='2026-06' and target_payload->>'target_sha256' ~ '^[a-f0-9]{64}$'
  and target_payload->>'source_sha256' ~ '^[a-f0-9]{64}$' and target_payload->>'extraction_result_sha256' ~ '^[a-f0-9]{64}$'
  and target_payload->>'extraction_policy_version'='saved-payslip-v21-p95-v1'
  and target_payload-array['schema_version','case_id','product_document_id','version_id','source_sha256','month','extraction_policy_version','extraction_result_sha256','legal_policy_sha256','subject','target_sha256']='{}'::jsonb
  and target_payload->>'target_sha256'=encode(sha256(convert_to(private.governance_jsonb_compact_text(target_payload-'target_sha256'),'UTF8')),'hex')
  and (kind='earnings_completeness' and target_payload->'subject'=jsonb_build_object('kind',kind)
   or kind='applicability' and field in ('age_18_entire_month','sector','hours_rest_law_applies','no_better_minimum_wage_arrangement','no_adapted_minimum_wage','regular_hours_exclude_absence_overtime_rest') and target_payload->'subject'=jsonb_build_object('kind',kind,'field',field)
   or kind='component' and jsonb_typeof(target_payload#>'{subject,component}')='object' and target_payload->'subject'=jsonb_build_object('kind',kind,'component',target_payload#>'{subject,component}')),false)
  or target_question is null or char_length(target_question) not between 4 and 400
  or target_question is distinct from private.june2026_collection_question(target_payload) then raise exception 'JUNE_COLLECTION_TARGET_INVALID';end if;
 if not private.june2026_collection_current(target_case,target_payload) then raise exception 'JUNE_COLLECTION_SOURCE_OR_SCOPE_CHANGED';end if;
 if kind='component' then choices:=array['שכר יסוד או שכר משולב','תוספת יוקר שאינה כלולה כבר בשכר המשולב','תוספת קבועה עקב העבודה','תוספת ותק','תוספת משפחה','תוספת משמרות','פרמיית תפוקה','משכורת שלוש עשרה','מענק שנתי','החזר הוצאות','תשלום בעד שעות נוספות','תשלום בעד עבודה במנוחה השבועית','תשלום בעד היעדרות','ניכוי מהשכר','רכיב מסוג אחר','איני יודע/ת','יש מידע סותר'];
 elsif kind='applicability' and field in ('sector','hours_rest_law_applies') then answer_kind:='text';choices:=null;end if;
 select t.request_id into new_request from private.june2026_collection_targets t where t.case_id=target_case and t.target_sha256=target_payload->>'target_sha256';
 if new_request is not null then
  if (select t.target from private.june2026_collection_targets t where t.request_id=new_request) is distinct from target_payload then raise exception 'JUNE_COLLECTION_TARGET_CONFLICT';end if;
  if exists(select 1 from public.case_requests q where q.id=new_request and q.answered_at is null and (q.expired_at is not null or q.expires_at<=clock_timestamp())) then return null;end if;
  return new_request;
 end if;
 new_request:=gen_random_uuid();
 insert into private.june2026_collection_targets(request_id,case_id,target_sha256,target) values(new_request,target_case,target_payload->>'target_sha256',target_payload);
 insert into public.case_requests(id,case_id,code,question,answer_kind,options,field_crop,blocking,expires_at)
 values(new_request,target_case,'minimum_wage_june2026:'||(target_payload->>'target_sha256'),target_question,answer_kind,choices,'minimum_wage',false,clock_timestamp()+interval '10 days');
 return new_request;
end;$$;
revoke all on function private.june2026_collection_request_open(uuid,integer,text,jsonb,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.june2026_collection_request_open(uuid,integer,text,jsonb,text) to tivdoc_worker_runtime;

-- Bind originals, corrections and drafts. Direct legacy/unidentified writes
-- cannot bypass the new namespace by choosing a different RPC.
create function private.guard_june2026_collection_answer() returns trigger language plpgsql security definer set search_path='' as $$
declare r public.case_requests; target jsonb; actor uuid; answer text;
begin
 if tg_table_schema='public' then
  if old.code not like 'minimum_wage_june2026:%' then return new;end if;
  if (to_jsonb(new)-array['answered_at','answer_text','answered_by_identity','expired_at']) is distinct from (to_jsonb(old)-array['answered_at','answer_text','answered_by_identity','expired_at']) then raise exception 'JUNE_COLLECTION_TARGET_IMMUTABLE';end if;
  if old.answered_at is not null or new.answered_at is null then return new;end if;
  r:=new;actor:=new.answered_by_identity;answer:=new.answer_text;
 else
  select * into r from public.case_requests where id=new.request_id;
  if r.code not like 'minimum_wage_june2026:%' then return new;end if;
  actor:=new.identity_id;answer:=new.answer_text;
 end if;
 perform 1 from public.cases where id=r.case_id for update;
 select t.target into target from private.june2026_collection_targets t where t.request_id=r.id and t.case_id=r.case_id and r.code='minimum_wage_june2026:'||t.target_sha256;
 if target is null or not private.june2026_collection_current(r.case_id,target) then raise exception 'JUNE_COLLECTION_SOURCE_OR_SCOPE_CHANGED';end if;
 if actor is null or not exists(select 1 from public.case_identity_cases where case_id=r.case_id and identity_id=actor) then raise exception 'JUNE_COLLECTION_FORBIDDEN';end if;
 if answer is null or char_length(answer)>1500 then raise exception 'JUNE_COLLECTION_ANSWER_INVALID';end if;
 return new;
end;$$;
revoke all on function private.guard_june2026_collection_answer() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger guard_june2026_collection_answer before update on public.case_requests for each row execute function private.guard_june2026_collection_answer();
create trigger guard_june2026_collection_revision before insert on private.case_request_answer_versions for each row execute function private.guard_june2026_collection_answer();
create trigger guard_june2026_collection_draft before insert or update on private.case_request_drafts for each row execute function private.guard_june2026_collection_answer();

create function public.case_request_june_states(target_case uuid,target_identity uuid) returns table(request_id uuid,source_current boolean)
 language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'JUNE_COLLECTION_FORBIDDEN';end if;
 return query select r.id,coalesce(private.june2026_collection_current(target_case,t.target),false)
 from public.case_requests r left join private.june2026_collection_targets t on t.request_id=r.id and t.case_id=r.case_id
 where r.case_id=target_case and r.code like 'minimum_wage_june2026:%';
end;$$;
revoke all on function public.case_request_june_states(uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_request_june_states(uuid,uuid) to tivdoc_web_runtime,service_role;

-- Preserve historical function/ACL behavior and fail closed if the expected
-- upgrade base differs. No RLS policy or existing approval guard is removed.
do $migration$ declare definition text; needle text; signature text; scope text;begin
 definition:=pg_get_functiondef('private.pin_request_statement_month()'::regprocedure);
 needle:='  if new.code like ''document_field:%'' then';
 if position(needle in definition)=0 then raise exception 'JUNE_COLLECTION_MONTH_BASE';end if;
 execute replace(definition,needle,$new$  if new.code like 'minimum_wage_june2026:%' then
   select t.target->>'month' into new.statement_month from private.june2026_collection_targets t where t.request_id=new.id and t.case_id=new.case_id and new.code='minimum_wage_june2026:'||t.target_sha256;
   if not found then raise exception 'JUNE_COLLECTION_TARGET_MISSING';end if;
  elsif new.code like 'document_field:%' then$new$);
 definition:=pg_get_functiondef('private.capture_case_input(uuid,text)'::regprocedure);
 needle:='''field_target'',(select t.target from private.document_field_targets t where t.request_id=r.id and t.case_id=r.case_id),';
 if position(needle in definition)=0 then raise exception 'JUNE_COLLECTION_CAPTURE_BASE';end if;
 execute replace(definition,needle,needle||E'\n ''june2026_target'',(select t.target from private.june2026_collection_targets t where t.request_id=r.id and t.case_id=r.case_id),');
 foreach signature in array array['private.managed_dev_worker_status(text)','public.case_notification_managed_pending(text)','private.managed_dev_notification_event_current(uuid,text)'] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  scope:=case when signature like 'private.managed_dev_worker_status%' then 'r.case_id' when signature like 'public.case_notification_managed_pending%' then 'e.case_id' else 'target_case' end;
  needle:='or exists(select 1 from private.dev_financial_request_targets t where t.request_id=q.id and';
  if position(needle in definition)=0 then raise exception 'JUNE_COLLECTION_NOTIFICATION_BASE';end if;
  execute replace(definition,needle,format('or exists(select 1 from private.june2026_collection_targets t where t.request_id=q.id and t.case_id=%s and private.june2026_collection_current(%s,t.target)) ',scope,scope)||needle);
 end loop;
end $migration$;
