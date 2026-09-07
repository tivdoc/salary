-- A refresh and revoke serialize on the same session; renewal never races a
-- committed revocation. Cookie renewal uses the expiry returned from this RPC.
do $upgrade$ declare definition text; begin
 definition:=pg_get_functiondef('public.case_access_session_resolve(text,integer,integer)'::regprocedure);
 if position('candidate.expires_at > now();' in definition)=0 then raise exception 'SESSION_UPGRADE_BASE_MISMATCH'; end if;
 definition:=replace(definition,'candidate.expires_at > now();','candidate.expires_at > now() for update;');
 execute definition;
end $upgrade$;
