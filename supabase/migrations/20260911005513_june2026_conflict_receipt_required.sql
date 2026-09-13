-- SQL NULL is not a provider receipt. Match the application legacy refusal.
do $migration$ declare definition text;needle text;begin
 definition:=pg_get_functiondef('private.june2026_hours_conflict_target(jsonb,uuid,uuid)'::regprocedure);
 needle:='jsonb_array_length(source#>''{checkpoint,run,provider_receipts}'') not between 1 and 2';
 if position(needle in definition)=0 then raise exception 'HOURS_CONFLICT_RECEIPT_BASE';end if;
 definition:=replace(definition,needle,'jsonb_typeof(source#>''{checkpoint,run,provider_receipts}'') is distinct from ''array'' or coalesce(jsonb_array_length(source#>''{checkpoint,run,provider_receipts}''),0) not between 1 and 2');
 needle:='extraction->>''detected_document_type''<>''payslip'' or extraction->>''status'' not in (''completed'',''partial'')';
 if position(needle in definition)=0 then raise exception 'HOURS_CONFLICT_STATUS_BASE';end if;
 definition:=replace(definition,needle,'extraction->>''detected_document_type'' is distinct from ''payslip'' or coalesce(extraction->>''status'','''') not in (''completed'',''partial'')');
 execute definition;
end $migration$;
