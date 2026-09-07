-- Local/worker-credential webhook ingress still verifies Svix before this RPC.
-- The customer web role remains unable to manufacture provider events.
grant execute on function public.case_notification_webhook_record(text,uuid,text,timestamptz) to tivdoc_worker_runtime;
