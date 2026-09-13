-- Append-only repair evidence for one historical DEV orchestration label.
-- The original checkpoint, raw provider response and normalized fields remain
-- immutable. This grants no calculation, publication or professional authority.
create table private.extraction_prompt_derivations(
 case_id uuid not null, revision integer not null, version_id uuid not null,
 checkpoint_sha256 text not null check(checkpoint_sha256~'^[a-f0-9]{64}$'),
 receipt jsonb not null, recorded_at timestamptz not null default clock_timestamp(),
 primary key(case_id,revision,version_id,checkpoint_sha256),
 foreign key(case_id,revision) references private.case_input_versions(case_id,revision)
);
alter table private.extraction_prompt_derivations enable row level security;
alter table private.extraction_prompt_derivations force row level security;
create policy extraction_prompt_derivation_scope on private.extraction_prompt_derivations
 using(session_user='tivdoc_worker_runtime' and private.runtime_verified_tenant()='saved-case:'||case_id::text)
 with check(session_user='tivdoc_worker_runtime' and private.runtime_verified_tenant()='saved-case:'||case_id::text);
revoke all on private.extraction_prompt_derivations from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger extraction_prompt_derivation_immutable before update or delete on private.extraction_prompt_derivations
 for each row execute function private.reject_engine_append_only_mutation();

create function private.extraction_prompt_derivation_get(target_case uuid,target_revision integer,target_version uuid,checkpoint_sha text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare value jsonb;
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text
 then raise exception 'EXTRACTION_PROMPT_DERIVATION_FORBIDDEN';end if;
 select d.receipt into value from private.extraction_prompt_derivations d
 join private.case_extraction_checkpoints c on c.case_id=d.case_id and c.revision=d.revision and c.version_id=d.version_id
 where d.case_id=target_case and d.revision=target_revision and d.version_id=target_version and d.checkpoint_sha256=checkpoint_sha
 and c.policy_version='saved-payslip-v21-p95-v1'
 and encode(sha256(convert_to(private.governance_jsonb_compact_text(c.result),'UTF8')),'hex')=checkpoint_sha;
 return value;
end;$$;

create function private.extraction_prompt_derivation_put(target_case uuid,target_revision integer,target_version uuid,checkpoint_sha text,target_receipt jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare original jsonb;derived jsonb;provider jsonb;body jsonb;expected jsonb;stored jsonb;result_hash text;
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text
  or not exists(select 1 from public.cases where id=target_case and is_qa=true)
 then raise exception 'EXTRACTION_PROMPT_DERIVATION_FORBIDDEN';end if;
 -- Source mutation and derivation admission use the same case lock.
 perform 1 from public.cases where id=target_case for update;
 if not exists(select 1 from private.case_input_heads where case_id=target_case and revision=target_revision)
 then raise exception 'ANALYSIS_INPUT_SUPERSEDED';end if;
 select c.result into original from private.case_extraction_checkpoints c
 where c.case_id=target_case and c.revision=target_revision and c.version_id=target_version and c.policy_version='saved-payslip-v21-p95-v1';
 if original is null or encode(sha256(convert_to(private.governance_jsonb_compact_text(original),'UTF8')),'hex') is distinct from checkpoint_sha
  or original->>'case_id' is distinct from target_case::text or original->>'version_id' is distinct from target_version::text
 then raise exception 'EXTRACTION_PROMPT_DERIVATION_PARENT';end if;
 provider:=original#>'{run,provider_receipts,0}';
 if jsonb_array_length(original#>'{run,provider_receipts}')<>1
  or original#>'{run,result,recovery_passes}' is distinct from '[]'::jsonb
  or original#>>'{run,result,first_pass,kind}' is distinct from 'first_pass'
  or original#>>'{run,result,first_pass,prompt_version}' is distinct from 'payslip-extraction-openai-v2-first-r8'
  or provider->>'prompt_version' is distinct from 'payslip-extraction-openai-v2-first-r8-fp1'
  or provider->>'pass_kind' is distinct from 'first_pass' or provider->>'status' is distinct from 'completed'
  or provider->>'case_id' is distinct from target_case::text or provider->>'document_id' is distinct from target_version::text
  or provider->>'source_sha256' is distinct from original->>'input_sha256'
  or provider->>'raw_extraction_sha256' is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(original#>'{run,result,first_pass,raw_extraction}'),'UTF8')),'hex')
  or provider->>'receipt_sha256' is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(provider-'receipt_sha256'),'UTF8')),'hex')
  or original->>'result_sha256' is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(original#>'{run,result}'),'UTF8')),'hex')
  or coalesce(target_receipt->>'code_revision','')!~'^[a-f0-9]{40}$'
  or target_receipt->>'created_at' is null
 then raise exception 'EXTRACTION_PROMPT_DERIVATION_NOT_APPLICABLE';end if;
 derived:=jsonb_set(original,'{run,result,first_pass,prompt_version}',to_jsonb(provider->>'prompt_version'));
 result_hash:=encode(sha256(convert_to(private.governance_jsonb_compact_text(derived#>'{run,result}'),'UTF8')),'hex');
 derived:=jsonb_set(derived,'{result_sha256}',to_jsonb(result_hash));
 body:=jsonb_build_object('policy_version','saved-payslip-v21-prompt-receipt-derivation-v1',
  'case_id',target_case::text,'version_id',target_version::text,'source_sha256',original->>'input_sha256',
  'original_checkpoint_sha256',checkpoint_sha,'original_result_sha256',original->>'result_sha256',
  'derived_checkpoint_sha256',encode(sha256(convert_to(private.governance_jsonb_compact_text(derived),'UTF8')),'hex'),
  'derived_result_sha256',result_hash,'provider_receipt_sha256',provider->>'receipt_sha256','raw_extraction_sha256',provider->>'raw_extraction_sha256',
  'original_prompt_version',original#>>'{run,result,first_pass,prompt_version}','provider_prompt_version',provider->>'prompt_version',
  'origin',provider->>'origin','code_revision',target_receipt->>'code_revision','created_at',target_receipt->>'created_at',
  'provider_calls',0,'changed_paths',jsonb_build_array('run.result.first_pass.prompt_version','result_sha256'));
 expected:=body||jsonb_build_object('receipt_sha256',encode(sha256(convert_to(private.governance_jsonb_compact_text(body),'UTF8')),'hex'));
 if expected is distinct from target_receipt then raise exception 'EXTRACTION_PROMPT_DERIVATION_RECEIPT';end if;
 stored:=private.extraction_prompt_derivation_get(target_case,target_revision,target_version,checkpoint_sha);
 if stored is not null then
  -- A racing issuer reuses the immutable winner, including its audit time and
  -- code revision. The reader re-derives and verifies that receipt in full.
  return stored;
 end if;
 if (target_receipt->>'created_at')::timestamptz>clock_timestamp()+interval '5 minutes'
  or (target_receipt->>'created_at')::timestamptz<clock_timestamp()-interval '1 hour'
 then raise exception 'EXTRACTION_PROMPT_DERIVATION_TIME';end if;
 insert into private.extraction_prompt_derivations values(target_case,target_revision,target_version,checkpoint_sha,expected,clock_timestamp())
 on conflict(case_id,revision,version_id,checkpoint_sha256) do nothing;
 stored:=private.extraction_prompt_derivation_get(target_case,target_revision,target_version,checkpoint_sha);
 if stored is distinct from expected then raise exception 'EXTRACTION_PROMPT_DERIVATION_IMMUTABLE';end if;
 return stored;
end;$$;
revoke all on function private.extraction_prompt_derivation_get(uuid,integer,uuid,text),private.extraction_prompt_derivation_put(uuid,integer,uuid,text,jsonb)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.extraction_prompt_derivation_get(uuid,integer,uuid,text),private.extraction_prompt_derivation_put(uuid,integer,uuid,text,jsonb)
 to tivdoc_worker_runtime;
