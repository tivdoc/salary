-- Owner-only draft artifacts in isolated DEV; no public report projection.
create or replace function public.case_report_private_review_list(target_case uuid,target_identity uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if current_database()<>'tivdoc_release_replay_20260907' or session_user<>'tivdoc_web_runtime' then return '[]'::jsonb;end if;
 if not exists(select 1 from public.cases c join public.case_identity_cases i on i.case_id=c.id
  where c.id=target_case and c.is_qa and c.contact_verified_at is not null and i.identity_id=target_identity) then return '[]'::jsonb;end if;
 select coalesce(jsonb_agg(s.payload order by s.created_at desc,s.run_id),'[]'::jsonb) into result from (
 select ar.created_at,ar.canonical_analysis_run_id run_id,jsonb_build_object(
  'report_id',ar.completion_payload#>>'{report,report_id}','analysis_run_id',ar.canonical_analysis_run_id,
  'period',ar.completion_payload#>'{bundle,document_review,period}',
  'report_revision',(ar.completion_payload#>>'{report,report_revision}')::integer,'created_at',ar.created_at,
  'purchased_topics',ar.completion_payload#>'{bundle,document_review,purchased_scope,topics}',
  'current',ar.command_payload->>'document_snapshot_id'='saved-documents:'||left(ar.command_payload#>>'{period,start_date}',7)||':'||h.input_sha256
   and not exists(select 1 from public.analysis_runs newer where newer.case_id=ar.case_id and newer.tenant_id=ar.tenant_id
    and newer.status='completed' and newer.completion_payload#>>'{bundle,document_review,purchased_scope,order_id}'=ar.completion_payload#>>'{bundle,document_review,purchased_scope,order_id}'
    and newer.command_payload->'period'=ar.command_payload->'period' and (newer.created_at,newer.id)>(ar.created_at,ar.id))
   and (exists(select 1 from private.product_orders o join private.order_entitlements e on e.order_id=o.id
     where o.case_id=target_case and o.id::text=ar.completion_payload#>>'{bundle,document_review,purchased_scope,order_id}'
      and o.offer_sha256=ar.completion_payload#>>'{bundle,document_review,purchased_scope,receipt_sha256}' and o.state='paid' and o.refund_state<>'refunded' and e.state='active')
    or exists(select 1 from jsonb_array_elements(private.legacy_paid_scopes_internal(target_case)) receipt
     where receipt->>'id'=ar.completion_payload#>>'{bundle,document_review,purchased_scope,order_id}'
      and receipt->>'receipt_sha256'=ar.completion_payload#>>'{bundle,document_review,purchased_scope,receipt_sha256}'))
 ) payload
 from public.analysis_runs ar join private.case_input_heads h on h.case_id::text=ar.canonical_case_id
 join public.engine_report_versions r on r.analysis_run_id=ar.id and r.tenant_id=ar.tenant_id and r.case_id=ar.case_id
  and r.report_id=ar.completion_payload#>>'{report,report_id}' and r.report_sha256=ar.completion_payload#>>'{report,report_sha256}'
  and r.analysis_result_sha256=ar.completion_payload#>>'{bundle,result_sha256}'
 where ar.canonical_case_id=target_case::text and ar.tenant_id='saved-case:'||target_case::text and ar.canonical_case_id=target_case::text and ar.status='completed'
  and ar.completion_payload#>>'{bundle,document_review,schema_version}'='document-review-product-v1'
  and ar.completion_payload#>>'{bundle,document_review,case_id}'=target_case::text
  and ar.completion_payload#>>'{bundle,document_review,analysis_run_id}'=ar.canonical_analysis_run_id
 order by ar.created_at desc,ar.id desc limit 100) s;
 return result;
end;$$;
revoke all on function public.case_report_private_review_list(uuid,uuid) from public,anon,authenticated,service_role,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_report_private_review_list(uuid,uuid) to tivdoc_web_runtime;

create or replace function public.case_report_private_review_artifact(target_case uuid,target_identity uuid,target_report uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare summary jsonb;result jsonb;
begin
 select item into summary from jsonb_array_elements(public.case_report_private_review_list(target_case,target_identity)) item where item->>'report_id'=target_report::text;
 if not found then return null;end if;
 select jsonb_build_object('current',summary->'current','completion',ar.completion_payload) into result
 from public.analysis_runs ar where ar.canonical_case_id=target_case::text and ar.tenant_id='saved-case:'||target_case::text
  and ar.canonical_analysis_run_id=summary->>'analysis_run_id' and ar.status='completed'
  and ar.completion_payload#>>'{report,report_id}'=target_report::text;
 return result;
end;$$;
revoke all on function public.case_report_private_review_artifact(uuid,uuid,uuid) from public,anon,authenticated,service_role,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_report_private_review_artifact(uuid,uuid,uuid) to tivdoc_web_runtime;
