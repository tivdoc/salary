-- PostgreSQL ARE repetition bounds stop at255; {32,256} raises2201B before
-- controller/issuer admission. Keep exactly32..256 permitted ASCII characters
-- using an independent length check. Existing definitions, owners and ACLs stay.
-- Reproduced through actual worker LOGIN on DEV; no authority records changed.
-- https://www.postgresql.org/docs/15/functions-matching.html#POSIX-QUANTIFIERS-TABLE
do $capability_regex$
declare signature text;definition text;before_acl aclitem[];after_acl aclitem[];
 old_fragment text:='p_capability!~''^[A-Za-z0-9._-]{32,256}$''';
 new_fragment text:='(length(p_capability) not between 32 and 256 or p_capability!~''^[A-Za-z0-9._-]+$'')';
begin
 foreach signature in array array[
  'private.real_service_activation_material(text,uuid,uuid,integer,text,text,text)',
  'private.real_service_machine_issuer_material(text,uuid,uuid,text,uuid,boolean)',
  'private.real_service_deployment_successor_material(text,uuid,uuid,integer,text,text,text)',
  'private.real_service_candidates(text,text,text,jsonb,integer)'
 ] loop
  select pg_get_functiondef(p.oid),p.proacl into definition,before_acl
   from pg_proc p where p.oid=to_regprocedure(signature);
  if definition is null or (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment)<>1
   then raise exception 'REAL_CAPABILITY_REGEX_DEFINITION_CHANGED';end if;
  execute replace(definition,old_fragment,new_fragment);
  select proacl into after_acl from pg_proc where oid=to_regprocedure(signature);
  if before_acl is distinct from after_acl then raise exception 'REAL_CAPABILITY_REGEX_ACL_CHANGED';end if;
 end loop;
end;$capability_regex$;
