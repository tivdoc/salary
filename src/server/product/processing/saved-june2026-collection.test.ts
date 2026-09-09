import {beforeEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createJune2026CollectionTarget,JUNE2026_DECLARATION_OPTIONS} from '@/engine/minimum-wage-june2026/collection';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {SAVED_EXTRACTION_POLICY} from './saved-snapshot';
import {savedJuneCollectionFixture} from './saved-june2026-collection.fixture';
import {materializeSavedJune2026Collection,openSavedJune2026Collection} from './saved-june2026-collection';
import type {SourceJob} from './source-dispatch';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
const ports=vi.hoisted(()=>({admit:vi.fn(),orders:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./saved-admission',()=>({admitSavedSource:ports.admit}));
vi.mock('./saved-order-scope',async load=>({...await load<typeof import('./saved-order-scope')>(),readSavedOrders:ports.orders}));
beforeEach(()=>{vi.resetAllMocks();ports.orders.mockResolvedValue([{id:randomUUID(),from:'2026-06-01',to:'2026-06-01',topics:['minimum_wage']}]);});
function setup(){
 const f=savedJuneCollectionFixture(),requestId=randomUUID(),identityId=randomUUID();
 const target=createJune2026CollectionTarget({checkpoint:f.checkpoint,policyVersion:SAVED_EXTRACTION_POLICY,subject:{kind:'applicability',field:'age_18_entire_month'}});
 const answer={id:requestId,case_id:f.doc.case_id,scope_month:'2026-06',code:'minimum_wage_june2026:'+target.target_sha256,answer:String(JUNE2026_DECLARATION_OPTIONS[0]),answer_revision:1,answer_identity_id:identityId,answer_created_at:'2026-09-09T18:00:00.000Z',june2026_target:target};
 const input={caseId:f.doc.case_id,journal:{answers:[answer]},targets:[{request_id:requestId,target,expires_at:'2026-09-19T18:00:00.000Z',expired_at:null}],checkpoints:[f.checkpoint],evaluatedAt:'2026-09-09T18:01:00.000Z'};
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:f.doc.case_id,revision:1,input_sha256:'a'.repeat(64),mode:'draft'};
 const calls:unknown[]=[];const context:PostgresTransactionContext={transaction_id:'june-unit',client:{async query(s){expect(s.name).toBe('saved_june2026_request_open');calls.push(JSON.parse(String(s.values[3])));return {rows:[{id:randomUUID()}],row_count:1};}}};
 return {...f,input,answer,target,job,context,calls};
}
it('opens the bounded eight source-bound requests for the purchased June topic and emits no confirmation',async()=>{
 const s=setup();expect(await openSavedJune2026Collection(s.context,s.job,s.checkpoint)).toHaveLength(8);expect(s.calls).toHaveLength(8);
 const evidence=materializeSavedJune2026Collection(s.input);expect(evidence.customer_declarations).toBe(1);expect(evidence.legal_confirmation).toBe(false);
 expect(evidence.resolutions[0]).toMatchObject({state:'declared',declaration:{identity_id:s.answer.answer_identity_id,answer_revision:1,evidence_status:'needs_confirmation'}});
});
it.each([{from:'2026-07-01',to:'2026-07-01',topics:['minimum_wage']},{from:'2026-06-01',to:'2026-06-01',topics:['travel']}])('never borrows a different month/topic entitlement: %j',async order=>{
 const s=setup();ports.orders.mockResolvedValue([order]);expect(await openSavedJune2026Collection(s.context,s.job,s.checkpoint)).toEqual([]);expect(s.calls).toEqual([]);
});
it('does not ask applicability questions for an unresolved document period',async()=>{const s=setup();s.checkpoint.period_mismatch=true;expect(await openSavedJune2026Collection(s.context,s.job,s.checkpoint)).toEqual([]);expect(ports.orders).not.toHaveBeenCalled();});
it('refuses journal scope drift and forged actor targets',()=>{
 const s=setup();s.answer.scope_month='2026-07';expect(()=>materializeSavedJune2026Collection(s.input)).toThrow('JUNE_COLLECTION_CASE_OR_TARGET_MISMATCH');
 s.answer.scope_month='2026-06';s.answer.case_id=randomUUID();expect(()=>materializeSavedJune2026Collection(s.input)).toThrow('JUNE_COLLECTION_CASE_OR_TARGET_MISMATCH');
});
it('preserves explicit unknown/conflict and distinguishes closed unanswered questions',()=>{
 const s=setup();s.answer.answer='איני יודע/ת';expect(materializeSavedJune2026Collection(s.input).resolutions[0].state).toBe('unknown');
 s.answer.answer='יש מידע סותר';expect(materializeSavedJune2026Collection(s.input).resolutions[0].state).toBe('conflicted');
 s.input.journal.answers=[];s.input.evaluatedAt='2026-09-20T00:00:00.000Z';expect(materializeSavedJune2026Collection(s.input).resolutions[0].state).toBe('expired');
});
it('keeps corrections and source replacement in separate immutable receipts',()=>{
 const s=setup(),first=materializeSavedJune2026Collection(s.input);s.answer.answer_revision=2;s.answer.answer=JUNE2026_DECLARATION_OPTIONS[1];
 const second=materializeSavedJune2026Collection(s.input);expect(canonicalSha256(first)).not.toBe(canonicalSha256(second));expect(first.resolutions[0]).toMatchObject({declaration:{answer_revision:1}});
 s.checkpoint.input_sha256='b'.repeat(64);expect(materializeSavedJune2026Collection(s.input).resolutions[0].state).toBe('stale');
});
it('rejects duplicate and unregistered request answers',()=>{const s=setup();s.input.journal.answers.push(s.answer);expect(()=>materializeSavedJune2026Collection(s.input)).toThrow('JUNE_COLLECTION_ANSWER_AMBIGUOUS');s.input.journal.answers.pop();s.input.targets=[];expect(()=>materializeSavedJune2026Collection(s.input)).toThrow('JUNE_COLLECTION_JOURNAL_REQUEST_MISSING');});
