-- An uploaded tariff is a source reading, never a fare/applicability approval.
-- Actor and physical page count come from authenticated server upload handling.
create table private.document_upload_actors(
 batch_id uuid primary key references public.document_upload_batches(id) deferrable initially deferred,
 case_id uuid not null references public.cases(id), identity_id uuid not null references public.case_identities(id),
 created_at timestamptz not null default clock_timestamp()
);
create table private.document_source_purposes(
 purpose_id uuid primary key, batch_id uuid not null references public.document_upload_batches(id),
 case_id uuid not null references public.cases(id), document_id uuid not null references public.documents(id),
 version_id uuid not null, month date not null, payload jsonb not null,
 sequence bigint generated always as identity unique,
 unique(batch_id,version_id),
 check(coalesce(payload->>'schema_version'='document-source-purpose-v1'
  and payload->>'purpose_id'=purpose_id::text and payload->>'case_id'=case_id::text
  and payload->>'document_id'=document_id::text and payload->>'version_id'=version_id::text
  and payload->>'month'=to_char(month,'YYYY-MM') and payload->>'evidence_purpose'='travel_tariff'
  and payload->>'purpose_sha256'=encode(sha256(convert_to(private.governance_jsonb_compact_text(payload-'purpose_sha256'),'UTF8')),'hex'),false))
);
alter table private.document_upload_actors enable row level security;
alter table private.document_upload_actors force row level security;
alter table private.document_source_purposes enable row level security;
alter table private.document_source_purposes force row level security;
create policy upload_actor_owner on private.document_upload_actors to tivdoc_dev_migrator using(true) with check(true);
create policy source_purpose_owner on private.document_source_purposes to tivdoc_dev_migrator using(true) with check(true);
revoke all on private.document_upload_actors,private.document_source_purposes from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.document_source_purpose_immutable() returns trigger
language plpgsql security invoker set search_path='' as $$
begin raise exception 'UPLOAD_PURPOSE_IMMUTABLE';end;$$;
revoke all on function private.document_source_purpose_immutable() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger immutable_upload_actor before update or delete on private.document_upload_actors for each row execute function private.document_source_purpose_immutable();
create trigger immutable_source_purpose before update or delete on private.document_source_purposes for each row execute function private.document_source_purpose_immutable();

create function private.travel_tariff_paid(target_case uuid,target_month date) returns boolean
language sql stable security invoker set search_path='' as $$
 select coalesce(target_month in ('2026-05-01'::date,'2026-06-01'::date,'2026-07-01'::date)
 and (exists(select 1 from private.product_orders o join private.order_entitlements e on e.order_id=o.id
  where o.case_id=target_case and o.state='paid' and o.refund_state<>'refunded' and e.state='active'
   and 'travel'=any(o.topics) and target_month between o.period_from and o.period_to)
 or exists(select 1 from jsonb_array_elements(private.legacy_paid_scopes_internal(target_case)) s
  where s->'topics' ? 'travel' and private.legacy_scope_covers_month(s,target_month))),false);
$$;
revoke all on function private.travel_tariff_paid(uuid,date) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

-- Latest explicit selection per month wins. Replacement never resurrects an
-- earlier source: first select the latest purpose, then test its current bytes.
create function private.document_source_purpose_journal(target_case uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(p.payload order by p.month),'[]'::jsonb)
 from (select distinct on(month) * from private.document_source_purposes where case_id=target_case order by month,sequence desc) p
 join public.documents d on d.case_id=p.case_id and d.id=p.document_id and d.version_id=p.version_id
  and d.document_type='other' and d.content_sha256=p.payload->>'file_sha256';
$$;
revoke all on function private.document_source_purpose_journal(uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function public.case_documents_reserve(target_case uuid,target_batch uuid,target_manifest jsonb,target_identity uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior private.document_upload_actors; result jsonb;
begin
 if session_user not in ('tivdoc_web_runtime','authenticator','service_role') or target_identity is null
  or not exists(select 1 from public.case_identity_cases i join public.cases c on c.id=i.case_id
   where i.case_id=target_case and i.identity_id=target_identity and c.contact_verified_at is not null)
  then raise exception 'UPLOAD_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;
 select * into prior from private.document_upload_actors where batch_id=target_batch;
 if found then
  if prior.case_id<>target_case or prior.identity_id<>target_identity then raise exception 'UPLOAD_FORBIDDEN';end if;
 else insert into private.document_upload_actors(batch_id,case_id,identity_id) values(target_batch,target_case,target_identity);
 end if;
 result:=public.case_documents_reserve(target_case,target_batch,target_manifest);
 return result;
end;$$;
revoke all on function public.case_documents_reserve(uuid,uuid,jsonb,uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_documents_reserve(uuid,uuid,jsonb,uuid) to service_role,tivdoc_web_runtime;

create function private.document_tariff_upload_validate(target_case uuid,target_batch uuid,f jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare purpose jsonb:=f->'evidencePurpose';m date;
begin
 if f->>'documentType'<>'other' then
  if f ? 'evidencePurpose' then raise exception 'UPLOAD_INVALID';end if;
  return;
 end if;
 if f->>'type'<>'application/pdf' or f ? 'periodMonth' or purpose is null
  or jsonb_typeof(purpose)<>'object' or (select count(*) from jsonb_object_keys(purpose))<>4
  or not coalesce(purpose->>'kind'='travel_tariff' and purpose->>'month'~'^2026-(05|06|07)$'
   and jsonb_typeof(purpose->'page')='number' and purpose->>'page'~'^[1-9][0-9]?$|^100$'
   and jsonb_typeof(purpose->'locator')='string' and char_length(purpose->>'locator') between 1 and 120 and purpose->>'locator'=btrim(purpose->>'locator'),false)
  then raise exception 'UPLOAD_INVALID';end if;
 if not exists(select 1 from private.document_upload_actors a join public.case_identity_cases i on i.case_id=a.case_id and i.identity_id=a.identity_id
  where a.case_id=target_case and a.batch_id=target_batch) then raise exception 'UPLOAD_FORBIDDEN';end if;
 m:=to_date(purpose->>'month','YYYY-MM');
 if not private.travel_tariff_paid(target_case,m) then raise exception 'UPLOAD_PURCHASED_SCOPE';end if;
end;$$;
revoke all on function private.document_tariff_upload_validate(uuid,uuid,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.document_tariff_upload_validate(uuid,uuid,jsonb) to service_role,tivdoc_web_runtime;

create function private.document_tariff_upload_record(target_case uuid,target_batch uuid,target_checks jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare b public.document_upload_batches;f jsonb;purpose jsonb;actor uuid;pages integer;generated_id uuid;body jsonb;d public.documents;
begin
 select * into b from public.document_upload_batches where id=target_batch and case_id=target_case;
 if not found then raise exception 'UPLOAD_FORBIDDEN';end if;
 if not exists(select 1 from jsonb_array_elements(b.files) entry(value) where entry.value->>'documentType'='other') then return;end if;
 if session_user not in ('tivdoc_web_runtime','authenticator','service_role') then raise exception 'UPLOAD_FORBIDDEN';end if;
 for f in select * from jsonb_array_elements(b.files) where value->>'documentType'='other' loop
  perform private.document_tariff_upload_validate(target_case,target_batch,f);
  select * into d from public.documents where case_id=target_case and id=(f->>'documentId')::uuid and version_id=(f->>'versionId')::uuid;
  if not found or d.content_sha256 is distinct from f->>'sha256' then raise exception 'UPLOAD_CONFLICT';end if;
  if not coalesce(jsonb_typeof(target_checks->('purpose:'||d.version_id))='object'
    and jsonb_typeof(target_checks#>array['purpose:'||d.version_id,'page_count'])='number'
    and target_checks#>>array['purpose:'||d.version_id,'page_count']~'^[1-9][0-9]?$|^100$',false)
   then raise exception 'UPLOAD_UNVERIFIED';end if;
  pages:=(target_checks#>>array['purpose:'||d.version_id,'page_count'])::integer;purpose:=f->'evidencePurpose';
  if (purpose->>'page')::integer>pages then raise exception 'UPLOAD_INVALID_FILE';end if;
  if exists(select 1 from private.document_source_purposes where batch_id=target_batch and version_id=d.version_id) then continue;end if;
  select identity_id into actor from private.document_upload_actors where batch_id=target_batch and case_id=target_case;
  generated_id:=gen_random_uuid();
  body:=jsonb_build_object('schema_version','document-source-purpose-v1','purpose_id',generated_id,'case_id',target_case,'document_id',d.id,'version_id',d.version_id,
   'file_sha256',d.content_sha256,'document_type','other','evidence_purpose','travel_tariff','month',purpose->>'month','page_count',pages,
   'group',jsonb_build_object('page',(purpose->>'page')::integer,'locator',purpose->>'locator'),'identity_id',actor,
   'recorded_at',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  insert into private.document_source_purposes(purpose_id,batch_id,case_id,document_id,version_id,month,payload)
   values(generated_id,target_batch,target_case,d.id,d.version_id,to_date(purpose->>'month','YYYY-MM'),
    body||jsonb_build_object('purpose_sha256',encode(sha256(convert_to(private.governance_jsonb_compact_text(body),'UTF8')),'hex')));
 end loop;
 if exists(select 1 from private.document_source_purposes where batch_id=target_batch) then perform private.capture_case_input(target_case,'travel_tariff_source_received');end if;
end;$$;
revoke all on function private.document_tariff_upload_record(uuid,uuid,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.document_tariff_upload_record(uuid,uuid,jsonb) to service_role,tivdoc_web_runtime;

create function private.document_tariff_snapshot(target_case uuid,original jsonb) returns jsonb
language sql stable security definer set search_path='' as $$
 select original||jsonb_build_object('documents',coalesce((select jsonb_agg(d.value||coalesce((select jsonb_build_object('evidence_purpose',
  jsonb_build_object('kind','travel_tariff','month',p.payload->>'month','page',p.payload#>'{group,page}',
   'locator',p.payload#>>'{group,locator}','page_count',p.payload->'page_count'))
   from private.document_source_purposes p where p.case_id=target_case and p.document_id::text=d.value->>'id'
    and p.version_id::text=d.value->>'version_id' order by p.sequence desc limit 1),'{}'::jsonb) order by d.ordinality)
  from jsonb_array_elements(original->'documents') with ordinality d(value,ordinality)),'[]'::jsonb))
 where original->>'caseId'=target_case::text;
$$;
revoke all on function private.document_tariff_snapshot(uuid,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.document_tariff_snapshot(uuid,jsonb) to service_role,tivdoc_web_runtime;

alter table public.documents drop constraint documents_document_type_check;
alter table public.documents add constraint documents_document_type_check check(document_type in('payslip','contract','attendance','other'));
alter table public.documents drop constraint documents_slot_check;
alter table public.documents add constraint documents_slot_check check(slot~'^(payslip-(0[1-9]|[1-9][0-9]|[1-5][0-9]{2}|600)|contract|attendance|other-(0[1-9]|1[0-2]))$');
alter table public.documents drop constraint documents_slot_matches_type_check;
alter table public.documents add constraint documents_slot_matches_type_check check((document_type='payslip' and slot like 'payslip-%')
 or (document_type='other' and slot like 'other-%') or (document_type in('contract','attendance') and slot=document_type));

do $migration$
declare body text;anchor text;
begin
 body:=pg_get_functiondef('public.case_documents_reserve(uuid,uuid,jsonb)'::regprocedure);
 anchor:='f->>''documentType'' not in (''payslip'', ''contract'', ''attendance'')';
 if position(anchor in body)=0 then raise exception 'TARIFF_RESERVE_TYPE_ANCHOR';end if;
 body:=replace(body,anchor,'f->>''documentType'' not in (''payslip'', ''contract'', ''attendance'', ''other'')');
 anchor:='perform (f->>''clientId'')::uuid;';
 if position(anchor in body)=0 then raise exception 'TARIFF_RESERVE_VALIDATE_ANCHOR';end if;
 body:=replace(body,anchor,anchor||E'\n    perform private.document_tariff_upload_validate(target_case,target_batch,f);');
 anchor:='else
        selected_slot := f->>''documentType'';';
 if position(anchor in body)=0 then raise exception 'TARIFF_RESERVE_SLOT_ANCHOR';end if;
 body:=replace(body,anchor,'elsif f->>''documentType''=''other'' then
        select ''other-''||lpad(n::text,2,''0'') into selected_slot from generate_series(1,12) n
          where not (''other-''||lpad(n::text,2,''0'')=any(used_slots)) order by n limit 1;
        if selected_slot is null then raise exception ''UPLOAD_LIMIT'';end if;
      '||anchor);
 execute body;
 body:=pg_get_functiondef('public.case_documents_commit(uuid,uuid,jsonb)'::regprocedure);
 anchor:='update public.document_upload_batches set completed_at = now() where id = target_batch;';
 if position(anchor in body)=0 then raise exception 'TARIFF_COMMIT_ANCHOR';end if;
 execute replace(body,anchor,'perform private.document_tariff_upload_record(target_case,target_batch,target_checks);'||E'\n  '||anchor);
 body:=pg_get_functiondef('private.capture_case_input(uuid,text)'::regprocedure);
 anchor:='digest:=encode(sha256(convert_to(payload::text,''UTF8'')),''hex'');';
 if position(anchor in body)=0 then raise exception 'TARIFF_CAPTURE_ANCHOR';end if;
 execute replace(body,anchor,'if private.document_source_purpose_journal(target_case)<>''[]''::jsonb then
  payload:=payload||jsonb_build_object(''source_purposes'',private.document_source_purpose_journal(target_case));
 end if;
 '||anchor);
 body:=pg_get_functiondef('public.case_documents_snapshot(uuid)'::regprocedure);
 anchor:='return private.document_review_upload_snapshot(target_case,jsonb_build_object(';
 if position(anchor in body)=0 or position(E'  ));' in body)=0 then raise exception 'TARIFF_SNAPSHOT_ANCHOR';end if;
 execute replace(replace(body,anchor,'return private.document_tariff_snapshot(target_case,private.document_review_upload_snapshot(target_case,jsonb_build_object('),E'  ));',E'  )));');
end;$migration$;
