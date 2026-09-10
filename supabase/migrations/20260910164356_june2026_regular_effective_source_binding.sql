-- Preserve the canonical parent facts. An admitted hours declaration changes
-- only the effective calculation snapshot and carries the current signed
-- assessment into the normal durable trace/publication boundary.
do $migration$ declare definition text;needle text;begin
 definition:=pg_get_functiondef('private.june2026_regular_result_save(uuid,uuid,integer,text,text,jsonb,jsonb)'::regprocedure);
 needle:=' artifact:=convert_from';
 if position(needle in definition)=0 then raise exception 'REGULAR_EFFECTIVE_SOURCE_BASE';end if;
 execute replace(definition,needle,$guard$
 if execution#>>'{admission,facts_snapshot_sha256}' is distinct from execution#>>'{admission,effective_facts_snapshot_sha256}' then
  if execution#>>'{source_admission,schema_version}' is distinct from 'june2026-regular-source-admission-v1'
   or execution#>>'{source_admission,verification}' is distinct from 'signed_assessment_binding_only'
   or execution->'source_admission' is distinct from ar.completion_payload#>'{bundle,topic_results,0,source_admission}'
   or execution#>'{source_admission,assessment}' is distinct from auth->'assessment'
   or execution#>>'{source_admission,authority_sha256}' is distinct from execution->>'authority_sha256'
   or execution#>>'{source_admission,admission_sha256}' is distinct from execution#>>'{admission,resolution_sha256}'
   or execution#>>'{source_admission,parent_facts_sha256}' is distinct from execution#>>'{admission,facts_snapshot_sha256}'
   or execution#>>'{source_admission,effective_facts_sha256}' is distinct from execution#>>'{admission,effective_facts_snapshot_sha256}'
   or execution#>>'{source_admission,effective_facts_sha256}' is distinct from execution#>>'{trace,facts_snapshot_sha256}'
   or execution#>>'{source_admission,parent_rule_input_sha256}' is distinct from ar.completion_payload#>>'{bundle,topic_results,0,rule_input_sha256}'
   or execution#>>'{source_admission,effective_rule_input_sha256}' is distinct from execution#>>'{trace,rule_input_sha256}'
   then raise exception 'REGULAR_SIGNED_EFFECTIVE_SOURCE_BINDING';end if;
 elsif execution ? 'source_admission' or ar.completion_payload#>'{bundle,topic_results,0}' ? 'source_admission' then
  raise exception 'REGULAR_UNEXPECTED_SOURCE_ADMISSION';
 end if;
 artifact:=convert_from$guard$);
end $migration$;
