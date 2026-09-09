-- Operational collection policy v1, not a legal dependency/entitlement rule.
-- Five shared payslip readings support document consistency. Dedicated cells
-- are requested only for their purchased topic. No historical row is rewritten.
create function private.document_field_question_fields_v1(purchased_topics text[]) returns text[]
 language sql immutable security invoker set search_path='' as $$
 select coalesce(array_agg(f.field order by f.field),'{}'::text[]) from (values
  ('base_monthly_salary',null::text),('hourly_rate',null),('gross_salary',null),('net_salary',null),('regular_hours',null),
  ('overtime_125_hours','working_time'),('overtime_150_hours','working_time'),('pension_base','pension'),
  ('travel_amount','travel'),('convalescence_amount','convalescence'),('vacation_balance','vacation'),('sick_balance','sick_leave')
 ) f(field,topic)
 where cardinality(purchased_topics)>0 and array_position(purchased_topics,null) is null
  and purchased_topics <@ array['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave']::text[]
  and (f.topic is null or f.topic=any(purchased_topics));
$$;
revoke all on function private.document_field_question_fields_v1(text[]) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.document_field_question_fields_v1(text[]) to tivdoc_worker_runtime;

create or replace function private.document_field_request_open(target_case uuid,expected_revision integer,expected_input_sha256 text,target_payload jsonb,target_question text) returns uuid
 language plpgsql security definer set search_path='' as $$
declare new_request uuid; head private.case_input_heads; candidate_field text:=target_payload#>>'{candidate,field}';
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;if not found then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 select * into head from private.case_input_heads where case_id=target_case;
 if head.revision is distinct from expected_revision or head.input_sha256 is distinct from expected_input_sha256 then raise exception 'REQUEST_FIELD_SOURCE_CHANGED';end if;
 if not coalesce(target_payload->>'schema_version'='document-field-confirmation-v1' and target_payload->>'case_id'=target_case::text
  and target_payload->>'target_sha256' ~ '^[a-f0-9]{64}$' and target_payload->>'month' ~ '^\d{4}-(0[1-9]|1[0-2])$'
  and target_payload->'candidate'->'normalized_value'<>'null'::jsonb
  and candidate_field in ('base_monthly_salary','hourly_rate','gross_salary','net_salary','regular_hours','overtime_125_hours','overtime_150_hours','pension_base','travel_amount','convalescence_amount','vacation_balance','sick_balance'),false)
  or char_length(target_question) not between 4 and 400 or target_question is null then raise exception 'REQUEST_FIELD_TARGET_INVALID';end if;
 if not private.document_field_current(target_case,target_payload) then raise exception 'REQUEST_FIELD_SOURCE_CHANGED';end if;
 if not exists(select 1 from private.product_orders o join private.order_entitlements e on e.order_id=o.id and e.state='active'
  where o.case_id=target_case and o.state='paid' and o.refund_state<>'refunded'
   and to_date(target_payload->>'month','YYYY-MM') between o.period_from and o.period_to) then raise exception 'REQUEST_FIELD_UNPURCHASED_MONTH';end if;
 -- The same paid order must be pinned in this exact input revision and still
 -- own an active entitlement. A different month's topic never authorizes it.
 if not exists(select 1 from private.case_input_versions v
  cross join lateral jsonb_array_elements(v.input->'orders') pinned
  join private.product_orders o on o.case_id=v.case_id and o.id::text=pinned->>'id'
  join private.order_entitlements e on e.order_id=o.id and e.state='active'
  where v.case_id=target_case and v.revision=expected_revision and v.input_sha256=expected_input_sha256
   and o.state='paid' and o.refund_state<>'refunded'
   and pinned=jsonb_build_object('id',o.id,'kind',o.kind,'from',o.period_from,'to',o.period_to,'topics',o.topics,'offer_sha256',o.offer_sha256)
   and to_date(target_payload->>'month','YYYY-MM') between o.period_from and o.period_to
   and candidate_field=any(private.document_field_question_fields_v1(o.topics))) then raise exception 'REQUEST_FIELD_UNPURCHASED_TOPIC';end if;
 select t.request_id into new_request from private.document_field_targets t where t.case_id=target_case and t.target_sha256=target_payload->>'target_sha256';
 if new_request is not null then
  if (select t.target from private.document_field_targets t where t.request_id=new_request) is distinct from target_payload then raise exception 'REQUEST_FIELD_TARGET_CONFLICT';end if;
  return new_request;
 end if;
 new_request:=gen_random_uuid();
 insert into private.document_field_targets(request_id,case_id,target_sha256,target) values(new_request,target_case,target_payload->>'target_sha256',target_payload);
 insert into public.case_requests(id,case_id,code,question,answer_kind,options,field_crop,blocking,expires_at)
 values(new_request,target_case,'document_field:'||(target_payload->>'target_sha256'),target_question,'choice',
 array['כן, בדקתי במסמך והערך נכון','הערך שונה במסמך','לא ניתן לקרוא את השדה'],candidate_field,false,clock_timestamp()+interval '10 days');
 return new_request;
end;$$;
revoke all on function private.document_field_request_open(uuid,integer,text,jsonb,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.document_field_request_open(uuid,integer,text,jsonb,text) to tivdoc_worker_runtime;
