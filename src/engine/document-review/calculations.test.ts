import {describe,it,expect} from 'vitest';
import {createRuleSpecPackage} from '../legal-operations/rulespec.ts';
import {calculateDocumentReview,replayDocumentReviewCalculation,type DocumentReviewCalculationInput,type DocumentReviewOperand} from './calculations.ts';

const sha='a'.repeat(64),otherSha='b'.repeat(64);
const source={document_id:'synthetic-document',version_id:'source.synthetic.v1',file_sha256:sha,page:1,locator:'synthetic table row',label:'original source label',reading:'ai_document_review' as const,reading_receipt_sha256:sha};
function operand(id:string,printed_value:string|null,representation:DocumentReviewOperand['representation']='money_ils',quantity_unit:DocumentReviewOperand['quantity_unit']=null):DocumentReviewOperand{
 return {id,observation_id:'observation.'+id,state:printed_value===null?'missing':'observed',printed_value,representation,quantity_unit,precision:'printed_precision',source:{...source,locator:'synthetic row '+id}};
}
function input(operation:DocumentReviewCalculationInput['operation'],operands:DocumentReviewOperand[]):DocumentReviewCalculationInput{
 return {schema_version:'document-review-calculation-input-v1',case_id:'synthetic-case',run_id:'synthetic-run-1',check_id:'synthetic.check',period:{from:'2026-06-01',to:'2026-06-30'},evaluated_at:'2026-09-11T12:00:00Z',source_manifest:[{document_id:source.document_id,version_id:source.version_id,file_sha256:sha,page_count:1,kind:'case_document',case_id:'synthetic-case'}],operands,operation,remittance_status:'missing'};
}
const ratio=()=>input({kind:'observed_ratio',numerator_ref:'contribution',denominator_ref:'base',component_identity:'employee printed contribution',same_period_and_base:true,basis:'same synthetic period and source base'},[operand('contribution','300.00'),operand('base','5000.00')]);
const product=()=>input({kind:'product',money_ref:'rate',factor_refs:['hours'],recorded_ref:'recorded',rounding:'half_up',rounding_basis:'explicit synthetic candidate; no payroll-policy claim'},[operand('rate','30.00'),operand('hours','8.50','decimal_quantity','hours'),operand('recorded','255.00')]);
function calculated(i:DocumentReviewCalculationInput){const r=calculateDocumentReview(i);expect(r.state).toBe('calculated');if(r.state!=='calculated')throw Error('test expected calculated');return r;}
function candidate(){
 const rule=createRuleSpecPackage({schema_version:'tivdoc-rulespec-v0.6.0',rule_spec_id:'synthetic.candidate.rule',rule_spec_version:'1.0.0',topic:'pension',catalog_boundary:'real_inactive',source_version_ids:[source.version_id],effective_period:{from:'2026-01-01',to:'2026-12-31'},sectors:['synthetic'],populations:['synthetic'],facts:[{ref_id:'fact.base',value_kind:'money',unit:'currency.ils'}],parameters:[{ref_id:'parameter.rate',parameter_id:'synthetic.rate',parameter_version:'1.0.0',value_kind:'rational',unit:'ratio'}],nodes:[{node_id:'expected.contribution',operation:'money.scale',money_ref:'fact.base',rational_ref:'parameter.rate',rounding:'half_up'}],output_ref:'expected.contribution',golden_case_set_sha256:sha,resource_policy:{max_steps:1,max_depth:1,max_aggregate_items:1,max_integer_digits:32}});
 return input({kind:'candidate_rule',rule,fact_bindings:[{ref_id:'fact.base',operand_id:'base'}],parameter_bindings:[{ref_id:'parameter.rate',operand_id:'rate'}],required_decision_ids:['scope.applies'],decisions:[{decision_id:'scope.applies',state:'accepted',basis:'ai_source_assessment',explanation:'Explicit synthetic source-scoped conditional assessment',sources:[source],valid_until:'2026-09-12T00:00:00Z'}],expected_output_ref:'expected.contribution',recorded_ref:null},[operand('base','5000.00'),operand('rate','6','percent','ratio')]);
}

describe('document review: source arithmetic and independent remittance',()=>{
 it('derives 300/5000 = 6% as an observed ratio with source conversion trace',()=>{
  const r=calculated(ratio());expect(r.observed_ratio).toEqual({kind:'rational',numerator:'3',denominator:'50',unit:'ratio'});
  expect(r.transformations).toHaveLength(2);expect(r.execution.trace[0].operation).toBe('divide');
  expect(r.claim).toBe('observed_ratio');expect(r.legal_requirement_status).toBe('not_determined');expect(r.remittance_status).toBe('missing');
  expect(r.input.operands[0].source.label).toBe('original source label');expect(r.input.operands.every(o=>o.representation==='money_ils')).toBe(true);
  expect(replayDocumentReviewCalculation(r)).toEqual(r);
 });
 it('keeps combined employer ratio combined, without inventing its split',()=>{
  const i=ratio();i.operands[0].printed_value='625.00';i.operation={...i.operation,...{kind:'observed_ratio',numerator_ref:'contribution',denominator_ref:'base',component_identity:'combined employer amount',same_period_and_base:true,basis:'source combined row'}};
  expect(calculated(i).observed_ratio).toMatchObject({numerator:'1',denominator:'8'});
 });
 it('does not block printed arithmetic because transfer evidence is missing',()=>{
  const r=calculated(product());expect(r.expected).toMatchObject({minor_units:25500});expect(r.difference).toMatchObject({minor_units:0});expect(r.remittance_status).toBe('missing');
 });
 it('reconciles signed cash amounts without turning deductions positive',()=>{
  const r=calculated(input({kind:'reconciliation',add_refs:['base','adjustment'],subtract_refs:['tax'],recorded_ref:'net',inventory_complete:true,inventory_basis:'all synthetic cash items',disjoint_components:true,overlap_basis:'distinct cash rows'},[operand('base','1000.00'),operand('adjustment','-10.00'),operand('tax','50.00'),operand('net','940.00')]));
  expect(r.difference).toMatchObject({minor_units:0});
 });
 it('retains exact HH:MM and decimal observations as a nonzero representation difference',()=>{
  const r=calculated(input({kind:'quantity_comparison',left_ref:'minutes',right_ref:'decimal',interpretation:'different_source_representations'},[operand('minutes','10:01','hours_minutes','hours'),operand('decimal','10.02','decimal_quantity','hours')]));
  expect(r.difference).toEqual({kind:'rational',numerator:'-1',denominator:'300',unit:'hours'});expect(r.input.operands.map(o=>o.printed_value)).toEqual(['10:01','10.02']);
 });
 it('does not round HH:MM into a convenient printed decimal for a product',()=>{
  const i=product();i.operands[1]=operand('hours','8:31','hours_minutes','hours');expect(calculated(i).expected).toMatchObject({minor_units:25550});
 });
 it.each([['08:05',24250],['00:30',1500],['00:00',0]] as const)('accepts printed HH:MM %s without altering its source or exact minutes', (raw,minor_units)=>{
  const i=product();i.operands[1]=operand('hours',raw,'hours_minutes','hours');const r=calculated(i);
  expect(r.expected).toMatchObject({minor_units});expect(r.input.operands[1].printed_value).toBe(raw);expect(replayDocumentReviewCalculation(r)).toEqual(r);
 });
 it('blocks overlapping premium hours before sum, even with all amounts present',()=>{
  const i=input({kind:'reconciliation',add_refs:['ordinary','premium'],subtract_refs:[],recorded_ref:'total',inventory_complete:true,inventory_basis:'two printed columns',disjoint_components:false,overlap_basis:'premium overlaps ordinary'},[operand('ordinary','8','decimal_quantity','hours'),operand('premium','2','decimal_quantity','hours'),operand('total','10','decimal_quantity','hours')]);
  expect(calculateDocumentReview(i)).toMatchObject({state:'blocked',expected:null,blockers:[{dependency_id:'inventory.disjoint',state:'conflict'}]});
 });
 it('blocks incomplete cash inventory without pretending a zero gap',()=>{
  const i=input({kind:'reconciliation',add_refs:['cash'],subtract_refs:[],recorded_ref:'total',inventory_complete:false,inventory_basis:'cropped source',disjoint_components:true,overlap_basis:'single visible row'},[operand('cash','100'),operand('total','100')]);
  expect(calculateDocumentReview(i)).toMatchObject({state:'blocked',difference:null});
 });
 it.each(['missing','unknown','conflict','unreadable','stale','expired'] as const)('preserves %s instead of treating it as zero',s=>{
  const i=product();i.operands[1].state=s;if(s==='missing')i.operands[1].printed_value=null;
  expect(calculateDocumentReview(i)).toMatchObject({state:'blocked',blockers:[{dependency_id:'hours',state:s}],expected:null});
 });
 it('blocks a ratio whose base or period is unidentified',()=>{
  const i=ratio();if(i.operation.kind==='observed_ratio')i.operation.same_period_and_base=false;expect(calculateDocumentReview(i).state).toBe('blocked');
 });
 it.each(['0.00','-1.00'])('refuses denominator %s',raw=>{const i=ratio();i.operands[1].printed_value=raw;expect(()=>calculateDocumentReview(i)).toThrow('DOCUMENT_REVIEW_RATIO_DENOMINATOR');});
});

describe('source identity, replay and per-check dependencies',()=>{
 function withDeclaredHours(){
  const i=product();i.source_manifest.push({document_id:'identified-answer',version_id:'answer.version.1',file_sha256:otherSha,page_count:1,kind:'customer_answer',case_id:i.case_id});
  i.operands[1]={...i.operands[1],state:'declared',observation_id:'answer.observation.hours',printed_value:'9.00',source:{...source,document_id:'identified-answer',version_id:'answer.version.1',file_sha256:otherSha,reading_receipt_sha256:otherSha,reading:'customer_declaration',locator:'authenticated answer; actual hours',label:'תשובת הלקוח'}};
  return i;
 }
 it('uses an identified declaration for arithmetic without turning it into a source reading',()=>{
  const original=product();const r=calculated(withDeclaredHours());expect(r.expected).toMatchObject({minor_units:27000});expect(r.input_basis).toBe('includes_customer_declaration');
  expect(r.legal_requirement_status).toBe('not_determined');expect(r.input.operands[1].state).toBe('declared');expect(r.remittance_status).toBe('missing');
  expect(original.operands[1].printed_value).toBe('8.50');expect(replayDocumentReviewCalculation(r)).toEqual(r);
 });
 it('rejects an answer from another case',()=>{
  const i=withDeclaredHours();i.source_manifest[1].case_id='foreign-case';expect(()=>calculateDocumentReview(i)).toThrow('DOCUMENT_REVIEW_FOREIGN_CASE');
 });
 it('rejects a declared numeric value relabelled as a document observation',()=>{
  const i=withDeclaredHours();i.operands[1].state='observed';expect(()=>calculateDocumentReview(i)).toThrow('DOCUMENT_REVIEW_DECLARATION_NOT_DOCUMENT');
 });
 it('rejects a declared value without an answer manifest and matching reading kind',()=>{
  const i=product();i.operands[1].state='declared';expect(()=>calculateDocumentReview(i)).toThrow('DOCUMENT_REVIEW_DECLARED_SOURCE');
  const j=withDeclaredHours();j.operands[1].source.reading='ai_document_review';expect(()=>calculateDocumentReview(j)).toThrow('DOCUMENT_REVIEW_DECLARED_SOURCE');
 });
 it('keeps unknown customer replies blocked rather than using an old numeric value',()=>{
  const i=withDeclaredHours();i.operands[1].state='unknown';i.operands[1].printed_value=null;
  expect(calculateDocumentReview(i)).toMatchObject({state:'blocked',input_basis:'includes_customer_declaration',expected:null,blockers:[{state:'unknown'}]});
 });
 it('uses the same fingerprint for retry/restart with a new run id/time',()=>{
  const a=product(),b=structuredClone(a);b.run_id='synthetic-run-2';b.evaluated_at='2026-09-11T12:30:00Z';
  expect(calculated(a).dependency_fingerprint).toBe(calculated(b).dependency_fingerprint);
 });
 it('changes dependency fingerprint for a changed answer, label or source version',()=>{
  const a=product();const original=calculated(a).dependency_fingerprint;
  const b=structuredClone(a);b.operands[1].printed_value='9.00';expect(calculated(b).dependency_fingerprint).not.toBe(original);
  const c=structuredClone(a);c.operands[0].source.label='changed source reading';expect(calculated(c).dependency_fingerprint).not.toBe(original);
  const d=structuredClone(a);d.source_manifest[0].version_id='source.synthetic.v2';d.operands.forEach(o=>o.source.version_id='source.synthetic.v2');expect(calculated(d).dependency_fingerprint).not.toBe(original);
 });
 it('does not invalidate an arithmetic dependency because a transfer status changes',()=>{
  const a=product(),b=structuredClone(a);b.remittance_status='confirmed';expect(calculated(a).dependency_fingerprint).toBe(calculated(b).dependency_fingerprint);
 });
 it('excludes unrelated same-case manifest documents from a check fingerprint',()=>{
  const a=product(),b=structuredClone(a);b.source_manifest.push({...b.source_manifest[0],document_id:'unrelated',version_id:'source.other.v1',file_sha256:otherSha});expect(calculated(a).dependency_fingerprint).toBe(calculated(b).dependency_fingerprint);
 });
 it.each(['case','hash','page'] as const)('rejects foreign/mismatched %s source',kind=>{
  const i=product();if(kind==='case')i.source_manifest[0].case_id='foreign-case';else if(kind==='hash')i.operands[0].source.file_sha256=otherSha;else i.operands[0].source.page=2;
  expect(()=>calculateDocumentReview(i)).toThrow(kind==='case'?'DOCUMENT_REVIEW_FOREIGN_CASE':'DOCUMENT_REVIEW_SOURCE_BINDING');
 });
 it('rejects a tampered receipt despite keeping its outer result hash',()=>{
  const r=structuredClone(calculated(product()));r.input.operands[0].source.label='forged';expect(()=>replayDocumentReviewCalculation(r)).toThrow('DOCUMENT_REVIEW_REPLAY_MISMATCH');
 });
 it('rejects unknown operand refs and duplicate operands',()=>{
  const i=product();i.operands[1].id='rate';expect(()=>calculateDocumentReview(i)).toThrow('DOCUMENT_REVIEW_DUPLICATE_OPERAND');
 });
 it('rejects malformed hours rather than lowering a confidence threshold',()=>{
  const i=product();i.operands[1]=operand('hours','8:79','hours_minutes','hours');expect(()=>calculateDocumentReview(i)).toThrow('DOCUMENT_REVIEW_HOURS_MINUTES');
 });
 it.each(['08:60','08:5','001:00','8.30'])('continues to reject malformed HH:MM %s',raw=>{
  const i=product();i.operands[1]=operand('hours',raw,'hours_minutes','hours');expect(()=>calculateDocumentReview(i)).toThrow('DOCUMENT_REVIEW_HOURS_MINUTES');
 });
});

describe('conditional existing RuleSpec execution, never REAL activation',()=>{
 it('executes a source-scoped candidate while deposit remains missing',()=>{
  const r=calculated(candidate());expect(r.expected).toMatchObject({minor_units:30000});expect(r.real_activation_allowed).toBe(false);expect(r.human_attestation).toBeNull();expect(r.claim).toBe('conditional_entitlement_candidate');
 });
 it.each(['unknown','conflict','stale','expired','missing'] as const)('preserves %s applicability',s=>{
  const i=candidate();if(i.operation.kind==='candidate_rule')i.operation.decisions[0].state=s;expect(calculateDocumentReview(i)).toMatchObject({state:'blocked',blockers:[{state:s}],expected:null});
 });
 it('blocks a declaration from being promoted into legal applicability',()=>{
  const i=candidate();if(i.operation.kind==='candidate_rule')i.operation.decisions[0].basis='customer_declaration';expect(calculateDocumentReview(i)).toMatchObject({state:'blocked',blockers:[{reason:'declaration_alone_is_not_rule_applicability'}]});
 });
 it('blocks absent source, absent decision and expiry independently',()=>{
  for(const what of ['source','decision','expiry']){const i=candidate();if(i.operation.kind!=='candidate_rule')throw Error('fixture');if(what==='source')i.operation.decisions[0].sources=[];else if(what==='decision')i.operation.decisions=[];else i.evaluated_at='2026-09-12T00:00:00Z';expect(calculateDocumentReview(i).state).toBe('blocked');}
 });
 it('changes fingerprint when natural expiry changes the applicability outcome',()=>{
  const i=candidate(),a=calculateDocumentReview(i);i.evaluated_at='2026-09-12T00:00:00Z';const b=calculateDocumentReview(i);expect(b.state).toBe('blocked');expect(a.dependency_fingerprint).not.toBe(b.dependency_fingerprint);
 });
 it('refuses modified rule bytes and missing rule source version',()=>{
  const i=candidate();if(i.operation.kind!=='candidate_rule')throw Error('fixture');i.operation.rule={...i.operation.rule,rule_spec_version:'2.0.0'};expect(()=>calculateDocumentReview(i)).toThrow('DOCUMENT_REVIEW_RULE_HASH');
  const j=candidate();j.source_manifest[0].version_id='other.version';j.operands.forEach(o=>o.source.version_id='other.version');if(j.operation.kind==='candidate_rule')j.operation.decisions[0].sources[0].version_id='other.version';expect(()=>calculateDocumentReview(j)).toThrow('DOCUMENT_REVIEW_RULE_SOURCE_VERSION');
 });
 it('does not apply an existing period-specific rule to a different month',()=>{
  const i=candidate();i.period={from:'2027-01-01',to:'2027-01-31'};expect(calculateDocumentReview(i)).toMatchObject({state:'blocked',blockers:[{dependency_id:'rule.period',state:'stale'}]});
 });
});
