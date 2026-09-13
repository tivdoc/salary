-- Versioned source reviews admitted through the existing authenticated worker.
-- Requires legacy paid review scope migration and governance compact JSON helper.
-- Source readings are not findings, legal admissions, or report publication.
create table private.document_review_source_versions(
 case_id uuid not null references public.cases(id),order_id uuid not null,month date not null check(extract(day from month)=1),
 review_sha256 text not null check(review_sha256~'^[a-f0-9]{64}$'),
 source_revision integer not null,source_input_sha256 text not null,source_documents jsonb not null,
 input jsonb not null,created_at timestamptz not null default transaction_timestamp(),
 primary key(case_id,order_id,month,review_sha256),
 foreign key(case_id,source_revision) references private.case_input_versions(case_id,revision)
);
create table private.document_review_source_heads(
 case_id uuid not null,order_id uuid not null,month date not null,review_sha256 text not null,
 primary key(case_id,order_id,month),
 foreign key(case_id,order_id,month,review_sha256) references private.document_review_source_versions(case_id,order_id,month,review_sha256)
);
alter table private.document_review_source_versions enable row level security;
alter table private.document_review_source_heads enable row level security;
revoke all on private.document_review_source_versions,private.document_review_source_heads
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger document_review_source_immutable before update or delete on private.document_review_source_versions
 for each row execute function private.reject_engine_append_only_mutation();

-- Exact constant public law exception. This does not make it active or exempt
-- private source pins from case ownership. Unknown fields also fail equality.
create function private.document_review_source_is_law(target_case uuid,document jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
 select document=jsonb_build_object('case_id',target_case::text,'document_id','il.hours-work-rest-law.1951',
 'version_id','IL_HOURS_WORK_REST_LAW@discovery-v0','file_sha256','ca770f73436663094f546e53bed93aeca867bbed7124991fecfa1a8d750fdcd9',
 'page_count',6,'kind','other','label','חוק שעות עבודה ומנוחה — מקור רשמי לחישוב המותנה','period',null,
 'reading_origin','ai_document_review','reading_sha256','2d3be1afb43e053000bf7f1aec35cf36c448a71dc8bd239df2177b413e01fa62')
$$;
revoke all on function private.document_review_source_is_law(uuid,jsonb)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

-- Full saved document inventory: addition, removal, metadata/month or version
-- replacement invalidates the head. Answers intentionally do not affect it.
create function private.document_review_source_refs(target_case uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('schema_version','document-review-source-ref-v1',
  'order_id',v.order_id::text,'month',to_char(v.month,'YYYY-MM'),'review_sha256',v.review_sha256) order by v.order_id,v.month),'[]'::jsonb)
 from private.document_review_source_heads h
 join private.document_review_source_versions v using(case_id,order_id,month,review_sha256)
 where v.case_id=target_case
  and private.document_review_paid_scope_current(v.case_id,v.order_id,v.input#>>'{purchased_scope,origin}',
   v.input#>>'{purchased_scope,receipt_sha256}',v.input#>'{purchased_scope,topics}',v.month)
  and v.source_documents=(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'version_id',d.version_id,'sha256',d.content_sha256,
    'type',d.document_type,'month',d.period_month) order by d.id),'[]'::jsonb) from public.documents d where d.case_id=target_case)
$$;
revoke all on function private.document_review_source_refs(uuid)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

-- Preserve old case-input hashes: omit the key entirely if there are no refs.
do $upgrade$
declare definition text;marker text;
begin
 definition:=pg_get_functiondef('private.capture_case_input(uuid,text)'::regprocedure);
 marker:=$old$ digest:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');$old$;
 if position(marker in definition)=0 or position('document_review_source_refs' in definition)>0 then raise exception 'REVIEW_SOURCE_CAPTURE_BASE_DRIFT';end if;
 execute replace(definition,marker,E' if private.document_review_source_refs(target_case)<>''[]''::jsonb then\n  payload:=payload||jsonb_build_object(''document_reviews'',private.document_review_source_refs(target_case));\n end if;\n'||marker);
end;$upgrade$;

create function private.document_review_source_admit(target_case uuid,expected_revision integer,expected_input_sha256 text,
 target_order uuid,target_month date,target_review_sha256 text,target_input jsonb,expected_dependency_sha256 text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare source_row private.case_input_versions;head private.case_input_heads;dependency text;ref jsonb;job jsonb;old_input jsonb;old_documents jsonb;doc jsonb;
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'REVIEW_SOURCE_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;
 select * into head from private.case_input_heads where case_id=target_case;
 if not found or head.revision<>expected_revision or head.input_sha256<>expected_input_sha256 then raise exception 'ANALYSIS_INPUT_SUPERSEDED';end if;
 select d.authority_dependency_sha256 into dependency from private.case_analysis_dispatch d where d.case_id=target_case and d.revision=expected_revision and d.mode='draft';
 if not found or dependency is distinct from expected_dependency_sha256 then raise exception 'ANALYSIS_AUTHORITY_SUPERSEDED';end if;
 select * into source_row from private.case_input_versions where case_id=target_case and revision=expected_revision and input_sha256=expected_input_sha256;
 if not found then raise exception 'REVIEW_SOURCE_INPUT_REQUIRED';end if;
 if target_input->>'schema_version' is distinct from 'document-review-product-v1'
  or target_input->>'case_id' is distinct from target_case::text
  or target_input#>>'{purchased_scope,order_id}' is distinct from target_order::text
  or extract(day from target_month)<>1
  or target_input#>>'{period,from}' is distinct from to_char(target_month,'YYYY-MM-DD')
  or target_input#>>'{period,to}' is distinct from to_char((target_month+interval '1 month - 1 day')::date,'YYYY-MM-DD')
  or target_review_sha256 is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(target_input),'UTF8')),'hex')
  or target_input->'answer_history' is distinct from '[]'::jsonb
  or jsonb_typeof(target_input->'documents') is distinct from 'array'
  or jsonb_array_length(target_input->'documents') not between 1 and 64
  or not private.document_review_paid_scope_current(target_case,target_order,target_input#>>'{purchased_scope,origin}',
    target_input#>>'{purchased_scope,receipt_sha256}',target_input#>'{purchased_scope,topics}',target_month)
 then raise exception 'REVIEW_SOURCE_SCOPE';end if;
 if not exists(select 1 from jsonb_array_elements(coalesce(source_row.input->'orders','[]'::jsonb)) p
   where target_input#>>'{purchased_scope,origin}'='saved_order' and p->>'id'=target_order::text
    and p->>'offer_sha256'=target_input#>>'{purchased_scope,receipt_sha256}' and p->'topics'=target_input#>'{purchased_scope,topics}')
  and not exists(select 1 from jsonb_array_elements(coalesce(source_row.input->'legacy_orders','[]'::jsonb)) p
   where target_input#>>'{purchased_scope,origin}'='legacy_paid_receipt' and p->>'id'=target_order::text
    and p->>'receipt_sha256'=target_input#>>'{purchased_scope,receipt_sha256}' and p->'topics'=target_input#>'{purchased_scope,topics}')
 then raise exception 'REVIEW_SOURCE_ORDER_NOT_PINNED';end if;
 if jsonb_array_length(source_row.input->'documents')=0
  or not exists(select 1 from jsonb_array_elements(target_input->'documents') d where not private.document_review_source_is_law(target_case,d))
  or exists(select 1 from jsonb_array_elements(target_input->'documents') d group by d->>'document_id' having count(*)<>1)
 then raise exception 'REVIEW_SOURCE_DOCUMENT_SET';end if;
 for doc in select value from jsonb_array_elements(target_input->'documents') loop
  if private.document_review_source_is_law(target_case,doc) then continue;end if;
  if doc->>'case_id' is distinct from target_case::text or doc->>'reading_origin' is null
   or doc->>'reading_origin' not in ('provider_extraction','ai_document_review','source_inventory')
   or not exists(select 1 from jsonb_array_elements(source_row.input->'documents') p
    join public.documents d on d.case_id=target_case and d.id=(p->>'id')::uuid and d.version_id=(p->>'version_id')::uuid and d.content_sha256=p->>'sha256'
    where (d.id::text=doc->>'document_id' or d.version_id::text=doc->>'document_id')
     and d.version_id::text=doc->>'version_id' and d.content_sha256=doc->>'file_sha256')
  then raise exception 'REVIEW_SOURCE_DOCUMENT_BINDING';end if;
 end loop;
 -- The input must not smuggle an identified answer into this source journal.
 if coalesce(jsonb_array_length(target_input#>'{completion_input,previous_answers}'),0)<>0
  or exists(select 1 from jsonb_array_elements(coalesce(target_input#>'{completion_input,evidence}','[]'::jsonb)) e where e->>'origin'='answer')
 then raise exception 'REVIEW_SOURCE_ANSWER_JOURNAL_REQUIRED';end if;
 insert into private.document_review_source_versions(case_id,order_id,month,review_sha256,source_revision,source_input_sha256,source_documents,input)
 values(target_case,target_order,target_month,target_review_sha256,expected_revision,expected_input_sha256,source_row.input->'documents',target_input)
 on conflict(case_id,order_id,month,review_sha256) do nothing;
 select v.input,v.source_documents into old_input,old_documents from private.document_review_source_versions v
  where v.case_id=target_case and v.order_id=target_order and v.month=target_month and v.review_sha256=target_review_sha256;
 if old_input is distinct from target_input or old_documents is distinct from source_row.input->'documents' then raise exception 'REVIEW_SOURCE_IMMUTABLE';end if;
 insert into private.document_review_source_heads(case_id,order_id,month,review_sha256) values(target_case,target_order,target_month,target_review_sha256)
 on conflict(case_id,order_id,month) do update set review_sha256=excluded.review_sha256;
 perform private.capture_case_input(target_case,'document_review_source_revision');
 select * into head from private.case_input_heads where case_id=target_case;
 select d.authority_dependency_sha256 into dependency from private.case_analysis_dispatch d where d.case_id=target_case and d.revision=head.revision and d.mode='draft';
 if not found then raise exception 'REVIEW_SOURCE_DISPATCH_REQUIRED';end if;
 ref:=jsonb_build_object('schema_version','document-review-source-ref-v1','order_id',target_order::text,'month',to_char(target_month,'YYYY-MM'),'review_sha256',target_review_sha256);
 if not exists(select 1 from private.case_input_versions v where v.case_id=target_case and v.revision=head.revision and v.input_sha256=head.input_sha256
  and v.input->'document_reviews' @> jsonb_build_array(ref)) then raise exception 'REVIEW_SOURCE_CAPTURE_BINDING';end if;
 job:=jsonb_build_object('schema_version','saved-case-work-v1','case_id',target_case::text,'revision',head.revision,'input_sha256',head.input_sha256,'mode','draft');
 if dependency is not null then job:=job||jsonb_build_object('authority_dependency_sha256',dependency);end if;
 return jsonb_build_object('source_job',job,'review_ref',ref,'changed',head.revision<>expected_revision);
end;$$;
revoke all on function private.document_review_source_admit(uuid,integer,text,uuid,date,text,jsonb,text)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.document_review_source_admit(uuid,integer,text,uuid,date,text,jsonb,text) to tivdoc_worker_runtime;

create function private.document_review_source_read(target_case uuid,expected_revision integer,expected_input_sha256 text,
 target_order uuid,target_month date,expected_dependency_sha256 text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare head private.case_input_heads;dependency text;payload jsonb;refs jsonb;ref jsonb;review jsonb;review_hash text;
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'REVIEW_SOURCE_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;
 select * into head from private.case_input_heads where case_id=target_case;
 if not found or head.revision<>expected_revision or head.input_sha256<>expected_input_sha256 then raise exception 'ANALYSIS_INPUT_SUPERSEDED';end if;
 select d.authority_dependency_sha256 into dependency from private.case_analysis_dispatch d where d.case_id=target_case and d.revision=expected_revision and d.mode='draft';
 if not found or dependency is distinct from expected_dependency_sha256 then raise exception 'ANALYSIS_AUTHORITY_SUPERSEDED';end if;
 select v.input into payload from private.case_input_versions v where v.case_id=target_case and v.revision=expected_revision and v.input_sha256=expected_input_sha256;
 if not found or extract(day from target_month)<>1 then raise exception 'REVIEW_SOURCE_INPUT_REQUIRED';end if;
 select coalesce(jsonb_agg(r),'[]'::jsonb) into refs from jsonb_array_elements(coalesce(payload->'document_reviews','[]'::jsonb)) r
  where r->>'order_id'=target_order::text and r->>'month'=to_char(target_month,'YYYY-MM');
 if jsonb_array_length(refs)>1 then raise exception 'REVIEW_SOURCE_REF_AMBIGUOUS';end if;
 if jsonb_array_length(refs)=0 then
  if exists(select 1 from private.document_review_source_heads h where h.case_id=target_case and h.order_id=target_order and h.month=target_month)
   then return jsonb_build_object('state','invalidated');end if;
  return jsonb_build_object('state','legacy');
 end if;
 ref:=refs->0;
 if not private.document_review_source_refs(target_case) @> jsonb_build_array(ref) then raise exception 'REVIEW_SOURCE_REF_STALE';end if;
 select v.input,v.review_sha256 into review,review_hash from private.document_review_source_versions v
  where v.case_id=target_case and v.order_id=target_order and v.month=target_month and v.review_sha256=ref->>'review_sha256';
 if not found or review_hash is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(review),'UTF8')),'hex')
  or ref is distinct from jsonb_build_object('schema_version','document-review-source-ref-v1','order_id',target_order::text,
   'month',to_char(target_month,'YYYY-MM'),'review_sha256',review_hash) then raise exception 'REVIEW_SOURCE_HASH';end if;
 return jsonb_build_object('state','pinned','review_ref',ref,'input',review);
end;$$;
revoke all on function private.document_review_source_read(uuid,integer,text,uuid,date,text)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.document_review_source_read(uuid,integer,text,uuid,date,text) to tivdoc_worker_runtime;


-- Required actual DEV proof (root): legacy fallback unchanged; first admission
-- advances revision; enhanced same-source input advances again; retry same hash
-- does not advance; old journal/report unchanged; answers retain exact ref and
-- regenerate only dependent checks; new/changed document removes the ref and
-- uses provider/partial branch; foreign tenant, stale job and direct writes fail.
