import {describe,it,expect} from 'vitest';
import {createRuleSpecPackage,executeRuleSpecAtomic,type RuleSpecPackage} from '../legal-operations/rulespec';
import {PENSION_CONTRIBUTION_SHADOW_SPEC,PENSION_EMPLOYER_CONTRIBUTION_SHADOW_SPEC,PENSION_SEVERANCE_CONTRIBUTION_SHADOW_SPEC} from '../shadow/draft-shadow-specs';
import {researchedPensionCap} from './release-pension-cap';

function calculate(rule:RuleSpecPackage,month:string,wage:number,share:string,n:number,d:number){
 const cap=researchedPensionCap(month);if(!cap)return null;
 const {content_sha256:oldHash,...draft}=rule;void oldHash;
 const scoped=createRuleSpecPackage({...draft,rule_spec_id:draft.rule_spec_id+'.ai_research',rule_spec_version:'1.0.0',
  effective_period:{from:cap.valid_from,to:cap.valid_to},
  parameters:draft.parameters.map(p=>p.ref_id==='parameter.wage.cap'?{...p,parameter_version:cap.parameter_version}:p)});
 expect(scoped.catalog_boundary).toBe('real_inactive');
 return executeRuleSpecAtomic({rule:scoped,facts:[{ref_id:'fact.pensionable.wage',value:{kind:'money',currency:'ILS',minor_units:wage}}],parameters:[{ref_id:'parameter.wage.cap',value:cap.value},{ref_id:share,value:{kind:'rational',numerator:String(n),denominator:String(d),unit:'ratio'}}]}).execution?.output;
}
describe('AI research pension cap: dated general-order base, not employer debt or activation',()=>{
 it.each(['2024-12','2027-01','2025-13','2025-00','unknown'])('does not invent a parameter for %s',month=>expect(researchedPensionCap(month)).toBeNull());
 it('keeps 2025/2026 distinct and carries no human attestation or activation',()=>{
  expect(researchedPensionCap('2025-12')).toMatchObject({value:{minor_units:1331600},valid_to:'2025-12-31',author_kind:'ai',activation_allowed:false,human_attestation:null});
  expect(researchedPensionCap('2026-01')).toMatchObject({value:{minor_units:1376900},valid_from:'2026-01-01'});
 });
 it.each([
  [PENSION_CONTRIBUTION_SHADOW_SPEC,'parameter.employee.share',6,100,79896],
  [PENSION_EMPLOYER_CONTRIBUTION_SHADOW_SPEC,'parameter.employer.share',65,1000,86554],
  [PENSION_SEVERANCE_CONTRIBUTION_SHADOW_SPEC,'parameter.severance.share',6,100,79896],
 ] as const)('caps an above-cap wage and keeps contribution %# separate', (rule,share,n,d,expected)=>{
  const out=calculate(rule,'2025-08',2000000,share,n,d);expect(out).toMatchObject({kind:'money',minor_units:expected});
 });
 it('uses actual wage between the frozen collection value and the pension cap',()=>{
  expect(calculate(PENSION_EMPLOYER_CONTRIBUTION_SHADOW_SPEC,'2025-08',1300000,'parameter.employer.share',65,1000)).toMatchObject({minor_units:84500});
 });
});
