-- DML proof is always rolled back, including when the DDL is upgraded.
do $contract$
declare null_field integer; worker_id uuid:=gen_random_uuid(); outbox_provider uuid:=gen_random_uuid(); who uuid; other_id uuid; message_id uuid:=gen_random_uuid(); receipt uuid; replay uuid; before_id uuid:=gen_random_uuid(); sample_time timestamptz:=clock_timestamp();
begin
 begin
  who:=public.case_access_identity_upsert('email',encode(sha256(convert_to('email|direct-receipt-schema-probe@example.invalid','UTF8')),'hex'),'direct-receipt-schema-probe@example.invalid');
  other_id:=public.case_access_identity_upsert('email',encode(sha256(convert_to('email|foreign-direct-schema-probe@example.invalid','UTF8')),'hex'),'foreign-direct-schema-probe@example.invalid');
  if has_function_privilege('anon','public.case_notification_record_provider(uuid,uuid,text,text,text,text,text,text,uuid)','execute') or has_function_privilege('authenticated','public.case_notification_record_provider(uuid,uuid,text,text,text,text,text,text,uuid)','execute') or has_function_privilege('tivdoc_worker_runtime','public.case_notification_record_provider(uuid,uuid,text,text,text,text,text,text,uuid)','execute') or has_function_privilege('tivdoc_web_runtime','private.apply_direct_notification_events(uuid)','execute') then raise exception 'DIRECT_RECEIPT_ACL';end if;
  if not has_function_privilege('tivdoc_web_runtime','public.case_notification_record_provider(uuid,uuid,text,text,text,text,text,text,uuid)','execute') then raise exception 'DIRECT_RECEIPT_WEB_ACL';end if;
  receipt:=public.case_notification_record_provider(null,who,'email','access_code','sent','resend',repeat('a',64),null,message_id);
  if not exists(select 1 from public.case_notifications where id=receipt and state='sent' and delivered_at is null and provider_message_id=message_id) then raise exception 'ACCEPTANCE_NOT_DELIVERY';end if;
  perform public.case_notification_webhook_record('synthetic-direct:'||message_id::text,message_id,'email.delivered',sample_time);
  if not exists(select 1 from public.case_notifications where id=receipt and state='delivered' and delivered_at=sample_time) then raise exception 'DIRECT_DELIVERY_NOT_LINKED';end if;
  replay:=public.case_notification_record_provider(null,who,'email','access_code','sent','resend',repeat('a',64),null,message_id);
  if replay<>receipt or (select count(*) from public.case_notifications where provider_message_id=message_id)<>1 then raise exception 'DIRECT_RETRY_DUPLICATED';end if;
  begin
   perform public.case_notification_record_provider(null,other_id,'email','access_code','sent','resend',repeat('a',64),null,message_id);
   raise exception 'FOREIGN_RECEIPT_ACCEPTED';
  exception when others then if sqlerrm<>'NOTIFICATION_PROVIDER_RECEIPT_MISMATCH' then raise;end if;end;
  for null_field in 1..6 loop
   begin
    perform public.case_notification_record_provider(null,case when null_field=1 then null else who end,case when null_field=2 then null else 'email' end,case when null_field=3 then null else 'access_code' end,case when null_field=4 then null else 'sent' end,case when null_field=5 then null else 'resend' end,case when null_field=6 then null else repeat('a',64) end,null,message_id);
    raise exception 'NULL_RECEIPT_ACCEPTED';
   exception when others then if sqlerrm<>'NOTIFICATION_PROVIDER_RECEIPT_SCOPE' then raise;end if;end;
  end loop;
  perform public.case_notification_webhook_record('synthetic-failed:'||message_id::text,message_id,'email.failed',sample_time-interval '1 second');
  if (select state from public.case_notifications where id=receipt)<>'delivered' then raise exception 'OLD_FAILURE_REPLACED_DELIVERY';end if;
  perform public.case_notification_webhook_record('synthetic-first:'||before_id::text,before_id,'email.delivered',sample_time);
  replay:=public.case_notification_record_provider(null,who,'email','access_code','sent','resend',repeat('b',64),null,before_id);
  if (select state from public.case_notifications where id=replay)<>'delivered' then raise exception 'EARLY_WEBHOOK_LOST';end if;
  perform public.case_notification_webhook_record('synthetic-suppressed:'||before_id::text,before_id,'email.suppressed',sample_time+interval '1 second');
  if (select state from public.case_notifications where id=replay)<>'refused' then raise exception 'SUPPRESSION_NOT_RECORDED';end if;
  insert into private.case_notification_outbox(delivery_id,identity_id,recipient_sha256,template,encrypted_payload,state,attempts,fencing_token,lease_owner,lease_expires_at,expires_at)
   values(repeat('c',64),other_id,repeat('d',64),'access_code','{"synthetic_contract_only":true}'::jsonb,'leased',1,1,worker_id,now()+interval '1 minute',now()+interval '10 minutes');
  begin
   perform public.case_notification_outbox_finish(repeat('c',64),worker_id,1,message_id,null);
   raise exception 'DIRECT_ID_REASSIGNED_TO_OUTBOX';
  exception when others then if sqlerrm<>'NOTIFICATION_PROVIDER_RECEIPT_MISMATCH' then raise;end if;end;
  begin
   perform public.case_notification_outbox_finish(repeat('c',64),worker_id,null,outbox_provider,null);
   raise exception 'NULL_FENCE_ACCEPTED';
  exception when others then if sqlerrm<>'NOTIFICATION_LEASE_LOST' then raise;end if;end;
  perform public.case_notification_outbox_finish(repeat('c',64),worker_id,1,outbox_provider,null);
  begin
   perform public.case_notification_record_provider(null,who,'email','access_code','sent','resend',repeat('a',64),null,outbox_provider);
   raise exception 'OUTBOX_ID_REASSIGNED_TO_DIRECT';
  exception when others then if sqlerrm<>'NOTIFICATION_PROVIDER_RECEIPT_MISMATCH' then raise;end if;end;
  perform public.case_notification_webhook_record('synthetic-outbox:'||outbox_provider::text,outbox_provider,'email.delivered',sample_time);
  if not exists(select 1 from private.case_notification_outbox where delivery_id=repeat('c',64) and state='delivered' and encrypted_payload is null) then raise exception 'EXISTING_OUTBOX_REGRESSION';end if;
  raise exception 'ROLLBACK_DIRECT_RECEIPT_FIXTURE' using errcode='ZX002';
 exception when sqlstate 'ZX002' then null;end;
end;$contract$;
