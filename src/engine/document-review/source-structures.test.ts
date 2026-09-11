import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {buildSyntheticCaseFixture} from '../case-analysis/synthetic-fixtures.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {normalizedPayslipExtractionSchema} from '../extraction/payslip.ts';
import {payslipMachineExtractionSha256} from '../extraction/reading-resolution.ts';
import type {SourceStructureSelector} from '../extraction/source-structure-resolution.ts';
import {documentSourceStructureTarget,resolveDocumentSourceStructureVerification,materializeDocumentSourceStructureVerification} from '../../server/product/reports/document-source-structure.ts';
import {reviewInputFromPayslips,PAYSLIP_SOURCE_STRUCTURE_POLICY,PAYSLIP_REVIEW_POLICY} from './payslip-adapter.ts';
import {runDocumentReview,replayDocumentReview} from './service.ts';
import {calculateDocumentReview,documentReviewCalculationInputSchema} from './calculations.ts';
import {documentReviewReadingDependencies} from './source-dependencies.ts';
import type {DocumentReviewInput} from './contracts.ts';

const basis={page:1,locator:'synthetic source block A',text:'Explicit current source block and row labels'};
function fixture(){
 const f=buildSyntheticCaseFixture({fixture_id:'synthetic-review-source-structures',mode:'real'}),d=f.stored.documents[0],template=f.stored.extractions[0];
 const period={from:'2025-01-01',to:'2025-01-31'};
 const source={document_id:d.document_id,page:1,text_fragment:'synthetic current source',source_scope:{period_kind:'current',fund_kind:'unknown',column_label:'current'}};
 const ids={base:randomUUID(),employee:randomUUID(),total:randomUUID(),voluntary:randomUUID(),combined:randomUUID(),row1:randomUUID(),row2:randomUUID(),row3:randomUUID(),vacation:randomUUID(),sick:randomUUID()};
 const field=(name:string,id:string,raw:string,value:unknown)=>({candidate_id:id,field:name,raw_value:raw,normalized_value:value,confidence:1,source,extraction_method:'fixture',warning_flags:[]});
 const money=(name:string,id:string,raw:string)=>field(name,id,raw,{currency:'ILS',minor_units:Math.round(Number(raw)*100)});
 const row=(id:string,raw:string)=>({component_id:id,source_label:`synthetic deduction ${id.slice(0,4)}`,normalized_label:'deduction',semantic_kind:'deduction',
  quantity_raw:null,rate_raw:null,percentage_raw:null,amount_raw:raw,quantity:null,rate:null,percentage:null,amount:{currency:'ILS',minor_units:Number(raw)*100},confidence:1,source,extraction_method:'fixture',warning_flags:[],normalization_warnings:[]});
 const scope=(id:string,scope:string,field:string,raw:string)=>({scope,source_label:`synthetic ${scope}`,policy_version:'payslip-explicit-source-scope-v1',candidate:{candidate_id:id,field,raw_value:raw,confidence:1,source,extraction_method:'fixture',warning_flags:[]}});
 const machine=normalizedPayslipExtractionSchema.parse({...template,document_quality_confidence:1,fields:[...template.fields.filter(f=>f.field==='salary_period'),money('pension_base',ids.base,'2000.00'),
  money('pension_employee_contribution',ids.employee,'100.00'),money('total_deductions',ids.total,'120.00')],additional_components:[row(ids.row1,'100.00'),row(ids.row2,'20.00'),row(ids.row3,'50.00')],
  source_scope_observations:[scope(ids.voluntary,'voluntary_deduction','total_deductions','50.00'),scope(ids.combined,'combined_employer_funds','pension_employer_contribution','250.00')]});
 const first=normalizedPayslipExtractionSchema.parse({...machine,extraction_id:randomUUID(),fields:[...machine.fields,field('vacation_balance',ids.vacation,'9.00',null),field('sick_balance',ids.sick,'12.00',null)]});
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:d.case_id,product_document_id:randomUUID(),version_id:d.document_id,input_sha256:d.content_sha256,expected_month:'2025-01',period_mismatch:false,
  result_sha256:'',run:{result:{final_extraction:machine,first_pass:{normalized_extraction:first}}}};
 const rehash=()=>{checkpoint.result_sha256=canonicalSha256(checkpoint.run.result);};rehash();
 const readings:NonNullable<typeof machine.customer_source_structures>=[];
 const read=(selector:SourceStructureSelector,value:unknown)=>{
  const target=documentSourceStructureTarget({checkpoint,policyVersion:'synthetic-structure-v1',selector});
  const decision=resolveDocumentSourceStructureVerification({target,currentCheckpoint:checkpoint,policyVersion:'synthetic-structure-v1',caseId:d.case_id,month:'2025-01',requestId:randomUUID(),answerRevision:1,identityId:randomUUID(),answeredAt:'2025-02-02T00:00:00Z',answer:{schema_version:'document-field-answer-v3',action:'correct',structured_value:value}});
  const materialized=materializeDocumentSourceStructureVerification(decision,canonicalSha256(machine));if(!materialized)throw Error('synthetic reading missing');
  readings.push(materialized.reading);return materialized.reading;
 };
 const relation=(fund_kind='pension',relationship='same_base')=>read({kind:'source_relationship',componentKind:'pension_employee',contribution:{kind:'field',id:ids.employee},base:{kind:'field',id:ids.base}},
  {kind:'source_relationship',component_kind:'pension_employee',fund_kind,fund_label:'synthetic fund',source_kind:'labelled_section',relationship,basis});
 const group=(inventory='complete',unknown=false)=>read({kind:'deduction_group'},{kind:'deduction_group',inventory,basis,members:[{component_id:ids.row1,group:'mandatory'},{component_id:ids.row2,group:unknown?'unknown':'mandatory'},{component_id:ids.row3,group:'voluntary'}]});
 const balance=(kind:'vacation'|'sick'='vacation',unit='source_native_unknown',closing='9',missing?:string)=>{
  for(const [cell,amount] of [['opening','8'],['accrued','2'],['used','1'],['closing',closing],['adjustments',null]] as const){
   if(cell===missing)continue;
   read({kind:'balance_movement',balanceKind:kind,cell,candidateId:ids[kind]},amount===null?{kind:'balance_movement',state:'not_present',period:'2025-01',basis}:{kind:'balance_movement',state:'value',amount,unit,period:'2025-01',basis});
  }
 };
 const extraction=()=>normalizedPayslipExtractionSchema.parse({...machine,...(readings.length?{customer_source_structures:readings,source_reading_context:{checkpoint_result_sha256:checkpoint.result_sha256,first_pass:first}}:{})});
 const build=(topics:DocumentReviewInput['purchased_scope']['topics']=['minimum_wage','pension','vacation'],policy:typeof PAYSLIP_SOURCE_STRUCTURE_POLICY|typeof PAYSLIP_REVIEW_POLICY=PAYSLIP_SOURCE_STRUCTURE_POLICY)=>reviewInputFromPayslips({case_id:d.case_id,period,review_policy:policy,purchased_scope:{order_id:'synthetic-order',receipt_sha256:'a'.repeat(64),origin:'saved_order',topics},
  snapshot:{...f.stored,documents:[d],extractions:[extraction()]},retained_unresolved_fields:[{case_id:d.case_id,document_id:d.document_id,source_sha256:d.content_sha256,checkpoint_result_sha256:checkpoint.result_sha256,checkpoint_result:checkpoint.run.result,final_extraction_sha256:canonicalSha256(machine),first_pass:first}]});
 const run=()=>runDocumentReview(build(),'synthetic.structure.run');
 return {ids,d,machine,first,readings,checkpoint,read,relation,group,balance,build,run,rehash,extraction};
}
const check=(r:ReturnType<typeof runDocumentReview>,suffix:string)=>{const c=r.checks.find(c=>c.check_id.endsWith(suffix));if(!c)throw Error(`missing synthetic check ${suffix}`);return c.calculation;};

describe('source structure v3 through the ordinary adapter and RuleSpec runtime',()=>{
 it('requests relationships and group roles before unusable numeric confirmations; keeps the original source unchanged',()=>{
  const f=fixture(),before=canonicalSha256(f.machine),r=f.run(),deps=documentReviewReadingDependencies({review:r,document_id:f.d.document_id,extraction:f.extraction()});
  expect(check(r,'ratio.pension_employee_contribution').state).toBe('blocked');expect(check(r,'deductions.mandatory').state).toBe('blocked');expect(check(r,'balance.vacation').state).toBe('blocked');
  expect(deps.source_structures).toHaveLength(8);expect(deps.row_cells).toEqual([]);expect(canonicalSha256(f.machine)).toBe(before);
  expect(r.coverage_inventory?.source_balance_observations.find(o=>o.field==='sick_balance')).toMatchObject({scope_status:'outside_purchased_scope'});
  expect(r.checks.some(c=>c.topic==='sick_leave')).toBe(false);
 });
 it('calculates an observed contribution/base ratio without converting the source reading into legal applicability',()=>{
  const f=fixture();f.relation();const r=f.run(),c=check(r,'ratio.pension_employee_contribution');
  expect(c).toMatchObject({state:'calculated',observed_ratio:{numerator:'1',denominator:'20',unit:'ratio'},real_activation_allowed:false,human_attestation:null});
  expect(c).toHaveProperty('source_structure_trace_binding');expect(f.machine.fields.find(v=>v.candidate_id===f.ids.employee)?.source.source_scope?.fund_kind).toBe('unknown');
  expect(replayDocumentReview(r)).toEqual(r);
 });
 it.each(['unknown','study','combined'])('blocks an incompatible %s fund even with same_base',fund=>{
  const f=fixture();f.relation(fund);expect(check(f.run(),'ratio.pension_employee_contribution')).toMatchObject({state:'blocked',observed_ratio:null});
 });
 it('does not promote low-confidence numeric cells after relationship acceptance',()=>{
  const f=fixture();f.machine.fields=f.machine.fields.map(v=>v.field==='pension_employee_contribution'?{...v,confidence:.94}:v);f.rehash();f.relation();
  const c=check(f.run(),'ratio.pension_employee_contribution');expect(c.state).toBe('blocked');expect(c.input.operands.find(o=>o.id==='contribution')?.state).toBe('unknown');
 });
 it('preserves different-base evidence and refuses an edited calculation flag',()=>{
  const f=fixture();f.relation('pension','different_base');const c=check(f.run(),'ratio.pension_employee_contribution'),i=documentReviewCalculationInputSchema.parse(c.input);
  expect(c.state).toBe('blocked');if(i.operation.kind!=='observed_ratio')throw Error('test ratio');i.operation.same_period_and_base=true;
  expect(()=>calculateDocumentReview(i)).toThrow('SOURCE_STRUCTURE_BINDING');
 });
 it('retains an explicit conflict with a previously known source fund',()=>{
  const f=fixture();f.machine.fields=f.machine.fields.map(v=>v.candidate_id===f.ids.base?{...v,source:{...v.source,source_scope:{period_kind:'current' as const,fund_kind:'study' as const,column_label:'study source'}}}:v);f.rehash();f.relation();
  expect(check(f.run(),'ratio.pension_employee_contribution').state).toBe('blocked');
 });
 it('blocks repeated source deduction locations with different IDs instead of double counting',()=>{
  const f=fixture(),first=f.machine.additional_components[0];f.machine.additional_components[1]={...f.machine.additional_components[1],source_label:first.source_label,source:first.source};f.rehash();f.group();
  expect(check(f.run(),'deductions.mandatory')).toMatchObject({state:'blocked',blockers:expect.arrayContaining([expect.objectContaining({dependency_id:'inventory.disjoint'})])});
 });
 it('keeps a combined amount combined while calculating the observed ratio',()=>{
  const f=fixture();f.read({kind:'source_relationship',componentKind:'combined_employer_funds',contribution:{kind:'scope',id:f.ids.combined},base:{kind:'field',id:f.ids.base}},
   {kind:'source_relationship',relationship:'same_base',component_kind:'combined_employer_funds',fund_kind:'combined',fund_label:'combined source',source_kind:'explicit_reference',basis});
  const c=check(f.run(),'ratio.combined_employer_funds');expect(c).toMatchObject({state:'calculated',observed_ratio:{numerator:'1',denominator:'8'}});expect(c.input.operands).toHaveLength(2);
 });
 it.each([['120.00',0],['120.01',-1]] as const)('uses explicit membership, not sum-fit selection (%s)',(total,difference)=>{
  const f=fixture();f.machine.fields=f.machine.fields.map(v=>v.field==='total_deductions'?{...v,raw_value:total,normalized_value:{currency:'ILS' as const,minor_units:Math.round(Number(total)*100)}}:v);f.rehash();f.group();
  const r=f.run();expect(check(r,'deductions.mandatory')).toMatchObject({state:'calculated',expected:{minor_units:12000},difference:{minor_units:difference}});
  expect(check(r,'deductions.voluntary')).toMatchObject({state:'calculated',expected:{minor_units:5000},difference:{minor_units:0}});
 });
 it('keeps partial/unassigned group inventories blocked even when visible values sum to the total',()=>{
  const f=fixture();f.group('partial',true);expect(check(f.run(),'deductions.mandatory')).toMatchObject({state:'blocked',difference:null});
 });
 it('rejects duplicate group IDs and edited membership instead of silently deduplicating or reassigning',()=>{
  const f=fixture();f.group();const i=documentReviewCalculationInputSchema.parse(check(f.run(),'deductions.mandatory').input);
  if(i.source_structure?.kind!=='deduction_group')throw Error('test group');i.source_structure.row_bindings.push(i.source_structure.row_bindings[0]);
  expect(()=>calculateDocumentReview(i)).toThrow();
 });
 it.each([['9','0'],['9.01','-1']] as const)('computes a same-block unknown-unit numerical identity with closing %s',(closing,numerator)=>{
  const f=fixture();f.balance('vacation','source_native_unknown',closing);const r=f.run(),c=check(r,'balance.vacation');
  expect(c).toMatchObject({state:'calculated',difference:{kind:'rational',numerator},source_structure_qualification:{unit:'source_native_unknown',legal_entitlement_assessed:false}});
  expect(c.expected).toMatchObject({numerator:'9',denominator:'1'});expect(c.expected?.kind==='rational'&&c.expected.unit.startsWith('source.balance.')).toBe(true);
  expect(c.input.operands.some(o=>o.quantity_unit==='days'||o.quantity_unit==='hours')).toBe(false);expect(replayDocumentReview(r)).toEqual(r);
 });
 it.each(['opening','accrued','used','adjustments','closing'])('keeps missing %s unknown, never zero',cell=>{
  const f=fixture();f.balance('vacation','days','9',cell);const c=check(f.run(),'balance.vacation');expect(c.state).toBe('blocked');expect(c.difference).toBeNull();
 });
 it('blocks mixed known/unknown units from the same source block without conversion',()=>{
  const f=fixture();f.balance('vacation','days','9','used');f.read({kind:'balance_movement',balanceKind:'vacation',cell:'used',candidateId:f.ids.vacation},{kind:'balance_movement',state:'value',amount:'1',unit:'hours',period:'2025-01',basis});
  expect(check(f.run(),'balance.vacation')).toMatchObject({state:'blocked',blockers:expect.arrayContaining([expect.objectContaining({reason:'balance_movement_units_differ'})])});
 });
 it('supports a sick balance only when that topic was actually purchased',()=>{
  const f=fixture();f.balance('sick','days','9');const r=runDocumentReview(f.build(['sick_leave']),'synthetic.sick');expect(check(r,'balance.sick')).toMatchObject({state:'calculated',difference:{numerator:'0',unit:'days'}});
  expect(f.run().checks.some(c=>c.topic==='sick_leave')).toBe(false);
 });
 it('rejects cumulative anchors, changed source months and tampered receipt values',()=>{
  const f=fixture();f.first.fields=f.first.fields.map(v=>v.candidate_id===f.ids.vacation?{...v,source:{...v.source,source_scope:{period_kind:'cumulative' as const,fund_kind:'unknown' as const,column_label:'year'}}}:v);f.rehash();
  expect(()=>f.balance()).toThrow('CURRENT_SOURCE_REQUIRED');
  const fresh=fixture();fresh.balance();const r=fresh.readings[0];fresh.readings[0]={...r,month:'2025-02'};expect(()=>fresh.run()).toThrow();
 });
 it('keeps a precise coverage gap for cumulative/ambiguous balance anchors',()=>{
  const f=fixture();f.first.fields=f.first.fields.map(v=>v.candidate_id===f.ids.vacation?{...v,source:{...v.source,source_scope:{period_kind:'cumulative' as const,fund_kind:'unknown' as const,column_label:'year'}}}:v);f.rehash();
  const r=f.run();expect(r.coverage_gaps).toContainEqual(expect.objectContaining({check_id:'document.0.balance.vacation.source_block',kind:'missing_source'}));
  expect(r.checks.some(c=>c.check_id==='document.0.balance.vacation')).toBe(false);
 });
 it('rejects edited representation or a changed source-reading pin in the balance replay',()=>{
  const f=fixture();f.balance();const c=check(f.run(),'balance.vacation'),i=documentReviewCalculationInputSchema.parse(c.input);i.operands[0].representation='integer';
  expect(()=>calculateDocumentReview(i)).toThrow('SOURCE_STRUCTURE_BINDING');
  const review=f.build();review.documents[0].reading_sha256='f'.repeat(64);expect(()=>runDocumentReview(review,'synthetic.changed')).toThrow();
 });
 it('preserves v2 calculation bytes when v3 is not selected',()=>{
  const f=fixture(),before=f.build(undefined,PAYSLIP_REVIEW_POLICY);expect(before.checks.some(c=>documentReviewCalculationInputSchema.parse(c.calculation).source_structure)).toBe(false);
  expect(canonicalSha256(f.build(undefined,PAYSLIP_REVIEW_POLICY))).toBe(canonicalSha256(before));expect(payslipMachineExtractionSha256(f.extraction())).toBe(canonicalSha256(f.machine));
 });
});
