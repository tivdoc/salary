import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {createRuleSpecPackage} from '../../legal-operations/rulespec.ts';
import {calculateDocumentReview,replayDocumentReviewCalculation,documentReviewCalculationInputSchema,type DocumentReviewOperand} from '../../document-review/calculations.ts';
import {obligationTextSha256,obligationsEntitlementInputSchema,resolveExplicitObligations,OBLIGATION_ASSESSMENTS,type ObligationsEntitlementInput} from './index.ts';
const sha='d'.repeat(64),source={document_id:'synthetic-agreement',version_id:'synthetic-agreement.v1',file_sha256:sha,page:1,locator:'Synthetic promise clause 1',label:'Synthetic explicit agreement; not a real customer',reading:'ai_document_review' as const,reading_receipt_sha256:sha};
function input():ObligationsEntitlementInput{
 const text='Synthetic example only: a 500.00 ILS bonus is payable for June 2026 if the specified project is completed.';
 const amount:DocumentReviewOperand={id:'promise',observation_id:'synthetic.promise',state:'observed',printed_value:'500.00',representation:'money_ils',quantity_unit:null,precision:'printed_precision',source};
 const recorded={...amount,id:'paid',observation_id:'synthetic.payment',printed_value:'450.00',source:{...source,locator:'Synthetic payment record row 1'}};
 return obligationsEntitlementInputSchema.parse({schema_version:'obligations-entitlement-input-v1',catalog_id:'il.review.explicit_obligations.2026',catalog_version:'1.0.0',case_id:'synthetic-case',run_id:'synthetic-run',check_prefix:'synthetic.obligation',period:{from:'2026-06-01',to:'2026-06-30'},evaluated_at:'2026-09-12T00:00:00Z',purchased_topics:['contract','bonuses'],source_manifest:[{document_id:source.document_id,version_id:source.version_id,file_sha256:sha,page_count:1,kind:'case_document',case_id:'synthetic-case'}],
  obligations:[{obligation_id:'project.payment',topic:'bonuses',title:'תגמול סינתטי עבור השלמת פרויקט',clause:{source,text,text_sha256:obligationTextSha256(text),effective_period:{from:'2026-01-01',to:'2026-12-31'}},payment_period:{from:'2026-06-01',to:'2026-06-30'},promise:{kind:'fixed',amount},conditions_mode:'all',conditions:[{condition_id:'project.completed',description:'האם הפרויקט הסינתטי שנקבע בסעיף הושלם בתקופה?',fact:{state:'known',value:true,source:{...source,locator:'Synthetic project completion record'},basis:'identified_document_reading'}}],assessments:Object.keys(OBLIGATION_ASSESSMENTS).map(decision_id=>({decision_id,state:'accepted',basis:'ai_source_assessment',explanation:'Explicit synthetic assessment only; no human approval',sources:[source],valid_until:null})),scenario:'established_only',recorded:{payment_id:'project.payment.recorded',amount:recorded,payment_period:{from:'2026-06-01',to:'2026-06-30'},scope_assessment:{decision_id:'obligation.recorded_scope',state:'accepted',basis:'ai_source_assessment',explanation:'Synthetic payment record explicitly names this obligation and period',sources:[source,recorded.source],valid_until:null}}}]});
}
const results=(i:ObligationsEntitlementInput)=>resolveExplicitObligations(i).checks.map(c=>calculateDocumentReview(c.calculation));
describe('explicit contract and bonus obligations through the versioned normal RuleSpec engine',()=>{
 it('computes a sourced fixed bonus and signed comparison, preserving the original clause',()=>{
  const i=input(),original=canonicalSha256(i),r=results(i);expect(r).toHaveLength(2);expect(r[0]).toMatchObject({state:'calculated',expected:{minor_units:50000},claim:'conditional_entitlement_candidate'});expect(r[1]).toMatchObject({recorded:{minor_units:45000},difference:{minor_units:5000}});expect(canonicalSha256(i)).toBe(original);
  for(const c of r){expect(c.input.operation).toHaveProperty('rule.topic','bonuses');expect(c.input.operation).toHaveProperty('rule.schema_version','tivdoc-rulespec-v0.6.1');expect(replayDocumentReviewCalculation(c)).toEqual(c);}
 });
 it('keeps the historical RuleSpec version closed to newly added topics',()=>{
  const r=results(input())[0];if(r.input.operation.kind!=='candidate_rule')throw Error('synthetic candidate');const {content_sha256,...draft}=r.input.operation.rule;expect(content_sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(()=>createRuleSpecPackage({...draft,schema_version:'tivdoc-rulespec-v0.6.0'})).toThrow('RULESPEC_TOPIC_REQUIRES_V061');
 });
 it.each([['500.00',0],['550.00',-5000]] as const)('keeps recorded %s as a signed comparison, not an automatic debt',(paid,difference)=>{
  const i=input();i.obligations[0].recorded!.amount.printed_value=paid;expect(results(i)[1].difference).toMatchObject({minor_units:difference});expect(resolveExplicitObligations(i).rule_metadata.agreement_binding_from_ocr).toBe(false);
 });
 it('uses an explicit linear rate and exact source quantity under the contract topic',()=>{
  const i=input(),o=i.obligations[0];o.topic='contract';if(o.promise.kind!=='fixed')throw Error('synthetic fixed');
  const rate={...o.promise.amount!,printed_value:'12.50'},quantity={...rate,id:'units',observation_id:'synthetic.units',printed_value:'8',representation:'integer' as const,quantity_unit:'count' as const,source:{...source,locator:'Synthetic accepted delivery count'}};
  o.promise={kind:'linear',rate,quantity,quantity_unit:'count'};o.recorded=null;const r=results(i)[0];expect(r).toMatchObject({state:'calculated',expected:{minor_units:10000}});expect(r.input.operation).toHaveProperty('rule.topic','contract');expect(r.input.operands.find(a=>a.id==='quantity')?.representation).toBe('integer');
 });
 it('retains exact HH:MM in a linear source formula without rounding the hours',()=>{
  const i=input(),o=i.obligations[0];if(o.promise.kind!=='fixed')throw Error('synthetic fixed');const rate={...o.promise.amount!,printed_value:'30.00'};
  o.promise={kind:'linear',rate,quantity:{...rate,id:'hours',observation_id:'synthetic.hours',printed_value:'08:05',representation:'hours_minutes',quantity_unit:'hours',source:{...source,locator:'Synthetic time record'}},quantity_unit:'hours'};
  const r=results(i)[0];expect(r.expected).toMatchObject({minor_units:24250});expect(r.input.operands.find(a=>a.id==='quantity')?.printed_value).toBe('08:05');
 });
 it('does not treat OCR, a missing binding assessment, or a declaration as agreement authority',()=>{
  const i=input();i.obligations[0].assessments=[];expect(results(i).every(r=>r.state==='blocked')).toBe(true);
  const j=input();j.obligations[0].assessments[0].basis='customer_declaration';expect(results(j).every(r=>r.state==='blocked')).toBe(true);
 });
 it.each(['missing','unknown','conflict','unreadable','stale','expired'] as const)('preserves %s fulfillment as an unresolved ordinary obligation',state=>{
  const i=input(),f=i.obligations[0].conditions[0].fact;f.state=state;f.value=null;const review=resolveExplicitObligations(i);
  expect(results(i).every(r=>r.state==='blocked')).toBe(true);expect(review.gaps).toEqual(expect.arrayContaining([expect.objectContaining({dependency_id:'condition.project.completed',state})]));
 });
 it('permits only an explicitly labeled unknown-condition scenario, retaining the unresolved fact',()=>{
  const i=input(),o=i.obligations[0];o.conditions[0].fact.state='unknown';o.conditions[0].fact.value=null;o.scenario='if_conditions_fulfilled';const r=results(i)[0];expect(r).toMatchObject({state:'calculated',counterfactual_only:true,expected:{minor_units:50000},unresolved_conditions:[{decision:{state:'unknown'}}]});
  expect(o.conditions[0].fact).toMatchObject({state:'unknown',value:null});o.conditions[0].fact.state='conflict';expect(results(i)[0].state).toBe('blocked');
 });
 it('reports a known unfulfilled necessary condition without inventing a zero money cell or asking irrelevant amounts',()=>{
  const i=input(),o=i.obligations[0];o.conditions[0].fact.value=false;if(o.promise.kind==='fixed')o.promise.amount=null;o.scenario='if_conditions_fulfilled';
  const r=resolveExplicitObligations(i);expect(r.checks).toEqual([]);expect(r.outcomes).toMatchObject([{state:'not_triggered',consumed_condition_ids:['project.completed']}]);expect(r.gaps).toEqual([]);
 });
 it('keeps missing recorded payment independent of the expected amount and blocks unresolved matching',()=>{
  const i=input();i.obligations[0].recorded=null;expect(results(i)).toHaveLength(1);expect(results(i)[0].state).toBe('calculated');
  const j=input();j.obligations[0].recorded!.scope_assessment.state='unknown';expect(results(j)[0].state).toBe('calculated');expect(results(j)[1].state).toBe('blocked');
 });
 it('does not double-count a promise just because it is placed under both purchased topics',()=>{
  const i=input(),copy=structuredClone(i.obligations[0]);copy.topic='contract';copy.obligation_id='contract.copy';i.obligations.push(copy);
  const r=resolveExplicitObligations(i);expect(r.checks).toHaveLength(0);expect(r.outcomes.every(o=>o.state==='duplicate')).toBe(true);
 });
 it('blocks reuse of the same payment cell across genuinely distinct source promises, while retaining both expected amounts',()=>{
  const i=input(),copy=structuredClone(i.obligations[0]);copy.obligation_id='second.promise';copy.topic='contract';copy.clause.source={...source,locator:'Synthetic promise clause 2'};copy.clause.text='Synthetic independent second promise 500.00 ILS.';copy.clause.text_sha256=obligationTextSha256(copy.clause.text);
  if(copy.promise.kind==='fixed')copy.promise.amount!.source=copy.clause.source;copy.assessments=copy.assessments.map(d=>({...d,sources:[copy.clause.source]}));copy.recorded!.scope_assessment.sources=[copy.clause.source,copy.recorded!.amount.source];i.obligations.push(copy);
  const r=resolveExplicitObligations(i);expect(r.checks).toHaveLength(2);expect(r.checks.every(c=>c.check_id.endsWith('.expected'))).toBe(true);expect(r.gaps.filter(g=>g.dependency_id==='obligation.payment_duplicate')).toHaveLength(2);
 });
 it('excludes an unpurchased topic and refuses a payment or clause from another period',()=>{
  const i=input();i.purchased_topics=['contract'];expect(resolveExplicitObligations(i).checks).toEqual([]);
  const j=input();j.obligations[0].payment_period={from:'2026-05-01',to:'2026-05-31'};expect(resolveExplicitObligations(j).checks).toEqual([]);
  const k=input();k.obligations[0].recorded!.payment_period={from:'2026-05-01',to:'2026-05-31'};expect(resolveExplicitObligations(k).checks).toHaveLength(1);
 });
 it('rejects changed clause text bytes, foreign sources, stale assessments and unbound amount sources',()=>{
  const i=input();i.obligations[0].clause.text+=' changed';expect(()=>resolveExplicitObligations(i)).toThrow('OBLIGATION_CLAUSE_TEXT_HASH');
  const j=input();j.source_manifest[0].case_id='foreign';expect(()=>resolveExplicitObligations(j)).toThrow('OBLIGATION_CASE_SOURCE_BINDING');
  const k=input();k.obligations[0].assessments[0].valid_until='2026-09-01T00:00:00Z';expect(results(k).every(r=>r.state==='blocked')).toBe(true);
  const l=input();if(l.obligations[0].promise.kind==='fixed')l.obligations[0].promise.amount!.source={...source,page:2};l.source_manifest[0].page_count=2;expect(()=>resolveExplicitObligations(l)).toThrow('OBLIGATION_PROMISE_CLAUSE_BINDING');
 });
 it('pins every consumed condition and source in the same check without using the run as a rule identity',()=>{
  const i=input(),a=results(i)[0],op=documentReviewCalculationInputSchema.parse(a.input).operation;if(op.kind!=='candidate_rule')throw Error('synthetic candidate');
  expect(JSON.parse(op.decisions.find(d=>d.decision_id==='obligation.source_scope')!.explanation)).toMatchObject({clause_text_sha256:i.obligations[0].clause.text_sha256,legal_applicability_approved:false});expect(op.decisions.find(d=>d.decision_id==='condition.project.completed')?.sources).toContainEqual(i.obligations[0].conditions[0].fact.source);
  i.run_id='synthetic-next-run';const b=results(i)[0];expect(b.dependency_fingerprint).toBe(a.dependency_fingerprint);
 });
});
