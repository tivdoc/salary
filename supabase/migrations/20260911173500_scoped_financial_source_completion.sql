-- Scoped source completion and suppression of obsolete unsent reminders.
-- No historical target/assessment/answer rewrite. No notification is sent.
-- Optional source-pinned gaps preserve missing rules/applicability; satisfying
-- a source request does not make those independent checks complete.
create function private.document_review_gap_sources_bound(review jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
 select coalesce(jsonb_typeof(review->'coverage_gaps')='array' and jsonb_typeof(review->'documents')='array'
 and not exists(select 1 from jsonb_array_elements(review->'coverage_gaps') gap where gap ? 'source_pins' and (
  jsonb_typeof(gap->'source_pins') is distinct from 'array'
  or jsonb_array_length(gap->'source_pins') not between 1 and 32
  or exists(select 1 from jsonb_array_elements(gap->'source_pins') pin where pin->>'case_id' is distinct from review->>'case_id'
   or not exists(select 1 from jsonb_array_elements(review->'documents') d where d->>'case_id'=pin->>'case_id'
    and d->>'version_id'=pin->>'version_id' and d->>'file_sha256'=pin->>'source_sha256'
    and (d->>'document_id'=pin->>'document_id' or d->>'document_id'=pin->>'version_id'))))),false)
$$;
revoke all on function private.document_review_gap_sources_bound(jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.document_review_financial_inventory_covered(target jsonb,dependencies jsonb,review jsonb,pins jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
 select coalesce(target->>'fact_key'='payslip.financial_source' and target->>'kind'='document' and target->>'document_kind'='payslip'
  and jsonb_typeof(dependencies)='array' and jsonb_typeof(review#>'{purchased_scope,topics}')='array'
  and jsonb_array_length(dependencies)=jsonb_array_length(review#>'{purchased_scope,topics}')
  and (select count(distinct value) from jsonb_array_elements_text(dependencies))=jsonb_array_length(dependencies)
  and (select count(distinct value) from jsonb_array_elements_text(review#>'{purchased_scope,topics}'))=jsonb_array_length(dependencies)
  and jsonb_array_length(dependencies)>0 and private.document_review_gap_sources_bound(review)
  and not exists(select 1 from jsonb_array_elements_text(review#>'{purchased_scope,topics}') topic where
   not dependencies @> jsonb_build_array('missing.payslip.'||topic)
   or not (
    exists(select 1 from jsonb_array_elements(review->'coverage_gaps') gap
     cross join lateral jsonb_array_elements(coalesce(gap->'source_pins','[]'::jsonb)) source
     where gap->>'topic'=topic and exists(select 1 from jsonb_array_elements(pins) pin
      where source->>'case_id'=pin->>'case_id' and source->>'version_id'=pin->>'version_id'
       and source->>'source_sha256'=pin->>'source_sha256'
       and (source->>'document_id'=pin->>'document_id' or source->>'document_id'=pin->>'version_id')))
    or exists(select 1 from jsonb_array_elements(review->'checks') c
     cross join lateral jsonb_array_elements(c#>'{calculation,input,source_manifest}') source
     where c->>'topic'=topic and source->>'kind'='case_document' and source->>'case_id'=review->>'case_id'
      and exists(select 1 from jsonb_array_elements(pins) pin where source->>'case_id'=pin->>'case_id'
       and source->>'version_id'=pin->>'version_id' and source->>'file_sha256'=pin->>'source_sha256'
       and (source->>'document_id'=pin->>'document_id' or source->>'document_id'=pin->>'version_id'))
      and exists(select 1 from jsonb_array_elements(c#>'{calculation,input,operands}') operand
       where operand#>>'{source,document_id}'=source->>'document_id' and operand#>>'{source,version_id}'=source->>'version_id'
        and operand#>>'{source,file_sha256}'=source->>'file_sha256'))
   )),false)
$$;
revoke all on function private.document_review_financial_inventory_covered(jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

-- Existing sweep is SECURITY INVOKER and retains its ACL/RLS. Expose only the
-- current satisfied boolean to its already authorized worker role. The full
-- state, source receipt and private target stay inaccessible to that role.
create function private.document_review_information_satisfied_for_sweep(target_case uuid,target_request uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
begin
 if session_user<>'tivdoc_worker_runtime' then raise exception 'REVIEW_UPLOAD_FORBIDDEN';end if;
 return exists(select 1 from public.case_requests q join private.document_review_request_targets t on t.request_id=q.id and t.case_id=q.case_id
  where q.id=target_request and q.case_id=target_case and q.code='document_review:'||t.target_sha256
   and q.answer_kind='document' and t.target->>'kind'='document'
   and private.document_review_request_current(target_case,target_request)
   and private.document_review_upload_state(target_case,target_request)->'information_satisfied'='true'::jsonb);
end;$$;
revoke all on function private.document_review_information_satisfied_for_sweep(uuid,uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.document_review_information_satisfied_for_sweep(uuid,uuid) to tivdoc_worker_runtime;

do $forward$
declare definition text;needle text;replacement text;
begin
 definition:=pg_get_functiondef('private.document_review_upload_assess(uuid,integer,text,uuid,text,text)'::regprocedure);
 needle:=$old$  or jsonb_typeof(planner->'evidence') is distinct from 'array' or jsonb_typeof(planner->'documents') is distinct from 'array'$old$;
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'REVIEW_FINANCIAL_GAP_VALIDATION_DRIFT';end if;
 definition:=replace(definition,needle,needle||E'\n  or not private.document_review_gap_sources_bound(review)');
 needle:=$old$ elsif exists(select 1 from jsonb_array_elements_text(t.dependent_check_ids) dep where not exists(select 1 from jsonb_array_elements((review->'checks')||(review->'coverage_gaps')) c where c->>'check_id'=dep)) then$old$;
 replacement:=$new$ elsif exists(select 1 from jsonb_array_elements_text(t.dependent_check_ids) dep where not exists(select 1 from jsonb_array_elements((review->'checks')||(review->'coverage_gaps')) c where c->>'check_id'=dep))
  and not private.document_review_financial_inventory_covered(t.target,t.dependent_check_ids,review,pins) then$new$;
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'REVIEW_FINANCIAL_DEPENDENCY_DRIFT';end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$   and pd->>'review'='complete' and pd#>>'{period,from}'<=t.target#>>'{period,from}'$old$;
 replacement:=$new$   and (pd->>'review'='complete' or (t.target->>'fact_key'='payslip.financial_source' and pd->>'kind'='payslip'
    and pd->>'review'='partial' and pd->'review_completed_fact_keys'='["payslip.financial_source"]'::jsonb))
   and pd#>>'{period,from}'<=t.target#>>'{period,from}'$new$;
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'REVIEW_FINANCIAL_PARTIAL_DRIFT';end if;
 definition:=replace(definition,needle,replacement);execute definition;

 -- All prior request namespaces/completion rounds remain untouched. This
 -- additional branch uses exact persisted target/currentness and excludes a
 -- satisfied upload without inventing answered_at or changing source_current.
 definition:=pg_get_functiondef('private.managed_dev_notification_event_current(uuid,text)'::regprocedure);
 needle:='or exists(select 1 from private.dev_financial_request_targets t where t.request_id=q.id and';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'REVIEW_FINANCIAL_NOTIFICATION_DRIFT';end if;
 replacement:=$new$or exists(select 1 from private.document_review_request_targets t where t.request_id=q.id and t.case_id=target_case
   and q.code='document_review:'||t.target_sha256 and private.document_review_request_current(target_case,q.id)
   and not coalesce(private.document_review_upload_state(target_case,q.id)->'information_satisfied'='true'::jsonb,false))
  or exists(select 1 from private.dev_financial_request_targets t where t.request_id=q.id and$new$;
 execute replace(definition,needle,replacement);

 definition:=pg_get_functiondef('public.case_request_sweep(timestamptz,integer)'::regprocedure);
 needle:='for r in select * from public.case_requests where answered_at is null and expired_at is null';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'REVIEW_FINANCIAL_SWEEP_DRIFT';end if;
 execute replace(definition,needle,needle||E'\n  and not private.document_review_information_satisfied_for_sweep(case_id,id)');

 -- Preserve old reminder events/outcomes. A previously created, unsent intent
 -- is not allowed to be enqueued or claimed after current information is found.
 definition:=pg_get_functiondef('public.case_notification_request_reminders(integer)'::regprocedure);
 needle:='and r.expires_at>now() and c.contact_verified_at is not null';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'REVIEW_FINANCIAL_REMINDER_DISCOVERY_DRIFT';end if;
 execute replace(definition,needle,needle||E'\n and not (private.document_review_request_current(r.case_id,r.id) and coalesce(private.document_review_upload_state(r.case_id,r.id)->\'information_satisfied\'=\'true\'::jsonb,false))');
 definition:=pg_get_functiondef('public.case_notification_reminder_enqueue(uuid,text,text,uuid,uuid,text,jsonb,timestamptz)'::regprocedure);
 needle:='and r.expires_at>now() for update of r,e;';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'REVIEW_FINANCIAL_REMINDER_ENQUEUE_DRIFT';end if;
 replacement:=$new$and r.expires_at>now() and not (private.document_review_request_current(r.case_id,r.id)
  and coalesce(private.document_review_upload_state(r.case_id,r.id)->'information_satisfied'='true'::jsonb,false)) for update of r,e;$new$;
 execute replace(definition,needle,replacement);
 definition:=pg_get_functiondef('public.case_notification_outbox_claim(uuid)'::regprocedure);
 needle:='(r.answered_at is not null or r.expired_at is not null or r.expires_at<=now())';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'REVIEW_FINANCIAL_REMINDER_CLAIM_DRIFT';end if;
 replacement:=$new$(r.answered_at is not null or r.expired_at is not null or r.expires_at<=now()
  or (private.document_review_request_current(r.case_id,r.id) and coalesce(private.document_review_upload_state(r.case_id,r.id)->'information_satisfied'='true'::jsonb,false)))$new$;
 execute replace(definition,needle,replacement);
end;$forward$;
