-- Repeatable DEV authorizations retain historical capabilities and signed bytes.
create table private.managed_dev_lifecycle_epochs(
 epoch_id uuid primary key, case_id uuid not null references public.cases(id),
 capability_sha256 text not null unique references private.managed_dev_worker_capabilities(capability_sha256),
 session_sid text not null unique references public.product_identity_sessions(sid),
 predecessor_capability_sha256 text not null references private.managed_dev_worker_capabilities(capability_sha256),
 owner_identity_id uuid not null, authorization_reference text not null,
 prepared_at timestamptz not null default clock_timestamp(),expires_at timestamptz not null,
 provider_policy text not null check(provider_policy='saved_receipts_only'),
 ledger_sha256 text not null check(ledger_sha256~'^[a-f0-9]{64}$'),
 check(expires_at>prepared_at and expires_at<=prepared_at+interval '4 hours'),
 check(length(authorization_reference) between 8 and 1000)
);
alter table private.managed_dev_lifecycle_epochs enable row level security;
revoke all on private.managed_dev_lifecycle_epochs from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger managed_dev_epoch_immutable before update or delete on private.managed_dev_lifecycle_epochs for each row execute function private.dev_financial_immutable();

-- An assessment is an immutable signed decision. A new decision gets a new ID
-- and monotonic revision, including after expiry/revocation. No resurrection.
alter table private.june2026_regular_assessments add column assessment_revision integer not null default 1 check(assessment_revision>0);
do $$declare constraint_name text;begin
 select conname into strict constraint_name from pg_constraint where conrelid='private.june2026_regular_assessments'::regclass and contype='u' and pg_get_constraintdef(oid)='UNIQUE (case_id, order_id, input_revision)';
 execute format('alter table private.june2026_regular_assessments drop constraint %I',constraint_name);
end;$$;
alter table private.june2026_regular_assessments add constraint june_regular_assessment_revision_unique unique(case_id,order_id,input_revision,assessment_revision);
create function private.june2026_regular_assessment_append() returns trigger language plpgsql security invoker set search_path='' as $$
declare previous integer;
begin
 if tg_op='DELETE' then raise exception 'REGULAR_ASSESSMENT_IMMUTABLE';end if;
 if tg_op='UPDATE' then
  if (to_jsonb(new)-'revoked_at') is distinct from (to_jsonb(old)-'revoked_at')
   or old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at
   then raise exception 'REGULAR_ASSESSMENT_IMMUTABLE';end if;
  return new;
 end if;
 perform 1 from public.cases where id=new.case_id for update nowait;
 select coalesce(max(assessment_revision),0) into previous from private.june2026_regular_assessments
  where case_id=new.case_id and order_id=new.order_id and input_revision=new.input_revision;
 if new.assessment_revision<>previous+1 then raise exception 'REGULAR_ASSESSMENT_REVISION';end if;
 if new.payload_sha256<>encode(sha256(convert_to(private.governance_jsonb_compact_text(new.payload),'UTF8')),'hex') then raise exception 'REGULAR_ASSESSMENT_HASH';end if;
 return new;
end;$$;
revoke all on function private.june2026_regular_assessment_append() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger june_regular_assessment_append before insert or update or delete on private.june2026_regular_assessments for each row execute function private.june2026_regular_assessment_append();

do $migration$
declare original text;body text;needle text;
begin
 select pg_get_functiondef('private.june2026_regular_authority(uuid,uuid,integer,text)'::regprocedure) into original;
 needle:='where case_id=target_case and order_id=target_order and input_revision=target_revision for share;';
 body:=replace(original,needle,'where case_id=target_case and order_id=target_order and input_revision=target_revision order by assessment_revision desc limit 1 for share;');
 if original=body then raise exception 'ASSESSMENT_SELECTION_ANCHOR';end if;execute body;
 select pg_get_functiondef('private.managed_dev_worker_status(text)'::regprocedure) into original;
 needle:='and a.input_revision=h.revision and (a.payload#>>''{payload,expires_at}'')';
 body:=replace(original,needle,'and a.input_revision=h.revision and not exists(select 1 from private.june2026_regular_assessments newer where newer.case_id=a.case_id and newer.order_id=a.order_id and newer.input_revision=a.input_revision and newer.assessment_revision>a.assessment_revision) and (a.payload#>>''{payload,expires_at}'')');
 if original=body then raise exception 'ASSESSMENT_STATUS_ANCHOR';end if;execute body;
 select pg_get_functiondef('private.managed_dev_worker_health(text)'::regprocedure) into original;
 body:=replace(original,'order by x.created_at desc,x.id limit 1','order by x.input_revision desc,x.assessment_revision desc,x.created_at desc,x.id limit 1');
 if original=body then raise exception 'ASSESSMENT_HEALTH_ANCHOR';end if;execute body;
end $migration$;
