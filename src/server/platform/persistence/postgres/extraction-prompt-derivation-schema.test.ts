import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const sql=readFileSync('supabase/migrations/20260911183000_extraction_prompt_derivation.sql','utf8').replaceAll(/\s+/gu,' ').toLowerCase();
const forward=readFileSync('supabase/migrations/20260911183500_extraction_prompt_qa_lock.sql','utf8');
const body=(name:string)=>{
 const start=sql.indexOf('create function private.'+name+'('),end=sql.indexOf('end;$$;',start);
 if(start<0||end<0)throw Error('EXPECTED_DERIVATION_FUNCTION');return sql.slice(start,end);
};

// Structural security regression only; PostgreSQL execution, canonical number
// rendering, effective ACL and competing writers require a separate DEV proof.
describe('append-only historical prompt-label evidence schema',()=>{
 it('adds exactly one private receipt table with tenant RLS and immutable history',()=>{
  expect([...sql.matchAll(/create table ([a-z_.]+)/gu)].map(m=>m[1])).toEqual(['private.extraction_prompt_derivations']);
  expect(sql).toContain('primary key(case_id,revision,version_id,checkpoint_sha256)');
  expect(sql).toContain('foreign key(case_id,revision) references private.case_input_versions(case_id,revision)');
  expect(sql).toContain('alter table private.extraction_prompt_derivations enable row level security');
  expect(sql).toContain('alter table private.extraction_prompt_derivations force row level security');
  expect(sql).toContain("using(session_user='tivdoc_worker_runtime' and private.runtime_verified_tenant()='saved-case:'||case_id::text)");
  expect(sql).toContain("with check(session_user='tivdoc_worker_runtime' and private.runtime_verified_tenant()='saved-case:'||case_id::text)");
  expect(sql).toContain('revoke all on private.extraction_prompt_derivations from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime');
  expect(sql).toMatch(/create trigger extraction_prompt_derivation_immutable before update or delete on private\.extraction_prompt_derivations for each row execute function private\.reject_engine_append_only_mutation\(\)/u);
  expect(sql).not.toMatch(/grant (?:select|insert|update|delete|all) /u);
 });
 it('fences the authenticated current QA source under the same case lock before inserting',()=>{
  const prior=body('extraction_prompt_derivation_put');
  const needle=forward.match(/needle:='([^']+)'/u)?.[1];
  const replacement=forward.match(/replacement:=\$sql\$([\s\S]*?)\$sql\$/u)?.[1];
  if(!needle||!replacement)throw Error('EXPECTED_QA_LOCK_FORWARD');
  expect(prior.split(needle.toLowerCase())).toHaveLength(2);
  expect(forward).toContain("length(definition)-length(replace(definition,needle,''))<>length(needle)");
  const put=prior.replace(needle.toLowerCase(),replacement.replaceAll(/\s+/gu,' ').toLowerCase());
  const lock=put.match(/perform 1 from public\.cases where id=target_case and is_qa=true for update;\s*if not found then raise exception 'extraction_prompt_derivation_forbidden';end if;/u);
  expect(lock).not.toBeNull();
  expect(put).toContain("session_user<>'tivdoc_worker_runtime'");
  expect(put).toContain("private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text");
  expect(put).toContain('private.case_input_heads where case_id=target_case and revision=target_revision');
  expect(put.indexOf('for update')).toBeLessThan(put.indexOf('select c.result into original'));
  expect(put.indexOf('analysis_input_superseded')).toBeLessThan(put.indexOf('insert into private.extraction_prompt_derivations'));
 });
 it('derives only the known r8 orchestration label from its single completed fp1 receipt',()=>{
  const put=body('extraction_prompt_derivation_put');
  expect(put).toContain("original#>'{run,result,recovery_passes}' is distinct from '[]'::jsonb");
  expect(put).toContain("original#>>'{run,result,first_pass,prompt_version}' is distinct from 'payslip-extraction-openai-v2-first-r8'");
  expect(put).toContain("provider->>'prompt_version' is distinct from 'payslip-extraction-openai-v2-first-r8-fp1'");
  expect(put).toContain("provider->>'status' is distinct from 'completed'");
  expect([...put.matchAll(/jsonb_set\([^,]+,'([^']+)'/gu)].map(m=>m[1])).toEqual(['{run,result,first_pass,prompt_version}','{result_sha256}']);
  expect(put).toContain("'provider_calls',0,'changed_paths',jsonb_build_array('run.result.first_pass.prompt_version','result_sha256')");
  expect([...sql.matchAll(/insert into ([a-z_.]+)/gu)].map(m=>m[1])).toEqual(['private.extraction_prompt_derivations']);
  expect(sql).not.toMatch(/(?:update|delete from) (?:private\.case_extraction_checkpoints|public\.(?:documents|analysis_runs|case_report_projections))/u);
 });
 it('rechecks parent and receipt hashes and preserves the first durable winner',()=>{
  const get=body('extraction_prompt_derivation_get'),put=body('extraction_prompt_derivation_put');
  expect(get).toContain('c.case_id=d.case_id and c.revision=d.revision and c.version_id=d.version_id');
  expect(get).toContain("private.governance_jsonb_compact_text(c.result),'utf8')),'hex')=checkpoint_sha");
  for(const path of ['original','provider-\'receipt_sha256\'','original#>\'{run,result,first_pass,raw_extraction}\'','original#>\'{run,result}\''])
   expect(put).toContain('private.governance_jsonb_compact_text('+path+')');
  expect(put).toContain("if expected is distinct from target_receipt then raise exception 'extraction_prompt_derivation_receipt'");
  expect(put.indexOf('if stored is not null then')).toBeLessThan(put.indexOf("clock_timestamp()+interval '5 minutes'"));
  expect(put).toContain('on conflict(case_id,revision,version_id,checkpoint_sha256) do nothing');
  expect(put).toContain("if stored is distinct from expected then raise exception 'extraction_prompt_derivation_immutable'");
 });
});
