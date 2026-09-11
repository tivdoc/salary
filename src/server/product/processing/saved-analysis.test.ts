import {describe,it,expect,vi} from 'vitest';
import {runSavedMonthAnalysis} from './saved-analysis';
import {savedOrderSchema,savedMonthIdempotencyKey,type SavedOrderScope} from './saved-order-scope';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {SAVED_DRAFT_TEMPLATE} from './saved-draft-report';
import {CASE_ANALYSIS_CODE_VERSION} from '@/engine/case-analysis/contracts';
import {resolveSavedDocumentReviewKey} from './document-review-key';
import type {SourceJob} from './source-dispatch';
import type {PostgresAnalysisRepositories} from '@/server/platform/persistence/postgres/analysis';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
vi.mock('server-only',()=>({}));

vi.mock('./source-dispatch',async importOriginal=>({...await importOriginal<typeof import('./source-dispatch')>(),lockCurrentSource:vi.fn(async()=>{})}));
const caseId='11111111-1111-4111-8111-111111111111';
function setup(){
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:caseId,revision:1,input_sha256:'a'.repeat(64),mode:'draft'};
 const order:SavedOrderScope={id:'22222222-2222-4222-8222-222222222222',kind:'initial',from:'2026-08-01',to:'2026-08-01',topics:['pension'],offer_sha256:'b'.repeat(64)};
 const current:SavedOrderScope[]=[{...order}];
 const journal={input:{case_id:caseId,month:'2026-08',documents:[{id:'33333333-3333-4333-8333-333333333333',
  version_id:'44444444-4444-4444-8444-444444444444',sha256:'c'.repeat(64),type:'attendance',month:'2026-08'}],answers:[]},
  input_sha256:job.input_sha256,actual_sha256:job.input_sha256,created_at:'2026-09-08T00:00:00.000Z'};
 const inventory=[{id:journal.input.documents[0].id,version_id:journal.input.documents[0].version_id,document_type:'attendance',content_sha256:'c'.repeat(64)}];
 const replay={command:{case_id:caseId,document_review_sha256:''},bundle:{},report:{}};
 const events:string[]=[];
 const cached=vi.fn(async(key:string)=>{expect(key).toMatch(/^review:[a-f0-9]{64}$/u);events.push('cached_result');return replay;});
 const context:PostgresTransactionContext={transaction_id:'unit-only',client:{async query(s){
  events.push(s.name);
  if(s.name==='saved_order_entitlements')return {rows:[{orders:[order],current_orders:current}],row_count:1};
  if(s.name==='saved_analysis_order')return {rows:[{input:{orders:[order]},created_at:'2026-09-08T00:00:00.000Z',engine_revision:1}],row_count:1};
  if(s.name==='saved_snapshot_journal')return {rows:[journal],row_count:1};
  if(s.name==='review_checkpoint_read')return {rows:[],row_count:0};
  if(s.name==='review_source_inventory')return {rows:inventory,row_count:inventory.length};
  throw new Error(`UNEXPECTED_SQL:${s.name}`);
 }}};
 // Resolve the baseline using the actual journal/snapshot/review adapters, then
 // mutate the mock stored rows in negative cases. No early-cache shortcut.
 const prepareReplay=async()=>{
  const resolved=await resolveSavedDocumentReviewKey(context,job,order,'2026-08',savedMonthIdempotencyKey(job,order.id,'2026-08'));
  replay.command.document_review_sha256=resolved.reviewSha256;events.length=0;return resolved;
 };
 return {order,current,cached,replay,journal,inventory,events,prepareReplay,input:{context,analysis:{caseAnalysis:{getCompletedByIdempotencyKey:cached}} as unknown as PostgresAnalysisRepositories,tenantId:`saved-case:${caseId}`,job,orderId:order.id,month:'2026-08'}};
}
describe('saved monthly analysis admission before replay',()=>{
 it('creates a distinct June analysis key for the acquired-source catalog while preserving other month keys',()=>{
  const {input}=setup();
  const previous=(month:string)=>`saved-month:${canonicalSha256({job:input.job,order_id:input.orderId,month,template:SAVED_DRAFT_TEMPLATE,engine:CASE_ANALYSIS_CODE_VERSION})}`;
  expect(savedMonthIdempotencyKey(input.job,input.orderId,'2026-06')).not.toBe(previous('2026-06'));
  expect(savedMonthIdempotencyKey(input.job,input.orderId,'2026-08')).toBe(previous('2026-08'));
 });
 it('does not reuse a pre-retention analysis key while retaining exact current retries',()=>{
  const {input}=setup();const old=`saved-month:${canonicalSha256({job:input.job,order_id:input.orderId,month:input.month,template:SAVED_DRAFT_TEMPLATE,engine:'case-analysis@0.6.3'})}`;
  const current=savedMonthIdempotencyKey(input.job,input.orderId,input.month);expect(current).not.toBe(old);expect(savedMonthIdempotencyKey(input.job,input.orderId,input.month)).toBe(current);
 });
 it.each(['revoked entitlement','another order','changed offer'] as const)('refuses %s before reading cached results',async defect=>{
  const s=setup();
  if(defect==='revoked entitlement')s.current.length=0;
  if(defect==='another order')s.current[0].id='33333333-3333-4333-8333-333333333333';
  if(defect==='changed offer')s.current[0].offer_sha256='c'.repeat(64);
  await expect(runSavedMonthAnalysis(s.input)).rejects.toThrow('SAVED_ORDER_ENTITLEMENT_REQUIRED');
  expect(s.cached).not.toHaveBeenCalled();
 });
 it('resolves the current saved journal and review before replaying an exact currently entitled order',async()=>{
  const s=setup(),resolved=await s.prepareReplay();
  expect(resolved.review.documents[0].kind).toBe('attendance');
  expect(resolved.review.checks).toEqual([]);expect(resolved.review.coverage_gaps[0].kind).toBe('missing_source');
  expect(await runSavedMonthAnalysis(s.input)).toBe(s.replay);expect(s.cached).toHaveBeenCalledExactlyOnceWith(resolved.key);
  expect(s.events.slice(-4)).toEqual(['saved_snapshot_journal','review_checkpoint_read','review_source_inventory','cached_result']);
 });
 it.each(['input_sha256','actual_sha256'] as const)('refuses changed journal %s before reading cached results',async hashField=>{
  const s=setup();await s.prepareReplay();s.journal[hashField]='f'.repeat(64);
  await expect(runSavedMonthAnalysis(s.input)).rejects.toThrow('SAVED_INPUT_HASH_MISMATCH');
  expect(s.cached).not.toHaveBeenCalled();
 });
 it('refuses a source removed from the current inventory before reading cached results',async()=>{
  const s=setup();await s.prepareReplay();s.inventory.length=0;
  await expect(runSavedMonthAnalysis(s.input)).rejects.toThrow('SAVED_REVIEW_DOCUMENT_REQUIRED');expect(s.cached).not.toHaveBeenCalled();
 });
 it('refuses a cached result with an unrelated review hash after resolving current inputs',async()=>{
  const s=setup();await s.prepareReplay();s.replay.command.document_review_sha256='d'.repeat(64);
  await expect(runSavedMonthAnalysis(s.input)).rejects.toThrow('SAVED_REPLAY_SCOPE');expect(s.cached).toHaveBeenCalledOnce();
 });
 it('refuses a saved initial order wider than the purchased three-topic product',async()=>{
  const s=setup();s.order.topics=['pension','travel','vacation','sick_leave'];s.current[0]={...s.order};
  await expect(runSavedMonthAnalysis(s.input)).rejects.toThrow();expect(s.cached).not.toHaveBeenCalled();
 });
 it('applies the same initial scope rule to the finalizer contract while preserving seven-topic full orders',()=>{
  const s=setup();s.order.topics=['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave'];
  expect(savedOrderSchema.safeParse(s.order).success).toBe(false);
  expect(savedOrderSchema.safeParse({...s.order,kind:'full'}).success).toBe(true);
 });
});
