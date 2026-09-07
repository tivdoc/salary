create table private.privacy_requests(id uuid primary key,identity_id uuid not null references public.case_identities(id),case_id uuid not null references public.cases(id),kind text not null check(kind in ('access','correction','deletion')),message text not null check(length(message) between 4 and 2000),state text not null default 'pending' check(state in ('pending','in_review','completed','restricted')),created_at timestamptz not null default now(),due_at timestamptz not null default now()+interval '30 days',resolved_at timestamptz,resolution text,check((state in ('completed','restricted'))=(resolved_at is not null)));
create table private.privacy_request_events(id bigint generated always as identity primary key,request_id uuid not null references private.privacy_requests(id),actor text not null,state text not null,at timestamptz not null default now());
create table private.case_retention_holds(id uuid primary key default gen_random_uuid(),case_id uuid not null references public.cases(id),reason text not null check(reason in ('active_work','dispute','legal_obligation','integrity_investigation')),evidence_reference text not null,created_at timestamptz not null default now(),review_at timestamptz not null,released_at timestamptz);
revoke all on private.privacy_requests,private.privacy_request_events,private.case_retention_holds from public,anon,authenticated,service_role,tivdoc_web_runtime;
grant select on private.privacy_requests,private.privacy_request_events,private.case_retention_holds to tivdoc_operations_runtime,tivdoc_worker_runtime;
grant insert,update on private.case_retention_holds to tivdoc_operations_runtime;
create function public.case_privacy_request(target_id uuid,target_identity uuid,target_case uuid,target_kind text,target_message text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.privacy_requests;
begin
 if not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'PRIVACY_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;
 select * into r from private.privacy_requests where id=target_id;
 if found then if (r.identity_id,r.case_id,r.kind,r.message) is distinct from(target_identity,target_case,target_kind,btrim(target_message)) then raise exception 'PRIVACY_RETRY_CONFLICT';end if;return to_jsonb(r);end if;
 if (select count(*) from private.privacy_requests where identity_id=target_identity and created_at>now()-interval '1 day')>=10 then raise exception 'PRIVACY_RATE_LIMIT';end if;
 insert into private.privacy_requests(id,identity_id,case_id,kind,message) values(target_id,target_identity,target_case,target_kind,btrim(target_message)) returning * into r;
 insert into private.privacy_request_events(request_id,actor,state) values(r.id,'customer','pending');
 return to_jsonb(r);
end;$$;
create function public.case_privacy_requests(target_identity uuid) returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('public_id',c.public_id) order by r.created_at desc),'[]'::jsonb) from private.privacy_requests r join public.cases c on c.id=r.case_id join public.case_identity_cases own on own.case_id=r.case_id and own.identity_id=target_identity where r.identity_id=target_identity;
$$;
create function public.case_privacy_export(target_case uuid,target_identity uuid,target_session uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.case_access_sessions s where s.id=target_session and s.identity_id=target_identity and s.revoked_at is null and s.expires_at>now() and s.created_at>now()-interval '15 minutes') then raise exception 'PRIVACY_REAUTH_REQUIRED';end if;
 if not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'PRIVACY_FORBIDDEN';end if;
 return jsonb_build_object('schema_version','tivdoc-personal-data-export-v1','exported_at',now(),
 'case',(select jsonb_build_object('public_id',public_id,'first_name',first_name,'email',email,'phone',phone,'status',status,'created_at',created_at,'check_period_month',check_period_month,'terms_version',terms_version,'terms_accepted_at',terms_accepted_at) from public.cases where id=target_case),
 'questionnaire',(select payload from public.questionnaire_responses where case_id=target_case),
 'documents',coalesce((select jsonb_agg(jsonb_build_object('id',id,'version_id',version_id,'filename',original_filename,'type',document_type,'mime',mime_type,'size',size,'month',period_month)) from public.documents where case_id=target_case),'[]'::jsonb),
 'answers',coalesce((select jsonb_agg(jsonb_build_object('id',id,'question',question,'answer',answer_text,'answered_at',answered_at)) from public.case_requests where case_id=target_case),'[]'::jsonb),
 'orders',coalesce((select jsonb_agg(jsonb_build_object('id',id,'kind',kind,'from',period_from,'to',period_to,'amount_minor',amount_minor,'currency',currency,'state',state,'refund_state',refund_state,'topics',topics,'terms_version',terms_version)) from private.product_orders where case_id=target_case),'[]'::jsonb),
 'reports',public.case_report_customer_snapshot(target_case,target_identity),
 'answer_versions',coalesce((select jsonb_agg(jsonb_build_object('request_id',v.request_id,'revision',v.revision,'answer',v.answer_text,'at',v.created_at)) from private.case_request_answer_versions v join public.case_requests r on r.id=v.request_id where r.case_id=target_case),'[]'::jsonb),
 'drafts',coalesce((select jsonb_agg(jsonb_build_object('request_id',d.request_id,'answer',d.answer_text,'updated_at',d.updated_at)) from private.case_request_drafts d join public.case_requests r on r.id=d.request_id where r.case_id=target_case and d.identity_id=target_identity),'[]'::jsonb),
 'payments',coalesce((select jsonb_agg(jsonb_build_object('id',id,'amount',amount,'currency',currency,'status',status,'verified_at',verified_at)) from public.payments where case_id=target_case),'[]'::jsonb),
 'privacy_requests',(select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) from private.privacy_requests r where r.case_id=target_case and r.identity_id=target_identity));
end;$$;
create function public.case_privacy_decide(target_request uuid,target_actor text,target_state text,target_resolution text) returns void language plpgsql security definer set search_path='' as $$
begin
 if target_state not in ('in_review','restricted') or length(btrim(target_resolution))<4 then raise exception 'PRIVACY_DECISION_INVALID';end if;
 -- Completion is reserved for a domain executor with actual export/correction/deletion evidence.
 update private.privacy_requests set state=target_state,resolution=left(target_resolution,2000),resolved_at=case when target_state='restricted' then now() else null end where id=target_request and state<>'completed';
 if not found then raise exception 'PRIVACY_REQUEST_MISSING';end if;
 insert into private.privacy_request_events(request_id,actor,state) values(target_request,target_actor,target_state);
end;$$;
revoke all on function public.case_privacy_request(uuid,uuid,uuid,text,text),public.case_privacy_requests(uuid),public.case_privacy_export(uuid,uuid,uuid),public.case_privacy_decide(uuid,text,text,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime;
grant execute on function public.case_privacy_request(uuid,uuid,uuid,text,text),public.case_privacy_requests(uuid),public.case_privacy_export(uuid,uuid,uuid) to service_role,tivdoc_web_runtime;
grant execute on function public.case_privacy_decide(uuid,text,text,text) to tivdoc_operations_runtime;
