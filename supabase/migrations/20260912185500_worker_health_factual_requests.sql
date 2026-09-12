-- Operational questions remain actionable when owner-purpose delivery is denied.
-- The existing capability gate, source currentness and delivery guard stay intact.
do $migration$
declare body text;anchor text;
begin
 body:=pg_get_functiondef('private.managed_dev_worker_health(text)'::regprocedure);
 anchor:='q.answered_at is null and q.expires_at>statement_timestamp() and private.managed_dev_notification_event_current(m.case_id,''request:''||q.id::text)';
 if position(anchor in body)=0 then raise exception 'WORKER_HEALTH_REQUEST_BASE';end if;
 execute replace(body,anchor,'q.answered_at is null and q.expired_at is null and q.expires_at>statement_timestamp()
  and private.managed_dev_event_source_current_before_owner_v1(m.case_id,''request:''||q.id::text)');
end;$migration$;
