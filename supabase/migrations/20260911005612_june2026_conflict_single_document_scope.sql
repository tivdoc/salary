-- A second payslip remains stored. This single-document declaration cannot
-- choose one automatically or turn unsupported scope into provider retries.
do $migration$ declare definition text;needle text;begin
 definition:=pg_get_functiondef('private.june2026_hours_conflict_request_open(uuid,uuid,integer,text)'::regprocedure);
 needle:=' source:=private.june2026_hours_admit(target_case,target_order,target_revision,target_input_sha);';
 if position(needle in definition)=0 then raise exception 'HOURS_CONFLICT_OPEN_SCOPE_BASE';end if;
 execute replace(definition,needle,$new$ if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'JUNE_REGULAR_HOURS_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;
 if not exists(select 1 from private.case_input_heads where case_id=target_case and revision=target_revision and input_sha256=target_input_sha) then raise exception 'ANALYSIS_INPUT_SUPERSEDED';end if;
 if (select count(*) from public.documents where case_id=target_case and document_type='payslip' and period_month='2026-06-01')<>1 then return null;end if;
 source:=private.june2026_hours_admit(target_case,target_order,target_revision,target_input_sha);$new$);
 definition:=pg_get_functiondef('private.june2026_hours_conflict_current(uuid,jsonb)'::regprocedure);
 needle:=' if target->>''case_id'' is distinct from target_case::text';
 if position(needle in definition)=0 then raise exception 'HOURS_CONFLICT_CURRENT_SCOPE_BASE';end if;
 execute replace(definition,needle,$new$ if (select count(*) from public.documents where case_id=target_case and document_type='payslip' and period_month='2026-06-01')<>1 then return false;end if;
 if target->>'case_id' is distinct from target_case::text$new$);
end $migration$;
