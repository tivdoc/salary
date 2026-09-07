-- Aggregate operations evidence; no contact data, tokens, payloads or salary amounts.
create function public.case_funnel_monitor() returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('schema_version','tivdoc-monitor-v1','observed_at',now(),'population','all_operational_records_including_qa','alerts',(select coalesce(jsonb_agg(a),'[]'::jsonb) from (
 select 'dispatch_pending' code,count(*) count,min(i.created_at) oldest_at from private.case_analysis_dispatch d join private.case_input_versions i using(case_id,revision) where d.job_id is null and i.created_at<now()-interval '5 minutes'
 union all select 'job_lease_expired',count(*),min(lease_expires_at) from public.engine_durable_jobs where state in ('leased','running') and lease_expires_at<now()
 union all select 'job_dead_letter',count(*),min(updated_at) from public.engine_durable_jobs where state='dead_letter'
 union all select 'notification_stalled',count(*),min(created_at) from private.case_notification_outbox where (state='queued' and created_at<now()-interval '5 minutes') or(state='leased' and lease_expires_at<now())
 union all select 'notification_dead_letter',count(*),min(created_at) from private.case_notification_outbox where state='dead_letter'
 union all select 'payment_uncertain',count(*),min(created_at) from private.order_checkouts where state='uncertain' or(state='creating' and created_at<now()-interval '10 minutes')
 union all select 'published_delivery_unlinked',count(*),min(created_at) from private.case_report_delivery where delivery_id is null and created_at<now()-interval '5 minutes'
 union all select 'privacy_overdue',count(*),min(due_at) from private.privacy_requests where state in ('pending','in_review') and due_at<now()
 ) a),'clocks',(select coalesce(jsonb_agg(c),'[]'::jsonb) from (select s.*,coalesce((select jsonb_agg(jsonb_build_object('start',p.started_at,'end',p.ended_at)) from private.order_sla_pauses p where p.order_id=s.order_id),'[]'::jsonb) pauses from private.order_sla s where completed_at is null order by started_at limit 100) c),'clocks_total',(select count(*) from private.order_sla where completed_at is null),'storage_integrity','not_measured','provider_cost','not_measured');
$$;
revoke all on function public.case_funnel_monitor() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime;
grant execute on function public.case_funnel_monitor() to tivdoc_operations_runtime;
do $$ begin execute format('create policy monitor_owner_jobs on public.engine_durable_jobs for select to %I using(true)',current_user);end $$;
