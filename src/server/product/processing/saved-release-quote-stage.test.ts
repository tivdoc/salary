import {beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
const mocks=vi.hoisted(()=>({orders:vi.fn(),reader:vi.fn()}));
vi.mock('./saved-order-scope',async original=>({...await original<typeof import('./saved-order-scope')>(),readSavedOrders:mocks.orders}));
vi.mock('../orders/saved-release-pricing-basis',async original=>({...await original<typeof import('../orders/saved-release-pricing-basis')>(),createSavedReleasePricingBasisReader:()=>mocks.reader}));
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {mapPostgresFailure} from '@/server/platform/persistence/postgres/runtime/errors';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {RELEASE_PURCHASE_TOPICS,PURCHASE_TOPICS_VERSION} from '../orders/purchase-topics';
import type {PricingBasis} from '../orders/pricing';
import {prepareSavedReleaseQuoteStage,recordSavedReleaseQuoteStatus,type SavedReleaseQuoteStageInput} from './saved-release-quote-stage';
import {savedOrderSchema} from './saved-order-scope';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=canonicalSha256({private_synthetic_quote_stage:true});
function setup(){
 const order=savedOrderSchema.parse({id:id(2),kind:'initial',from:'2026-06-01',to:'2026-06-01',topics:['minimum_wage'],offer_sha256:hash});
 const basis:PricingBasis={case_id:id(1),identity_id:id(3),analysis_version:'synthetic-current-analysis',input_sha256:hash,checked_months:['2026-06'],checked_topics:['minimum_wage'],
  components:[{finding_id:id(4),economic_key:'ordinary_wage',month:'2026-06',topic:'minimum_wage',kind:'wage_gap',direction:'employer_owes',certainty:'high',active:true,basis_complete:true,
   amount:54000,range:null,evidence_ids:[id(5)],rule_versions:['synthetic-admitted-comparison-v1'],alternative_group:null}]};
 const current={input_sha256:hash,now:'2026-09-12T00:00:00.000Z',credit:{order_id:order.id,case_id:id(1),identity_id:id(3),verified:true,paid_minor:999,already_consumed:false}};
 const quotes:Record<string,unknown>[]=[],orders:Record<string,unknown>[]=[];
 let saved:{quotes:Record<string,unknown>[];orders:Record<string,unknown>[]}|null=null,acceptFailure:string|Error|null=null,aborted=false;
 const query=vi.fn<PostgresTransactionContext['client']['query']>(async s=>{
  if(s.name==='release_quote_stage_rollback'){if(!saved)throw Error('NO_SAVEPOINT');quotes.splice(0,quotes.length,...saved.quotes);orders.splice(0,orders.length,...saved.orders);aborted=false;return {rows:[],row_count:0};}
  if(aborted)throw Error('TRANSACTION_ABORTED');
  if(s.name==='release_quote_stage_savepoint'){saved=structuredClone({quotes,orders});return {rows:[],row_count:0};}
  if(s.name==='release_quote_stage_release'){saved=null;return {rows:[],row_count:0};}
  if(s.name==='release_quote_status_record'){const detail=JSON.parse(String(s.values[0]));return {rows:[{value:{sha256:detail.sha256,replayed:false}}],row_count:1};}
  if(s.name==='price_quote_context')return {rows:[{value:current}],row_count:1};
  if(s.name==='price_quote_previous'){const rows=quotes.filter(q=>q.id===s.values[0]);return {rows,row_count:rows.length};}
  if(s.name==='price_quote_insert'){quotes.push({id:s.values[0],request_sha256:s.values[3],snapshot:JSON.parse(String(s.values[4])),quote_sha256:s.values[5],terms_version:s.values[6]});return {rows:[],row_count:1};}
  if(s.name==='quoted_order_snapshot'){const rows=quotes.filter(q=>q.id===s.values[0]);return {rows,row_count:rows.length};}
  if(s.name==='quoted_order_accept'){
   if(acceptFailure){aborted=true;throw typeof acceptFailure==='string'?Error(acceptFailure):acceptFailure;}
   const previous=orders.find(o=>o.quote_id===s.values[0]);if(previous)return {rows:[{value:{replayed:true,order:previous}}],row_count:1};
   const offer=JSON.parse(String(s.values[1])),full={id:id(8),case_id:id(1),kind:'full',amount_minor:offer.amount_minor,currency:'ILS',state:'awaiting_payment',offer,quote_id:s.values[0]};
   orders.push(full);return {rows:[{value:{replayed:false,order:full}}],row_count:1};
  }
  throw Error('UNEXPECTED_SQL:'+s.name);
 });
 const context:PostgresTransactionContext={transaction_id:'synthetic-stage-only',client:{query}};
 const input:SavedReleaseQuoteStageInput={context,job:{schema_version:'saved-case-work-v1',case_id:id(1),revision:4,input_sha256:hash,mode:'draft',processing_profile:'qualified_ai_v1',authority_dependency_sha256:hash},
  orderId:order.id,identityId:id(3),month:'2026-06',analysisRunId:basis.analysis_version};
 mocks.orders.mockResolvedValue([order]);mocks.reader.mockResolvedValue(basis);
 return {input,basis,current,order,quotes,orders,query,failAccept:(error:string|Error)=>{acceptFailure=error;},run:()=>prepareSavedReleaseQuoteStage(input)};
}
describe('same-month initial analysis → saved nine-topic quote and unpaid order',()=>{
 beforeEach(()=>vi.clearAllMocks());
 it('handles the actual driver classification at the savepoint, without swallowing other P0001 failures',async()=>{
  const f=setup();f.failAccept(mapPostgresFailure(Object.assign(Error('PRICE_QUOTE_CREDIT_UNAVAILABLE'),{code:'P0001'}),'POSTGRES_STATEMENT_FAILED'));
  expect(await f.run()).toEqual({state:'skipped',reason:'PRICE_QUOTE_CREDIT_UNAVAILABLE'});expect(f.quotes).toEqual([]);expect(f.orders).toEqual([]);
  const g=setup();g.failAccept(mapPostgresFailure(Object.assign(Error('REAL_SERVICE_FORBIDDEN'),{code:'P0001'}),'POSTGRES_STATEMENT_FAILED'));
  await expect(g.run()).rejects.toThrow('POSTGRES_STATEMENT_FAILED');expect(g.quotes).toEqual([]);
 });
 it('uses the saved monetary basis and existing credit to prepare only the same month, without checkout',async()=>{
  const f=setup(),result=await f.run();expect(result).toMatchObject({state:'offer_saved',replayed:false,period:{from:'2026-06',to:'2026-06'},topics:RELEASE_PURCHASE_TOPICS});
  expect(f.quotes).toHaveLength(1);expect(f.orders).toHaveLength(1);
  expect(f.quotes[0].snapshot).toMatchObject({schema_version:'tivdoc-price-quote-v2',purchase_topics_version:PURCHASE_TOPICS_VERSION,basis_minor:54000,total_minor:9900,credit_minor:999,balance_minor:8901,
   checked_topics:['minimum_wage'],purchased_topics:RELEASE_PURCHASE_TOPICS,purchased_period:{from:'2026-06',to:'2026-06'}});
  expect(f.orders[0]).toMatchObject({state:'awaiting_payment',amount_minor:8901,offer:{version:'tivdoc-order-offer-v3',maximum_checked_topics:9}});
  expect(f.query.mock.calls.map(([s])=>s.name)).not.toEqual(expect.arrayContaining(['order_checkout','payment_capture','terms_accept']));
 });
 it('reuses the exact quote and order on retry without reading a second monetary basis',async()=>{
  const f=setup(),first=await f.run(),second=await f.run();expect(second).toEqual({...first,replayed:true});expect(f.quotes).toHaveLength(1);expect(f.orders).toHaveLength(1);expect(mocks.reader).toHaveBeenCalledOnce();
 });
 it.each(RELEASE_PURCHASE_TOPICS)('routes supported %s to the trusted reader and retains an unavailable comparison as data-dependent',async topic=>{
  const f=setup();mocks.orders.mockResolvedValue([savedOrderSchema.parse({...f.order,purchase_topics_version:PURCHASE_TOPICS_VERSION,topics:[topic]})]);mocks.reader.mockResolvedValue(null);
  expect(await f.run()).toEqual({state:'skipped',reason:'supported_comparison_basis_unavailable'});
  expect(mocks.reader).toHaveBeenCalledOnce();expect(f.quotes).toEqual([]);expect(f.orders).toEqual([]);
 });
 it('permits the unchanged default initial topic scope to reach its trusted pricing reader',async()=>{
  const f=setup();mocks.orders.mockResolvedValue([{...f.order,topics:['minimum_wage','working_time','pension']}]);
  expect(await f.run()).toMatchObject({state:'offer_saved'});expect(mocks.reader).toHaveBeenCalledOnce();
 });
 it('leaves unavailable supported comparisons explicit and keeps the analysis transaction usable',async()=>{
  const f=setup();mocks.reader.mockResolvedValue(null);expect(await f.run()).toEqual({state:'skipped',reason:'supported_comparison_basis_unavailable'});
  expect(f.quotes).toEqual([]);expect(f.orders).toEqual([]);expect(f.query.mock.calls.at(-1)?.[0].name).toBe('release_quote_stage_release');
 });
 it.each([0,49999])('does not prepare an upgrade for a supported %s minor-unit basis',async amount=>{
  const f=setup();f.basis.components[0].amount=amount;f.basis.components[0].direction=amount?'employer_owes':'none';expect(await f.run()).toEqual({state:'skipped',reason:'below_threshold'});expect(f.quotes).toEqual([]);expect(f.orders).toEqual([]);
 });
 it('does not silently extend the paid initial month or issue from a full order',async()=>{
  const f=setup();f.input.month='2026-07';expect(await f.run()).toEqual({state:'skipped',reason:'initial_pricing_requires_exact_single_month'});
  mocks.orders.mockResolvedValue([{...f.order,kind:'full'}]);expect(await f.run()).toEqual({state:'skipped',reason:'not_initial_order'});expect(f.quotes).toEqual([]);
 });
 it('keeps an expired saved quote and its reservation history unchanged',async()=>{
  const f=setup();await f.run();const before=JSON.stringify([f.quotes,f.orders]);f.current.now='2026-09-30T00:00:00.000Z';
  expect(await f.run()).toEqual({state:'skipped',reason:'PRICE_QUOTE_EXPIRED'});expect(JSON.stringify([f.quotes,f.orders])).toBe(before);expect(mocks.reader).toHaveBeenCalledOnce();
 });
 it.each(['PRICE_QUOTE_CREDIT_UNAVAILABLE','PRICE_QUOTE_EXISTING_ORDER_REQUIRES_RECONCILIATION','ORDER_COVERAGE_UNAVAILABLE'])('rolls back only the attempted offer on %s',async reason=>{
  const f=setup();f.failAccept(reason);expect(await f.run()).toEqual({state:'skipped',reason});expect(f.quotes).toEqual([]);expect(f.orders).toEqual([]);
  expect(f.query.mock.calls.slice(-2).map(([s])=>s.name)).toEqual(['release_quote_stage_rollback','release_quote_stage_release']);
 });
 it('binds deterministic quote identity to exact current analysis and source, without cancelling an older order',async()=>{
  const f=setup();await f.run();const firstId=f.quotes[0].id;f.input.analysisRunId='synthetic-recomputed-analysis';f.basis.analysis_version=f.input.analysisRunId;
  f.failAccept('PRICE_QUOTE_EXISTING_ORDER_REQUIRES_RECONCILIATION');expect(await f.run()).toMatchObject({state:'skipped'});expect(f.quotes).toHaveLength(1);expect(f.quotes[0].id).toBe(firstId);
  const attempted=f.query.mock.calls.filter(([s])=>s.name==='price_quote_insert').map(([s])=>s.values[0]);expect(new Set(attempted).size).toBe(2);expect(f.orders).toHaveLength(1);
 });
 it('refuses a different actual saved analysis and retains integrity failures',async()=>{
  const f=setup();f.basis.analysis_version='different-analysis';await expect(f.run()).rejects.toThrow('RELEASE_QUOTE_ANALYSIS_SCOPE');expect(f.quotes).toEqual([]);
  f.basis.analysis_version=f.input.analysisRunId;f.failAccept('PRICE_QUOTE_SOURCE_CHANGED');await expect(f.run()).rejects.toThrow('PRICE_QUOTE_SOURCE_CHANGED');expect(f.orders).toEqual([]);
 });
});


describe('saved pricing outcome attached to current initial-order history',()=>{
 it('records a precise safe category with exact source, analysis and initial receipt after a commercial refusal',async()=>{
  const f=setup(),before=JSON.stringify(f.order);
  const result=await recordSavedReleaseQuoteStatus(f.input,{state:'skipped',reason:'pricing_adapter_unsupported_topics',unsupported_topics:['vacation']});
  expect(result?.availability).toEqual({state:'coverage_unavailable',period:{from:'2026-06',to:'2026-06'}});
  const q=f.query.mock.calls.find(([s])=>s.name==='release_quote_status_record')?.[0];expect(q).toBeDefined();
  expect(JSON.parse(String(q!.values[0]))).toMatchObject({case_id:f.input.job.case_id,identity_id:f.input.identityId,initial_order_id:f.order.id,
   initial_order_receipt_sha256:f.order.offer_sha256,source_revision:4,source_sha256:f.input.job.input_sha256,analysis_run_id:f.input.analysisRunId});
  expect(JSON.stringify(f.order)).toBe(before);expect(f.quotes).toEqual([]);expect(f.orders).toEqual([]);
 });
 it('does not create a modern order event for a full order or relabel a foreign result period',async()=>{
  const f=setup();expect(await recordSavedReleaseQuoteStatus(f.input,{state:'skipped',reason:'not_initial_order'})).toBeNull();expect(f.query).not.toHaveBeenCalled();
  await expect(recordSavedReleaseQuoteStatus(f.input,{state:'offer_saved',quote_id:id(7),order_id:id(8),replayed:false,period:{from:'2026-07',to:'2026-07'},topics:RELEASE_PURCHASE_TOPICS})).rejects.toThrow('RELEASE_QUOTE_STATUS_PERIOD');
 });
});
