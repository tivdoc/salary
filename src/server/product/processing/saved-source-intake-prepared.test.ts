import {describe,expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresStatement,PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {legacySourceIntakeFixture} from './saved-legacy-source-intake.fixture.ts';
import {savedLegacySourceIntake} from './saved-legacy-source-intake.ts';
import {prepareSavedSourceIntake,openSavedSourceFinancialNeeds} from './saved-source-intake-planning.ts';
import {sourceJobSchema} from './source-dispatch.ts';
vi.mock('server-only',()=>({}));

describe('source intake prepared statements on a retained connection',()=>{
 it('opens field and document needs across transactions with unique SQL names and identical document RPC text',async()=>{
  const f=legacySourceIntakeFixture();
  let journal={...f.journal,answers:[],documents:[f.document]};
  let input={...f.input,journal,journalSha256:canonicalSha256(journal),currentDocuments:[f.document]};
  const job=sourceJobSchema.parse({schema_version:'saved-case-work-v1',case_id:f.caseId,revision:input.revision,input_sha256:input.inputSha256,mode:'draft',processing_profile:'qualified_ai_v1',authority_dependency_sha256:'f'.repeat(64)});
  const prepared=new Map<string,string>(),opened:PostgresStatement[]=[];
  const context:PostgresTransactionContext={transaction_id:'first',client:{async query(q){
   const prior=prepared.get(q.name);
   if(prior!==undefined&&prior!==q.text)throw Error(`Prepared statements must be unique - '${q.name}' was used for a different statement`);
   prepared.set(q.name,q.text);
   if(q.name==='saved_runner_source_intake_context')return {rows:[{context:input}],row_count:1};
   opened.push(q);return {rows:[{id:'99999999-9999-4999-8999-999999999999'}],row_count:1};
  }}};
  await prepareSavedSourceIntake(context,job,journal);
  expect(opened).toHaveLength(1);
  expect(JSON.parse(String(opened[0].values[3])).schema_version).toBe('document-source-period-intake-v1');
  journal={...journal,documents:[]};input={...input,journal,currentDocuments:[],journalSha256:canonicalSha256(journal)};
  await prepareSavedSourceIntake({...context,transaction_id:'second'},job,journal);
  expect(opened).toHaveLength(2);
  expect(JSON.parse(String(opened[1].values[3]))).toMatchObject({schema_version:'legacy-source-intake-document-v1',month:null,order_id:f.scope.id});
  await openSavedSourceFinancialNeeds({...context,transaction_id:'third'},job,savedLegacySourceIntake(input),[{orderId:f.scope.id,month:'2026-06',code:'source_financial_document_required'}]);
  expect(opened).toHaveLength(3);
  expect(JSON.parse(String(opened[2].values[3]))).toMatchObject({schema_version:'legacy-source-intake-document-v1',month:'2026-06',order_id:f.scope.id});
  expect(opened[0].name).not.toBe(opened[1].name);
  expect(opened[1].name).toBe(opened[2].name);
  expect(opened[1].text).toBe(opened[2].text);
  expect(opened.every(q=>typeof q.values[3]==='string')).toBe(true);
 });
});
