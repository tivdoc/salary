-- Forward source-period witnesses for identified relationship/group decisions.
-- Base: 20260912194500_document_source_period_association.sql (188).
-- Execute atomically after schema188. Generated with Supabase CLI; ordered after188.
-- No data/answer backfill, new storage, numeric approval or legal authority.

-- Preserve the installed wrapper chain and original v1 canonical constructors.
do $capture$
declare body text;needle text;
begin
 if to_regprocedure('private.document_field_current_before_structure_period_v2(uuid,jsonb)') is not null
  or to_regprocedure('private.source_structure_period_target_matches(jsonb,jsonb)') is not null
  or to_regprocedure('public.case_request_source_period_context(uuid,uuid,uuid)') is not null
  then raise exception 'SOURCE_STRUCTURE_PERIOD_V2_ALREADY_INSTALLED';end if;
 body:=pg_get_functiondef('private.document_field_current(uuid,jsonb)'::regprocedure);
 if position('private.source_period_target_current' in body)=0 or position('private.document_field_current_before_period_v1' in body)=0
  then raise exception 'SOURCE_STRUCTURE_PERIOD_V2_CURRENT_BASE';end if;
 execute replace(body,'FUNCTION private.document_field_current(','FUNCTION private.document_field_current_before_structure_period_v2(');
 body:=pg_get_functiondef('private.document_reading_question_scope_v4(text[],jsonb)'::regprocedure);
 if position('private.document_reading_question_scope_before_period_v1' in body)=0 then raise exception 'SOURCE_STRUCTURE_PERIOD_V2_SCOPE_BASE';end if;
 execute replace(body,'FUNCTION private.document_reading_question_scope_v4(','FUNCTION private.document_reading_question_scope_before_structure_period_v2(');

 body:=pg_get_functiondef('private.source_structure_subject_current(jsonb,jsonb,jsonb)'::regprocedure);
 needle:='or ref#>>''{source,source_scope,period_kind}'' is distinct from ''current''';
 if (char_length(body)-char_length(replace(body,needle,'')))<>char_length(needle)
  or position('if e->>''document_id'' is distinct from first_pass->>''document_id''' in body)=0
  then raise exception 'SOURCE_STRUCTURE_PERIOD_V2_SUBJECT_BASE';end if;
 body:=replace(body,'FUNCTION private.source_structure_subject_current(','FUNCTION private.source_structure_period_subject_matches(');
 body:=replace(body,needle,'');
 body:=replace(body,'if e->>''document_id'' is distinct from first_pass->>''document_id''',
  'if jsonb_typeof(s) is distinct from ''object'' or (s->>''kind'' in (''source_relationship'',''deduction_group'')) is not true or e->>''document_id'' is null or e->>''document_id'' is distinct from first_pass->>''document_id''');
 execute body;

 body:=pg_get_functiondef('private.source_structure_target_current(jsonb,jsonb)'::regprocedure);
 needle:=$n$schema_name:=case target#>>'{subject,kind}' when 'source_relationship' then 'document-source-relationship-v1' when 'deduction_group' then 'document-source-deduction-group-v1' when 'balance_movement' then 'document-source-balance-movement-v1' end;$n$;
 if position(needle in body)=0 or position('private.source_structure_subject_current(e,f,target->''subject'')' in body)=0
  or position('''subject'',target->''subject'',''proposed_value'',null)' in body)=0
  then raise exception 'SOURCE_STRUCTURE_PERIOD_V2_TARGET_BASE';end if;
 body:=replace(body,'FUNCTION private.source_structure_target_current(','FUNCTION private.source_structure_period_target_matches(');
 body:=replace(body,needle,$r$if checkpoint->>'schema_version' is distinct from 'tivdoc-saved-extraction-v1'
  or checkpoint->>'period_mismatch' is distinct from 'false' then return false;end if;
 schema_name:=case target#>>'{subject,kind}' when 'source_relationship' then 'document-source-relationship-v2' when 'deduction_group' then 'document-source-deduction-group-v2' end;$r$);
 body:=replace(body,'not private.source_structure_subject_current(e,f,target->''subject'')','private.source_structure_period_subject_matches(e,f,target->''subject'') is not true');
 body:=replace(body,'''subject'',target->''subject'',''proposed_value'',null)',
  '''subject'',target->''subject'',''proposed_value'',null,''period_witness'',target->''period_witness'')');
 -- This helper proves the raw subject/canonical target only. The witness is
 -- independently reconstructed below before any currentness result is true.
 execute body;

 body:=pg_get_functiondef('private.source_period_current_checkpoint(uuid,jsonb)'::regprocedure);
 needle:='target->>''schema_version'' is distinct from ''document-source-period-association-v1''';
 if position(needle in body)=0 or position('private.source_period_target_matches(checkpoint,target)' in body)=0
  then raise exception 'SOURCE_STRUCTURE_PERIOD_V2_CHECKPOINT_BASE';end if;
 body:=replace(body,'FUNCTION private.source_period_current_checkpoint(','FUNCTION private.source_structure_period_checkpoint(');
 body:=replace(body,needle,'(target->>''schema_version'' in (''document-source-relationship-v2'',''document-source-deduction-group-v2'')) is not true');
 body:=replace(body,'private.source_period_target_matches(checkpoint,target)','private.source_structure_period_target_matches(checkpoint,target)');
 execute body;
end;$capture$;

revoke all on function private.document_field_current_before_structure_period_v2(uuid,jsonb),
 private.document_reading_question_scope_before_structure_period_v2(text[],jsonb),
 private.source_structure_period_subject_matches(jsonb,jsonb,jsonb),
 private.source_structure_period_target_matches(jsonb,jsonb),private.source_structure_period_checkpoint(uuid,jsonb)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.document_reading_question_scope_before_structure_period_v2(text[],jsonb) to service_role,tivdoc_worker_runtime;

-- Reconstruct affirmative v1 period receipts from the CURRENT head journal.
-- null means malformed/ambiguous authority; [] means no affirmative reading.
-- Never use the reading embedded in a dependent v2 target as an input.
create function private.source_structure_period_readings(target_case uuid,target jsonb,checkpoint jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $readings$
declare journal jsonb;head_sha text;j jsonb;t jsonb;a jsonb;latest private.case_request_answer_versions%rowtype;
 r public.case_requests%rowtype;authority jsonb;decision jsonb;reading jsonb;result jsonb:='[]'::jsonb;
 seen_ids text[]:=array[]::text[];seen_subjects text[]:=array[]::text[];subject_sha text;stored_target jsonb;
begin
 select v.input,v.input_sha256 into journal,head_sha from private.case_input_heads h
 join private.case_input_versions v on v.case_id=h.case_id and v.revision=h.revision and v.input_sha256=h.input_sha256
 where h.case_id=target_case;
 if journal is null or head_sha is distinct from encode(sha256(convert_to(journal::text,'UTF8')),'hex')
  or jsonb_typeof(journal->'answers') is distinct from 'array' then return null;end if;
 for j in select x.value from jsonb_array_elements(journal->'answers') x(value) loop
  if j#>>'{field_target,schema_version}' is distinct from 'document-source-period-association-v1' then continue;end if;
  -- Foreign documents/months are unrelated. Same-document selected entries
  -- must be well formed and authenticated, including negative answers.
  if j#>>'{field_target,version_id}' is distinct from target->>'version_id' or j->>'scope_month' is distinct from target->>'month' then continue;end if;
  t:=j->'field_target';
  if jsonb_typeof(j) is distinct from 'object' or j->>'case_id' is distinct from target_case::text
   or t->>'case_id' is distinct from target_case::text or j->>'answer_kind' is distinct from 'choice'
   or j->>'code' is distinct from 'document_field:'||(t->>'target_sha256')
   or jsonb_typeof(j->'answer') is distinct from 'string'
   or jsonb_typeof(j->'answer_revision') is distinct from 'number'
   or coalesce(j->>'answer_revision'~'^[1-9][0-9]*$',false) is not true
   or jsonb_typeof(j->'answer_identity_id') is distinct from 'string'
   or jsonb_typeof(j->'answer_created_at') is distinct from 'string'
   or j->>'id'=any(seen_ids) then return null;end if;
  seen_ids:=array_append(seen_ids,j->>'id');
  select q.* into r from public.case_requests q where q.id=(j->>'id')::uuid and q.case_id=target_case;
  if not found or r.code is distinct from j->>'code' or r.answer_kind::text is distinct from 'choice'
   or r.statement_month is distinct from j->>'scope_month' or r.answered_at is null then return null;end if;
  select d.target into stored_target from private.document_field_targets d where d.request_id=r.id and d.case_id=target_case
   and d.target_sha256=t->>'target_sha256';
  if stored_target is distinct from t then return null;end if;
  select av.* into latest from private.case_request_answer_versions av where av.request_id=r.id order by av.revision desc limit 1;
  if not found or latest.revision is distinct from (j->>'answer_revision')::integer
   or latest.answer_text is distinct from j->>'answer' or latest.identity_id::text is distinct from j->>'answer_identity_id'
   or latest.created_at is distinct from (j->>'answer_created_at')::timestamptz
   or not exists(select 1 from public.case_identity_cases ic where ic.case_id=target_case and ic.identity_id=latest.identity_id) then return null;end if;
  -- Stale targets remain journal history; they never supply an older receipt.
  if r.expired_at is not null or t->>'policy_version' is distinct from target->>'policy_version'
   or private.source_period_target_matches(checkpoint,t) is not true
   or private.source_period_target_current(target_case,t) is not true then continue;end if;
  if private.source_period_answer_valid(t,j->>'answer') is not true then return null;end if;
  a:=(j->>'answer')::jsonb;
  if a->>'action' in ('unknown','unreadable') then continue;end if;
  if a->>'action' is distinct from 'correct' then return null;end if;
  subject_sha:=encode(sha256(convert_to(private.governance_jsonb_compact_text(t->'subject'),'UTF8')),'hex');
  if subject_sha=any(seen_subjects) then return null;end if;seen_subjects:=array_append(seen_subjects,subject_sha);
  authority:=jsonb_build_object('actor_kind','identified_account','identity_id',j->>'answer_identity_id','request_id',j->>'id',
   'answer_revision',j->'answer_revision','answered_at',j->>'answer_created_at');
  decision:=jsonb_build_object('policy_version','document-source-structure-identified-v1','scope','source_structure_reading_only',
   'target',t,'answer',a,'authority',authority,'source_structure_subject',t->'subject','state','corrected_reading',
   'effective_value',a->'structured_value','legal_applicability_verified',false,'provider_numeric_observations_verified',false,'balance_cell_transcribed',false);
  reading:=jsonb_build_object('schema_version','document-source-structure-reading-v1','actor_kind','customer','case_id',t->>'case_id',
   'document_id',t->>'version_id','source_sha256',t->>'source_sha256','normalized_extraction_sha256',t->>'normalized_extraction_sha256',
   'first_pass_extraction_sha256',t->>'first_pass_extraction_sha256','extraction_result_sha256',t->>'extraction_result_sha256',
   'target_sha256',t->>'target_sha256','subject',t->'subject','month',t->>'month','policy_version',t->>'policy_version',
   'request_id',j->>'id','answer_revision',j->'answer_revision','identity_id',j->>'answer_identity_id','confirmed_at',j->>'answer_created_at',
   'value',a->'structured_value','decision_sha256',encode(sha256(convert_to(private.governance_jsonb_compact_text(decision),'UTF8')),'hex'));
  reading:=reading||jsonb_build_object('verification_sha256',encode(sha256(convert_to(private.governance_jsonb_compact_text(reading),'UTF8')),'hex'));
  result:=result||jsonb_build_array(reading);
 end loop;
 return result;
exception when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value or datetime_field_overflow then return null;
end;$readings$;
revoke all on function private.source_structure_period_readings(uuid,jsonb,jsonb)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.source_structure_period_witness(target_case uuid,target jsonb,checkpoint jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $witness$
declare s jsonb:=target->'subject';refs jsonb;ref jsonb;readings jsonb;matches jsonb;reading jsonb;period jsonb;label text;entries jsonb:='[]'::jsonb;month_start date;
begin
 if private.source_structure_period_subject_matches(checkpoint#>'{run,result,final_extraction}',checkpoint#>'{run,result,first_pass,normalized_extraction}',s) is not true then return null;end if;
 month_start:=(target->>'month'||'-01')::date;
 period:=jsonb_build_object('from',to_char(month_start,'YYYY-MM-DD'),'to',to_char((month_start+interval '1 month - 1 day')::date,'YYYY-MM-DD'));
 refs:=case s->>'kind' when 'source_relationship' then jsonb_build_array(s->'contribution',s->'base')
  when 'deduction_group' then (s->'rows')||jsonb_build_array(s->'mandatory_total')||case when s->'voluntary_total'='null'::jsonb then '[]'::jsonb else jsonb_build_array(s->'voluntary_total') end end;
 if jsonb_typeof(refs) is distinct from 'array' then return null;end if;
 if jsonb_array_length(refs) not between 1 and 102 or (select count(distinct x.value->>'id') from jsonb_array_elements(refs) x(value))<>jsonb_array_length(refs) then return null;end if;
 readings:=private.source_structure_period_readings(target_case,target,checkpoint);
 if readings is null then return null;end if;
 for ref in select x.value from jsonb_array_elements(refs) x(value) order by ((x.value->>'kind')||':'||(x.value->>'id')) collate "C" loop
  select coalesce(jsonb_agg(x.value),'[]'::jsonb) into matches from jsonb_array_elements(readings) x(value)
   where exists(select 1 from jsonb_array_elements(x.value#>'{subject,refs}') rr(value) where rr.value->>'kind'=ref->>'kind' and rr.value->>'id'=ref->>'id');
  if jsonb_array_length(matches)>1 then return null;end if;
  reading:=matches->0;label:=ref#>>'{source,source_scope,period_kind}';
  if reading is not null then
   if reading#>>'{value,kind}' is distinct from 'period_association' or reading#>>'{value,period_kind}' is distinct from 'current'
    or reading#>'{value,period}' is distinct from period or reading#>'{value,basis,page}' is distinct from ref#>'{source,page}'
    or not exists(select 1 from jsonb_array_elements(reading#>'{subject,refs}') rr(value) where rr.value=ref)
    or exists(select 1 from jsonb_array_elements(reading#>'{subject,refs}') rr(value)
     where rr.value#>>'{source,document_id}' is distinct from target->>'version_id'
      or (rr.value#>>'{source,source_scope,period_kind}' is not null and rr.value#>>'{source,source_scope,period_kind}' not in ('unknown','current')))
    or reading->>'case_id' is distinct from target->>'case_id' or reading->>'document_id' is distinct from target->>'version_id'
    or reading->>'source_sha256' is distinct from target->>'source_sha256' or reading->>'month' is distinct from target->>'month'
    or reading->>'normalized_extraction_sha256' is distinct from target->>'normalized_extraction_sha256'
    or reading->>'first_pass_extraction_sha256' is distinct from target->>'first_pass_extraction_sha256'
    or reading->>'extraction_result_sha256' is distinct from target->>'extraction_result_sha256'
    or reading->>'policy_version' is distinct from target->>'policy_version' then return null;end if;
  end if;
  if label='current' then entries:=entries||jsonb_build_array(jsonb_build_object('ref',ref,'basis','original_current','reading',null));
  elsif (label is null or label='unknown') and reading is not null then
   entries:=entries||jsonb_build_array(jsonb_build_object('ref',ref,'basis','identified_current','reading',reading));
  else return null;end if;
 end loop;
 return jsonb_build_object('schema_version','document-source-structure-period-witness-v1','period',period,'refs',entries);
exception when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value or datetime_field_overflow then return null;
end;$witness$;
revoke all on function private.source_structure_period_witness(uuid,jsonb,jsonb)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.source_structure_period_target_in_scope(target_case uuid,target jsonb,topics text[]) returns boolean
language plpgsql stable security invoker set search_path='' as $scope$
declare checkpoint jsonb:=private.source_structure_period_checkpoint(target_case,target);witness jsonb;entry jsonb;
begin
 if checkpoint is null or coalesce(cardinality(topics)>0 and array_position(topics,null) is null
  and topics <@ array['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave','rest_day','bonuses','contract']::text[],false) is not true then return false;end if;
 if (case target->>'schema_version' when 'document-source-relationship-v2' then 'pension'=any(topics) and target#>>'{subject,kind}'='source_relationship'
  when 'document-source-deduction-group-v2' then 'minimum_wage'=any(topics) and target#>>'{subject,kind}'='deduction_group' else false end) is not true then return false;end if;
 witness:=private.source_structure_period_witness(target_case,target,checkpoint);
 if witness is null or witness is distinct from target->'period_witness' then return false;end if;
 for entry in select x.value from jsonb_array_elements(witness->'refs') x(value) loop
  if entry->>'basis'='identified_current' and private.source_period_refs_in_scope(checkpoint#>'{run,result,final_extraction}',topics,entry#>'{reading,subject}') is not true then return false;end if;
 end loop;
 return true;
exception when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value then return false;
end;$scope$;
revoke all on function private.source_structure_period_target_in_scope(uuid,jsonb,text[])
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.source_structure_period_target_current(target_case uuid,target jsonb) returns boolean
language plpgsql stable security invoker set search_path='' as $current$
declare target_month date;
begin
 if private.source_structure_period_checkpoint(target_case,target) is null then return false;end if;
 target_month:=(target->>'month'||'-01')::date;
 return exists(select 1 from private.case_input_heads h
  join private.case_input_versions v on v.case_id=h.case_id and v.revision=h.revision and v.input_sha256=h.input_sha256
  where h.case_id=target_case and (
   exists(select 1 from jsonb_array_elements(v.input->'orders') pinned(value)
    join private.product_orders o on o.case_id=target_case and o.id::text=pinned.value->>'id'
    join private.order_entitlements ent on ent.order_id=o.id and ent.state='active'
    where o.state='paid' and o.refund_state<>'refunded' and target_month between o.period_from and o.period_to
     and pinned.value=jsonb_build_object('id',o.id,'kind',o.kind,'from',o.period_from,'to',o.period_to,'topics',o.topics,'offer_sha256',o.offer_sha256)
     and private.source_structure_period_target_in_scope(target_case,target,o.topics))
   or exists(select 1 from jsonb_array_elements(v.input->'legacy_orders') pinned(value)
    cross join lateral jsonb_array_elements(private.legacy_paid_scopes_internal(target_case)) active(value)
    where pinned.value=active.value and private.legacy_scope_covers_month(active.value,target_month)
     and private.source_structure_period_target_in_scope(target_case,target,array(select jsonb_array_elements_text(active.value->'topics'))))));
exception when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value or datetime_field_overflow then return false;
end;$current$;
revoke all on function private.source_structure_period_target_current(uuid,jsonb)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.source_structure_period_answer_valid(target jsonb,answer_text text) returns boolean
language plpgsql immutable security invoker set search_path='' as $answer$
declare old_schema text;
begin
 old_schema:=case when target->>'schema_version'='document-source-relationship-v2' and target#>>'{subject,kind}'='source_relationship' then 'document-source-relationship-v1'
  when target->>'schema_version'='document-source-deduction-group-v2' and target#>>'{subject,kind}'='deduction_group' then 'document-source-deduction-group-v1' end;
 if old_schema is null or jsonb_typeof(target->'period_witness') is distinct from 'object' then return false;end if;
 -- Same strict answer value contract. The trigger separately checks currentness.
 return coalesce(private.document_source_structure_answer_valid((target-'period_witness')||jsonb_build_object('schema_version',old_schema),answer_text),false);
exception when invalid_text_representation or invalid_parameter_value or numeric_value_out_of_range then return false;
end;$answer$;
revoke all on function private.source_structure_period_answer_valid(jsonb,text)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create or replace function private.document_field_current(target_case uuid,target jsonb) returns boolean
language sql security definer set search_path='' as $wrapper$
 select case when target->>'schema_version' in ('document-source-relationship-v2','document-source-deduction-group-v2')
  then coalesce(private.source_structure_period_target_current(target_case,target),false)
  else private.document_field_current_before_structure_period_v2(target_case,target) end;
$wrapper$;

create or replace function private.document_reading_question_scope_v4(purchased_topics text[],target jsonb) returns boolean
language sql immutable security invoker set search_path='' as $question_scope$
 select case when target->>'schema_version' in ('document-source-relationship-v2','document-source-deduction-group-v2') then coalesce(
  cardinality(purchased_topics)>0 and array_position(purchased_topics,null) is null
  and purchased_topics <@ array['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave','rest_day','bonuses','contract']::text[]
  and case target->>'schema_version' when 'document-source-relationship-v2' then 'pension'=any(purchased_topics) and target#>>'{subject,kind}'='source_relationship'
   when 'document-source-deduction-group-v2' then 'minimum_wage'=any(purchased_topics) and target#>>'{subject,kind}'='deduction_group' else false end,false)
  else private.document_reading_question_scope_before_structure_period_v2(purchased_topics,target) end;
$question_scope$;

-- Protected read-only context for web answer validation. This has no caller
-- witness/journal parameter. TS verifies this exact journal hash before replay.
create function public.case_request_source_period_context(target_case uuid,target_identity uuid,target_request uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $context$
declare target jsonb;checkpoint jsonb;journal jsonb;source_revision integer;source_sha text;
begin
 if not exists(select 1 from public.case_identity_cases ic where ic.case_id=target_case and ic.identity_id=target_identity)
  then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 select t.target into target from private.document_field_targets t join public.case_requests r on r.id=t.request_id and r.case_id=t.case_id
 where t.case_id=target_case and t.request_id=target_request and r.code='document_field:'||t.target_sha256
  and r.answer_kind::text='choice' and r.statement_month=t.target->>'month' and r.expired_at is null
  and (r.answered_at is not null or r.expires_at>statement_timestamp())
  and t.target->>'schema_version' in ('document-source-relationship-v2','document-source-deduction-group-v2')
  and private.document_field_current(target_case,t.target) is true;
 if target is null then return null;end if;
 checkpoint:=private.source_structure_period_checkpoint(target_case,target);
 if checkpoint is null then return null;end if;
 select v.input,h.revision,v.input_sha256 into journal,source_revision,source_sha from private.case_input_heads h
 join private.case_input_versions v on v.case_id=h.case_id and v.revision=h.revision and v.input_sha256=h.input_sha256 where h.case_id=target_case;
 if journal is null or source_sha is distinct from encode(sha256(convert_to(journal::text,'UTF8')),'hex') then return null;end if;
 return jsonb_build_object('case_id',target_case,'request_id',target_request,'source_revision',source_revision,
  'source_input_sha256',source_sha,'source_journal',journal,
  'source_journal_sha256',encode(sha256(convert_to(private.governance_jsonb_compact_text(journal),'UTF8')),'hex'),'checkpoint',checkpoint);
exception when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value or datetime_field_overflow then return null;
end;$context$;
revoke all on function public.case_request_source_period_context(uuid,uuid,uuid)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_request_source_period_context(uuid,uuid,uuid) to service_role,tivdoc_web_runtime;

-- Apply narrow additions to the latest wrapper bodies, including tariff/188.
do $integration$
declare body text;definition text;needle text;replacement text;
begin
 select pg_get_constraintdef(oid) into definition from pg_constraint where conrelid='private.document_field_targets'::regclass and conname='document_field_targets_check';
 needle:='''document-source-period-association-v1''::text';
 if definition is null or (char_length(definition)-char_length(replace(definition,needle,'')))<>char_length(needle)
  then raise exception 'SOURCE_STRUCTURE_PERIOD_V2_CHECK_BASE';end if;
 alter table private.document_field_targets drop constraint document_field_targets_check;
 execute 'alter table private.document_field_targets add constraint document_field_targets_check '||replace(definition,needle,needle||', ''document-source-relationship-v2''::text, ''document-source-deduction-group-v2''::text');

 body:=pg_get_functiondef('private.guard_document_cell_decision()'::regprocedure);
 needle:='case when t->>''schema_version''=''document-source-period-association-v1''';
 if (char_length(body)-char_length(replace(body,needle,'')))<>char_length(needle) then raise exception 'SOURCE_STRUCTURE_PERIOD_V2_GUARD_BASE';end if;
 execute replace(body,needle,'case when t->>''schema_version'' in (''document-source-relationship-v2'',''document-source-deduction-group-v2'') then private.source_structure_period_answer_valid(t,answer) when t->>''schema_version''=''document-source-period-association-v1''');

 body:=pg_get_functiondef('private.document_field_request_open(uuid,integer,text,jsonb,text)'::regprocedure);
 needle:='candidate_field:=case target_payload->>''schema_version''';
 if (char_length(body)-char_length(replace(body,needle,'')))<>char_length(needle) then raise exception 'SOURCE_STRUCTURE_PERIOD_V2_OPENER_BASE';end if;
 body:=replace(body,needle,needle||' when ''document-source-relationship-v2'' then ''source_structure.source_relationship'' when ''document-source-deduction-group-v2'' then ''source_structure.deduction_group''');
 needle:='private.document_reading_question_scope_v4(o.topics,target_payload)';
 if (char_length(body)-char_length(replace(body,needle,'')))<>char_length(needle) then raise exception 'SOURCE_STRUCTURE_PERIOD_V2_MODERN_SCOPE_BASE';end if;
 replacement:='('||needle||' and (target_payload->>''schema_version'' not in (''document-source-relationship-v2'',''document-source-deduction-group-v2'') or private.source_structure_period_target_in_scope(target_case,target_payload,o.topics)))';
 body:=replace(body,needle,replacement);
 needle:='private.document_reading_question_scope_v4(array(select jsonb_array_elements_text(active->''topics'')),target_payload)';
 if (char_length(body)-char_length(replace(body,needle,'')))<>char_length(needle) then raise exception 'SOURCE_STRUCTURE_PERIOD_V2_LEGACY_SCOPE_BASE';end if;
 replacement:='('||needle||' and (target_payload->>''schema_version'' not in (''document-source-relationship-v2'',''document-source-deduction-group-v2'') or private.source_structure_period_target_in_scope(target_case,target_payload,array(select jsonb_array_elements_text(active->''topics'')))))';
 execute replace(body,needle,replacement);

 -- No replacement source path/permission: the existing RPC calls the current
 -- wrapper and already uses these subject paths for v1 and v2 alike.
 body:=pg_get_functiondef('public.case_request_document_source(uuid,uuid,uuid)'::regprocedure);
 if position('private.document_field_current(target_case,t.target)' in body)=0
  or position('{subject,contribution,source,page}' in body)=0
  or position('{subject,mandatory_total,source,page}' in body)=0
  or position('{tariff,group,page}' in body)=0 or position('{subject,refs,0,source,page}' in body)=0
  then raise exception 'SOURCE_STRUCTURE_PERIOD_V2_SOURCE_RPC_BASE';end if;
end;$integration$;

-- Existing callable wrappers retain ownership/ACL with CREATE OR REPLACE.
-- New helpers receive no runtime access except the captured pure scope helper
-- (existing worker/service pattern); the new authenticated RPC is web/service.
