-- Current governance is provisioned by the registry administrator, never by
-- customer answers or the worker. Test namespaces are DEV/QA only.
create table private.june2026_authority_registries (
 registry_key text not null, revision integer not null check(revision>0),
 namespace text not null check(namespace in ('real','isolated_test')),
 payload jsonb not null,payload_sha256 text not null check(payload_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default transaction_timestamp(),
 primary key(registry_key,revision),
 check(payload#>>'{registry,namespace}'=namespace)
);
create table private.june2026_regular_assessments (
 id uuid primary key,case_id uuid not null references public.cases(id),
 order_id uuid not null references private.product_orders(id),input_revision integer not null,
 input_sha256 text not null,registry_key text not null,payload jsonb not null,payload_sha256 text not null,
 created_at timestamptz not null default transaction_timestamp(),revoked_at timestamptz,
 unique(case_id,order_id,input_revision),
 check(input_sha256 ~ '^[a-f0-9]{64}$' and payload_sha256 ~ '^[a-f0-9]{64}$'),
 check(coalesce(payload#>>'{payload,assessment_id}'=id::text and payload#>>'{payload,case_id}'=case_id::text
  and payload#>>'{payload,order_id}'=order_id::text and (payload#>>'{payload,input_revision}')::integer=input_revision
  and payload#>>'{payload,input_sha256}'=input_sha256,false))
);
alter table private.june2026_authority_registries enable row level security;
alter table private.june2026_regular_assessments enable row level security;
revoke all on private.june2026_authority_registries,private.june2026_regular_assessments
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger june_regular_registry_immutable before update or delete on private.june2026_authority_registries
 for each row execute function private.dev_financial_immutable();

create function private.june2026_regular_registry_append() returns trigger language plpgsql security invoker set search_path='' as $$
declare old private.june2026_authority_registries; a jsonb;b jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('june-registry:'||new.registry_key,0));
 if new.payload_sha256<>encode(sha256(convert_to(private.governance_jsonb_compact_text(new.payload),'UTF8')),'hex')
  then raise exception 'REGULAR_REGISTRY_HASH';end if;
 select * into old from private.june2026_authority_registries where registry_key=new.registry_key order by revision desc limit 1;
 if not found then if new.revision<>1 then raise exception 'REGULAR_REGISTRY_FIRST_REVISION';end if;return new;end if;
 if new.revision<>old.revision+1 or new.namespace<>old.namespace
  or new.payload#>'{trust_journal,root_admin_ids}' is distinct from old.payload#>'{trust_journal,root_admin_ids}'
  or new.payload->'registry' is distinct from old.payload->'registry'
  or new.payload#>'{legal,goldenCases}' is distinct from old.payload#>'{legal,goldenCases}'
  then raise exception 'REGULAR_REGISTRY_HISTORY_BINDING';end if;
 if exists(select 1 from jsonb_array_elements(old.payload#>'{trust_journal,events}') with ordinality x(value,n)
  where value is distinct from new.payload#>'{trust_journal,events}'->(n::integer-1)) then raise exception 'REGULAR_TRUST_HISTORY_TRUNCATED';end if;
 if jsonb_array_length(new.payload#>'{legal,artifacts}')<>jsonb_array_length(old.payload#>'{legal,artifacts}') then raise exception 'REGULAR_LEGAL_INVENTORY_CHANGED';end if;
 for a in select value from jsonb_array_elements(old.payload#>'{legal,artifacts}') loop
  select value into b from jsonb_array_elements(new.payload#>'{legal,artifacts}') where value->'import'=a->'import';
  if b is null or exists(select 1 from jsonb_array_elements(a->'events') with ordinality x(value,n)
   where value is distinct from b->'events'->(n::integer-1)) then raise exception 'REGULAR_LEGAL_HISTORY_TRUNCATED';end if;
 end loop;
 return new;
end;$$;
revoke all on function private.june2026_regular_registry_append() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger june_regular_registry_append before insert on private.june2026_authority_registries for each row execute function private.june2026_regular_registry_append();

create function private.june2026_regular_authority(target_case uuid,target_order uuid,target_revision integer,target_sha text) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare a private.june2026_regular_assessments; r private.june2026_authority_registries;h private.case_input_heads;
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'REGULAR_AUTHORITY_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;
 select * into h from private.case_input_heads where case_id=target_case;
 if h.revision is distinct from target_revision or h.input_sha256 is distinct from target_sha then raise exception 'REGULAR_AUTHORITY_SOURCE_CHANGED';end if;
 select * into a from private.june2026_regular_assessments where case_id=target_case and order_id=target_order and input_revision=target_revision for share;
 if not found then return null;end if;
 perform pg_advisory_xact_lock_shared(hashtextextended('june-registry:'||a.registry_key,0));
 select * into r from private.june2026_authority_registries where registry_key=a.registry_key order by revision desc limit 1;
 if not found then return jsonb_build_object('state','blocked','reason','current_registry_missing');end if;
 if a.revoked_at is not null then return jsonb_build_object('state','blocked','reason','case_assessment_revoked');end if;
 if (a.payload#>>'{payload,expires_at}')::timestamptz<=transaction_timestamp()
  or (a.payload#>>'{payload,issued_at}')::timestamptz>transaction_timestamp()
  or exists(select 1 from jsonb_array_elements(r.payload#>'{legal,artifacts}') item
   cross join lateral jsonb_array_elements(item->'events') e where e->'envelope'<>'null'::jsonb
    and ((e#>>'{envelope,expires_at}')::timestamptz<=transaction_timestamp()
     or (e#>>'{envelope,issued_at}')::timestamptz>transaction_timestamp()))
  then return jsonb_build_object('state','blocked','reason','authority_expired_or_not_yet_valid');end if;
 if a.input_sha256<>target_sha or a.payload#>>'{payload,namespace}'<>r.namespace
  or a.payload_sha256<>encode(sha256(convert_to(private.governance_jsonb_compact_text(a.payload),'UTF8')),'hex')
  or r.payload_sha256<>encode(sha256(convert_to(private.governance_jsonb_compact_text(r.payload),'UTF8')),'hex') then raise exception 'REGULAR_AUTHORITY_BINDING';end if;
 if r.namespace='isolated_test' and (current_database()<>'tivdoc_release_replay_20260907'
  or not exists(select 1 from public.cases where id=target_case and is_qa and contact_verified_at is not null)) then raise exception 'REGULAR_TEST_NAMESPACE_FORBIDDEN';end if;
 if not exists(select 1 from private.product_orders o join private.order_entitlements e on e.order_id=o.id
  join public.documents d on d.case_id=o.case_id where o.id=target_order and o.case_id=target_case and o.state='paid'
   and o.refund_state<>'refunded' and e.state='active' and '2026-06-01'::date between o.period_from and o.period_to
   and o.topics=array['minimum_wage']::text[] and d.document_type='payslip' and d.period_month='2026-06-01'
   and d.version_id::text=a.payload#>>'{payload,document_version_id}' and d.content_sha256=a.payload#>>'{payload,document_sha256}') then raise exception 'REGULAR_AUTHORITY_PURCHASE_SOURCE';end if;
 return jsonb_build_object('state','loaded','registry',r.payload,'registry_sha256',r.payload_sha256,'registry_revision',r.revision,
  'assessment',a.payload,'assessment_sha256',a.payload_sha256,'evaluated_at',transaction_timestamp());
end;$$;
revoke all on function private.june2026_regular_authority(uuid,uuid,integer,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.june2026_regular_authority(uuid,uuid,integer,text) to tivdoc_worker_runtime;
