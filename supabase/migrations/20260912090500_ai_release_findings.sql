-- Versioned persistence of same-run qualified AI findings.
-- No public activation and no direct worker INSERT grant. Historical columns
-- retain their meaning. Qualified AI receipts have neither human confidence
-- nor invented canonical-fact UUIDs. Their signed comparison stays signed.
alter table public.analysis_findings
 add column finding_kind text not null default 'legacy' check(finding_kind in ('legacy','qualified_ai')),
 add column ai_release_envelope_sha256 text,
 add column finding_receipt_sha256 text,
 add column source_fact_references jsonb,
 add column signed_difference_minor_units bigint,
 alter column confidence drop not null,
 alter column confidence_tier drop not null;
alter table public.analysis_findings drop constraint analysis_findings_facts_check;
alter table public.analysis_findings add constraint analysis_findings_facts_check check(
 (finding_kind='legacy' and cardinality(fact_references)>0)
 or (finding_kind='qualified_ai' and cardinality(fact_references)=0));
alter table public.analysis_findings add constraint analysis_findings_kind_contract check(coalesce(
 (finding_kind='legacy' and confidence is not null and confidence_tier is not null
  and ai_release_envelope_sha256 is null and finding_receipt_sha256 is null
  and source_fact_references is null and signed_difference_minor_units is null)
 or (finding_kind='qualified_ai' and status='candidate' and confidence is null and confidence_tier is null
  and requires_confirmation and potential_gap_minor_units is null
  and ai_release_envelope_sha256~'^[a-f0-9]{64}$' and finding_receipt_sha256~'^[a-f0-9]{64}$'
  and jsonb_typeof(source_fact_references)='object'
  and source_fact_references->>'schema_version'='ai-release-fact-references-v1'
  and source_fact_references->>'canonical_facts_snapshot_sha256'~'^[a-f0-9]{64}$'
  and source_fact_references->>'source_input_sha256'~'^[a-f0-9]{64}$'
  and source_fact_references->>'parameter_manifest_sha256'~'^[a-f0-9]{64}$'
  and jsonb_typeof(source_fact_references->'source_operands')='array'
  and calculation_payload->>'schema_version'='tivdoc-ai-qualified-check-v1'
  and calculation_payload->>'claim_kind'='qualified_ai_report'
  and calculation_payload->'human_attestation'='null'::jsonb
  and calculation_payload->'verified_debt'='false'::jsonb
  and calculation_payload->'actual_transfer_proven'='false'::jsonb
  and calculation_payload->>'sha256'=finding_receipt_sha256
  and (signed_difference_minor_units is null or signed_difference_minor_units between -9007199254740991 and 9007199254740991)),false));

create function private.ai_release_finding_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op in ('UPDATE','DELETE') then
  if old.finding_kind='qualified_ai' or (tg_op='UPDATE' and new.finding_kind='qualified_ai') then raise exception 'AI_RELEASE_FINDING_IMMUTABLE';end if;
  if tg_op='DELETE' then return old;end if;return new;
 end if;
 if new.finding_kind='qualified_ai' and session_user<>'tivdoc_worker_runtime' then raise exception 'AI_RELEASE_FINDING_SCOPE';end if;
 return new;
end;$$;
create trigger ai_release_finding_immutable before insert or update or delete on public.analysis_findings
 for each row execute function private.ai_release_finding_immutable();

create function private.ai_release_findings_record(target_run text,expected_bundle_sha256 text,expected_envelope_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 ar public.analysis_runs; saved_stage public.engine_analysis_stage_versions;
 stages jsonb:='{}';stage_count integer:=0;target_case uuid;bundle jsonb;envelope jsonb;runtime_result jsonb;
 scope jsonb;context jsonb;configuration jsonb;assessment_input jsonb;original jsonb;facts jsonb;dependencies jsonb;
 finding jsonb;prior public.analysis_findings;manifest_sha text;finding_key text;fact_refs jsonb;
 expected_count integer;actual_count integer;family jsonb;receipt jsonb;reviewer jsonb;branch jsonb;
 decision jsonb;method_basis jsonb;method jsonb;source_pin jsonb;method_pin jsonb;
 journal jsonb;answer_journal jsonb;answer_history jsonb;answer_entry jsonb;answer_receipt jsonb;answer_version jsonb;answer_value jsonb;
 declarations jsonb;declared_fact jsonb;questionnaire_key text;fact_identity_hash text;expected_fact_id text;
 used_hashes text[]:='{}';live_at timestamptz:=clock_timestamp();
begin
 if session_user<>'tivdoc_worker_runtime' or current_database()<>'tivdoc_release_replay_20260907'
  or expected_bundle_sha256!~'^[a-f0-9]{64}$' or expected_envelope_sha256!~'^[a-f0-9]{64}$'
  then raise exception 'AI_RELEASE_FINDING_SCOPE';end if;
 select * into ar from public.analysis_runs r where r.canonical_analysis_run_id=target_run
  and r.tenant_id=private.runtime_verified_tenant();
 if not found or ar.status not in ('running','completed') then raise exception 'AI_RELEASE_FINDING_RUN';end if;
 target_case:=ar.canonical_case_id::uuid;
 -- Capture, enrollment and finalization all serialize case before run.
 perform 1 from public.cases where id=target_case and is_qa for update;
 if not found then raise exception 'AI_RELEASE_FINDING_SCOPE';end if;
 select * into ar from public.analysis_runs r where r.canonical_analysis_run_id=target_run
  and r.tenant_id=private.runtime_verified_tenant() for update;
 if not found or ar.status not in ('running','completed') then raise exception 'AI_RELEASE_FINDING_RUN';end if;
 if ar.tenant_id is distinct from 'saved-case:'||target_case::text
  or not exists(select 1 from public.engine_case_state c where c.case_id=ar.case_id and c.tenant_id=ar.tenant_id and c.canonical_case_id=ar.canonical_case_id)
  then raise exception 'AI_RELEASE_FINDING_SCOPE';end if;
 for saved_stage in select s.* from public.engine_analysis_stage_versions s where s.analysis_run_id=ar.id
  and s.case_id=ar.case_id and s.tenant_id=ar.tenant_id and s.stage in ('input_snapshot','canonical_facts','analysis_run','topic_results') loop
  if saved_stage.payload_sha256 is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(saved_stage.payload),'UTF8')),'hex') then raise exception 'AI_RELEASE_FINDING_STAGE_HASH';end if;
  stages:=stages||jsonb_build_object(saved_stage.stage,saved_stage.payload);stage_count:=stage_count+1;
 end loop;
 if stage_count<>4 then raise exception 'AI_RELEASE_FINDING_STAGE_REQUIRED';end if;
 bundle:=stages#>'{topic_results,bundle}';envelope:=bundle->'ai_release';runtime_result:=envelope->'result';
 assessment_input:=envelope#>'{input,assessment_input}';scope:=assessment_input#>'{current,scope}';
 original:=stages->'input_snapshot';facts:=stages->'canonical_facts';dependencies:=stages#>'{analysis_run,dependencies}';
 if bundle->>'result_sha256' is distinct from expected_bundle_sha256
  or expected_bundle_sha256 is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(bundle-'result_sha256'),'UTF8')),'hex')
  or envelope->>'schema_version' is distinct from 'case-analysis-ai-release-v1'
  or envelope->>'sha256' is distinct from expected_envelope_sha256
  or expected_envelope_sha256 is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(envelope-'sha256'),'UTF8')),'hex')
  or runtime_result->>'sha256' is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(runtime_result-'sha256'),'UTF8')),'hex')
  or runtime_result->>'schema_version' is distinct from 'tivdoc-ai-release-runtime-v1'
  or runtime_result->>'claim_kind' is distinct from 'qualified_ai_report'
  or runtime_result->'human_attestation' is distinct from 'null'::jsonb
  or runtime_result->'verified_debt' is distinct from 'false'::jsonb
  or runtime_result->'combined_amount' is distinct from 'null'::jsonb
  or runtime_result->'legal_debt_total' is distinct from 'null'::jsonb
  or runtime_result->'actual_transfer_proven' is distinct from 'false'::jsonb
  or runtime_result->'publication_performed' is distinct from 'false'::jsonb
  or runtime_result->>'analysis_run_id' is distinct from target_run or bundle->>'analysis_run_id' is distinct from target_run
  or envelope#>>'{input,analysis_run_id}' is distinct from target_run
  or runtime_result->>'case_id' is distinct from target_case::text or bundle->>'case_id' is distinct from target_case::text
  or scope->>'case_id' is distinct from target_case::text
  or (envelope#>>'{binding,engine_case_revision}')::bigint is distinct from ar.case_revision
  or (bundle->>'case_revision')::bigint is distinct from ar.case_revision
  or scope is distinct from runtime_result->'current_scope'
  or scope is distinct from assessment_input#>'{assessment,scope}'
  or envelope#>'{binding,source_journal}' is distinct from original->'source_journal'
  or original#>>'{source_journal,case_id}' is distinct from target_case::text
  or original#>>'{source_journal,input_revision}' is distinct from scope->>'input_revision'
  or original#>>'{source_journal,input_sha256}' is distinct from scope->>'input_sha256'
  or dependencies->>'code_version' is distinct from 'case-analysis@0.6.8'
  or dependencies->>'facts_snapshot_sha256' is distinct from bundle->>'facts_snapshot_sha256'
  or dependencies->>'catalog_sha256' is distinct from bundle->>'catalog_sha256'
  or facts->>'facts_snapshot_sha256' is distinct from bundle->>'facts_snapshot_sha256'
  or scope->>'facts_sha256' is distinct from bundle->>'facts_snapshot_sha256'
  or facts->>'facts_snapshot_sha256' is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(facts->'facts'),'UTF8')),'hex')
  or facts#>'{facts,facts}' is distinct from bundle->'facts'
  or ar.command_sha256 is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(ar.command_payload),'UTF8')),'hex')
  or original->>'command_sha256' is distinct from ar.command_sha256
  or original->>'document_review_sha256' is distinct from ar.command_payload->>'document_review_sha256'
  or original->'document_review_input' is distinct from envelope#>'{input,source}'
  or ar.command_payload->>'document_review_sha256' is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(envelope#>'{input,source}'),'UTF8')),'hex')
  or ar.command_payload->>'case_id' is distinct from target_case::text
  or ar.command_payload->>'population' is distinct from scope->>'population'
  or ar.command_payload#>>'{period,start_date}' is distinct from scope#>>'{period,from}'
  or ar.command_payload#>>'{period,end_date}' is distinct from scope#>>'{period,to}'
  or bundle->'document_review' is distinct from runtime_result->'review'
  or scope->>'order_id' is distinct from envelope#>>'{input,source,purchased_scope,order_id}'
  or scope->>'order_origin' is distinct from envelope#>>'{input,source,purchased_scope,origin}'
  or scope->>'order_receipt_sha256' is distinct from envelope#>>'{input,source,purchased_scope,receipt_sha256}'
  then raise exception 'AI_RELEASE_FINDING_BINDING';end if;
 -- Existing root RPC locks the QA case, authenticates the machine tenant and
 -- verifies live journal, grant/revocation, dispatch dependency and expiry.
 context:=private.ai_release_context_read(target_case,(scope->>'input_revision')::integer,scope->>'input_sha256');
 if context->>'state' is distinct from 'configured' or context->>'dependency_sha256' is distinct from scope->>'authority_dependency_sha256'
  then raise exception 'AI_RELEASE_FINDING_AUTHORITY';end if;
 select v.input into journal from private.case_input_versions v where v.case_id=target_case
  and v.revision=(scope->>'input_revision')::integer and v.input_sha256=scope->>'input_sha256'
  and v.input_sha256=encode(sha256(convert_to(v.input::text,'UTF8')),'hex');
 if journal is null then raise exception 'AI_RELEASE_FINDING_JOURNAL';end if;
 configuration:=context->'configuration';
 if assessment_input->'policy' is distinct from configuration->'policy'
  or assessment_input->'registry' is distinct from configuration->'registry'
  or assessment_input->'source_receipts' is distinct from configuration->'source_receipts'
  or assessment_input->'interpretation_receipts' is distinct from configuration->'interpretation_receipts'
  or assessment_input->'test_receipts' is distinct from configuration->'test_receipts'
  or scope->>'population' is distinct from configuration->>'population'
  or assessment_input#>>'{current,environment}' is distinct from 'development'
  or assessment_input#>'{current,is_qa}' is distinct from 'true'::jsonb
  or assessment_input#>>'{current,namespace}' is distinct from configuration#>>'{policy,namespace}'
  or assessment_input#>>'{assessment,actor_kind}' is distinct from 'ai_reviewer'
  or (assessment_input#>>'{assessment,issued_at}')::timestamptz>live_at
  or (assessment_input#>>'{assessment,expires_at}')::timestamptz<=live_at
  or (configuration#>>'{policy,expires_at}')::timestamptz<=live_at
  or (configuration#>>'{registry,expires_at}')::timestamptz<=live_at
  then raise exception 'AI_RELEASE_FINDING_CONFIGURATION';end if;
 if jsonb_typeof(runtime_result->'findings') is distinct from 'array' then raise exception 'AI_RELEASE_FINDING_SHAPE';end if;
 if runtime_result->'findings' is distinct from (select coalesce(jsonb_agg(c.value order by c.ordinality),'[]'::jsonb)
  from jsonb_array_elements(runtime_result->'checks') with ordinality c(value,ordinality)
  where c.value->>'state'='calculated' and c.value#>>'{expected,kind}'='money') then raise exception 'AI_RELEASE_FINDING_INCOMPLETE_SET';end if;
 expected_count:=jsonb_array_length(runtime_result->'findings');
 -- Only the families producing these findings are consumed. Expired unused
 -- branches remain blocked in the result instead of vetoing other families.
 used_hashes:=array[configuration#>>'{policy,sha256}',configuration#>>'{registry,sha256}',assessment_input#>>'{assessment,sha256}'];
 for branch in select b from jsonb_array_elements(configuration#>'{policy,branches}') b
  where exists(select 1 from jsonb_array_elements(runtime_result->'findings') f where f->>'family_id'=b->>'branch_id') loop
  used_hashes:=used_hashes||array[branch->>'interpretation_receipt_sha256',branch#>>'{generator,code_sha256}']
   ||array(select jsonb_array_elements_text(branch->'source_receipt_sha256s'))
   ||array(select jsonb_array_elements_text(branch->'test_receipt_sha256s'));
 end loop;
 for receipt in select value from jsonb_array_elements(configuration->'source_receipts') where value->>'sha256'=any(used_hashes)
  union all select value from jsonb_array_elements(configuration->'interpretation_receipts') where value->>'sha256'=any(used_hashes)
  union all select value from jsonb_array_elements(configuration->'test_receipts') where value->>'sha256'=any(used_hashes) loop
  if (receipt->>'issued_at')::timestamptz>live_at or (receipt->>'expires_at')::timestamptz<=live_at then raise exception 'AI_RELEASE_FINDING_RECEIPT_EXPIRED';end if;
  used_hashes:=used_hashes||array[receipt->>'artifact_sha256',receipt->>'transcription_sha256'];
  if receipt ? 'reviewer_id' then
   select value into reviewer from jsonb_array_elements(configuration#>'{registry,reviewers}')
    where value->>'actor_id'=receipt->>'reviewer_id' and value->>'actor_version'=receipt->>'reviewer_version';
   if reviewer is null or (reviewer->>'issued_at')::timestamptz>live_at or (reviewer->>'expires_at')::timestamptz<=live_at then raise exception 'AI_RELEASE_FINDING_REVIEWER_EXPIRED';end if;
   used_hashes:=array_append(used_hashes,encode(sha256(convert_to(private.governance_jsonb_compact_text(reviewer),'UTF8')),'hex'));
  end if;
 end loop;
 select value into reviewer from jsonb_array_elements(configuration#>'{registry,reviewers}')
  where value->>'actor_id'=assessment_input#>>'{assessment,reviewer_id}' and value->>'actor_version'=assessment_input#>>'{assessment,reviewer_version}';
 if reviewer is null or (reviewer->>'issued_at')::timestamptz>live_at or (reviewer->>'expires_at')::timestamptz<=live_at then raise exception 'AI_RELEASE_FINDING_ASSESSOR_EXPIRED';end if;
 used_hashes:=array_append(used_hashes,encode(sha256(convert_to(private.governance_jsonb_compact_text(reviewer),'UTF8')),'hex'));
 manifest_sha:=encode(sha256(convert_to(private.governance_jsonb_compact_text(runtime_result->'findings'),'UTF8')),'hex');
 if (select count(distinct f->>'check_id') from jsonb_array_elements(runtime_result->'findings') f)<>expected_count then raise exception 'AI_RELEASE_FINDING_DUPLICATE';end if;
 for finding in select value from jsonb_array_elements(runtime_result->'findings') loop
  select value into family from jsonb_array_elements(runtime_result->'families') where value->>'family_id'=finding->>'family_id';
  if finding->>'schema_version' is distinct from 'tivdoc-ai-qualified-check-v1'
   or finding->>'case_id' is distinct from target_case::text or finding->>'analysis_run_id' is distinct from target_run
   or finding->>'state' is distinct from 'calculated' or finding#>>'{expected,kind}' is distinct from 'money'
   or finding#>>'{expected,currency}' is distinct from 'ILS' or finding->'trace' is null or finding->'trace'='null'::jsonb
   or finding->'blockers' is distinct from '[]'::jsonb
   or finding->>'sha256' is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(finding-'sha256'),'UTF8')),'hex')
   or finding->>'claim_kind' is distinct from 'qualified_ai_report' or finding->'verified_debt' is distinct from 'false'::jsonb
   or finding->'human_attestation' is distinct from 'null'::jsonb or finding->'actual_transfer_proven' is distinct from 'false'::jsonb
   or runtime_result#>>'{admission,state}' is distinct from 'admitted'
   or (runtime_result#>>'{admission,receipt,evaluated_at}')::timestamptz>live_at
   or (runtime_result#>>'{admission,receipt,expires_at}')::timestamptz<=live_at
   or finding->>'admission_dependency_sha256' is distinct from runtime_result#>>'{admission,receipt,dependency_sha256}'
   or family is null or family->>'topic' is distinct from finding->>'topic'
   or finding->>'family_rule_manifest_sha256' is distinct from family#>>'{expected_generated_rule,rule_sha256}'
   or finding->>'family_parameter_manifest_sha256' is distinct from family#>>'{expected_generated_rule,parameter_set_sha256}'
   or not exists(select 1 from jsonb_array_elements(runtime_result->'checks') c where c=finding)
   or not exists(select 1 from jsonb_array_elements(family->'checks') c where c=finding)
   or not exists(select 1 from jsonb_array_elements(runtime_result#>'{admission,branches}') b
    where b->>'branch_id'=finding->>'family_id' and b->>'state'='admitted' and (b->>'expires_at')::timestamptz>live_at)
   or jsonb_typeof(finding->'source_manifest') is distinct from 'array' or jsonb_array_length(finding->'source_manifest')=0
   or jsonb_typeof(finding->'source_operands') is distinct from 'array'
   then raise exception 'AI_RELEASE_FINDING_QUALIFICATION';end if;
  for source_pin in select value from jsonb_array_elements(finding->'source_manifest') loop
   if source_pin->>'kind'='case_document' then
    if source_pin->>'case_id' is distinct from target_case::text or not exists(select 1 from public.documents d
     where d.case_id=target_case and d.version_id::text=source_pin->>'version_id'
      and (d.id::text=source_pin->>'document_id' or d.version_id::text=source_pin->>'document_id')
      and d.content_sha256=source_pin->>'file_sha256') then raise exception 'AI_RELEASE_FINDING_SOURCE_CHANGED';end if;
   elsif source_pin->>'kind'='legal_source' then
    if not exists(select 1 from jsonb_array_elements(configuration->'source_receipts') r
     where r->>'sha256'=any(used_hashes) and r->>'source_version_id'=source_pin->>'version_id'
      and r->>'artifact_sha256'=source_pin->>'file_sha256') then raise exception 'AI_RELEASE_FINDING_LEGAL_SOURCE';end if;
   elsif source_pin->>'kind'='questionnaire' then
    -- The declared snapshot is pinned by the original command/stage. Its
    -- source fact retains its own ID/hash; canonical composition derives a
    -- different aggregate ID, so compare its exact value/provenance by path.
    declarations:=envelope#>'{input,source,entitlement_declarations}';
    select value into declared_fact from jsonb_array_elements(declarations->'facts')
     where value->>'fact_id'=source_pin->>'document_id';
    if declared_fact is null or declarations->>'schema_version' is distinct from 'entitlement-questionnaire-evidence-v1'
     or declarations->>'snapshot_id' is distinct from ar.command_payload->>'declared_fact_snapshot_id'
     or declarations->>'snapshot_id' is distinct from source_pin->>'version_id'
     or declarations->>'snapshot_sha256' is distinct from ar.command_payload->>'declared_fact_snapshot_sha256'
     or declarations->>'snapshot_sha256' is distinct from original->>'declared_fact_snapshot_sha256'
     or declarations->>'snapshot_sha256' is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(declarations->'facts'),'UTF8')),'hex')
     or declarations->'period' is distinct from scope->'period'
     or source_pin->>'case_id' is distinct from target_case::text or source_pin->>'page_count' is distinct from '1'
     or declared_fact->>'case_id' is distinct from target_case::text
     or source_pin->>'file_sha256' is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(declared_fact),'UTF8')),'hex')
     or declared_fact->>'status' not in ('confirmed','needs_confirmation')
     or jsonb_array_length(declared_fact->'provenance')<>1
     or declared_fact#>>'{provenance,0,source_type}' is distinct from 'declared'
     or declared_fact#>>'{provenance,0,source_reference,kind}' is distinct from 'questionnaire_response'
     or declared_fact#>>'{provenance,0,source_reference,response_id}' is distinct from journal#>>'{questionnaire_source,id}'
     or journal#>>'{questionnaire_source,case_id}' is distinct from target_case::text
     or journal#>>'{questionnaire_source,scope_month}' is distinct from left(scope#>>'{period,from}',7)
     or not exists(select 1 from jsonb_array_elements(facts#>'{facts,facts}') f
      where f->>'case_id'=target_case::text and f->>'path'=declared_fact->>'path'
       and f->'value'=declared_fact->'value' and f->>'status' in ('confirmed','needs_confirmation')
       and f->'provenance' @> declared_fact->'provenance') then raise exception 'AI_RELEASE_FINDING_QUESTIONNAIRE';end if;
    questionnaire_key:=case declared_fact->>'path'
     when 'compensation.salary_type' then 'salaryType' when 'employment.start_month' then 'employmentStartMonth'
     when 'employment.still_employed' then 'stillEmployed' when 'employment.managerial_or_trust_role_declared' then 'managerialOrTrustRole'
     when 'person.birth_year' then 'birthYear' when 'person.sex' then 'sex' when 'work.days_per_week' then 'workDaysPerWeek'
     when 'work.typical_hours_per_day' then 'typicalHoursPerDay' when 'work.works_friday' then 'worksFriday'
     when 'work.works_saturday' then 'worksSaturday' when 'pension.fund_at_hire' then 'hadPensionFundAtHire'
     when 'travel.employer_provides_transport' then 'employerProvidesTransport' when 'travel.commute_over_500m' then 'commuteOver500m' end;
    if questionnaire_key is null or declared_fact->'value' is distinct from journal->'questionnaire'->questionnaire_key then raise exception 'AI_RELEASE_FINDING_QUESTIONNAIRE_VALUE';end if;
    fact_identity_hash:=encode(sha256(convert_to(private.governance_jsonb_compact_text(jsonb_build_object('namespace','saved-questionnaire-fact',
     'hash',encode(sha256(convert_to(private.governance_jsonb_compact_text(jsonb_build_object('case_id',target_case::text,
      'revision',(scope->>'input_revision')::integer,'input_sha256',scope->>'input_sha256',
      'response_id',journal#>>'{questionnaire_source,id}','path',declared_fact->>'path')),'UTF8')),'hex'))),'UTF8')),'hex');
    expected_fact_id:=substr(fact_identity_hash,1,8)||'-'||substr(fact_identity_hash,9,4)||'-4'||substr(fact_identity_hash,14,3)||'-8'||substr(fact_identity_hash,18,3)||'-'||substr(fact_identity_hash,21,12);
    if declared_fact->>'fact_id' is distinct from expected_fact_id then raise exception 'AI_RELEASE_FINDING_QUESTIONNAIRE_ID';end if;
   elsif source_pin->>'kind'='customer_answer' then
    -- Existing authenticated history RPC independently validates immutable
    -- target + every answer revision against THIS journal. No current mutable
    -- answer is injected into an older input, and no old numeric answer may
    -- survive a newer correction/unknown reply.
    if answer_journal is null then answer_journal:=private.document_review_answer_history(target_case,(scope->>'input_revision')::integer,scope->>'input_sha256');end if;
    select h into answer_history from jsonb_array_elements(envelope#>'{input,source,answer_history}') h
     where h#>>'{receipt,request_id}'=source_pin->>'document_id' and h#>>'{receipt,answer_sha256}'=source_pin->>'file_sha256';
    answer_receipt:=answer_history->'receipt';
    select h into answer_entry from jsonb_array_elements(answer_journal) h
     where h->'request'=answer_history->'request' and h->'source_current'='true'::jsonb;
    select a into answer_version from jsonb_array_elements(answer_entry->'answers') a
     order by (a->>'revision')::integer desc limit 1;
    if answer_history is null or answer_entry is null or answer_version is null
     or source_pin->>'case_id' is distinct from target_case::text or source_pin->>'page_count' is distinct from '1'
     or answer_receipt->>'case_id' is distinct from target_case::text
     or source_pin->>'version_id' is distinct from (answer_receipt->>'request_id')||':'||(answer_receipt->>'answer_revision')
     or answer_history#>>'{request,target,required_evidence_kind}' is distinct from 'customer_declaration'
     or answer_history#>'{request,target,period}' is distinct from scope->'period'
     or not coalesce(answer_history#>'{request,dependent_check_ids}' ? (finding->>'check_id'),false)
     or answer_receipt->>'target_sha256' is distinct from answer_history#>>'{request,target,target_sha256}'
     or answer_receipt->>'request_id' is distinct from answer_version->>'request_id'
     or answer_receipt->>'answer_revision' is distinct from answer_version->>'revision'
     or answer_receipt->>'identity_id' is distinct from answer_version->>'identity_id'
     or (answer_receipt->>'answered_at')::timestamptz is distinct from (answer_version->>'answered_at')::timestamptz
     or answer_receipt->>'answer_sha256' is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(answer_receipt-'answer_sha256'),'UTF8')),'hex')
     or not exists(select 1 from jsonb_array_elements(runtime_result#>'{review,input,completion_input,previous_answers}') a where a=answer_receipt)
     then raise exception 'AI_RELEASE_FINDING_ANSWER';end if;
    answer_value:=private.document_review_answer_value(answer_history#>'{request,target}',answer_version->>'answer_text');
    if answer_receipt->>'state' is distinct from answer_value->>'state' or answer_receipt->'value' is distinct from answer_value->'value'
     then raise exception 'AI_RELEASE_FINDING_ANSWER_VALUE';end if;
   else raise exception 'AI_RELEASE_FINDING_SOURCE_KIND';end if;
  end loop;
  used_hashes:=used_hashes||array[finding->>'rule_sha256',finding->>'family_rule_manifest_sha256',finding->>'family_parameter_manifest_sha256'];
  -- Required decision expiry is checked at DB time, independently of the
  -- preserved historical evaluation instant. Recipe descriptors come from the
  -- current server configuration and must match the exact consumed decision.
  for decision in select d from jsonb_array_elements(family#>'{source_manifest,applicability_decisions}') c
   cross join lateral jsonb_array_elements(c->'decisions') d
   where c->>'check_id'=finding->>'check_id' and c->'required_decision_ids' ? (d->>'decision_id') loop
   if decision->>'state' is distinct from 'accepted'
    or (decision->>'valid_until' is not null and (decision->>'valid_until')::timestamptz<=live_at)
    then raise exception 'AI_RELEASE_FINDING_DECISION_EXPIRED';end if;
   if decision->>'basis'='ai_source_assessment' and left(decision->>'explanation',1)='{' then
    method_basis:=(decision->>'explanation')::jsonb;
    if method_basis->>'schema_version'='ai-release-method-basis-v1' then
     select value into method from jsonb_array_elements(coalesce(configuration->'methods','[]'))
      where value->>'recipe_id'=method_basis->>'recipe_id' and value->>'recipe_sha256'=method_basis->>'recipe_sha256'
       and value->>'interpretation_receipt_sha256'=method_basis->>'interpretation_receipt_sha256';
     if method is null or (method->>'issued_at')::timestamptz>live_at or (method->>'expires_at')::timestamptz<=live_at then raise exception 'AI_RELEASE_FINDING_METHOD_EXPIRED';end if;
     used_hashes:=used_hashes||array[method->>'recipe_sha256',method->>'source_policy_sha256',method->>'interpretation_receipt_sha256',
      encode(sha256(convert_to(private.governance_jsonb_compact_text(method),'UTF8')),'hex')];
     for method_pin in select jsonb_build_object('receipt_sha256',method->>'interpretation_receipt_sha256')
      union all select value from jsonb_array_elements(method->'source_receipts') loop
      select r into receipt from (
       select value r from jsonb_array_elements(configuration->'source_receipts')
       union all select value r from jsonb_array_elements(configuration->'interpretation_receipts')) all_receipts
       where r->>'sha256'=method_pin->>'receipt_sha256';
      if receipt is null or (receipt->>'issued_at')::timestamptz>live_at or (receipt->>'expires_at')::timestamptz<=live_at then raise exception 'AI_RELEASE_FINDING_METHOD_SOURCE_EXPIRED';end if;
      used_hashes:=used_hashes||array[receipt->>'sha256',receipt->>'artifact_sha256',receipt->>'transcription_sha256'];
      select value into reviewer from jsonb_array_elements(configuration#>'{registry,reviewers}')
       where value->>'actor_id'=receipt->>'reviewer_id' and value->>'actor_version'=receipt->>'reviewer_version';
      if reviewer is null or (reviewer->>'issued_at')::timestamptz>live_at or (reviewer->>'expires_at')::timestamptz<=live_at then raise exception 'AI_RELEASE_FINDING_METHOD_REVIEWER_EXPIRED';end if;
      used_hashes:=array_append(used_hashes,encode(sha256(convert_to(private.governance_jsonb_compact_text(reviewer),'UTF8')),'hex'));
     end loop;
    end if;
   end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(configuration#>'{registry,revocations}') r
   where r->>'target_sha256'=any(used_hashes) and (r->>'effective_at')::timestamptz<=live_at) then raise exception 'AI_RELEASE_FINDING_REVOKED';end if;
  finding_key:='ai-release:'||(finding->>'check_id');
  fact_refs:=jsonb_build_object('schema_version','ai-release-fact-references-v1',
   'canonical_facts_snapshot_sha256',bundle->>'facts_snapshot_sha256','source_input_sha256',scope->>'input_sha256',
   'parameter_manifest_sha256',finding->>'family_parameter_manifest_sha256','source_operands',finding->'source_operands');
  insert into public.analysis_findings(id,analysis_run_id,category,status,period_start,period_end,currency,
   paid_minor_units,expected_minor_units,potential_gap_minor_units,confidence,confidence_tier,rule_id,rule_version,
   calculation_payload,fact_references,evidence_references,requires_confirmation,idempotency_key,
   tenant_id,canonical_case_id,canonical_analysis_run_id,canonical_finding_id,finding_kind,
   ai_release_envelope_sha256,finding_receipt_sha256,source_fact_references,signed_difference_minor_units)
  values(private.canonical_text_uuid('ai_release_finding',target_run||':'||finding_key),ar.id,finding->>'topic','candidate',
   (finding#>>'{period,from}')::date,(finding#>>'{period,to}')::date,'ILS',
   case when finding#>>'{recorded,kind}'='money' and (finding#>>'{recorded,minor_units}')::bigint>=0 then (finding#>>'{recorded,minor_units}')::bigint end,
   case when (finding#>>'{expected,minor_units}')::bigint>=0 then (finding#>>'{expected,minor_units}')::bigint end,
   null,null,null,finding->>'rule_id',finding->>'rule_version',finding,'{}'::uuid[],finding->'source_manifest',true,finding_key,
   ar.tenant_id,ar.canonical_case_id,target_run,target_run||':'||finding_key,'qualified_ai',
   expected_envelope_sha256,finding->>'sha256',fact_refs,
   case when finding#>>'{difference,kind}'='money' then (finding#>>'{difference,minor_units}')::bigint end)
  on conflict(analysis_run_id,idempotency_key) do nothing;
  select * into prior from public.analysis_findings where analysis_run_id=ar.id and idempotency_key=finding_key;
  if not found or prior.finding_kind<>'qualified_ai' or prior.tenant_id is distinct from ar.tenant_id
   or prior.canonical_case_id is distinct from ar.canonical_case_id or prior.canonical_analysis_run_id is distinct from target_run
   or prior.ai_release_envelope_sha256 is distinct from expected_envelope_sha256
   or prior.finding_receipt_sha256 is distinct from finding->>'sha256' or prior.calculation_payload is distinct from finding
   or prior.source_fact_references is distinct from fact_refs
   then raise exception 'AI_RELEASE_FINDING_RETRY_MISMATCH';end if;
 end loop;
 select count(*) into actual_count from public.analysis_findings where analysis_run_id=ar.id;
 if actual_count<>expected_count then raise exception 'AI_RELEASE_FINDING_SET_MISMATCH';end if;
 return jsonb_build_object('finding_count',actual_count,'manifest_sha256',manifest_sha);
end;$$;
revoke all on function private.ai_release_finding_immutable(),private.ai_release_findings_record(text,text,text)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.ai_release_findings_record(text,text,text) to tivdoc_worker_runtime;
-- Do not grant INSERT/UPDATE/DELETE on analysis_findings to the worker.
