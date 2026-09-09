-- Reuse the existing authenticated, SHA-checked source endpoint for typed
-- June declarations. A replaced or no-longer-purchased source returns null.
do $migration$ declare definition text;needle text;begin
 definition:=pg_get_functiondef('public.case_request_document_source(uuid,uuid,uuid)'::regprocedure);
 needle:=' if target is null then return null;end if;';
 if position(needle in definition)=0 then raise exception 'JUNE_COLLECTION_SOURCE_LINK_BASE';end if;
 definition:=replace(definition,needle,$new$ if target is null then
  select t.target into target from private.june2026_collection_targets t join public.case_requests r on r.id=t.request_id and r.case_id=t.case_id
   where t.case_id=target_case and t.request_id=target_request and r.code='minimum_wage_june2026:'||t.target_sha256
    and private.june2026_collection_current(target_case,t.target);
 end if;
 if target is null then return null;end if;$new$);
 needle:='''page'',(target#>>''{candidate,source,page}'')::integer';
 if position(needle in definition)=0 then raise exception 'JUNE_COLLECTION_SOURCE_PAGE_BASE';end if;
 definition:=replace(definition,needle,'''page'',coalesce((target#>>''{candidate,source,page}'')::integer,(target#>>''{subject,component,source,page}'')::integer,1)');
 execute definition;
end $migration$;
