-- Repeated printed month observations are not different months. Preserve
-- every candidate and require all of them to identify the same full June.
do $migration$ declare definition text;needle text;replacement text;begin
 definition:=pg_get_functiondef('private.june2026_collection_current(uuid,jsonb)'::regprocedure);
 needle:=$old$(select count(*)=1 and bool_and(f#>'{normalized_value}'=jsonb_build_object('year',2026,'month',6,'start_date','2026-06-01','end_date','2026-06-30') and f#>>'{source,document_id}'=d.version_id::text)$old$;
 replacement:=$new$(select count(*)>0 and count(distinct f->>'candidate_id')=count(*)
   and bool_and(coalesce(f#>'{normalized_value}'=jsonb_build_object('year',2026,'month',6,'start_date','2026-06-01','end_date','2026-06-30')
    and f#>>'{source,document_id}'=d.version_id::text
    and (f#>>'{source,page}')::integer between 1 and (c.result#>>'{run,result,final_extraction,quality_metrics,page_count}')::integer,false))$new$;
 if position(needle in definition)=0 then raise exception 'JUNE_REPEATED_PERIOD_BASE';end if;
 execute replace(definition,needle,replacement);
end $migration$;
