-- Immutable object names + case-serialized reservations + atomic publication.
-- Old objects are retained. There is deliberately no destructive cleanup worker:
-- a future retention policy must account for legacy references and live tokens.
alter table public.documents add column version_id uuid not null default gen_random_uuid();

-- The canonical migration replaced the MVP's case FK with an unconditional
-- engine identity FK. A funnel case has no engine identity. Keep both ownership
-- domains constrained, without fabricating an engine tenant for a customer upload.
alter table public.documents
  add column product_owner_case_id uuid generated always as
    (case when tenant_id is null and canonical_case_id is null and canonical_document_id is null then case_id end) stored,
  add column engine_owner_case_id uuid generated always as
    (case when tenant_id is not null or canonical_case_id is not null or canonical_document_id is not null then case_id end) stored;
alter table public.documents drop constraint documents_engine_identity_fkey;
alter table public.documents
  add constraint documents_product_owner_fkey foreign key(product_owner_case_id) references public.cases(id) on delete cascade,
  add constraint documents_engine_owner_fkey foreign key(engine_owner_case_id) references public.engine_case_identity(internal_case_id) on delete restrict;
create index documents_product_owner_idx on public.documents(product_owner_case_id) where product_owner_case_id is not null;
create index documents_engine_owner_idx on public.documents(engine_owner_case_id) where engine_owner_case_id is not null;

-- Product funnel documents are separate from tenant/canonical engine documents.
-- The existing runtime role had no INSERT grant on this legacy product surface.
-- Grant only the columns this protocol writes; never grant tenant reassignment.
grant select on public.documents to tivdoc_web_runtime;
grant insert(id,case_id,version_id,document_type,slot,storage_path,original_filename,mime_type,size,period_month,content_sha256)
  on public.documents to tivdoc_web_runtime;
grant update(version_id,storage_path,original_filename,mime_type,size,period_month,content_sha256,processing_status,detected_type,classification_confidence,period_start,period_end)
  on public.documents to tivdoc_web_runtime;
grant update(status,check_period_month,updated_at) on public.cases to tivdoc_web_runtime;
create policy document_upload_product on public.documents for all to tivdoc_web_runtime
  using (tenant_id is null and canonical_case_id is null and canonical_document_id is null and storage_layout = 'legacy_slot')
  with check (tenant_id is null and canonical_case_id is null and canonical_document_id is null and storage_layout = 'legacy_slot');
-- The portal's restrictive SELECT policy still protects canonical tenant rows.
-- Product rows have no canonical owner; they are authorized by the case-cookie
-- server boundary, like public.cases and case_requests already are.
alter policy tivdoc_portal_web_owned_case on public.documents to tivdoc_web_runtime
  using ((tenant_id is null and canonical_case_id is null and canonical_document_id is null and storage_layout = 'legacy_slot')
    or private.runtime_web_owns_case(tenant_id, canonical_case_id));

create table public.document_upload_batches (
  id uuid primary key,
  case_id uuid not null references public.cases(id) on delete cascade,
  manifest jsonb not null,
  files jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '3 hours',
  completed_at timestamptz,
  cancelled_at timestamptz,
  check (not (completed_at is not null and cancelled_at is not null))
);
create index document_upload_batches_pending on public.document_upload_batches(case_id, expires_at)
  where completed_at is null and cancelled_at is null;

create table public.document_versions (
  version_id uuid primary key,
  document_id uuid not null references public.documents(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  storage_path text not null unique,
  original_filename text not null,
  mime_type text not null,
  size bigint not null,
  period_month date,
  retained_at timestamptz not null default now()
);
create index document_versions_case on public.document_versions(case_id);
create index document_versions_document on public.document_versions(document_id);

alter table public.document_upload_batches enable row level security;
alter table public.document_upload_batches force row level security;
alter table public.document_versions enable row level security;
alter table public.document_versions force row level security;
revoke all on public.document_upload_batches, public.document_versions from public, anon, authenticated;
grant select, insert, update on public.document_upload_batches to service_role, tivdoc_web_runtime;
grant select, insert on public.document_versions to service_role, tivdoc_web_runtime;
create policy document_upload_batches_server on public.document_upload_batches
  for all to service_role, tivdoc_web_runtime using (true) with check (true);
create policy document_versions_server on public.document_versions
  for all to service_role, tivdoc_web_runtime using (true) with check (true);

-- The caller is a trusted server role, after validating the signed case cookie.
-- Never expose these functions to browser roles. No new SECURITY DEFINER surface.
create function public.case_documents_snapshot(target_case uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare c public.cases;
begin
  select * into c from public.cases where id = target_case;
  if not found or c.contact_verified_at is null then raise exception 'UPLOAD_FORBIDDEN'; end if;
  return jsonb_build_object(
    'caseId', c.id, 'publicId', c.public_id, 'status', c.status, 'paymentStatus', c.payment_status,
    'checkPeriodMonth', to_char(c.check_period_month, 'YYYY-MM'),
    'documents', coalesce((select jsonb_agg(jsonb_build_object(
      'id', d.id, 'version_id', d.version_id, 'document_type', d.document_type, 'slot', d.slot,
      'original_filename', d.original_filename, 'mime_type', d.mime_type, 'size', d.size,
      'period_month', to_char(d.period_month, 'YYYY-MM')) order by d.slot)
      from public.documents d where d.case_id = target_case), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code,
      'question', r.question, 'documentType', case r.code when 'contract_missing' then 'contract'
        when 'attendance_missing' then 'attendance' else 'payslip' end) order by r.opened_at)
      from public.case_requests r where r.case_id = target_case and r.answered_at is null
        and r.answer_kind = 'document'
        and r.code in ('document_missing', 'document_unreadable', 'contract_missing', 'attendance_missing')), '[]'::jsonb)
  );
end;
$$;

create function public.case_documents_reserve(target_case uuid, target_batch uuid, target_manifest jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  c public.cases; b public.document_upload_batches; d public.documents; r public.case_requests;
  f jsonb; allocated jsonb := '[]'; pending jsonb; used_slots text[]; selected_slot text;
  target_id uuid; version uuid; expected uuid; current_size bigint; total_size bigint;
  request_type text; requested_month date; effective_month date;
begin
  -- All writers take the case lock first, including retries and cancellation.
  select * into c from public.cases where id = target_case for update;
  if not found or c.contact_verified_at is null then raise exception 'UPLOAD_FORBIDDEN'; end if;
  if target_batch is null or target_manifest->>'caseId' is distinct from target_case::text
    or target_manifest->>'batchId' is distinct from target_batch::text then raise exception 'UPLOAD_FORBIDDEN'; end if;
  select * into b from public.document_upload_batches where id = target_batch;
  if found then
    if b.case_id <> target_case then raise exception 'UPLOAD_FORBIDDEN'; end if;
    if b.manifest <> target_manifest then raise exception 'UPLOAD_RETRY_MISMATCH'; end if;
    if b.cancelled_at is not null then raise exception 'UPLOAD_CANCELLED'; end if;
    if b.completed_at is null and b.expires_at <= now() then raise exception 'UPLOAD_EXPIRED'; end if;
    return to_jsonb(b);
  end if;
  if jsonb_typeof(target_manifest->'files') is distinct from 'array'
    or jsonb_array_length(target_manifest->'files') not between 1 and 14 then raise exception 'UPLOAD_INVALID'; end if;
  if (select count(distinct x->>'clientId') from jsonb_array_elements(target_manifest->'files') x)
    <> jsonb_array_length(target_manifest->'files') then raise exception 'UPLOAD_INVALID'; end if;

  select coalesce(jsonb_agg(x), '[]') into pending
  from public.document_upload_batches ub cross join lateral jsonb_array_elements(ub.files) x
  where ub.case_id = target_case and ub.completed_at is null and ub.cancelled_at is null and ub.expires_at > now();
  select coalesce(array_agg(slot), '{}') into used_slots from (
    select slot from public.documents where case_id = target_case
    union select x->>'slot' from jsonb_array_elements(pending) x
  ) slots;
  select coalesce(sum(size), 0) into total_size from public.documents where case_id = target_case;
  -- Reserve increases only: a pending shrink cannot fund an upload until committed.
  total_size := total_size + coalesce((select sum(greatest(0, (x->>'size')::bigint - (x->>'previousSize')::bigint))
    from jsonb_array_elements(pending) x), 0);

  for f in select * from jsonb_array_elements(target_manifest->'files') loop
    if f->>'documentType' is null or f->>'documentType' not in ('payslip', 'contract', 'attendance')
      or f->>'type' is null or f->>'type' not in ('application/pdf', 'image/jpeg', 'image/png')
      or coalesce((f->>'size')::bigint, 0) not between 1 and 10485760
      or coalesce(length(f->>'name'), 0) not between 1 and 240
      or coalesce(f->>'sha256', '') !~ '^[a-f0-9]{64}$'
      or f->>'clientId' is null then raise exception 'UPLOAD_INVALID'; end if;
    perform (f->>'clientId')::uuid;
    if f->>'documentType' = 'payslip' then
      if coalesce(f->>'periodMonth', '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception 'UPLOAD_INVALID'; end if;
    elsif f ? 'periodMonth' then raise exception 'UPLOAD_INVALID'; end if;
    current_size := 0; expected := null;
    if f ? 'replace' then
      select * into d from public.documents where id = (f->'replace'->>'documentId')::uuid and case_id = target_case;
      if not found then raise exception 'UPLOAD_FORBIDDEN'; end if;
      if d.version_id is distinct from (f->'replace'->>'versionId')::uuid or d.document_type <> f->>'documentType'
        or d.tenant_id is not null or d.canonical_case_id is not null or d.storage_layout <> 'legacy_slot'
        then raise exception 'UPLOAD_CONFLICT'; end if;
      if exists(select 1 from jsonb_array_elements(pending || allocated) x where x->>'documentId' = d.id::text)
        then raise exception 'UPLOAD_CONFLICT'; end if;
      target_id := d.id; selected_slot := d.slot; expected := d.version_id; current_size := d.size;
    else
      target_id := gen_random_uuid();
      if f->>'documentType' = 'payslip' then
        select 'payslip-' || lpad(n::text, 2, '0') into selected_slot from generate_series(1,12) n
          where not ('payslip-' || lpad(n::text, 2, '0') = any(used_slots)) order by n limit 1;
        if selected_slot is null then raise exception 'UPLOAD_LIMIT'; end if;
      else
        selected_slot := f->>'documentType';
        if selected_slot = any(used_slots) then raise exception 'UPLOAD_CONFLICT'; end if;
      end if;
      used_slots := array_append(used_slots, selected_slot);
    end if;
    total_size := total_size + greatest(0, (f->>'size')::bigint - current_size);
    version := gen_random_uuid();
    allocated := allocated || jsonb_build_array(f || jsonb_build_object(
      'documentId', target_id, 'versionId', version, 'expectedVersion', expected,
      'previousSize', current_size, 'slot', selected_slot,
      'path', 'cases/' || target_case || '/versions/' || version || case f->>'type'
        when 'application/pdf' then '.pdf' when 'image/png' then '.png' else '.jpg' end));
  end loop;
  if total_size > 26214400 then raise exception 'UPLOAD_LIMIT'; end if;
  if not exists(select 1 from public.documents where case_id = target_case and document_type = 'payslip')
    and not exists(select 1 from jsonb_array_elements(allocated) x where x->>'documentType' = 'payslip')
    then raise exception 'UPLOAD_PAYSLIP_REQUIRED'; end if;

  if target_manifest ? 'requestId' then
    select * into r from public.case_requests where id = (target_manifest->>'requestId')::uuid
      and case_id = target_case and answered_at is null and answer_kind = 'document';
    if not found then raise exception 'UPLOAD_REQUEST_CONFLICT'; end if;
    request_type := case r.code when 'document_missing' then 'payslip' when 'document_unreadable' then 'payslip'
      when 'contract_missing' then 'contract' when 'attendance_missing' then 'attendance' end;
    if request_type is null or not exists(select 1 from jsonb_array_elements(allocated) x
      where x->>'documentType' = request_type and (r.code <> 'document_unreadable' or x->>'expectedVersion' is not null))
      then raise exception 'UPLOAD_REQUEST_CONFLICT'; end if;
  end if;

  requested_month := (target_manifest->>'checkPeriodMonth' || '-01')::date;
  if c.status in ('payment_pending', 'paid', 'under_review', 'completed') or c.payment_status in ('pending', 'paid', 'verified', 'refunded') then
    if requested_month is not null and requested_month is distinct from c.check_period_month then raise exception 'UPLOAD_MONTH_LOCKED'; end if;
  end if;
  effective_month := coalesce(requested_month, c.check_period_month);
  if effective_month is not null and not (
    exists(select 1 from public.documents doc where doc.case_id = target_case and doc.document_type = 'payslip'
      and doc.period_month = effective_month and not exists(select 1 from jsonb_array_elements(allocated) x where x->>'documentId' = doc.id::text))
    or exists(select 1 from jsonb_array_elements(allocated) x where x->>'documentType' = 'payslip' and (x->>'periodMonth' || '-01')::date = effective_month)
  ) then raise exception 'UPLOAD_MONTH_MISSING'; end if;

  insert into public.document_upload_batches(id, case_id, manifest, files)
    values (target_batch, target_case, target_manifest, allocated) returning * into b;
  return to_jsonb(b);
end;
$$;

create function public.case_documents_batch(target_case uuid, target_batch uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare b public.document_upload_batches;
begin
  perform 1 from public.cases where id = target_case and contact_verified_at is not null;
  if not found then raise exception 'UPLOAD_FORBIDDEN'; end if;
  select * into b from public.document_upload_batches where id = target_batch and case_id = target_case;
  if not found then raise exception 'UPLOAD_FORBIDDEN'; end if;
  return to_jsonb(b);
end;
$$;

create function public.case_documents_commit(target_case uuid, target_batch uuid, target_checks jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c public.cases; b public.document_upload_batches; d public.documents; f jsonb; total_size bigint; month date;
begin
  select * into c from public.cases where id = target_case for update;
  if not found or c.contact_verified_at is null then raise exception 'UPLOAD_FORBIDDEN'; end if;
  select * into b from public.document_upload_batches where id = target_batch and case_id = target_case for update;
  if not found then raise exception 'UPLOAD_FORBIDDEN'; end if;
  if b.completed_at is not null then return public.case_documents_snapshot(target_case); end if;
  if b.cancelled_at is not null then raise exception 'UPLOAD_CANCELLED'; end if;
  if b.expires_at <= now() then raise exception 'UPLOAD_EXPIRED'; end if;
  if jsonb_typeof(target_checks) is distinct from 'object' then raise exception 'UPLOAD_UNVERIFIED'; end if;
  for f in select * from jsonb_array_elements(b.files) loop
    if target_checks->>(f->>'versionId') is distinct from f->>'sha256' then raise exception 'UPLOAD_UNVERIFIED'; end if;
    if f->>'expectedVersion' is not null then
      select * into d from public.documents where id = (f->>'documentId')::uuid and case_id = target_case;
      if not found or d.version_id::text <> f->>'expectedVersion' then raise exception 'UPLOAD_CONFLICT'; end if;
      insert into public.document_versions(version_id, document_id, case_id, storage_path, original_filename, mime_type, size, period_month)
        values(d.version_id, d.id, d.case_id, d.storage_path, d.original_filename, d.mime_type, d.size, d.period_month)
        on conflict (version_id) do nothing;
      update public.documents set version_id = (f->>'versionId')::uuid, storage_path = f->>'path',
        original_filename = f->>'name', mime_type = f->>'type', size = (f->>'size')::bigint,
        period_month = (f->>'periodMonth' || '-01')::date, content_sha256 = f->>'sha256',
        processing_status = 'uploaded', detected_type = null, classification_confidence = null,
        period_start = null, period_end = null where id = d.id;
    else
      if exists(select 1 from public.documents where case_id = target_case and slot = f->>'slot') then raise exception 'UPLOAD_CONFLICT'; end if;
      insert into public.documents(id, case_id, version_id, document_type, slot, storage_path, original_filename, mime_type, size, period_month, content_sha256)
        values((f->>'documentId')::uuid, target_case, (f->>'versionId')::uuid, f->>'documentType', f->>'slot',
          f->>'path', f->>'name', f->>'type', (f->>'size')::bigint, (f->>'periodMonth' || '-01')::date, f->>'sha256');
    end if;
  end loop;
  -- Recheck the actual case, not the request or a stale sign-time snapshot.
  select sum(size) into total_size from public.documents where case_id = target_case;
  if total_size > 26214400 then raise exception 'UPLOAD_LIMIT'; end if;
  if not exists(select 1 from public.documents where case_id = target_case and document_type = 'payslip') then raise exception 'UPLOAD_PAYSLIP_REQUIRED'; end if;
  month := coalesce((b.manifest->>'checkPeriodMonth' || '-01')::date, c.check_period_month);
  if c.status in ('payment_pending','paid','under_review','completed') or c.payment_status in ('pending','paid','verified','refunded') then
    if month is distinct from c.check_period_month then raise exception 'UPLOAD_MONTH_LOCKED'; end if;
  end if;
  if month is not null and not exists(select 1 from public.documents where case_id = target_case and document_type = 'payslip' and period_month = month)
    then raise exception 'UPLOAD_MONTH_MISSING'; end if;

  if b.manifest ? 'requestId' then
    -- Exactly the request chosen at reservation; a newer request with the same code is untouched.
    update public.case_requests set answered_at = now(), answer_text = 'המסמך צורף לתיק'
      where id = (b.manifest->>'requestId')::uuid and case_id = target_case and answered_at is null;
    if not found then raise exception 'UPLOAD_REQUEST_CONFLICT'; end if;
  end if;
  update public.cases set check_period_month = month,
    status = case when status in ('started','questionnaire_completed','documents_uploaded') then 'documents_uploaded'
      when status = 'awaiting_document' and not exists(select 1 from public.case_requests where case_id = target_case
        and blocking and answered_at is null and expires_at > now()) then 'documents_uploaded' else status end,
    updated_at = now() where id = target_case;
  update public.document_upload_batches set completed_at = now() where id = target_batch;
  return public.case_documents_snapshot(target_case);
end;
$$;

create function public.case_documents_cancel(target_case uuid, target_batch uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare b public.document_upload_batches;
begin
  perform 1 from public.cases where id = target_case and contact_verified_at is not null for update;
  if not found then raise exception 'UPLOAD_FORBIDDEN'; end if;
  select * into b from public.document_upload_batches where id = target_batch for update;
  if found and b.case_id <> target_case then raise exception 'UPLOAD_FORBIDDEN'; end if;
  if not found then
    -- A failed/lost sign request may not have reserved yet. A tombstone also
    -- prevents that delayed sign request from publishing after cancellation.
    insert into public.document_upload_batches(id, case_id, manifest, files, cancelled_at)
      values(target_batch, target_case, '{}', '[]', now());
  elsif b.completed_at is null then
    update public.document_upload_batches set cancelled_at = coalesce(cancelled_at, now()) where id = target_batch;
  end if;
  return public.case_documents_snapshot(target_case);
end;
$$;

revoke all on function public.case_documents_snapshot(uuid), public.case_documents_reserve(uuid,uuid,jsonb),
  public.case_documents_batch(uuid,uuid), public.case_documents_commit(uuid,uuid,jsonb), public.case_documents_cancel(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.case_documents_snapshot(uuid), public.case_documents_reserve(uuid,uuid,jsonb),
  public.case_documents_batch(uuid,uuid), public.case_documents_commit(uuid,uuid,jsonb), public.case_documents_cancel(uuid,uuid)
  to service_role, tivdoc_web_runtime;
