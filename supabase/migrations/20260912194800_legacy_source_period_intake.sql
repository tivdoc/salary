-- Additive source intake before a historical paid period is known.
-- Schema190 is the required base. No historical receipt, document kind,
-- purchase period, payment or answer is rewritten by this migration.

-- Keep historical request codes and admit only the new UUID/month namespace.
alter table public.case_requests drop constraint case_requests_code_check;
alter table public.case_requests add constraint case_requests_code_check check (
 code ~ '^[a-z][a-z0-9_.:]{2,119}$'
 or code ~ '^legacy\.source\.document:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(:[0-9]{4}-(0[1-9]|1[0-2]))?$'
);

create table private.document_physical_page_receipts (
 case_id uuid not null references public.cases(id),
 document_id uuid not null,
 version_id uuid primary key,
 source_sha256 text not null check(source_sha256~'^[a-f0-9]{64}$'),
 byte_size bigint not null check(byte_size>0),
 mime_type text not null check(mime_type in ('application/pdf','image/jpeg','image/png')),
 page_count integer not null check(page_count between 1 and 100),
 method text not null check(method='physical-pages-v1'),
 recorded_at timestamptz not null default clock_timestamp()
);
alter table private.document_physical_page_receipts enable row level security;
revoke all on private.document_physical_page_receipts from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

create function private.document_physical_page_receipt_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin raise exception 'SOURCE_PHYSICAL_RECEIPT_IMMUTABLE';end;$$;
revoke all on function private.document_physical_page_receipt_guard() from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
create trigger document_physical_page_receipt_immutable before update or delete on private.document_physical_page_receipts
 for each row execute function private.document_physical_page_receipt_guard();

-- This port accepts server-side physical parsing only, never a browser count.
-- The source tuple and byte size are rechecked against the current upload.
create function private.document_physical_pages_record(target_case uuid,target_document uuid,target_version uuid,
 target_sha text,target_size bigint,target_mime text,target_pages integer) returns void
language plpgsql security definer set search_path='' as $$
declare d public.documents;old private.document_physical_page_receipts;
begin
 if session_user not in ('tivdoc_web_runtime','tivdoc_worker_runtime','service_role') then raise exception 'SOURCE_INTAKE_FORBIDDEN';end if;
 if session_user='tivdoc_worker_runtime' and private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text
  then raise exception 'SOURCE_INTAKE_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case and contact_verified_at is not null for update;
 if not found then raise exception 'SOURCE_INTAKE_FORBIDDEN';end if;
 select * into d from public.documents where case_id=target_case and id=target_document and version_id=target_version;
 if d.id is null or d.content_sha256 is distinct from target_sha or d.size is distinct from target_size
  or d.mime_type is distinct from target_mime or (target_pages between 1 and 100) is not true
  or target_mime not in ('application/pdf','image/jpeg','image/png')
  or (target_mime<>'application/pdf' and target_pages<>1) then raise exception 'SOURCE_INTAKE_PHYSICAL_MISMATCH';end if;
 insert into private.document_physical_page_receipts(case_id,document_id,version_id,source_sha256,byte_size,mime_type,page_count,method)
 values(target_case,target_document,target_version,target_sha,target_size,target_mime,target_pages,'physical-pages-v1') on conflict(version_id) do nothing;
 select * into old from private.document_physical_page_receipts where version_id=target_version;
 if old.case_id is distinct from target_case or old.document_id is distinct from target_document or old.source_sha256 is distinct from target_sha
  or old.byte_size is distinct from target_size or old.mime_type is distinct from target_mime or old.page_count is distinct from target_pages
  then raise exception 'SOURCE_INTAKE_PHYSICAL_CONFLICT';end if;
end;$$;

-- Unknown-period document requests are source intake, never fake monthly
-- document reviews. Their original paid receipt remains immutable.
create table private.legacy_source_document_targets (
 request_id uuid primary key,case_id uuid not null references public.cases(id),
 target_sha256 text not null check(target_sha256~'^[a-f0-9]{64}$'),target jsonb not null,
 renewal_index integer not null check(renewal_index>=0),predecessor_request_id uuid,
 created_at timestamptz not null default clock_timestamp(),unique(case_id,target_sha256,renewal_index)
);
alter table private.legacy_source_document_targets enable row level security;
revoke all on private.legacy_source_document_targets from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
create trigger legacy_source_document_target_immutable before update or delete on private.legacy_source_document_targets
 for each row execute function private.document_physical_page_receipt_guard();

create function private.legacy_source_document_request_open(target_case uuid,expected_revision integer,expected_sha text,t jsonb,q text) returns uuid
language plpgsql security definer set search_path='' as $$
declare h private.case_input_heads;r public.case_requests;target_id uuid;generation integer:=0;previous uuid;code text;expected_question text;
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;if not found then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 select * into h from private.case_input_heads where case_id=target_case;
 if h.revision is distinct from expected_revision or h.input_sha256 is distinct from expected_sha
  or t->>'schema_version' is distinct from 'legacy-source-intake-document-v1' or not private.source_intake_target_current(target_case,t) then raise exception 'REQUEST_FIELD_SOURCE_CHANGED';end if;
 code:='legacy.source.document:'||(t->>'order_id')||case when t->>'month' is null then '' else ':'||(t->>'month') end;
 expected_question:=case when t->>'month' is null then 'נא לצרף תלוש שכר מלא או מסמך מקור המציג את התקופה לבדיקה. תקופת הרכישה לא נרשמה; אין צורך לשלם שוב.'
  else 'נא לצרף תלוש שכר מלא לחודש '||(t->>'month')||'. אין כרגע מסמך מקור שמור לתקופה זו.' end;
 if q is distinct from expected_question and (t->>'month' is null or q is distinct from 'נא לצרף תלוש שכר מלא לחודש '||(t->>'month')||'. אין כרגע תלוש שכר המשויך לתקופה זו.') then raise exception 'REQUEST_FIELD_TARGET_INVALID';end if;
 -- An answer-created head does not by itself create another upload request.
 select cr.* into r from private.legacy_source_document_targets x join public.case_requests cr on cr.id=x.request_id
 where x.case_id=target_case and cr.code=code and private.source_intake_target_current(target_case,x.target)
 order by x.created_at desc limit 1;
 if r.id is not null and (r.answered_at is not null or r.expired_at is null and r.expires_at>clock_timestamp()) then return r.id;end if;
 select x.request_id,x.renewal_index into previous,generation from private.legacy_source_document_targets x
 where x.case_id=target_case and x.target_sha256=t->>'target_sha256' order by x.renewal_index desc limit 1;
 if previous is not null then
  select * into r from public.case_requests where id=previous for update;
  if r.answered_at is not null or r.expired_at is null and r.expires_at>clock_timestamp() then return r.id;end if;
  if r.expires_at>clock_timestamp() then raise exception 'REQUEST_FIELD_RENEWAL_NOT_DUE';end if;
  update public.case_requests set expired_at=coalesce(expired_at,clock_timestamp()) where id=previous and answered_at is null;
  generation:=generation+1;
 else generation:=0;end if;
 target_id:=gen_random_uuid();
 insert into private.legacy_source_document_targets(request_id,case_id,target_sha256,target,renewal_index,predecessor_request_id)
 values(target_id,target_case,t->>'target_sha256',t,generation,previous);
 insert into public.case_requests(id,case_id,code,question,answer_kind,blocking,expires_at,statement_month)
 values(target_id,target_case,code,q,'document',true,clock_timestamp()+interval '10 days',case when t->>'month' is null then null else ((t->>'month')||'-01')::date end);
 return target_id;
end;$$;
revoke all on function private.legacy_source_document_request_open(uuid,integer,text,jsonb,text) from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function private.legacy_source_document_request_open(uuid,integer,text,jsonb,text) to tivdoc_worker_runtime;
revoke all on function private.document_physical_pages_record(uuid,uuid,uuid,text,bigint,text,integer) from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function private.document_physical_pages_record(uuid,uuid,uuid,text,bigint,text,integer) to tivdoc_web_runtime,tivdoc_worker_runtime,service_role;

create function private.source_intake_journal_sha(j jsonb) returns text
language sql immutable security invoker set search_path='' as $$
 select encode(sha256(convert_to(private.governance_jsonb_compact_text(j),'UTF8')),'hex');$$;
revoke all on function private.source_intake_journal_sha(jsonb) from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

-- Exact original anchor plus exact current source and original paid scope.
-- An answer legitimately creates a newer head; the old target stays usable
-- only while its original source and paid receipt are still current.
create function private.source_intake_target_current(target_case uuid,t jsonb) returns boolean
language plpgsql stable security invoker set search_path='' as $$
declare anchor jsonb;current_input jsonb;head_revision bigint;head_sha text;anchor_sha text;scope jsonb;d public.documents;p private.document_physical_page_receipts;
 body jsonb;is_document boolean:=t->>'schema_version'='legacy-source-intake-document-v1';
begin
 if jsonb_typeof(t) is distinct from 'object' or (t->>'schema_version' in ('document-source-period-intake-v1','legacy-source-intake-document-v1')) is not true
  or t->>'case_id' is distinct from target_case::text or t->>'order_origin' is distinct from 'legacy_paid_receipt'
  or t->>'policy_version' is distinct from 'legacy-source-intake-v1'
  or (t->>'source_revision'~'^[1-9][0-9]{0,9}$') is not true
  or t->>'target_sha256' is distinct from private.source_intake_journal_sha(t-'target_sha256') then return false;end if;
 select v.input,h.revision,v.input_sha256 into current_input,head_revision,head_sha from private.case_input_heads h
 join private.case_input_versions v on v.case_id=h.case_id and v.revision=h.revision and v.input_sha256=h.input_sha256 where h.case_id=target_case;
 if current_input is null or head_sha is distinct from encode(sha256(convert_to(current_input::text,'UTF8')),'hex')
  or (t->>'source_revision')::bigint>head_revision then return false;end if;
 select v.input,v.input_sha256 into anchor,anchor_sha from private.case_input_versions v
 where v.case_id=target_case and v.revision=(t->>'source_revision')::bigint;
 if anchor is null or anchor_sha is distinct from t->>'source_input_sha256'
  or anchor_sha is distinct from encode(sha256(convert_to(anchor::text,'UTF8')),'hex')
  or private.source_intake_journal_sha(anchor) is distinct from t->>'source_journal_sha256' then return false;end if;
 select s into scope from jsonb_array_elements(private.legacy_paid_scopes_internal(target_case)) s
 where s->>'id'=t->>'order_id' and s->>'receipt_sha256'=t->>'order_receipt_sha256';
 if scope is null or scope->>'case_id' is distinct from target_case::text or scope->'topics' is distinct from t->'purchased_topics'
  or not coalesce(anchor->'legacy_orders' @> jsonb_build_array(scope),false)
  or not coalesce(current_input->'legacy_orders' @> jsonb_build_array(scope),false) then return false;end if;
 body:=jsonb_build_object('schema_version',t->>'schema_version','case_id',target_case,'order_id',t->>'order_id',
  'order_origin','legacy_paid_receipt','order_receipt_sha256',t->>'order_receipt_sha256','purchased_topics',scope->'topics',
  'source_revision',t->'source_revision','source_input_sha256',anchor_sha,'source_journal_sha256',t->>'source_journal_sha256',
  'month',t->'month','policy_version','legacy-source-intake-v1');
 if is_document then
  if t->'month' is distinct from 'null'::jsonb and ((t->>'month'~'^[0-9]{4}-(0[1-9]|1[0-2])$') is not true
   or not private.legacy_scope_covers_month(scope,(t->>'month'||'-01')::date)) then return false;end if;
  return t=body||jsonb_build_object('target_sha256',private.source_intake_journal_sha(body));
 end if;
 if t->'month' is distinct from 'null'::jsonb or t->'subject' is distinct from jsonb_build_object('kind','source_period_and_type') then return false;end if;
 select * into d from public.documents where case_id=target_case and id::text=t->>'product_document_id' and version_id::text=t->>'version_id' and content_sha256=t->>'source_sha256';
 if d.id is null then return false;end if;
 select * into p from private.document_physical_page_receipts where case_id=target_case and document_id=d.id and version_id=d.version_id and source_sha256=d.content_sha256 and byte_size=d.size and mime_type=d.mime_type;
 if p.version_id is null or t->'page_count' is distinct from to_jsonb(p.page_count) then return false;end if;
 if not exists(select 1 from jsonb_array_elements(anchor->'documents') x where x->>'id'=d.id::text and x->>'version_id'=d.version_id::text and x->>'sha256'=d.content_sha256 and x->>'type'=d.document_type)
  or not exists(select 1 from jsonb_array_elements(current_input->'documents') x where x->>'id'=d.id::text and x->>'version_id'=d.version_id::text and x->>'sha256'=d.content_sha256 and x->>'type'=d.document_type) then return false;end if;
 body:=body||jsonb_build_object('product_document_id',d.id,'version_id',d.version_id,'source_sha256',d.content_sha256,'page_count',p.page_count,'subject',t->'subject');
 return t=body||jsonb_build_object('target_sha256',private.source_intake_journal_sha(body));
exception when invalid_text_representation or invalid_parameter_value or datetime_field_overflow or numeric_value_out_of_range then return false;
end;$$;
revoke all on function private.source_intake_target_current(uuid,jsonb) from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

create function private.source_intake_answer_valid(t jsonb,answer_text text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare a jsonb;v jsonb;p jsonb;f date;l date;
begin
 if t->>'schema_version' is distinct from 'document-source-period-intake-v1' or answer_text is null or char_length(answer_text)>2000 then return false;end if;
 a:=answer_text::jsonb;
 if a->'v' is distinct from '1'::jsonb then return false;end if;
 if a->>'action' in ('unknown','unreadable') then return a=jsonb_build_object('v',1,'action',a->>'action');end if;
 if a->>'action' is distinct from 'correct' then return false;end if;
 v:=a->'value';p:=v->'period';
 if a is distinct from jsonb_build_object('v',1,'action','correct','value',v)
  or v is distinct from jsonb_build_object('document_kind',v->>'document_kind','period',p,'page',v->'page','source_label',v->>'source_label')
  or (v->>'document_kind' in ('payslip','attendance','contract','other')) is not true
  or jsonb_typeof(v->'page') is distinct from 'number' or (v->>'page'~'^[1-9][0-9]?$|^100$') is not true
  or (v->>'page')::integer>(t->>'page_count')::integer
  or jsonb_typeof(v->'source_label') is distinct from 'string' or char_length(btrim(v->>'source_label')) not between 1 and 400
  or btrim(v->>'source_label') is distinct from v->>'source_label' then return false;end if;
 if p='null'::jsonb then return true;end if;
 if p is distinct from jsonb_build_object('from',p->>'from','to',p->>'to')
  or (p->>'from'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and p->>'to'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$') is not true then return false;end if;
 f:=(p->>'from')::date;l:=(p->>'to')::date;
 return to_char(f,'YYYY-MM-DD')=p->>'from' and to_char(l,'YYYY-MM-DD')=p->>'to' and f<=l
  and (extract(year from l)-extract(year from f))*12+extract(month from l)-extract(month from f)<600;
exception when invalid_text_representation or invalid_parameter_value or datetime_field_overflow or numeric_value_out_of_range then return false;
end;$$;
revoke all on function private.source_intake_answer_valid(jsonb,text) from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

create function private.source_intake_context_internal(target_case uuid,expected_revision bigint,expected_sha text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare j jsonb;h private.case_input_heads;v private.case_input_versions;a jsonb;t jsonb;r public.case_requests;answer private.case_request_answer_versions;
 anchors jsonb:='[]'::jsonb;anchor_ids bigint[]:=array[]::bigint[];physical jsonb;
begin
 select * into h from private.case_input_heads where case_id=target_case;
 if h.revision is distinct from expected_revision or h.input_sha256 is distinct from expected_sha then raise exception 'SOURCE_INTAKE_SOURCE_CHANGED';end if;
 select * into v from private.case_input_versions where case_id=target_case and revision=h.revision and input_sha256=h.input_sha256;
 j:=v.input;
 if j is null or v.input_sha256 is distinct from encode(sha256(convert_to(j::text,'UTF8')),'hex') then raise exception 'SOURCE_INTAKE_JOURNAL_HASH';end if;
 for a in select x from jsonb_array_elements(coalesce(j->'answers','[]'::jsonb)) x loop
  if a#>>'{field_target,schema_version}' is distinct from 'document-source-period-intake-v1' then continue;end if;
  t:=a->'field_target';
  select * into r from public.case_requests where id=(a->>'id')::uuid and case_id=target_case;
  select * into answer from private.case_request_answer_versions where request_id=r.id order by revision desc limit 1;
  if r.id is null or r.code is distinct from 'document_field:'||(t->>'target_sha256') or r.answer_kind is distinct from 'choice'
   or r.statement_month is not null or r.answered_at is null or a->>'case_id' is distinct from target_case::text
   or a->>'code' is distinct from r.code or a->>'answer_kind' is distinct from 'choice' or a->'scope_month' is distinct from 'null'::jsonb
   or answer.request_id is null or answer.revision::text is distinct from a->>'answer_revision'
   or answer.identity_id::text is distinct from a->>'answer_identity_id' or answer.answer_text is distinct from a->>'answer'
   or answer.created_at is distinct from (a->>'answer_created_at')::timestamptz
   or not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=answer.identity_id)
   or not exists(select 1 from private.document_field_targets where request_id=r.id and case_id=target_case and target=t and target_sha256=t->>'target_sha256')
   or not private.source_intake_answer_valid(t,answer.answer_text) then raise exception 'SOURCE_INTAKE_ANSWER_JOURNAL';end if;
  if (t->>'source_revision')::bigint=any(anchor_ids) then continue;end if;
  select * into v from private.case_input_versions where case_id=target_case and revision=(t->>'source_revision')::bigint;
  if v.case_id is null or v.revision>h.revision or v.input_sha256 is distinct from t->>'source_input_sha256'
   or v.input_sha256 is distinct from encode(sha256(convert_to(v.input::text,'UTF8')),'hex')
   or private.source_intake_journal_sha(v.input) is distinct from t->>'source_journal_sha256' then raise exception 'SOURCE_INTAKE_ANCHOR_HASH';end if;
  anchors:=anchors||jsonb_build_array(jsonb_build_object('revision',v.revision,'input_sha256',v.input_sha256,'journal_sha256',private.source_intake_journal_sha(v.input),'input',v.input));
  anchor_ids:=array_append(anchor_ids,v.revision);
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'version_id',d.version_id,'sha256',d.content_sha256,'type',d.document_type,
  'page_count',p.page_count) order by d.id),'[]'::jsonb) into physical from public.documents d
 left join private.document_physical_page_receipts p on p.case_id=d.case_id and p.document_id=d.id and p.version_id=d.version_id
  and p.source_sha256=d.content_sha256 and p.byte_size=d.size and p.mime_type=d.mime_type
 where d.case_id=target_case and exists(select 1 from jsonb_array_elements(j->'documents') x where x->>'id'=d.id::text
  and x->>'version_id'=d.version_id::text and x->>'sha256'=d.content_sha256 and x->>'type'=d.document_type);
 return jsonb_build_object('caseId',target_case,'revision',h.revision,'inputSha256',h.input_sha256,'journalSha256',private.source_intake_journal_sha(j),
  'journal',j,'currentDocuments',physical,'sourceAnchors',anchors);
end;$$;
revoke all on function private.source_intake_context_internal(uuid,bigint,text) from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

create function private.legacy_source_intake_context(target_case uuid,expected_revision bigint,expected_sha text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'SOURCE_INTAKE_FORBIDDEN';end if;
 return private.source_intake_context_internal(target_case,expected_revision,expected_sha);
end;$$;
revoke all on function private.legacy_source_intake_context(uuid,bigint,text) from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function private.legacy_source_intake_context(uuid,bigint,text) to tivdoc_worker_runtime;

create function private.source_physical_pages_pending(target_case uuid,expected_revision bigint,expected_sha text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c jsonb;items jsonb;
begin
 c:=private.legacy_source_intake_context(target_case,expected_revision,expected_sha);
 if not exists(select 1 from jsonb_array_elements(c#>'{journal,legacy_orders}') s where s->'periods'='[]'::jsonb) then return '[]'::jsonb;end if;
 select coalesce(jsonb_agg(jsonb_build_object('document_id',d.id,'version_id',d.version_id,'source_sha256',d.content_sha256,
  'byte_size',d.size,'mime_type',d.mime_type,'storage_path',d.storage_path) order by d.id),'[]'::jsonb) into items
 from public.documents d where d.case_id=target_case and exists(select 1 from jsonb_array_elements(c->'currentDocuments') p
  where p->>'id'=d.id::text and p->>'version_id'=d.version_id::text and p->'page_count'='null'::jsonb);
 return items;
end;$$;
revoke all on function private.source_physical_pages_pending(uuid,bigint,text) from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function private.source_physical_pages_pending(uuid,bigint,text) to tivdoc_worker_runtime;

create function public.case_request_source_intake_context(target_case uuid,target_identity uuid,target_request uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t jsonb;h private.case_input_heads;v private.case_input_versions;context jsonb;anchors jsonb;
begin
 if session_user not in ('tivdoc_web_runtime','service_role') or not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity)
  then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 select target into t from private.document_field_targets f join public.case_requests r on r.id=f.request_id and r.case_id=f.case_id
 where f.case_id=target_case and f.request_id=target_request and r.code='document_field:'||f.target_sha256
  and f.target->>'schema_version'='document-source-period-intake-v1';
 if t is null or not private.source_intake_target_current(target_case,t) then return null;end if;
 select * into h from private.case_input_heads where case_id=target_case;
 context:=private.source_intake_context_internal(target_case,h.revision,h.input_sha256);
 anchors:=context->'sourceAnchors';
 if not exists(select 1 from jsonb_array_elements(anchors) a where a->'revision'=t->'source_revision') then
  select * into v from private.case_input_versions where case_id=target_case and revision=(t->>'source_revision')::bigint;
  anchors:=anchors||jsonb_build_array(jsonb_build_object('revision',v.revision,'input_sha256',v.input_sha256,'journal_sha256',private.source_intake_journal_sha(v.input),'input',v.input));
 end if;
 return jsonb_set(context,'{sourceAnchors}',anchors);
end;$$;
revoke all on function public.case_request_source_intake_context(uuid,uuid,uuid) from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function public.case_request_source_intake_context(uuid,uuid,uuid) to tivdoc_web_runtime,service_role;

-- Reconstruct the same typed customer-reading receipt used by the adapter.
-- This is coverage evidence for a missing historic period, not a rewrite of
-- the purchase and not an applicability or numerical verification decision.
create function private.legacy_source_period_evidence(target_case uuid,scope jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare h private.case_input_heads;c jsonb;d jsonb;a jsonb;chosen jsonb;answer jsonb;reading jsonb;reading_body jsonb;
 periods jsonb:='[]'::jsonb;conflicts jsonb:='[]'::jsonb;body jsonb;answer_hash text;first_hash text;conflict boolean;f date;l date;first_month date;
begin
 select * into h from private.case_input_heads where case_id=target_case;
 c:=private.source_intake_context_internal(target_case,h.revision,h.input_sha256);
 if not coalesce(c#>'{journal,legacy_orders}' @> jsonb_build_array(scope),false) or scope->>'case_id' is distinct from target_case::text then raise exception 'SOURCE_INTAKE_SCOPE';end if;
 for d in select x from jsonb_array_elements(c->'currentDocuments') x loop
  chosen:=null;first_hash:=null;conflict:=false;
  for a in select x from jsonb_array_elements(coalesce(c#>'{journal,answers}','[]'::jsonb)) x
   where x#>>'{field_target,schema_version}'='document-source-period-intake-v1'
    and x#>>'{field_target,order_id}'=scope->>'id' and x#>>'{field_target,order_receipt_sha256}'=scope->>'receipt_sha256'
    and x#>>'{field_target,product_document_id}'=d->>'id' and x#>>'{field_target,version_id}'=d->>'version_id' loop
   if not private.source_intake_target_current(target_case,a->'field_target') then continue;end if;
   answer:=(a->>'answer')::jsonb;answer_hash:=private.source_intake_journal_sha(answer);
   if chosen is null then chosen:=a;first_hash:=answer_hash;elsif first_hash<>answer_hash then conflict:=true;end if;
  end loop;
  if conflict then conflicts:=conflicts||jsonb_build_array(d->>'version_id');continue;end if;
  if chosen is null then continue;end if;
  answer:=(chosen->>'answer')::jsonb;
  if answer->>'action'<>'correct' or answer#>'{value,period}'='null'::jsonb
   or (answer#>>'{value,document_kind}' in ('payslip','attendance')) is not true then continue;end if;
  f:=(answer#>>'{value,period,from}')::date;l:=(answer#>>'{value,period,to}')::date;
  first_month:=date_trunc('month',f)::date;if f<>first_month then first_month:=(first_month+interval '1 month')::date;end if;
  if first_month+interval '1 month'-interval '1 day'>l then continue;end if;
  reading_body:=jsonb_build_object('schema_version','customer-source-period-intake-reading-v1','origin','customer_document_reading',
   'target',chosen->'field_target','request_id',chosen->>'id','answer_revision',chosen->'answer_revision','identity_id',chosen->>'answer_identity_id',
   'answered_at',to_char((chosen->>'answer_created_at')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'answer',answer);
  periods:=periods||jsonb_build_array(jsonb_build_object('period',answer#>'{value,period}','source_document_kind',answer#>>'{value,document_kind}',
   'reading_sha256',private.source_intake_journal_sha(reading_body),'source_pins',jsonb_build_array(jsonb_build_object('case_id',target_case,
   'document_id',d->>'id','version_id',d->>'version_id','source_sha256',d->>'sha256'))));
 end loop;
 body:=jsonb_build_object('schema_version','legacy-customer-source-periods-v1','order_id',scope->>'id','order_receipt_sha256',scope->>'receipt_sha256',
  'origin','customer_document_reading','purchase_period_unchanged',true,'periods',periods,'conflicts',conflicts);
 return body||jsonb_build_object('evidence_sha256',private.source_intake_journal_sha(body));
end;$$;
revoke all on function private.legacy_source_period_evidence(uuid,jsonb) from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

do $capture_coverage$
declare b text;
begin
 if to_regprocedure('private.legacy_scope_covers_month_before_intake_v1(jsonb,date)') is not null then raise exception 'SOURCE_INTAKE_ALREADY_INSTALLED';end if;
 b:=pg_get_functiondef('private.legacy_scope_covers_month(jsonb,date)'::regprocedure);
 execute replace(b,'FUNCTION private.legacy_scope_covers_month(','FUNCTION private.legacy_scope_covers_month_before_intake_v1(');
end;$capture_coverage$;
revoke all on function private.legacy_scope_covers_month_before_intake_v1(jsonb,date) from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
create or replace function private.legacy_scope_covers_month(scope jsonb,target_month date) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare evidence jsonb;
begin
 if private.legacy_scope_covers_month_before_intake_v1(scope,target_month) then return true;end if;
 if scope->>'period_state' is distinct from 'missing' or target_month is null or target_month<>date_trunc('month',target_month)::date then return false;end if;
 evidence:=private.legacy_source_period_evidence((scope->>'case_id')::uuid,scope);
 return exists(select 1 from jsonb_array_elements(evidence->'periods') p where (p#>>'{period,from}')::date<=target_month
  and (p#>>'{period,to}')::date>=(target_month+interval '1 month'-interval '1 day')::date);
exception when invalid_text_representation or datetime_field_overflow then return false;
end;$$;

alter table private.case_extraction_invocations add column source_period_evidence jsonb;
create function private.guard_extraction_source_period_evidence() returns trigger
language plpgsql security definer set search_path='' as $$
declare scope jsonb;e jsonb;
begin
 if tg_op='UPDATE' then
  if new.source_period_evidence is distinct from old.source_period_evidence then raise exception 'EXTRACTION_SOURCE_PERIOD_IMMUTABLE';end if;
  return new;
 end if;
 if new.source_period_evidence is null then return new;end if;
 select s into scope from jsonb_array_elements(private.legacy_paid_scopes_internal(new.case_id)) s
 where s->>'id'=new.source_period_evidence->>'order_id' and s->>'receipt_sha256'=new.source_period_evidence->>'order_receipt_sha256' and s->>'period_state'='missing';
 if scope is null then raise exception 'EXTRACTION_SOURCE_PERIOD_SCOPE';end if;
 e:=private.legacy_source_period_evidence(new.case_id,scope);
 if e is distinct from new.source_period_evidence or not exists(select 1 from jsonb_array_elements(e->'periods') p
  cross join lateral jsonb_array_elements(p->'source_pins') pin where p->>'source_document_kind'='payslip'
   and pin->>'version_id'=new.version_id::text and pin->>'source_sha256'=new.input_sha256
   and (p#>>'{period,from}')::date<=(new.expected_month||'-01')::date
   and (p#>>'{period,to}')::date>=((new.expected_month||'-01')::date+interval '1 month'-interval '1 day')::date)
 then raise exception 'EXTRACTION_SOURCE_PERIOD_SCOPE';end if;
 return new;
end;$$;
revoke all on function private.guard_extraction_source_period_evidence() from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
create trigger extraction_source_period_evidence_guard before insert or update on private.case_extraction_invocations
 for each row execute function private.guard_extraction_source_period_evidence();

-- Preserve the installed historical implementations and branch only on the
-- new discriminant. Existing field target and answer bytes remain untouched.
do $capture$
declare b text;constraint_body text;
begin
 if to_regprocedure('private.document_field_current_before_intake_v1(uuid,jsonb)') is not null then raise exception 'SOURCE_INTAKE_ALREADY_INSTALLED';end if;
 b:=pg_get_functiondef('private.document_field_current(uuid,jsonb)'::regprocedure);
 if position('document_field_current_before_structure_period_v2' in b)=0 then raise exception 'SOURCE_INTAKE_BASE_190_REQUIRED';end if;
 execute replace(b,'FUNCTION private.document_field_current(','FUNCTION private.document_field_current_before_intake_v1(');
 b:=pg_get_functiondef('private.document_field_request_open(uuid,integer,text,jsonb,text)'::regprocedure);
 execute replace(b,'FUNCTION private.document_field_request_open(','FUNCTION private.document_field_request_open_before_intake_v1(');
 select pg_get_constraintdef(oid) into constraint_body from pg_constraint where conrelid='private.document_field_targets'::regclass and conname='document_field_targets_check';
 if position('''document-source-period-association-v1''::text' in constraint_body)=0 then raise exception 'SOURCE_INTAKE_TARGET_CONSTRAINT_BASE';end if;
 alter table private.document_field_targets drop constraint document_field_targets_check;
 execute 'alter table private.document_field_targets add constraint document_field_targets_check '||replace(constraint_body,
  '''document-source-period-association-v1''::text','''document-source-period-association-v1''::text, ''document-source-period-intake-v1''::text');
 b:=pg_get_functiondef('private.guard_document_cell_decision()'::regprocedure);
 if position('case when t->>''schema_version'' in (''document-source-relationship-v2'',''document-source-deduction-group-v2'')' in b)=0 then raise exception 'SOURCE_INTAKE_ANSWER_GUARD_BASE';end if;
 execute replace(b,'case when t->>''schema_version'' in (''document-source-relationship-v2'',''document-source-deduction-group-v2'')',
  'case when t->>''schema_version''=''document-source-period-intake-v1'' then private.source_intake_answer_valid(t,answer) when t->>''schema_version'' in (''document-source-relationship-v2'',''document-source-deduction-group-v2'')');
end;$capture$;
revoke all on function private.document_field_current_before_intake_v1(uuid,jsonb),private.document_field_request_open_before_intake_v1(uuid,integer,text,jsonb,text)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

create or replace function private.document_field_current(target_case uuid,target jsonb) returns boolean
language sql security definer set search_path='' as $$
 select case when target->>'schema_version'='document-source-period-intake-v1' then private.source_intake_target_current(target_case,target)
 else private.document_field_current_before_intake_v1(target_case,target) end;$$;

create or replace function private.document_field_request_open(target_case uuid,expected_revision integer,expected_input_sha256 text,target_payload jsonb,target_question text) returns uuid
language plpgsql security definer set search_path='' as $$
declare old public.case_requests;request_id uuid;h private.case_input_heads;generation integer:=0;predecessor uuid;
begin
 if target_payload->>'schema_version' is distinct from 'document-source-period-intake-v1' then
  return private.document_field_request_open_before_intake_v1(target_case,expected_revision,expected_input_sha256,target_payload,target_question);end if;
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;if not found then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 select * into h from private.case_input_heads where case_id=target_case;
 if h.revision is distinct from expected_revision or h.input_sha256 is distinct from expected_input_sha256 then raise exception 'REQUEST_FIELD_SOURCE_CHANGED';end if;
 if not private.source_intake_target_current(target_case,target_payload) then raise exception 'REQUEST_FIELD_SOURCE_CHANGED';end if;
 if target_question is distinct from 'מה סוג המסמך ומהם תאריכי התקופה המופיעים בו? יש להעתיק את כותרת התקופה או לציין שלא מוצגת תקופה.' then raise exception 'REQUEST_FIELD_TARGET_INVALID';end if;
 -- Dedupe logical source identity, not the answer-created head revision.
 select r.* into old from private.document_field_targets t join public.case_requests r on r.id=t.request_id and r.case_id=t.case_id
 where t.case_id=target_case and t.target->>'schema_version'='document-source-period-intake-v1'
  and t.target->>'order_id'=target_payload->>'order_id' and t.target->>'order_receipt_sha256'=target_payload->>'order_receipt_sha256'
  and t.target->>'version_id'=target_payload->>'version_id' and t.target->>'source_sha256'=target_payload->>'source_sha256'
  and private.source_intake_target_current(target_case,t.target)
 order by t.created_at desc limit 1;
 if old.id is not null and (old.answered_at is not null or old.expired_at is null and old.expires_at>clock_timestamp()) then return old.id;end if;
 select f.request_id,f.renewal_index into predecessor,generation from private.document_field_targets f
 where f.case_id=target_case and f.target_sha256=target_payload->>'target_sha256' order by f.renewal_index desc limit 1;
 if predecessor is not null then
  select * into old from public.case_requests where id=predecessor for update;
  if old.answered_at is not null or old.expired_at is null and old.expires_at>clock_timestamp() then return old.id;end if;
  if old.expires_at>clock_timestamp() then raise exception 'REQUEST_FIELD_RENEWAL_NOT_DUE';end if;
  update public.case_requests set expired_at=coalesce(expired_at,clock_timestamp()) where id=predecessor and answered_at is null;
  generation:=generation+1;
 else generation:=0;end if;
 request_id:=gen_random_uuid();
 insert into private.document_field_targets(request_id,case_id,target_sha256,target,renewal_index,predecessor_request_id)
 values(request_id,target_case,target_payload->>'target_sha256',target_payload,generation,predecessor);
 insert into public.case_requests(id,case_id,code,question,answer_kind,options,field_crop,blocking,expires_at,statement_month)
 values(request_id,target_case,'document_field:'||(target_payload->>'target_sha256'),target_question,'choice',
  array['העתקת הפרט מהמקור','לא ניתן לקרוא','לא יודע/ת'],'source.period_and_type',true,clock_timestamp()+interval '10 days',null);
 return request_id;
end;$$;

create table private.legacy_source_upload_bindings(
 batch_id uuid primary key,case_id uuid not null references public.cases(id),request_id uuid not null,
 scope jsonb not null,existing_source_hashes jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table private.legacy_source_upload_receipts(
 batch_id uuid primary key,case_id uuid not null references public.cases(id),request_id uuid not null,
 receipt_sha256 text not null check(receipt_sha256~'^[a-f0-9]{64}$'),receipt jsonb not null,created_at timestamptz not null default clock_timestamp()
);
alter table private.legacy_source_upload_bindings enable row level security;
alter table private.legacy_source_upload_receipts enable row level security;
revoke all on private.legacy_source_upload_bindings,private.legacy_source_upload_receipts from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
create trigger legacy_source_upload_binding_immutable before update or delete on private.legacy_source_upload_bindings
 for each row execute function private.document_physical_page_receipt_guard();
create trigger legacy_source_upload_receipt_immutable before update or delete on private.legacy_source_upload_receipts
 for each row execute function private.document_physical_page_receipt_guard();

create function private.legacy_source_upload_validate(target_case uuid,target_batch uuid,m jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t jsonb;r public.case_requests;actor private.document_upload_actors;
begin
 if not m?'sourceIntake' then return null;end if;
 if session_user not in ('tivdoc_web_runtime','service_role','authenticator') then raise exception 'UPLOAD_FORBIDDEN';end if;
 select * into actor from private.document_upload_actors where batch_id=target_batch and case_id=target_case;
 if actor.batch_id is null or not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=actor.identity_id) then raise exception 'UPLOAD_FORBIDDEN';end if;
 select * into r from public.case_requests where id=(m->>'requestId')::uuid and case_id=target_case;
 select target into t from private.legacy_source_document_targets where request_id=r.id and case_id=target_case;
 if r.id is null or r.answer_kind<>'document' or r.answered_at is not null or r.expired_at is not null or r.expires_at<=clock_timestamp()
  or not private.source_intake_target_current(target_case,t)
  or m->'sourceIntake' is distinct from jsonb_build_object('policy','legacy-source-intake-v1','target_sha256',t->>'target_sha256')
  or m?'checkPeriodMonth' or exists(select 1 from jsonb_array_elements(m->'files') f
   where (f->>'documentType' in ('payslip','attendance','contract')) is not true or f?'periodMonth' or f?'evidencePurpose') then raise exception 'UPLOAD_REQUEST_CONFLICT';end if;
 return jsonb_build_object('schema_version','legacy-source-intake-upload-scope-v1','request_id',r.id,'target',t);
end;$$;
revoke all on function private.legacy_source_upload_validate(uuid,uuid,jsonb) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function private.legacy_source_upload_validate(uuid,uuid,jsonb) to tivdoc_web_runtime,service_role;

create function private.legacy_source_upload_bind(target_case uuid,target_batch uuid) returns void
language plpgsql security definer set search_path='' as $$
declare b public.document_upload_batches;s jsonb;
begin
 select * into b from public.document_upload_batches where id=target_batch and case_id=target_case;
 if b.id is null then raise exception 'UPLOAD_FORBIDDEN';end if;
 s:=private.legacy_source_upload_validate(target_case,target_batch,b.manifest);if s is null then return;end if;
 insert into private.legacy_source_upload_bindings(batch_id,case_id,request_id,scope,existing_source_hashes)
 values(target_batch,target_case,(s->>'request_id')::uuid,s,coalesce((select jsonb_agg(content_sha256) from public.documents where case_id=target_case),'[]'::jsonb));
end;$$;
revoke all on function private.legacy_source_upload_bind(uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function private.legacy_source_upload_bind(uuid,uuid) to tivdoc_web_runtime,service_role;

create function private.legacy_source_upload_scope(target_case uuid,target_batch uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select scope from private.legacy_source_upload_bindings where case_id=target_case and batch_id=target_batch;$$;
revoke all on function private.legacy_source_upload_scope(uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function private.legacy_source_upload_scope(uuid,uuid) to tivdoc_web_runtime,service_role;

create function private.legacy_source_upload_commit_guard(target_case uuid,target_batch uuid) returns void
language plpgsql security definer set search_path='' as $$
declare b public.document_upload_batches;s jsonb;
begin
 select * into b from public.document_upload_batches where id=target_batch and case_id=target_case;
 s:=private.legacy_source_upload_scope(target_case,target_batch);
 if b.manifest?'sourceIntake' then
  if s is null or s is distinct from private.legacy_source_upload_validate(target_case,target_batch,b.manifest)
   or private.document_review_upload_batch_scope(target_case,target_batch) is not null then raise exception 'UPLOAD_REQUEST_CONFLICT';end if;
 elsif s is not null then raise exception 'UPLOAD_REQUEST_CONFLICT';end if;
end;$$;
revoke all on function private.legacy_source_upload_commit_guard(uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function private.legacy_source_upload_commit_guard(uuid,uuid) to tivdoc_web_runtime,service_role;

create function private.upload_physical_pages_record(target_case uuid,target_batch uuid,checks jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare b public.document_upload_batches;f jsonb;p jsonb;
begin
 if session_user not in ('tivdoc_web_runtime','service_role') then raise exception 'UPLOAD_FORBIDDEN';end if;
 select * into b from public.document_upload_batches where id=target_batch and case_id=target_case;
 if b.id is null then raise exception 'UPLOAD_FORBIDDEN';end if;
 for f in select x from jsonb_array_elements(b.files) x loop
  p:=checks->('physical:'||(f->>'versionId'));
  if p is null and not b.manifest?'sourceIntake' then continue;end if; -- old API clients remain readable
  if p is distinct from jsonb_build_object('page_count',p->'page_count') or jsonb_typeof(p->'page_count') is distinct from 'number'
   or (p->>'page_count'~'^[1-9][0-9]?$|^100$') is not true then raise exception 'UPLOAD_UNVERIFIED';end if;
  perform private.document_physical_pages_record(target_case,(f->>'documentId')::uuid,(f->>'versionId')::uuid,f->>'sha256',(f->>'size')::bigint,f->>'type',(p->>'page_count')::integer);
 end loop;
end;$$;
revoke all on function private.upload_physical_pages_record(uuid,uuid,jsonb) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function private.upload_physical_pages_record(uuid,uuid,jsonb) to tivdoc_web_runtime,service_role;

create function private.legacy_source_upload_received(target_case uuid,target_batch uuid) returns void
language plpgsql security definer set search_path='' as $$
declare b public.document_upload_batches;s private.legacy_source_upload_bindings;t jsonb;f jsonb;files jsonb:='[]'::jsonb;body jsonb;p integer;
begin
 select * into s from private.legacy_source_upload_bindings where case_id=target_case and batch_id=target_batch;
 if s.batch_id is null then return;end if;
 select * into b from public.document_upload_batches where id=target_batch and case_id=target_case;t:=s.scope->'target';
 if exists(select 1 from private.legacy_source_upload_receipts where batch_id=target_batch) then return;end if;
 for f in select x from jsonb_array_elements(b.files) x order by x->>'versionId' loop
  select page_count into p from private.document_physical_page_receipts where case_id=target_case and document_id=(f->>'documentId')::uuid
   and version_id=(f->>'versionId')::uuid and source_sha256=f->>'sha256';
  if p is null then raise exception 'UPLOAD_UNVERIFIED';end if;
  files:=files||jsonb_build_array(jsonb_build_object('document_id',f->>'documentId','version_id',f->>'versionId','source_sha256',f->>'sha256',
   'document_kind',f->>'documentType','period_month',null,'page_count',p,'duplicate_content',s.existing_source_hashes @> jsonb_build_array(f->>'sha256')
    or (select count(*) from jsonb_array_elements(b.files) x where x->>'sha256'=f->>'sha256')>1
    or exists(select 1 from public.documents d where d.case_id=target_case and d.content_sha256=f->>'sha256'
      and not exists(select 1 from jsonb_array_elements(b.files) x where x->>'versionId'=d.version_id::text))));
 end loop;
 body:=jsonb_build_object('schema_version','legacy-source-intake-upload-receipt-v1','case_id',target_case,'request_id',s.request_id,
  'target_sha256',t->>'target_sha256','order_id',t->>'order_id','order_origin','legacy_paid_receipt','order_receipt_sha256',t->>'order_receipt_sha256',
  'purchased_topics',t->'purchased_topics','month',t->'month','batch_id',target_batch,'received_at',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'state','received_pending_reading','information_satisfied',false,'files',files);
 insert into private.legacy_source_upload_receipts(batch_id,case_id,request_id,receipt_sha256,receipt)
 values(target_batch,target_case,s.request_id,private.source_intake_journal_sha(body),body||jsonb_build_object('receipt_sha256',private.source_intake_journal_sha(body)));
end;$$;
revoke all on function private.legacy_source_upload_received(uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function private.legacy_source_upload_received(uuid,uuid) to tivdoc_web_runtime,service_role;

create function private.legacy_source_upload_snapshot(target_case uuid,snapshot jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare requests jsonb;receipts jsonb;
begin
 if snapshot->>'caseId' is distinct from target_case::text then raise exception 'UPLOAD_FORBIDDEN';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'code',r.code,'question',r.question,'documentType','payslip',
  'sourceIntake',jsonb_build_object('policy','legacy-source-intake-v1','target_sha256',t.target_sha256,'month',t.target->'month')) order by r.opened_at),'[]'::jsonb) into requests
 from public.case_requests r join private.legacy_source_document_targets t on t.case_id=r.case_id and t.request_id=r.id
 where r.case_id=target_case and r.answered_at is null and r.expired_at is null and r.expires_at>clock_timestamp()
  and private.source_intake_target_current(target_case,t.target);
 select coalesce(jsonb_agg(receipt order by created_at),'[]'::jsonb) into receipts from private.legacy_source_upload_receipts where case_id=target_case;
 return jsonb_set(snapshot,'{requests}',coalesce(snapshot->'requests','[]'::jsonb)||requests)||jsonb_build_object('sourceIntakeReceipts',receipts);
end;$$;
revoke all on function private.legacy_source_upload_snapshot(uuid,jsonb) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function private.legacy_source_upload_snapshot(uuid,jsonb) to tivdoc_web_runtime,service_role;

-- Exact guarded insertion points in the existing allocator/finalizer. No slot,
-- storage, capacity, replacement, current-source or idempotency check is removed.
do $upload_intake_hooks$
declare b text;needle text;
begin
 b:=pg_get_functiondef('public.case_documents_reserve(uuid,uuid,jsonb)'::regprocedure);
 if position('perform private.document_review_upload_bind(target_case,target_batch);' in b)=0 or position('sourceIntake' in b)>0 then raise exception 'SOURCE_INTAKE_RESERVE_BASE';end if;
 b:=replace(b,'request_type text; requested_month date; effective_month date;','request_type text; requested_month date; effective_month date; intake jsonb;');
 b:=replace(b,'  if jsonb_typeof(target_manifest->''files'')',E'  intake:=private.legacy_source_upload_validate(target_case,target_batch,target_manifest);\n  if jsonb_typeof(target_manifest->''files'')');
 b:=replace(b,'if f->>''documentType'' = ''payslip'' then'||E'\n      if coalesce(f->>''periodMonth''',
  'if intake is not null then'||E'\n      if f ? ''periodMonth'' then raise exception ''UPLOAD_INVALID'';end if;\n    elsif f->>''documentType'' = ''payslip'' then\n      if coalesce(f->>''periodMonth''');
 b:=replace(b,'  if not exists(select 1 from public.documents where case_id = target_case and document_type = ''payslip'')',
  '  if intake is null and not exists(select 1 from public.documents where case_id = target_case and document_type = ''payslip'')');
 b:=replace(b,'    if r.code like ''document_review:%'' then',E'    if intake is not null then\n      if r.id::text is distinct from intake->>''request_id'' then raise exception ''UPLOAD_REQUEST_CONFLICT'';end if;\n    elsif r.code like ''document_review:%'' then');
 b:=replace(b,'  if effective_month is not null and not (','  if intake is null and effective_month is not null and not (');
 b:=replace(b,'  perform private.document_review_upload_bind(target_case,target_batch);',
  E'  if intake is not null then perform private.legacy_source_upload_bind(target_case,target_batch);\n  else perform private.document_review_upload_bind(target_case,target_batch);end if;');
 b:=replace(b,'''review_scope'',private.document_review_upload_batch_scope(target_case,target_batch)',
  '''review_scope'',private.document_review_upload_batch_scope(target_case,target_batch),''source_intake_scope'',private.legacy_source_upload_scope(target_case,target_batch)');
 if position('elsif f->>''documentType'' = ''payslip'' then' in b)=0 then raise exception 'SOURCE_INTAKE_RESERVE_MONTH_PATCH';end if;
 execute b;
 b:=pg_get_functiondef('public.case_documents_commit(uuid,uuid,jsonb)'::regprocedure);
 if position('perform private.document_review_upload_commit_guard(target_case,target_batch);' in b)=0 or position('sourceIntake' in b)>0 then raise exception 'SOURCE_INTAKE_COMMIT_BASE';end if;
 b:=replace(b,'  perform private.document_review_upload_commit_guard(target_case,target_batch);',
  E'  perform private.legacy_source_upload_commit_guard(target_case,target_batch);\n  perform private.document_review_upload_commit_guard(target_case,target_batch);');
 b:=replace(b,'  if not exists(select 1 from public.documents where case_id = target_case and document_type = ''payslip'')',
  '  if not b.manifest?''sourceIntake'' and not exists(select 1 from public.documents where case_id = target_case and document_type = ''payslip'')');
 b:=replace(b,'  if month is not null and not exists(','  if not b.manifest?''sourceIntake'' and month is not null and not exists(');
 needle:='  if private.document_review_upload_batch_scope(target_case,target_batch) is not null then'||E'\n    perform private.document_review_upload_received(target_case,target_batch,target_checks);';
 if position(needle in b)=0 then raise exception 'SOURCE_INTAKE_COMMIT_RECEIVED_PATCH';end if;
 b:=replace(b,needle,E'  perform private.upload_physical_pages_record(target_case,target_batch,target_checks);\n  if b.manifest?''sourceIntake'' then\n    perform private.legacy_source_upload_received(target_case,target_batch);\n  elsif private.document_review_upload_batch_scope(target_case,target_batch) is not null then\n    perform private.document_review_upload_received(target_case,target_batch,target_checks);');
 b:=replace(b,'  return public.case_documents_snapshot(target_case);',E'  if b.manifest?''sourceIntake'' then perform private.capture_case_input(target_case,''legacy_source_upload_received'');end if;\n  return public.case_documents_snapshot(target_case);');
 execute b;
 b:=pg_get_functiondef('public.case_documents_batch(uuid,uuid)'::regprocedure);
 if position('''review_scope'',private.document_review_upload_batch_scope(target_case,target_batch)' in b)=0 then raise exception 'SOURCE_INTAKE_BATCH_BASE';end if;
 execute replace(b,'''review_scope'',private.document_review_upload_batch_scope(target_case,target_batch)',
  '''review_scope'',private.document_review_upload_batch_scope(target_case,target_batch),''source_intake_scope'',private.legacy_source_upload_scope(target_case,target_batch)');
 b:=pg_get_functiondef('public.case_documents_snapshot(uuid)'::regprocedure);
 execute replace(b,'FUNCTION public.case_documents_snapshot(','FUNCTION private.case_documents_snapshot_before_intake_v1(');
 b:=pg_get_functiondef('private.managed_dev_worker_note(uuid,text,bigint,text)'::regprocedure);
 if position('''purchased_document_missing'',''entitlement_unavailable''' in b)=0 then raise exception 'SOURCE_INTAKE_NOTE_BASE';end if;
 execute replace(b,'''purchased_document_missing'',''entitlement_unavailable''',
  '''purchased_document_missing'',''source_intake_required'',''source_integrity_required'',''source_file_unavailable'',''entitlement_unavailable''');
end;$upload_intake_hooks$;
revoke all on function private.case_documents_snapshot_before_intake_v1(uuid) from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function private.case_documents_snapshot_before_intake_v1(uuid) to tivdoc_web_runtime,service_role;
create or replace function public.case_documents_snapshot(target_case uuid) returns jsonb
language sql security invoker set search_path='' as $$
 select private.legacy_source_upload_snapshot(target_case,private.case_documents_snapshot_before_intake_v1(target_case));$$;

create function private.source_upload_contexts_internal(target_case uuid,expected_revision bigint,expected_sha text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare context jsonb;item jsonb;items jsonb:='[]'::jsonb;t private.legacy_source_document_targets;v private.case_input_versions;r jsonb;anchors jsonb;linked jsonb;
begin
 context:=private.source_intake_context_internal(target_case,expected_revision,expected_sha);
 for t in select x.* from private.legacy_source_document_targets x join public.case_requests q on q.id=x.request_id and q.case_id=x.case_id
  where x.case_id=target_case order by x.created_at loop
  select * into v from private.case_input_versions where case_id=target_case and revision=(t.target->>'source_revision')::bigint;
  if v.case_id is null or v.input_sha256 is distinct from t.target->>'source_input_sha256'
   or private.source_intake_journal_sha(v.input) is distinct from t.target->>'source_journal_sha256'
   or v.input_sha256 is distinct from encode(sha256(convert_to(v.input::text,'UTF8')),'hex') then raise exception 'SOURCE_INTAKE_ANCHOR_HASH';end if;
  anchors:=context->'sourceAnchors';
  if not exists(select 1 from jsonb_array_elements(anchors) a where a->'revision'=t.target->'source_revision') then
   anchors:=anchors||jsonb_build_array(jsonb_build_object('revision',v.revision,'input_sha256',v.input_sha256,'journal_sha256',private.source_intake_journal_sha(v.input),'input',v.input));end if;
  select receipt into r from private.legacy_source_upload_receipts where request_id=t.request_id and case_id=target_case order by created_at desc limit 1;
  select coalesce(jsonb_agg(f.request_id order by f.created_at),'[]'::jsonb) into linked from (
   select distinct on (x.target->>'version_id') x.request_id,x.created_at from private.document_field_targets x
   join public.case_requests q on q.id=x.request_id and q.case_id=x.case_id
   where x.case_id=target_case and x.target->>'schema_version'='document-source-period-intake-v1'
    and x.target->>'order_id'=t.target->>'order_id' and x.target->>'order_receipt_sha256'=t.target->>'order_receipt_sha256'
    and private.source_intake_target_current(target_case,x.target)
    and (q.answered_at is not null or q.expired_at is null and q.expires_at>clock_timestamp())
    and r is not null and exists(select 1 from jsonb_array_elements(r->'files') p where p->>'version_id'=x.target->>'version_id')
   order by x.target->>'version_id',x.created_at desc,x.request_id desc) f;
  items:=items||jsonb_build_array(jsonb_build_object('scope',jsonb_build_object('schema_version','legacy-source-intake-upload-scope-v1','request_id',t.request_id,'target',t.target),
   'receipt',r,'journalContext',jsonb_set(context,'{sourceAnchors}',anchors),'reading_request_ids',linked));
 end loop;
 return items;
end;$$;
revoke all on function private.source_upload_contexts_internal(uuid,bigint,text) from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
create function public.case_request_source_intake_upload_context(target_case uuid,target_identity uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare h private.case_input_heads;
begin
 if session_user not in ('tivdoc_web_runtime','service_role') or not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity)
  then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 select * into h from private.case_input_heads where case_id=target_case;
 return private.source_upload_contexts_internal(target_case,h.revision,h.input_sha256);
end;$$;
revoke all on function public.case_request_source_intake_upload_context(uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function public.case_request_source_intake_upload_context(uuid,uuid) to tivdoc_web_runtime,service_role;
create function private.legacy_source_upload_assessment_context(target_case uuid,expected_revision bigint,expected_sha text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'SOURCE_INTAKE_FORBIDDEN';end if;
 return private.source_upload_contexts_internal(target_case,expected_revision,expected_sha);
end;$$;
revoke all on function private.legacy_source_upload_assessment_context(uuid,bigint,text) from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function private.legacy_source_upload_assessment_context(uuid,bigint,text) to tivdoc_worker_runtime;

create table private.legacy_source_upload_assessments(
 assessment_sha256 text primary key check(assessment_sha256~'^[a-f0-9]{64}$'),case_id uuid not null references public.cases(id),
 request_id uuid not null,source_revision bigint not null,assessment jsonb not null,created_at timestamptz not null default clock_timestamp()
);
alter table private.legacy_source_upload_assessments enable row level security;
revoke all on private.legacy_source_upload_assessments from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
create trigger legacy_source_upload_assessment_immutable before update or delete on private.legacy_source_upload_assessments
 for each row execute function private.document_physical_page_receipt_guard();
create function private.source_upload_assessment_replay(target_case uuid,expected_revision bigint,expected_sha text,a jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare contexts jsonb;ctx jsonb;r jsonb;j jsonb;scope jsonb;e jsonb;accepted jsonb;reading_hashes jsonb:='[]'::jsonb;pins jsonb:='[]'::jsonb;
 state text;reason text;body jsonb;matching jsonb;
begin
 contexts:=private.source_upload_contexts_internal(target_case,expected_revision,expected_sha);
 select c into ctx from jsonb_array_elements(contexts) c where c#>>'{scope,request_id}'=a->>'request_id' and c#>>'{receipt,receipt_sha256}'=a->>'receipt_sha256';
 if ctx is null then raise exception 'SOURCE_INTAKE_ASSESSMENT_SCOPE';end if;
 r:=ctx->'receipt';j:=ctx#>'{journalContext,journal}';
 select s into scope from jsonb_array_elements(j->'legacy_orders') s where s->>'id'=r->>'order_id' and s->>'receipt_sha256'=r->>'order_receipt_sha256';
 if scope is null then raise exception 'SOURCE_INTAKE_ASSESSMENT_SCOPE';end if;
 select coalesce(jsonb_agg(x),'[]'::jsonb) into matching from jsonb_array_elements(coalesce(j->'answers','[]'::jsonb)) x
 where x#>>'{field_target,schema_version}'='document-source-period-intake-v1' and x#>>'{field_target,order_id}'=r->>'order_id'
  and x#>>'{field_target,order_receipt_sha256}'=r->>'order_receipt_sha256' and private.source_intake_target_current(target_case,x->'field_target')
  and exists(select 1 from jsonb_array_elements(r->'files') f where f->>'version_id'=x#>>'{field_target,version_id}' and f->>'source_sha256'=x#>>'{field_target,source_sha256}');
 if exists(select 1 from jsonb_array_elements(r->'files') f where not exists(select 1 from jsonb_array_elements(ctx#>'{journalContext,currentDocuments}') d
  where d->>'id'=f->>'document_id' and d->>'version_id'=f->>'version_id' and d->>'sha256'=f->>'source_sha256' and d->>'type'=f->>'document_kind' and d->'page_count'=f->'page_count')) then
  state:='stale';reason:='submitted_source_replaced';
 elsif exists(select 1 from jsonb_array_elements(r->'files') f where f->'duplicate_content'='true'::jsonb) then state:='insufficient';reason:='duplicate_content';
 elsif matching='[]'::jsonb then state:='received_pending_reading';reason:='source_reading_required';
 elsif exists(select 1 from jsonb_array_elements(matching) x where ((x->>'answer')::jsonb)->>'action'<>'correct') then state:='insufficient';reason:='source_reading_unresolved';
 else
  e:=private.legacy_source_period_evidence(target_case,scope);
  select coalesce(jsonb_agg(p),'[]'::jsonb) into accepted from jsonb_array_elements(e->'periods') p
  where exists(select 1 from jsonb_array_elements(p->'source_pins') pin join jsonb_array_elements(r->'files') f on f->>'version_id'=pin->>'version_id' and f->>'source_sha256'=pin->>'source_sha256')
   and (r->>'month' is null or p->>'source_document_kind'='payslip' and (p#>>'{period,from}')::date<=(r->>'month'||'-01')::date and (p#>>'{period,to}')::date>=((r->>'month'||'-01')::date+interval '1 month'-interval '1 day')::date);
  if accepted='[]'::jsonb or exists(select 1 from jsonb_array_elements_text(e->'conflicts') v join jsonb_array_elements(r->'files') f on f->>'version_id'=v) then
   state:='insufficient';reason:='complete_month_not_identified';
  else
   state:='satisfied';reason:='source_period_identified';
   select jsonb_agg(p->>'reading_sha256' order by p->>'reading_sha256') into reading_hashes from jsonb_array_elements(accepted) p;
   select jsonb_agg(jsonb_build_object('case_id',target_case,'document_id',f->>'document_id','version_id',f->>'version_id','source_sha256',f->>'source_sha256') order by f->>'version_id') into pins
   from jsonb_array_elements(r->'files') f where exists(select 1 from jsonb_array_elements(accepted) p cross join lateral jsonb_array_elements(p->'source_pins') pin
    where pin->>'document_id'=f->>'document_id' and pin->>'version_id'=f->>'version_id' and pin->>'source_sha256'=f->>'source_sha256');
  end if;
 end if;
 body:=jsonb_build_object('schema_version','legacy-source-intake-upload-assessment-v1','case_id',target_case,'request_id',r->>'request_id','receipt_sha256',r->>'receipt_sha256',
  'target_sha256',r->>'target_sha256','source_revision',expected_revision,'source_input_sha256',expected_sha,'source_journal_sha256',ctx#>>'{journalContext,journalSha256}',
  'state',state,'reason',reason,'information_satisfied',state='satisfied','reading_sha256s',reading_hashes,'verified_source_pins',pins,'financial_analysis_completed',false);
 return body||jsonb_build_object('assessment_sha256',private.source_intake_journal_sha(body));
end;$$;
revoke all on function private.source_upload_assessment_replay(uuid,bigint,text,jsonb) from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
create function private.legacy_source_upload_assessment_record(target_case uuid,expected_revision bigint,expected_sha text,a jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare expected jsonb;
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'SOURCE_INTAKE_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;
 expected:=private.source_upload_assessment_replay(target_case,expected_revision,expected_sha,a);
 if a is distinct from expected then raise exception 'SOURCE_INTAKE_ASSESSMENT_MISMATCH';end if;
 insert into private.legacy_source_upload_assessments(assessment_sha256,case_id,request_id,source_revision,assessment)
 values(a->>'assessment_sha256',target_case,(a->>'request_id')::uuid,expected_revision,a) on conflict(assessment_sha256) do nothing;
 return true;
end;$$;
revoke all on function private.legacy_source_upload_assessment_record(uuid,bigint,text,jsonb) from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function private.legacy_source_upload_assessment_record(uuid,bigint,text,jsonb) to tivdoc_worker_runtime;

create function private.document_field_request_answer_valid(target_case uuid,target_request uuid,answer text) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare t jsonb;
begin
 select target into t from private.document_field_targets where case_id=target_case and request_id=target_request;
 if t->>'schema_version'='document-source-period-intake-v1' then return private.source_intake_answer_valid(t,answer);end if;
 return private.document_field_answer_envelope_valid(answer);
end;$$;
revoke all on function private.document_field_request_answer_valid(uuid,uuid,text) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function private.document_field_request_answer_valid(uuid,uuid,text) to tivdoc_web_runtime,service_role;
do $answer_envelope$
declare signature text;b text;
begin
 foreach signature in array array['public.case_request_answer(uuid,uuid,text)','public.case_request_edit(uuid,uuid,uuid,text,integer,text)'] loop
  b:=pg_get_functiondef(signature::regprocedure);
  if position('private.document_field_answer_envelope_valid(answer)' in b)=0 then raise exception 'SOURCE_INTAKE_ANSWER_ENVELOPE_BASE';end if;
  execute replace(b,'private.document_field_answer_envelope_valid(answer)','private.document_field_request_answer_valid(target_case,target_request,answer)');
 end loop;
end;$answer_envelope$;

-- Use the exact same deterministic assessment as the worker and UI. A reply
-- may satisfy intake before the next worker tick; an old queued reminder must
-- not race that tick and ask for the same already identified source again.
create function private.legacy_source_upload_information_satisfied(target_case uuid,target_request uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare t jsonb;r jsonb;h private.case_input_heads;a jsonb;
begin
 select x.target into t from private.legacy_source_document_targets x join public.case_requests q on q.id=x.request_id and q.case_id=x.case_id
 where x.case_id=target_case and x.request_id=target_request and q.answer_kind='document'
  and q.code='legacy.source.document:'||(x.target->>'order_id')||case when x.target->>'month' is null then '' else ':'||(x.target->>'month') end;
 if t is null or not private.source_intake_target_current(target_case,t) then return false;end if;
 select x.receipt into r from private.legacy_source_upload_receipts x join public.document_upload_batches b on b.id=x.batch_id and b.case_id=x.case_id
 where x.case_id=target_case and x.request_id=target_request and b.completed_at is not null and b.cancelled_at is null order by x.created_at desc limit 1;
 if r is null then return false;end if;
 if r->>'receipt_sha256' is distinct from private.source_intake_journal_sha(r-'receipt_sha256')
  or r->>'target_sha256' is distinct from t->>'target_sha256' or r->>'order_id' is distinct from t->>'order_id'
  or r->>'order_receipt_sha256' is distinct from t->>'order_receipt_sha256' or r->'purchased_topics' is distinct from t->'purchased_topics'
  or r->'month' is distinct from t->'month' then return false;end if;
 select * into h from private.case_input_heads where case_id=target_case;
 a:=private.source_upload_assessment_replay(target_case,h.revision,h.input_sha256,jsonb_build_object('request_id',target_request,'receipt_sha256',r->>'receipt_sha256'));
 return a->>'state'='satisfied' and a->'information_satisfied'='true'::jsonb and a->'financial_analysis_completed'='false'::jsonb;
end;$$;
revoke all on function private.legacy_source_upload_information_satisfied(uuid,uuid) from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

do $source_intake_operations$
declare b text;needle text;
begin
 b:=pg_get_functiondef('private.managed_dev_event_source_current_before_owner_v1(uuid,text)'::regprocedure);
 needle:='or exists(select 1 from private.dev_financial_request_targets t where t.request_id=q.id and';
 if position(needle in b)=0 then raise exception 'SOURCE_INTAKE_OPS_CURRENT_BASE';end if;
 execute replace(b,needle,'or exists(select 1 from private.legacy_source_document_targets t where t.case_id=target_case and t.request_id=q.id and q.expired_at is null and private.source_intake_target_current(target_case,t.target) and not private.legacy_source_upload_information_satisfied(target_case,q.id)) '||needle);
 b:=pg_get_functiondef('private.document_review_information_satisfied_for_sweep(uuid,uuid)'::regprocedure);
 needle:='return exists(select 1 from public.case_requests q';
 if position(needle in b)=0 then raise exception 'SOURCE_INTAKE_SWEEP_BASE';end if;
 execute replace(b,needle,'return private.legacy_source_upload_information_satisfied(target_case,target_request) or exists(select 1 from public.case_requests q');
 b:=pg_get_functiondef('public.case_notification_request_reminders(integer)'::regprocedure);
 needle:=' order by e.occurred_at,e.request_id limit target_limit;';
 if position(needle in b)=0 then raise exception 'SOURCE_INTAKE_REMINDER_DISCOVERY_BASE';end if;
 execute replace(b,needle,E' and not private.legacy_source_upload_information_satisfied(r.case_id,r.id)\n'||needle);
 b:=pg_get_functiondef('public.case_notification_reminder_enqueue(uuid,text,text,uuid,uuid,text,jsonb,timestamptz)'::regprocedure);
 needle:=' for update of r,e;';
 if position(needle in b)=0 then raise exception 'SOURCE_INTAKE_REMINDER_ENQUEUE_BASE';end if;
 execute replace(b,needle,' and not private.legacy_source_upload_information_satisfied(r.case_id,r.id)'||needle);
 b:=pg_get_functiondef('public.case_notification_outbox_claim(uuid)'::regprocedure);
 needle:='r.answered_at is not null or r.expired_at is not null or r.expires_at<=now()';
 if position(needle in b)=0 then raise exception 'SOURCE_INTAKE_REMINDER_CLAIM_BASE';end if;
 execute replace(b,needle,needle||' or private.legacy_source_upload_information_satisfied(r.case_id,r.id)');
end;$source_intake_operations$;
