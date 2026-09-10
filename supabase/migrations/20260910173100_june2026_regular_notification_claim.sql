-- Pending/enqueue were fenced in144. Also invalidate an already queued
-- regular report intention before the independent delivery CLI claims it.
-- An email whose provider call already began cannot be recalled; its protected
-- link always rechecks current input and authority.
do $migration$
declare original text;body text;
begin
 select pg_get_functiondef('public.case_notification_outbox_claim(uuid)'::regprocedure) into original;
 body:=replace(original,' select delivery_id into target',$guard$
 update private.case_notification_outbox o set state='dead_letter',last_error='report_authority_unavailable',
  encrypted_payload=null,lease_owner=null,lease_expires_at=null
 where (o.state='queued' or o.state='leased' and o.lease_expires_at<=statement_timestamp()) and exists(
  select 1 from private.case_report_delivery d join public.case_report_projections p on p.id=d.report_id and p.case_id=d.case_id
  where d.delivery_id=o.delivery_id and d.case_id=o.case_id and p.report_document ? 'execution_authority'
   and not private.june2026_regular_publication_current(p.id));
 select delivery_id into target$guard$);
 if original=body then raise exception 'REGULAR_NOTIFICATION_CLAIM_ANCHOR';end if;execute body;
end $migration$;
