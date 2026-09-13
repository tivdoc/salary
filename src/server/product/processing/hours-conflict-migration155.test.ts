import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const migration=(name:string)=>readFileSync(`supabase/migrations/${name}.sql`,'utf8');
const original=migration('20260911004113_june2026_hours_conflict_journal');
const scope=migration('20260911005612_june2026_conflict_single_document_scope');
const repair=migration('20260911014710_hours_conflict_open_variable_scope');

function openerBeforeRepair(){
 const definition=original.match(/create function private\.june2026_hours_conflict_request_open\([\s\S]*?end;\$\$;/u)?.[0];
 if(!definition)throw Error('OPEN_FUNCTION_REQUIRED');
 const needle=scope.match(/needle:='([^']+)';/u)?.[1];
 const replacement=scope.match(/execute replace\(definition,needle,\$new\$([\s\S]*?)\$new\$\);/u)?.[1];
 if(!needle||!replacement||definition.split(needle).length!==2)throw Error('OPEN_SCOPE_PATCH_REQUIRED');
 return definition.replace(needle,replacement);
}

function repairedOpener(){
 const before=openerBeforeRepair();
 // This test models only this explicit ASCII SQL identifier replacement. It
 // does not execute PL/pgSQL or claim a database transaction was verified.
 expect(repair).toContain("regexp_replace(definition,'\\mtarget\\M','conflict_target','g')");
 for(const guard of repair.matchAll(/position\('((?:[^']|'')*)' in definition\)=0/gu)){
  expect(before).toContain(guard[1].replaceAll("''","'"));
 }
 return {before,after:before.replace(/\btarget\b/gu,'conflict_target')};
}

describe('migration155 conflict opener identifier scope (static chain)',()=>{
 it('removes the actual journal-column/local-variable collision without renaming the column or target pins',()=>{
  const {before,after}=repairedOpener();
  expect(original).toMatch(/create table private\.june2026_hours_conflict_targets\s*\([\s\S]*?\btarget jsonb not null/u);
  expect(before).toContain('declare source jsonb;target jsonb;request uuid;question text;');
  expect(before).toContain("and target_sha256=target->>'target_sha256'");
  expect(after).toContain('declare source jsonb;conflict_target jsonb;request uuid;question text;');
  expect(after).toContain("and target_sha256=conflict_target->>'target_sha256'");
  expect(after).not.toMatch(/\btarget\b/u);
  expect(after.replace(/\bconflict_target\b/gu,'target')).toBe(before);
  expect(repair).not.toMatch(/\b(?:alter table|grant|revoke|drop|variable_conflict|use_variable|use_column)\b/iu);
 });

 it('retains worker identity, case lock, current source revision and single-document checks before paid-source admission',()=>{
  const {after}=repairedOpener();
  const orderedGuards=[
   "session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text",
   'perform 1 from public.cases where id=target_case for update;',
   'case_id=target_case and revision=target_revision and input_sha256=target_input_sha',
   "then raise exception 'ANALYSIS_INPUT_SUPERSEDED'",
   "document_type='payslip' and period_month='2026-06-01')<>1 then return null",
   'source:=private.june2026_hours_admit(target_case,target_order,target_revision,target_input_sha);',
   'conflict_target:=private.june2026_hours_conflict_target(source,target_case,target_order);',
  ];
  let previous=-1;
  for(const guard of orderedGuards){const index=after.indexOf(guard);expect(index,guard).toBeGreaterThan(previous);previous=index;}
  expect(after).toContain("language plpgsql security definer set search_path=''");
  expect(after).not.toMatch(/exception\s+when/iu);
 });

 it('retains a null-target refusal and immutable target reuse before opening the customer request',()=>{
  const {after}=repairedOpener();
  const orderedEffects=[
   'if conflict_target is null then return null;end if;',
   'select request_id into request from private.june2026_hours_conflict_targets where case_id=target_case and order_id=target_order',
   'if request is not null then return request;end if;',
   'request:=gen_random_uuid();',
   "insert into private.june2026_hours_conflict_targets values(request,target_case,target_order,conflict_target,conflict_target->>'target_sha256');",
   'insert into public.case_requests',
   "'document_hours_conflict:'||(conflict_target->>'target_sha256')",
   'return request;',
  ];
  let previous=-1;
  for(const effect of orderedEffects){const index=after.indexOf(effect,previous+1);expect(index,effect).toBeGreaterThan(previous);previous=index;}
  expect(after).not.toMatch(/\b(?:update|delete)\s+private\.june2026_hours_conflict_targets/iu);
  expect(repair).toContain("raise exception 'HOURS_CONFLICT_OPEN_VARIABLE_BASE'");
 });
});
