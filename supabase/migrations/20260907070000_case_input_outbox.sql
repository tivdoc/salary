-- P05: transactional source journal. Dispatch uses the EXISTING engine queue.
-- No payment, publication, legal activation, or provider call happens here.
create table private.case_input_heads (
 case_id uuid primary key references public.cases(id) on delete cascade,
 revision integer not null check(revision>0), input_sha256 text not null,
 changed_at timestamptz not null default now()
);
create table private.case_input_versions (
 case_id uuid not null references public.cases(id) on delete cascade,
 revision integer not null check(revision>0), input_sha256 text not null check(input_sha256~'^[a-f0-9]{64}$'),
 input jsonb not null, reason text not null, created_at timestamptz not null default now(),
 primary key(case_id,revision)
);
create table private.case_analysis_dispatch (
 case_id uuid not null, revision integer not null,
 mode text not null default 'draft' check(mode in ('draft','shadow','live')),
 job_id text unique references public.engine_durable_jobs(job_id), dispatched_at timestamptz,
 primary key(case_id,revision,mode),
 foreign key(case_id,revision) references private.case_input_versions(case_id,revision) on delete cascade,
 check((job_id is null)=(dispatched_at is null))
);
create table private.case_extraction_checkpoints (
 case_id uuid not null, revision integer not null, version_id uuid not null,
 input_sha256 text not null check(input_sha256~'^[a-f0-9]{64}$'),
 policy_version text not null, result_sha256 text not null check(result_sha256~'^[a-f0-9]{64}$'),
 result jsonb not null, created_at timestamptz not null default now(),
 primary key(case_id,revision,version_id,policy_version),
 foreign key(case_id,revision) references private.case_input_versions(case_id,revision) on delete cascade
);
-- Runtime credentials remain server-only. Browser and service-role routes may
-- cause the constrained trigger, but cannot manufacture a journal or dispatch.
revoke all on private.case_input_heads,private.case_input_versions,private.case_analysis_dispatch,private.case_extraction_checkpoints from public,anon,authenticated,service_role;
grant select on private.case_input_heads,private.case_input_versions,private.case_analysis_dispatch,private.case_extraction_checkpoints to tivdoc_worker_runtime,tivdoc_operations_runtime;
grant update on private.case_analysis_dispatch to tivdoc_worker_runtime;
grant insert on private.case_extraction_checkpoints to tivdoc_worker_runtime;
-- The trigger owner reads append-only answers under FORCE RLS; callers gain no read.
do $$ begin execute format('create policy case_input_capture_owner on public.case_requests for select to %I using(true)', current_user); end $$;
create function private.capture_case_input(target_case uuid, change_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare payload jsonb; digest text; old_head private.case_input_heads; next_revision integer;
begin
 -- All capture transactions serialize on the case, including concurrent docs.
 perform 1 from public.cases where id=target_case for update;
 if not found then return; end if;
 select jsonb_build_object('case_id',c.id,'month',to_char(c.check_period_month,'YYYY-MM'),
  'payment_status',c.payment_status,
  'documents',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'version_id',d.version_id,'sha256',d.content_sha256,'type',d.document_type,'month',d.period_month) order by d.id) from public.documents d where d.case_id=c.id),'[]'::jsonb),
  'questionnaire',(select q.payload from public.questionnaire_responses q where q.case_id=c.id),
  'answers',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'code',r.code,'answer',r.answer_text) order by r.id) from public.case_requests r where r.case_id=c.id and r.answered_at is not null),'[]'::jsonb)) into payload
 from public.cases c where c.id=target_case;
 digest:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
 select * into old_head from private.case_input_heads where case_id=target_case;
 if old_head.input_sha256=digest then return; end if;
 next_revision:=coalesce(old_head.revision,0)+1;
 insert into private.case_input_versions(case_id,revision,input_sha256,input,reason) values(target_case,next_revision,digest,payload,change_reason);
 insert into private.case_input_heads(case_id,revision,input_sha256) values(target_case,next_revision,digest)
 on conflict(case_id) do update set revision=excluded.revision,input_sha256=excluded.input_sha256,changed_at=now();
 insert into private.case_analysis_dispatch(case_id,revision) values(target_case,next_revision);
end;
$$;
revoke all on function private.capture_case_input(uuid,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create function private.capture_case_input_trigger() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='cases' then
  perform private.capture_case_input(new.id,'case_scope_or_payment');
 elsif tg_op='DELETE' then
  perform private.capture_case_input(old.case_id,tg_table_name);
 else
  perform private.capture_case_input(new.case_id,tg_table_name);
 end if;
 return null;
end;
$$;
revoke all on function private.capture_case_input_trigger() from public,anon,authenticated,service_role;
create trigger case_documents_input after insert or update or delete on public.documents for each row execute function private.capture_case_input_trigger();
create trigger case_questionnaire_input after insert or update or delete on public.questionnaire_responses for each row execute function private.capture_case_input_trigger();
create trigger case_answer_input after update of answer_text on public.case_requests for each row execute function private.capture_case_input_trigger();
create trigger case_scope_input after update of check_period_month,payment_status on public.cases for each row execute function private.capture_case_input_trigger();
-- Approval remains a separate human/system decision. Any new report must bind
-- the current source revision; an old approval cannot authorize a new input.
alter table public.case_report_projections add column input_revision integer;
create function private.case_report_current_input() returns trigger
language plpgsql security invoker set search_path='' as $$
declare expected integer; actual integer;
begin
 if new.state in ('approved','published') then
  select revision into expected from private.case_input_heads where case_id=new.case_id;
  select input_revision into actual from public.case_report_projections where id=new.projection_id and case_id=new.case_id;
  if expected is not null and actual is distinct from expected then raise exception 'REPORT_INPUT_STALE'; end if;
 end if;
 return new;
end;
$$;
revoke all on function private.case_report_current_input() from public,anon,authenticated,service_role;
create trigger case_report_current_input before insert or update on public.case_report_qa for each row execute function private.case_report_current_input();
