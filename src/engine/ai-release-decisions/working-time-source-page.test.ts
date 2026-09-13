import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {AI_RELEASE_DECISION_RECIPES} from './catalog.ts';
import {aiReleaseDecisionInputSchema} from './contracts.ts';
import {entitlementLegalDocuments,isPinnedEntitlementLegalDocument} from '../entitlement-review/legal-documents.ts';
import {WORKING_TIME_PROTECTED_BREAK_POLICY,WORKING_TIME_PROTECTED_BREAK_AMENDMENT,WORKING_TIME_PROTECTED_BREAK_SOURCE_REVIEW_SHA256} from '../entitlement-review/working-time/protected-breaks.ts';

// Captured from the unmodified e6fe213 catalog before the locator correction.
const historical={
 'ai-method.wt.rounding':'106b64567b06f4f80d5997611e3e51b2a7f0dc9d8c788ad76ac6f8b09c220251',
 'ai-method.wt.weekly_aggregation':'80ec0265aa85e07fe4e88471671663ba7b872bcae078832e886153d06bba19f1',
 'ai-method.wt.rest_additive':'389a3e059c450a8955b6544c52e4b2ab0b8126b2cb0f9ff4ac8a0701de737d5f',
 'ai-case.wt.regular_wage':'0a824928b35ce18c8e37b8322221477fd698523c7e56657fa88646dbf02a0f08',
 'ai-case.wt.payroll_allocation':'6264217d622637c043a84bcddc8970cf4b5af9cb6f1eb0ebd903ac2ef86ccbf5',
};
describe('original hours-law source page correction without historical rewrites',()=>{
 it('admits the new legal document only for the explicit working-time or rest policy and preserves the64-method limit',()=>{
  const id='11111111-1111-4111-8111-111111111111',plain=entitlementLegalDocuments(id,['working_time']);
  expect(plain.some(d=>d.version_id===WORKING_TIME_PROTECTED_BREAK_AMENDMENT.version_id)).toBe(false);
  expect(entitlementLegalDocuments(id,['working_time'],{})).toEqual(plain);
  const selected=entitlementLegalDocuments(id,['working_time'],{working_time_policy:WORKING_TIME_PROTECTED_BREAK_POLICY});
  expect(selected.filter(d=>d.version_id!==WORKING_TIME_PROTECTED_BREAK_AMENDMENT.version_id)).toEqual(plain);
  const amendment=selected.find(d=>d.version_id===WORKING_TIME_PROTECTED_BREAK_AMENDMENT.version_id)!;
  expect(isPinnedEntitlementLegalDocument(amendment,id)).toBe(true);expect(isPinnedEntitlementLegalDocument({...amendment,file_sha256:'f'.repeat(64)},id)).toBe(false);
  expect(entitlementLegalDocuments(id,['travel'],{working_time_policy:WORKING_TIME_PROTECTED_BREAK_POLICY}).some(d=>d.version_id===amendment.version_id)).toBe(false);
  expect(entitlementLegalDocuments(id,['rest_day'],{working_time_policy:WORKING_TIME_PROTECTED_BREAK_POLICY}).some(d=>d.version_id===amendment.version_id)).toBe(true);
  const r=AI_RELEASE_DECISION_RECIPES[0],m={recipe_id:r.recipe_id,recipe_version:r.recipe_version,recipe_sha256:r.recipe_sha256,source_policy_sha256:r.source_policy_sha256,
   interpretation_receipt_sha256:'a'.repeat(64),source_receipts:r.legal_sources.map(s=>({receipt_sha256:'b'.repeat(64),source_version_id:s.version_id,artifact_sha256:s.file_sha256})),issued_at:'2026-09-12T00:00:00Z',expires_at:'2026-09-13T00:00:00Z'};
  expect(aiReleaseDecisionInputSchema.shape.methods.safeParse(Array.from({length:64},()=>m)).success).toBe(true);
  expect(aiReleaseDecisionInputSchema.shape.methods.safeParse(Array.from({length:65},()=>m)).success).toBe(false);
 });
 it.each(['worked_time','arrangement','payroll_allocation'])('binds the %s protected-break descendant to the actual amendment and an unchanged parent',id=>{
  const base='ai-case.wt.'+id,parentId=base+(id==='payroll_allocation'?'.source-page-v2':'');
  const parent=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id===parentId)!,next=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id===base+'.protected-breaks-v1')!;
  expect(next).toMatchObject({decision_id:parent.decision_id,parent_recipe_sha256:parent.recipe_sha256,protected_break_policy:WORKING_TIME_PROTECTED_BREAK_POLICY,source_policy_sha256:WORKING_TIME_PROTECTED_BREAK_SOURCE_REVIEW_SHA256});
  expect(next.consumed_paths).toEqual([...parent.consumed_paths,'protected_break_policy']);expect(next.legal_sources.slice(0,-1)).toEqual(parent.legal_sources);
  expect(next.legal_sources.at(-1)).toMatchObject({version_id:WORKING_TIME_PROTECTED_BREAK_AMENDMENT.version_id,file_sha256:WORKING_TIME_PROTECTED_BREAK_AMENDMENT.file_sha256,page:1,reading_receipt_sha256:WORKING_TIME_PROTECTED_BREAK_SOURCE_REVIEW_SHA256});
  if(id==='payroll_allocation')expect(next.legal_sources[0].page).toBe(4);
 });
 it.each(['general_section3','seniority_basis','annual_workdays','pay_calendar_days','pay_quarter_selection','pay_monthly_period','pay_recorded_allocation','general_section3.age-range-v1'])('pins vacation %s to operative pages while preserving its exact parent',id=>{
  const parent=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id==='ai-case.vacation.'+id)!;
  const next=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id===parent.recipe_id+'.source-page-v2')!;
  expect(next).toMatchObject({parent_recipe_sha256:parent.recipe_sha256,decision_id:parent.decision_id,method:parent.method,
   consumed_paths:parent.consumed_paths,source_policy_sha256:parent.source_policy_sha256});
  expect(parent.legal_sources.find(s=>s.document_id==='il.annual-vacation.amendment15')?.page).toBe(1);
  expect(next.legal_sources).toEqual(parent.legal_sources.map(s=>s.document_id==='il.annual-vacation.amendment15'||id==='pay_recorded_allocation'&&s.document_id==='il.annual-vacation.law'?{...s,page:2}:s));
  if(id.endsWith('.age-range-v1'))expect(next).toHaveProperty('age_range_policy','questionnaire-age-range-reuse-v1');
  else expect('age_range_policy'in next).toBe(false);
  const {recipe_sha256,...body}=next;expect(canonicalSha256(body)).toBe(recipe_sha256);expect(recipe_sha256).not.toBe(parent.recipe_sha256);
 });
 it.each(['fare_basis','ticket_options'])('corrects the historical travel %s locator without changing the existing floor method',id=>{
  const parent=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id==='ai-case.travel.'+id)!;
  const next=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id===parent.recipe_id+'.source-page-v2')!;
  const floor=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id===parent.recipe_id+'.floor-v2')!;
  expect(parent.legal_sources[0].page).toBe(2);expect(next.legal_sources).toEqual(parent.legal_sources.map(s=>({...s,page:1})));
  expect(next).toMatchObject({parent_recipe_sha256:parent.recipe_sha256,decision_id:parent.decision_id,method:parent.method,consumed_paths:parent.consumed_paths});
  expect(floor.legal_sources[0].page).toBe(1);expect('source_locator_policy'in floor).toBe(false);
 });
 it('also preserves the convalescence due-date parent while correcting section5(d)',()=>{
  const parent=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id==='ai-case.cv.due_date')!;
  const next=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id==='ai-case.cv.due_date.source-provision-v2')!;
  expect(parent.recipe_sha256).toBe('78691e92e9919014817591fa4f2418d1d1534e87efd9d92bf26822088731be71');
  expect(next).toMatchObject({parent_recipe_sha256:parent.recipe_sha256,decision_id:parent.decision_id,method:parent.method});
  expect(next.legal_sources[0]).toEqual({...parent.legal_sources[0],locator:'סעיף 5(ד) — מועד מפורש ומזוהה; אין בחירת חודש אוטומטית בטווח הקיץ'});
 });
 it.each(Object.entries(historical))('preserves %s and explicitly pins its descendant to PDF page4', (id,hash)=>{
  const parent=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id===id)!;
  const next=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id===id+'.source-page-v2')!;
  expect(parent.recipe_sha256).toBe(hash);
  expect(next).toMatchObject({parent_recipe_sha256:hash,decision_id:parent.decision_id,method:parent.method,
   consumed_paths:parent.consumed_paths,source_policy_sha256:parent.source_policy_sha256});
  expect(next.recipe_sha256).not.toBe(hash);
  const {recipe_sha256,...body}=next;expect(canonicalSha256(body)).toBe(recipe_sha256);
  const law=parent.legal_sources[0];expect(law.page).toBe(3);
  expect(next.legal_sources[0]).toEqual({...law,page:4});
  expect(next.legal_sources.slice(1)).toEqual(parent.legal_sources.slice(1));
 });
});
