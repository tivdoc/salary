-- Preserve source-bound quote preparation outcomes in existing order history.
create function private.release_quote_preparation_category(reason text) returns text
language sql immutable security invoker set search_path='' as $$
 select case when reason='offer_saved' then 'ready'
 when reason in ('pricing_comparison_incomplete','pricing_recorded_comparison_missing','pricing_payment_allocation_missing','pricing_payment_source_incomplete') then 'needs_information'
 when reason='pricing_comparison_conditional' then 'conditional_result'
 when reason in ('pricing_comparison_alternatives','pricing_cross_topic_allocation_unavailable','pricing_payment_source_overlap') then 'comparison_needs_review'
 when reason in ('pricing_adapter_unsupported_topics','pricing_adapter_unsupported_rule_branch','pricing_adapter_unsupported_payment_expression','pricing_workday_outside_checked_month','initial_pricing_requires_exact_single_month','ORDER_COVERAGE_UNAVAILABLE') then 'coverage_unavailable'
 when reason in ('verified_initial_credit_unavailable','PRICE_QUOTE_CREDIT_UNAVAILABLE','PRICE_QUOTE_EXISTING_ORDER_REQUIRES_RECONCILIATION') then 'order_needs_review'
 when reason='PRICE_QUOTE_EXPIRED' then 'quote_expired' when reason='below_threshold' then 'below_upgrade_threshold' else 'not_prepared' end
$$;
revoke all on function private.release_quote_preparation_category(text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

-- Return exact current initial analysis/source/order pins. A publication row
-- alone is insufficient: reuse the existing full REAL currentness evaluator.
create function private.release_quote_preparation_context(p_case uuid,p_identity uuid,p_analysis text,p_source text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare ar public.analysis_runs;pub private.real_ai_service_report_publications;initial private.product_orders;h private.case_input_heads;material jsonb;s jsonb;month text;
begin
 select * into h from private.case_input_heads where case_id=p_case;
 if h.case_id is null or h.input_sha256 is distinct from p_source then return null;end if;
 select * into ar from public.analysis_runs where tenant_id='saved-case:'||p_case::text and canonical_case_id=p_case::text and canonical_analysis_run_id=p_analysis and status='completed';
 select * into pub from private.real_ai_service_report_publications where case_id=p_case and identity_id=p_identity and analysis_run_id=p_analysis;
 if ar.id is null or pub.report_id is null then return null;end if;
 s:=ar.completion_payload#>'{bundle,ai_release,input,source}';
 if ar.completion_payload#>'{bundle,ai_release,binding,source_journal}' is distinct from jsonb_build_object('case_id',p_case,'input_revision',h.revision,'input_sha256',p_source)
  or s#>>'{purchased_scope,origin}' is distinct from 'saved_order' then return null;end if;
 select * into initial from private.product_orders where id=(s#>>'{purchased_scope,order_id}')::uuid and case_id=p_case and kind='initial' and state='paid' and refund_state in ('none','rejected');
 if initial.id is null or initial.offer_sha256 is distinct from s#>>'{purchased_scope,receipt_sha256}'
  or not exists(select 1 from private.order_entitlements where order_id=initial.id and state='active') then return null;end if;
 month:=left(s#>>'{period,from}',7);
 if initial.period_from<>initial.period_to or to_char(initial.period_from,'YYYY-MM')<>month or left(s#>>'{period,to}',7)<>month then return null;end if;
 material:=private.real_ai_service_delivery_material(p_case,p_identity,pub.report_id,false);
 if material->>'state' is distinct from 'configured' or material->'publication' is null or material->'publication'='null'::jsonb then return null;end if;
 return jsonb_build_object('case_id',p_case,'identity_id',p_identity,'initial_order_id',initial.id,'initial_order_receipt_sha256',initial.offer_sha256,
  'source_revision',h.revision,'source_sha256',p_source,'analysis_run_id',p_analysis,'period',jsonb_build_object('from',month,'to',month));
end;$$;
revoke all on function private.release_quote_preparation_context(uuid,uuid,text,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

create function private.release_quote_preparation_record(target jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p_case uuid;p_identity uuid;initial_id uuid;context jsonb;prior private.order_events;actor text;category text;
begin
 p_case:=(target->>'case_id')::uuid;p_identity:=(target->>'identity_id')::uuid;initial_id:=(target->>'initial_order_id')::uuid;
 perform private.real_ai_service_assert_worker(p_case);actor:=private.runtime_verified_actor()::text;
 if actor is null or target->>'schema_version' is distinct from 'release-quote-preparation-v1'
  or target->>'sha256' is distinct from private.source_intake_journal_sha(target-'sha256')
  or (target->>'reason'~'^[A-Za-z][A-Za-z0-9_]{0,119}$') is not true then raise exception 'RELEASE_QUOTE_STATUS_BINDING';end if;
 perform 1 from public.cases where id=p_case for update;
 context:=private.release_quote_preparation_context(p_case,p_identity,target->>'analysis_run_id',target->>'source_sha256');
 if context is null or target-'schema_version'-'reason'-'availability'-'quote_id'-'order_id'-'sha256' is distinct from context then raise exception 'RELEASE_QUOTE_STATUS_SOURCE_CHANGED';end if;
 category:=private.release_quote_preparation_category(target->>'reason');
 if target->'availability' is distinct from jsonb_build_object('state',category,'period',context->'period') then raise exception 'RELEASE_QUOTE_STATUS_BINDING';end if;
 if category='ready' then
  if not exists(select 1 from private.order_price_quotes q join private.order_quote_reservations r on r.quote_id=q.id and r.released_at is null
   join private.product_orders o on o.id=r.order_id and o.case_id=p_case and o.kind='full' and o.state='awaiting_payment'
   where q.id::text=target->>'quote_id' and o.id::text=target->>'order_id' and q.case_id=p_case and q.identity_id=p_identity
    and q.snapshot->>'analysis_version'=target->>'analysis_run_id' and q.snapshot->>'input_sha256'=target->>'source_sha256'
    and q.quote_sha256=private.source_intake_journal_sha(q.snapshot-'sha256') and q.snapshot->>'sha256'=q.quote_sha256
    and o.offer->>'price_quote_id'=q.id::text and o.offer->>'price_quote_sha256'=q.quote_sha256 and o.offer->'price_quote'=q.snapshot)
   then raise exception 'RELEASE_QUOTE_STATUS_OFFER_BINDING';end if;
 elsif target->'quote_id' is distinct from 'null'::jsonb or target->'order_id' is distinct from 'null'::jsonb then raise exception 'RELEASE_QUOTE_STATUS_BINDING';end if;
 -- Serialize against the existing order row; repeat of the latest exact result
 -- reuses history, while a later changed commercial outcome appends a new event.
 perform 1 from private.product_orders where id=initial_id and case_id=p_case for update;
 select * into prior from private.order_events where order_id=initial_id and kind='release_quote_preparation_v1' order by id desc limit 1;
 if prior.detail=target then return jsonb_build_object('sha256',target->>'sha256','replayed',true);end if;
 insert into private.order_events(order_id,kind,actor,detail) values(initial_id,'release_quote_preparation_v1',actor,target);
 return jsonb_build_object('sha256',target->>'sha256','replayed',false);
end;$$;
revoke all on function private.release_quote_preparation_record(jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function private.release_quote_preparation_record(jsonb) to tivdoc_worker_runtime;

create function public.case_order_saved_release_quote(target_case uuid,target_identity uuid,target_session_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare h private.case_input_heads;q private.order_price_quotes;selected jsonb;context jsonb;status jsonb;availability jsonb;prior private.order_events;
begin
 if public.case_access_real_service_context_install(target_case,target_session_hash) is distinct from target_identity then raise exception 'ORDER_FORBIDDEN';end if;
 perform private.real_ai_service_assert_web(target_case,target_identity);
 select * into h from private.case_input_heads where case_id=target_case;
 if h.case_id is null then return jsonb_build_object('quote',null,'availability',jsonb_build_object('state','not_prepared','period',null));end if;
 -- Discover only a real existing quote; the old exact-period reader retains
 -- its independent credit, expiry, source, order and ownership guards.
 for q in select p.* from private.order_price_quotes p where p.case_id=target_case and p.identity_id=target_identity
  and p.snapshot->>'input_sha256'=h.input_sha256 and p.snapshot->>'schema_version'='tivdoc-price-quote-v2'
  order by p.created_at desc,p.id loop
  context:=private.release_quote_preparation_context(target_case,target_identity,q.snapshot->>'analysis_version',h.input_sha256);
  if context is null then continue;end if;
  selected:=public.case_order_release_quote(target_case,target_identity,(q.snapshot#>>'{purchased_period,from}'||'-01')::date,(q.snapshot#>>'{purchased_period,to}'||'-01')::date);
  if selected is not null and selected->>'id'=q.id::text then
   perform private.real_ai_service_assert_web(target_case,target_identity);
   return jsonb_build_object('quote',selected,'availability',jsonb_build_object('state','ready','period',q.snapshot->'purchased_period'));
  end if;
 end loop;
 select e.* into prior from private.order_events e join private.product_orders o on o.id=e.order_id
  where o.case_id=target_case and o.kind='initial' and e.kind='release_quote_preparation_v1'
   and e.detail->>'case_id'=target_case::text and e.detail->>'identity_id'=target_identity::text
   and e.detail->>'source_sha256'=h.input_sha256 and e.detail->>'source_revision'=h.revision::text order by e.id desc limit 1;
 if prior.id is not null then
  status:=prior.detail;context:=private.release_quote_preparation_context(target_case,target_identity,status->>'analysis_run_id',h.input_sha256);
  if context is not null and status->>'schema_version'='release-quote-preparation-v1' and status->>'sha256'=private.source_intake_journal_sha(status-'sha256')
   and status-'schema_version'-'reason'-'availability'-'quote_id'-'order_id'-'sha256'=context
   and status->'availability'=jsonb_build_object('state',private.release_quote_preparation_category(status->>'reason'),'period',context->'period') then
   availability:=status->'availability';
   -- Never report an offer as ready after its separate expiry/credit/order
   -- guard refused it. Preserve the historical event rather than rewriting it.
   if availability->>'state'='ready' then
    select * into q from private.order_price_quotes where id=(status->>'quote_id')::uuid and case_id=target_case and identity_id=target_identity;
    availability:=jsonb_build_object('state',case when q.id is not null and statement_timestamp()>=(q.snapshot->>'expires_at')::timestamptz then 'quote_expired' else 'order_needs_review' end,'period',context->'period');
   end if;
  end if;
 end if;
 perform private.real_ai_service_assert_web(target_case,target_identity);
 return jsonb_build_object('quote',null,'availability',coalesce(availability,jsonb_build_object('state','not_prepared','period',null)));
end;$$;
revoke all on function public.case_order_saved_release_quote(uuid,uuid,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function public.case_order_saved_release_quote(uuid,uuid,text) to tivdoc_web_runtime;
