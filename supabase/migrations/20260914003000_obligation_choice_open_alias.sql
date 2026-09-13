-- Actual worker-role opening exposed a PL/pgSQL local/SQL alias collision.
-- Qualify the JSON item; no admission, scope or currentness predicate changes.
do $fix$
declare body text;old_sql text;new_sql text;
begin
 body:=pg_get_functiondef('private.document_field_request_open(uuid,integer,text,jsonb,text)'::regprocedure);
 old_sql:='exists(select 1 from jsonb_array_elements(target_payload->''candidates'') p where private.obligation_payment_pair_current(target_case,target_payload,p))';
 new_sql:='exists(select 1 from jsonb_array_elements(target_payload->''candidates'') as candidate_row(value) where private.obligation_payment_pair_current(target_case,target_payload,candidate_row.value))';
 if position(old_sql in body)=0 then raise exception 'OBLIGATION_CHOICE_ALIAS_BASE';end if;
 execute replace(body,old_sql,new_sql);
end;$fix$;
