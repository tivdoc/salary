-- A new approval/publication requires actual saved provenance. Historical
-- published rows are left readable; the guard runs only on a new decision.
do $upgrade$ declare definition text;begin
 definition:=pg_get_functiondef('private.case_report_current_input()'::regprocedure);
 definition:=replace(definition,'  actual:=p.input_revision;', $guard$
  if p.report_document is null or p.report_document->'projection' is distinct from p.projection
   or p.report_document->>'projection_sha256' is distinct from p.projection_sha256
   or p.report_document->>'input_sha256' is distinct from (select input_sha256 from private.case_input_heads where case_id=new.case_id)
   or jsonb_typeof(p.report_document->'evidence') is distinct from 'array'
   or jsonb_typeof(p.report_document->'findings') is distinct from 'array'
   or p.report_document->>'order_id' is null or p.report_document->>'revision' is null
  then raise exception 'REPORT_PROVENANCE_REQUIRED';end if;
  if exists(select 1 from jsonb_array_elements(p.report_document->'evidence') e where
   not exists(select 1 from public.documents d where d.case_id=new.case_id and d.id::text=e->>'document_id' and d.version_id::text=e->>'version_id')
   and not exists(select 1 from public.document_versions v where v.case_id=new.case_id and v.document_id::text=e->>'document_id' and v.version_id::text=e->>'version_id'))
  then raise exception 'REPORT_SOURCE_SCOPE';end if;
  if exists(select 1 from jsonb_array_elements(p.projection->'topics') t where t->>'gate'='checked' and t->>'status'='finding' and not exists(select 1 from jsonb_array_elements(p.report_document->'findings') f where f->>'topic'=t->>'topic' and jsonb_array_length(f->'evidence_ids')>0)) then raise exception 'REPORT_FINDING_SOURCE_REQUIRED';end if;
  if exists(select 1 from jsonb_array_elements(p.report_document->'findings') f cross join lateral jsonb_array_elements_text(f->'evidence_ids') id where not exists(select 1 from jsonb_array_elements(p.report_document->'evidence') e where e->>'id'=id)) then raise exception 'REPORT_FINDING_SOURCE_REQUIRED';end if;
  actual:=p.input_revision;$guard$);execute definition;
end $upgrade$;
