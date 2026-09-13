-- Enforce identified grand-total transcription at the database write boundary. Preserve historical
-- target semantics, currentness, identity checks, function OIDs and ACLs.
create function private.grand_total_answer_valid_v1(target jsonb,answer text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare a jsonb;v jsonb;label_key text;amount_minor numeric;
begin
 if target->>'schema_version' is distinct from 'document-source-transcription-v1'
  or target#>>'{subject,kind}' is distinct from 'grand_total'
  or target#>'{subject,page}' is distinct from '1'::jsonb
  or target#>>'{subject,meaning}' is distinct from 'document_total_deductions'
  or answer is null or char_length(answer)>2000 then return false;end if;
 -- Existing negative labels are historical unknown/unreadable decisions.
 -- In particular, "different" without a copied value never confirms a total.
 if answer in ('הערך שונה במסמך','לא ניתן לקרוא את השדה','לא יודע/ת') then return true;end if;
 a:=answer::jsonb;
 if jsonb_typeof(a) is distinct from 'object' or a->>'schema_version' is distinct from 'document-field-answer-v2' then return false;end if;
 if a->>'action' in ('unknown','unreadable') then
  return a=jsonb_build_object('schema_version','document-field-answer-v2','action',a->>'action');
 end if;
 -- No original grand total was observed: confirm is invalid, including via a
 -- direct authenticated web RPC that bypasses TypeScript and browser controls.
 if a->>'action' is distinct from 'correct' or jsonb_typeof(a->'corrected_raw_value') is distinct from 'string'
  or char_length(btrim(a->>'corrected_raw_value')) not between 1 and 500
  or a is distinct from jsonb_build_object('schema_version','document-field-answer-v2','action','correct','corrected_raw_value',a->>'corrected_raw_value')
  then return false;end if;
 v:=(a->>'corrected_raw_value')::jsonb;
 if jsonb_typeof(v) is distinct from 'object' or v->>'schema_version' is distinct from 'grand-total-source-value-v1'
  or (v-array['schema_version','amount','label','locator'])<>'{}'::jsonb
  or jsonb_typeof(v->'amount') is distinct from 'string' or jsonb_typeof(v->'label') is distinct from 'string'
  or jsonb_typeof(v->'locator') is distinct from 'string'
  or char_length(btrim(v->>'amount')) not between 1 and 50
  or char_length(btrim(v->>'label')) not between 1 and 100
  or char_length(btrim(v->>'locator')) not between 1 and 160
  or regexp_replace(v->>'locator','\s','','g')='' then return false;end if;
 label_key:=lower(btrim(regexp_replace(translate(normalize(v->>'label',NFKC),'"''״׳.',''),'\s+',' ','g')));
 if label_key!~'^(?:סך (?:כל )?(?:ה)?ניכויים|סהכ (?:ה)?ניכויים|total deductions)$' then return false;end if;
 -- Existing v1 SQL money parser is the payslip normalizeMoney grammar:
 -- currency stripping, NFKC, direction/space removal, decimal/thousands rule,
 -- <=2 significant fractional digits and JavaScript safe-integer cents.
 amount_minor:=private.document_evidence_money_minor_v2(btrim(v->>'amount'),'document-evidence-normalization-v1');
 return coalesce(amount_minor between 0 and 9007199254740991,false);
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end;$$;
revoke all on function private.grand_total_answer_valid_v1(jsonb,text)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

do $install$
declare definition text;needle text;
begin
 if to_regprocedure('private.document_field_request_answer_valid_before_grand_total_v1(uuid,uuid,text)') is not null
  then raise exception 'GRAND_TOTAL_ANSWER_ALREADY_INSTALLED';end if;
 definition:=pg_get_functiondef('private.document_field_request_answer_valid(uuid,uuid,text)'::regprocedure);
 if position('evidence_source_transcription_answer_valid' in definition)=0
  then raise exception 'GRAND_TOTAL_ANSWER_BASE_REQUIRED';end if;
 execute replace(definition,'FUNCTION private.document_field_request_answer_valid(',
  'FUNCTION private.document_field_request_answer_valid_before_grand_total_v1(');
 definition:=pg_get_functiondef('private.guard_document_cell_decision()'::regprocedure);
 needle:=$anchor$if tg_table_name='case_request_drafts' and answer='' then return new;end if;$anchor$;
 if position(needle in definition)=0 or position('private.document_field_current(r.case_id,t)' in definition)=0
  or position('case_identity_cases' in definition)=0 or position('evidence_source_transcription_answer_valid' in definition)=0
  then raise exception 'GRAND_TOTAL_ANSWER_TRIGGER_BASE_REQUIRED';end if;
 -- Preserve actual source/actor checks above this point and the empty draft
 -- exception. This also protects answer versions and draft writes, independently
 -- of the public answer/edit RPC's own request validator.
 execute replace(definition,needle,needle||$guard$
 if t->>'schema_version'='document-source-transcription-v1' and t#>>'{subject,kind}'='grand_total' then
  if not private.grand_total_answer_valid_v1(t,answer) then raise exception 'REQUEST_ANSWER_INVALID';end if;
  return new;
 end if;$guard$);
end;$install$;
revoke all on function private.document_field_request_answer_valid_before_grand_total_v1(uuid,uuid,text)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

create or replace function private.document_field_request_answer_valid(target_case uuid,target_request uuid,answer text) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare t jsonb;
begin
 select target into t from private.document_field_targets where case_id=target_case and request_id=target_request;
 if t->>'schema_version'='document-source-transcription-v1' and t#>>'{subject,kind}'='grand_total' then
  return private.document_field_current(target_case,t) and private.grand_total_answer_valid_v1(t,answer);
 end if;
 return private.document_field_request_answer_valid_before_grand_total_v1(target_case,target_request,answer);
end;$$;
-- No grants to new helpers. CREATE OR REPLACE retains installed wrapper/trigger
-- OIDs and ACLs; no rows, old answers, targets or provider observations change.
