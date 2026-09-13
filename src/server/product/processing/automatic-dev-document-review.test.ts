import {beforeEach,expect,it,vi} from 'vitest';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentReviewInputSchema} from '@/engine/document-review/contracts';
import {runDocumentReview} from '@/engine/document-review/service';
import {June2026ReviewCatalog} from '@/engine/legal-operations/june2026-catalog';
import type {AnalysisResultBundle,Wave3Topic} from '@/engine/wave3/contracts';
import type {PostgresStatement} from '@/server/platform/persistence/postgres/contracts';
import {SavedAnalysisDraftBuilder,savedAnalysisId} from './saved-draft-report';
import {june2026RegularReviewIdempotencyKey} from './saved-june2026-regular-authority';
import {savedMonthIdempotencyKey} from './saved-order-scope';
import {documentReviewIdempotencyKey} from './document-review-key';
import {SAVED_JUNE_REVIEW_VERSION} from './saved-minimum-wage-review';
import {runAutomaticDevMonth} from './automatic-dev-flow';

const ports=vi.hoisted(()=>({currentReview:vi.fn(),legacy:vi.fn(),regular:vi.fn(),financial:vi.fn(),publish:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./document-review-key',async original=>({...await original<typeof import('./document-review-key')>(),resolveSavedDocumentReviewKey:ports.currentReview}));
vi.mock('./saved-june2026-test-authority',()=>({loadJune2026TestAuthority:ports.legacy,june2026TestIdempotencyKey:()=> 'unused-synthetic-authority'}));
vi.mock('./saved-june2026-regular-authority',async original=>({...await original<typeof import('./saved-june2026-regular-authority')>(),loadSavedJune2026RegularAuthority:ports.regular}));
vi.mock('./dev-financial-analysis',()=>({runSavedDevFinancialMonth:ports.financial}));
vi.mock('../reports/publish-ai-report',()=>({publishSavedAiReport:ports.publish}));
type Input=Parameters<typeof runAutomaticDevMonth>[0];

// All source readings are explicitly synthetic. Current-source authentication
// is a mocked saved adapter; arithmetic, catalog and artifact replay are real.
async function fixture(month='2026-06',topics:Wave3Topic[]=['minimum_wage']){
 const f=buildSyntheticCaseFixture({fixture_id:'document-review-callback',mode:'real'}),snapshot=f.stored;
 const job:Input['job']={schema_version:'saved-case-work-v1',case_id:f.command.case_id,revision:1,input_sha256:'a'.repeat(64),mode:'draft'};
 const order={id:'11111111-1111-4111-8111-111111111111',kind:'full',from:month+'-01',to:month+'-01',topics,offer_sha256:'b'.repeat(64)};
 const period={from:month+'-01',to:month==='2026-06'?'2026-06-30':'2026-07-31'};
 const d=snapshot.documents[0],reading='c'.repeat(64),pin={case_id:job.case_id,document_id:d.document_id,version_id:d.document_id,source_sha256:d.content_sha256};
 const review=documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:job.case_id,period,
  purchased_scope:{order_id:order.id,receipt_sha256:order.offer_sha256,topics,origin:'saved_order'},
  documents:[{case_id:job.case_id,document_id:d.document_id,version_id:d.document_id,file_sha256:d.content_sha256,page_count:1,kind:'payslip',
   label:'תלוש בדיקה סינתטי',period,reading_origin:'ai_document_review',reading_sha256:reading}],
  checks:[{check_id:'synthetic.gross.net',topic:topics[0],title:'התאמה חשבונית סינתטית',explanation:'חיסור סכומים שנקראו במקור הסינתטי.',
   calculation:{schema_version:'document-review-calculation-input-v1',case_id:job.case_id,run_id:'pending',check_id:'synthetic.gross.net',period,evaluated_at:'2026-09-11T12:00:00.000Z',
    source_manifest:[{document_id:d.document_id,version_id:d.document_id,file_sha256:d.content_sha256,page_count:1,kind:'case_document',case_id:job.case_id}],
    operands:[['gross','100.00'],['deductions','10.00'],['net','90.00']].map(([id,value])=>({id,observation_id:'synthetic.'+id,state:'observed',printed_value:value,
     representation:'money_ils',quantity_unit:null,precision:'printed_precision',source:{document_id:d.document_id,version_id:d.document_id,file_sha256:d.content_sha256,page:1,
      locator:'synthetic table '+id,label:'נתון סינתטי',reading:'ai_document_review',reading_receipt_sha256:reading}})),
    operation:{kind:'reconciliation',add_refs:['gross'],subtract_refs:['deductions'],recorded_ref:'net',inventory_complete:true,inventory_basis:'synthetic totals',disjoint_components:true,overlap_basis:'distinct synthetic totals'},remittance_status:'not_assessed'}}],
  completion_input:{case_id:job.case_id,period,documents:[{pin,kind:'payslip',period,review:'complete'}],needs:[],evidence:[]}});
 const reviewSha256=canonicalSha256(review),baseKey=month==='2026-06'&&topics.length===1&&topics[0]==='minimum_wage'
  ?june2026RegularReviewIdempotencyKey(job,order.id):savedMonthIdempotencyKey(job,order.id,month);
 const key=documentReviewIdempotencyKey(baseKey,reviewSha256),command={...f.command,idempotency_key:key,document_review_sha256:reviewSha256,requested_topics:topics,
  period:{start_date:period.from,end_date:period.to},as_of:'2026-09-11',sector:'unverified',population:'unverified'};
 const commandSha=canonicalSha256(command),runId=savedAnalysisId('case-analysis-run',commandSha),catalog=new June2026ReviewCatalog();
 const selections=await Promise.all(topics.map(topic=>catalog.resolve({mode:'real',topic,target_date:period.to,as_of:command.as_of,sector:command.sector,population:command.population})));
 const seed:Omit<AnalysisResultBundle,'result_sha256'>={schema_version:'tivdoc-analysis-result-bundle-v0.6.0',analysis_run_id:runId,case_id:job.case_id,case_revision:command.case_revision,
  period:command.period,as_of:command.as_of,document_snapshot_sha256:command.document_snapshot_sha256,extraction_snapshot_sha256:command.extraction_snapshot_sha256,
  declared_fact_snapshot_sha256:command.declared_fact_snapshot_sha256,facts_snapshot_sha256:canonicalSha256([]),facts:[],rule_inputs:[],catalog_sha256:selections[0].catalog_sha256,
  topic_results:selections.map(selection=>({topic:selection.topic,status:'blocked_legal_readiness',blockers:['unsigned_authority'],rule_input_sha256:null,amount:null,trace:null,legal_readiness:selection.readiness})),
  known_subtotal:null,coverage_complete:false,document_review:runDocumentReview(review,runId)};
 const bundle={...seed,result_sha256:canonicalSha256(seed)},report=await new SavedAnalysisDraftBuilder().build(bundle);
 const payload={report_sha256:report.report_sha256,auto_approved:false,export_eligible_before_review:false,diagnostics:{schema_version:SAVED_JUNE_REVIEW_VERSION,
  case_id:job.case_id,analysis_run_id:runId,candidate_calculation_performed:false,findings_created:false,activation_allowed:false}};
 const query=vi.fn(async(sql:PostgresStatement)=>{
  if(sql.name!=='saved_order_entitlements')throw Error('UNEXPECTED_MUTATING_QUERY');
  return {rows:[{orders:[order],current_orders:[order]}],row_count:1};
 });
 const parent:Input['parent']={analysis_run_id:runId,idempotency_key:key,command_sha256:commandSha,command,completed:true,dependencies:null,selections,bundle,report,
  stages:[{stage:'review_pending',payload,payload_sha256:canonicalSha256(payload)}]};
 const current={key,review,reviewSha256,snapshot};ports.currentReview.mockResolvedValue(current);
 return {input:{context:{client:{query},transaction_id:'explicit-mocked-current-source'},job,orderId:order.id,month,parent} satisfies Input,current,query};
}
beforeEach(()=>{Object.values(ports).forEach(mock=>mock.mockReset());ports.legacy.mockResolvedValue(null);ports.regular.mockResolvedValue(null);});

it.each([['2026-06',['minimum_wage']],['2026-07',['pension','working_time']]] as [string,Wave3Topic[]][])
('acknowledges the same-run source review draft for %s and never calls a publisher or the engineering calculator',async(month,topics)=>{
 const s=await fixture(month,topics);await runAutomaticDevMonth(s.input);await runAutomaticDevMonth(s.input);
 expect(s.input.parent.bundle!.document_review!.checks[0].calculation.difference).toMatchObject({kind:'money',minor_units:0});
 expect(ports.currentReview).toHaveBeenCalledTimes(2);expect(ports.financial).not.toHaveBeenCalled();expect(ports.publish).not.toHaveBeenCalled();
 expect(s.query.mock.calls.every(([sql])=>sql.name==='saved_order_entitlements')).toBe(true);
});
it('refuses a new current review pin on an unchanged source job instead of accepting its old draft',async()=>{
 const s=await fixture();ports.currentReview.mockResolvedValue({...s.current,reviewSha256:'f'.repeat(64)});
 await expect(runAutomaticDevMonth(s.input)).rejects.toThrow('DOCUMENT_REVIEW_MANAGED_SCOPE');expect(ports.publish).not.toHaveBeenCalled();
});
it.each(['command review','snapshot','case','month','run','selection','report bytes','stage'] as const)('refuses altered %s before any delivery or calculation',async change=>{
 const s=await fixture(),p=s.input.parent;
 if(change==='command review')s.input.parent={...p,command:{...p.command,document_review_sha256:'f'.repeat(64)}};
 if(change==='snapshot')ports.currentReview.mockResolvedValue({...s.current,snapshot:{...s.current.snapshot,document_snapshot_sha256:'f'.repeat(64)}});
 if(change==='case')s.input.job={...s.input.job,case_id:'22222222-2222-4222-8222-222222222222'};
 if(change==='month')s.input.month='2026-07';
 if(change==='run')s.input.parent={...p,analysis_run_id:'other-run'};
 if(change==='selection')s.input.parent={...p,selections:[{...p.selections[0],catalog_sha256:'f'.repeat(64)}]};
 if(change==='report bytes')s.input.parent={...p,report:{...p.report!,html:Buffer.from('edited saved HTML')}};
 if(change==='stage')s.input.parent={...p,stages:[]};
 await expect(runAutomaticDevMonth(s.input)).rejects.toThrow();expect(ports.financial).not.toHaveBeenCalled();expect(ports.publish).not.toHaveBeenCalled();
});
it('refuses a previously unsigned draft after regular authority becomes ready',async()=>{
 const s=await fixture();ports.regular.mockResolvedValue({state:'ready'});
 await expect(runAutomaticDevMonth(s.input)).rejects.toThrow('REGULAR_MANAGED_REVIEW_AUTHORITY_CHANGED');
 expect(ports.currentReview).not.toHaveBeenCalled();expect(ports.publish).not.toHaveBeenCalled();
});
