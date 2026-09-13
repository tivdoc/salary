-- Migration 203; CLI-generated file sequenced after the existing future-dated chain.
-- One focused contract reading per document/month; preserves fixed-page v1 history.
do $backup$
declare body text;f record;
begin
 for f in select * from (values
  ('private.evidence_source_transcription_context(uuid,jsonb)','private.evidence_source_transcription_context(','private.evidence_source_transcription_context_fixed_page_v1('),
  ('private.evidence_source_transcription_answer_valid(jsonb,text)','private.evidence_source_transcription_answer_valid(','private.evidence_source_transcription_answer_valid_fixed_page_v1(')
 ) x(signature,old_name,new_name) loop
  body:=pg_get_functiondef(f.signature::regprocedure);execute replace(body,f.old_name,f.new_name);
 end loop;
end;$backup$;
revoke all on function private.evidence_source_transcription_context_fixed_page_v1(uuid,jsonb),
 private.evidence_source_transcription_answer_valid_fixed_page_v1(jsonb,text)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

create or replace function private.evidence_source_reading_dependencies(journal jsonb,source_version uuid) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('version_id',a#>>'{field_target,version_id}','request_id',a->>'id',
  'answer_revision',a->'answer_revision','answer_sha256',private.source_intake_journal_sha(to_jsonb(a->>'answer')))
  order by a->>'id'),'[]'::jsonb)
 from jsonb_array_elements(journal->'answers') a
 where a->>'code' like 'document_field:%' and a#>>'{field_target,version_id}'=source_version::text
  and a#>>'{field_target,schema_version}' not in ('document-evidence-source-transcription-v1','document-evidence-source-transcription-v2','obligation-payment-choice-v1','obligation-payment-link-v1');
$$;

create or replace function private.evidence_source_transcription_context(target_case uuid,t jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare legacy jsonb;current_context jsonb;body jsonb;
begin
 if t->>'schema_version' is distinct from 'document-evidence-source-transcription-v2' then
  return private.evidence_source_transcription_context_fixed_page_v1(target_case,t);end if;
 if t->'page' is distinct from 'null'::jsonb or t->>'policy_version' is distinct from 'document-evidence-source-transcription-v2' then return null;end if;
 -- The v1 helper independently reconstructs current source/purchase/period
 -- dependencies from authenticated tables. This conversion grants no authority.
 legacy:=(t-'target_sha256')||jsonb_build_object('schema_version','document-evidence-source-transcription-v1','policy_version','document-evidence-source-transcription-v1','page',1);
 legacy:=legacy||jsonb_build_object('target_sha256',private.source_intake_journal_sha(legacy));
 current_context:=private.evidence_source_transcription_context_fixed_page_v1(target_case,legacy);
 if current_context is null then return null;end if;
 body:=(legacy-'target_sha256')||jsonb_build_object('schema_version','document-evidence-source-transcription-v2','policy_version','document-evidence-source-transcription-v2','page',null);
 if t is distinct from body||jsonb_build_object('target_sha256',private.source_intake_journal_sha(body)) then return null;end if;
 return current_context||jsonb_build_object('page',null);
end;$$;

create or replace function private.evidence_source_transcription_answer_valid(t jsonb,answer_text text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare a jsonb;v jsonb;
begin
 if t->>'schema_version' is distinct from 'document-evidence-source-transcription-v2' then
  return private.evidence_source_transcription_answer_valid_fixed_page_v1(t,answer_text);end if;
 if answer_text is null or char_length(answer_text)>2000 then return false;end if;
 a:=answer_text::jsonb;
 if a->>'schema_version' is distinct from 'document-evidence-source-answer-v2' then return false;end if;
 if a->>'action' in ('unknown','unreadable') then return a=jsonb_build_object('schema_version','document-evidence-source-answer-v2','action',a->>'action');end if;
 if a->>'action' is distinct from 'correct' then return false;end if;
 v:=a->'value';
 return coalesce(a=jsonb_build_object('schema_version','document-evidence-source-answer-v2','action','correct','value',v)
  and v=jsonb_build_object('page',v->'page','raw_value',v->'raw_value','locator',v->'locator')
  and jsonb_typeof(v->'page')='number' and v->>'page'~'^[1-9][0-9]?$|^100$'
  and (v->>'page')::integer between 1 and (t->>'page_count')::integer
  and jsonb_typeof(v->'raw_value')='string' and char_length(v->>'raw_value') between 1 and 1600 and v->>'raw_value'=btrim(v->>'raw_value')
  and jsonb_typeof(v->'locator')='string' and char_length(v->>'locator') between 1 and 120 and v->>'locator'=btrim(v->>'locator'),false);
exception when invalid_text_representation or invalid_parameter_value or numeric_value_out_of_range then return false;
end;$$;

-- Add v2 to the exact existing dispatch hooks. No old function bodies or rows
-- are replaced with prepared outputs; all existing authorization is retained.
do $dispatch$
declare body text;changed text;sig text;anchor text;
begin
 select pg_get_constraintdef(oid) into body from pg_constraint where conrelid='private.document_field_targets'::regclass and conname='document_field_targets_check';
 anchor:='''document-evidence-source-transcription-v1''::text';
 if position(anchor in body)=0 then raise exception 'SOURCE_TRANSCRIPTION_V2_CHECK_BASE';end if;
 alter table private.document_field_targets drop constraint document_field_targets_check;
 execute 'alter table private.document_field_targets add constraint document_field_targets_check '||replace(body,anchor,anchor||', ''document-evidence-source-transcription-v2''::text');
 foreach sig in array array[
  'private.document_field_current(uuid,jsonb)',
  'private.document_reading_question_scope_v4(text[],jsonb)',
  'private.document_field_request_answer_valid(uuid,uuid,text)',
  'private.document_field_request_open(uuid,integer,text,jsonb,text)',
  'private.guard_document_cell_decision()',
  'public.case_request_evidence_source_context(uuid,uuid,uuid)',
  'public.case_request_document_source(uuid,uuid,uuid)'
 ] loop
  body:=pg_get_functiondef(sig::regprocedure);
  changed:=replace(body,'=''document-evidence-source-transcription-v1''',' in (''document-evidence-source-transcription-v1'',''document-evidence-source-transcription-v2'')');
  changed:=replace(changed,'is distinct from ''document-evidence-source-transcription-v1''','not in (''document-evidence-source-transcription-v1'',''document-evidence-source-transcription-v2'')');
  if changed=body then raise exception 'SOURCE_TRANSCRIPTION_V2_DISPATCH_BASE: %',sig;end if;
  if sig='public.case_request_document_source(uuid,uuid,uuid)' then
   anchor:='''page'',(t->>''page'')::integer';
   if position(anchor in changed)=0 then raise exception 'SOURCE_TRANSCRIPTION_V2_SOURCE_PAGE_BASE';end if;
   -- The RPC returns the complete verified PDF. Page1 is only the initial
   -- navigation position; the answer receipt stores the selected evidence page.
   changed:=replace(changed,anchor,'''page'',coalesce((t->>''page'')::integer,1)');
  end if;
  execute changed;
 end loop;
end;$dispatch$;

-- Existing RPC/helper ACLs are unchanged by CREATE OR REPLACE. New backups are
-- private above. Root must rollback-preflight and run actual named worker/web
-- proof: seven-page source -> one request, selected page bounds, v1 history,
-- unknown/correction, foreign/source/purchase/dependency changes fail closed.
