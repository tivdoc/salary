import {describe,it,expect} from 'vitest';
import {buildSyntheticCaseFixture} from '../case-analysis/synthetic-fixtures.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {documentReviewInputSchema} from '../document-review/contracts.ts';
import {normalizeMoney} from './normalization.ts';
import {isExplicitMandatorySubtotalCandidate,deriveDeductionScope,createDeductionScopeDerivation,assertDeductionScopeDerivation} from './deduction-source-scope.ts';

function fixture(label='ניכויי חובה - מסים'){
 const f=buildSyntheticCaseFixture({fixture_id:'retained-deduction-scope',mode:'real'}),document=f.stored.documents[0],seed=structuredClone(f.stored.extractions[0]);
 const candidate={...structuredClone(seed.fields[0]),candidate_id:'00000000-0000-4000-8000-000000000090',field:'total_deductions' as const,
  raw_value:'120.00',normalized_value:normalizeMoney('120.00'),source:{document_id:document.document_id,page:1,text_fragment:`${label}: 120.00`}};
 const original={...seed,fields:[...seed.fields.filter(c=>c.field!=='total_deductions'),candidate]};
 const checkpoint_result={final_extraction:original,first_pass:{normalized_extraction:structuredClone(original)},synthetic_only:true};
 const input={document,original,checkpoint_result,checkpoint_result_sha256:canonicalSha256(checkpoint_result),reading_sha256:canonicalSha256(original)};
 return {candidate,original,document,input};
}

describe('retained mandatory-subtotal scope, separate from original provider observations',()=>{
 it.each(['ניכויי חובה','סה״כ ניכויי חובה','ניכויי חובה-מסים','ניכויי חובה - מסים','ניכויי חובה־מסים','ניכויי חובה – מסים','mandatory deductions'])(
  'recognizes only the bounded printed label: %s',label=>expect(isExplicitMandatorySubtotalCandidate(fixture(label).candidate)).toBe(true));
 it.each(['סך ניכויים','סה״כ ניכויים','total deductions','ניכויי חובה ורשות','ניכויי חובה וקופות גמל','מסים','ניכויי חובה משוערים'])(
  'does not exclude ambiguous or grand-total label: %s',label=>{
   const f=fixture(label),before=canonicalSha256(f.original),derived=deriveDeductionScope(f.original);
   expect(derived.derivation).toBeNull();expect(derived.extraction).toBe(f.original);expect(canonicalSha256(f.original)).toBe(before);
  });
 it('requires the exact printed raw value, not nearby label text or an arithmetic fit',()=>{
  const f=fixture();f.candidate.source.text_fragment='ניכויי חובה - מסים: 120.01';
  expect(isExplicitMandatorySubtotalCandidate(f.candidate)).toBe(false);
  f.candidate.source.text_fragment='ניכויי חובה - מסים';expect(isExplicitMandatorySubtotalCandidate(f.candidate)).toBe(false);
 });
 it('preserves all original bytes while removing only the scoped candidate from the effective grand total',()=>{
  const f=fixture(),grand={...structuredClone(f.candidate),candidate_id:'00000000-0000-4000-8000-000000000091',raw_value:'160.00',normalized_value:normalizeMoney('160.00'),source:{...f.candidate.source,text_fragment:'סך ניכויים: 160.00'}};
  f.original.fields.push(grand);const before=canonicalSha256(f.original),derived=deriveDeductionScope(f.original);
  expect(derived.extraction.fields.filter(c=>c.field==='total_deductions')).toEqual([grand]);
  expect(derived.derivation?.excluded_candidates).toEqual([{candidate_id:f.candidate.candidate_id,candidate_sha256:canonicalSha256(f.candidate),page:1,classification:'mandatory_deduction_subtotal'}]);
  expect(derived.derivation?.original_extraction_sha256).toBe(before);
  expect(derived.derivation?.effective_extraction_sha256).toBe(canonicalSha256(derived.extraction));
  expect(canonicalSha256(f.original)).toBe(before);
 });
 it('pins a independently rebuilt receipt to original checkpoint/source; altered result or candidate cannot reuse it',()=>{
  const f=fixture(),receipt=createDeductionScopeDerivation(f.input);
  expect(receipt?.provider_calls).toBe(0);expect(assertDeductionScopeDerivation(receipt,f.input)).toEqual(receipt);
  expect(()=>createDeductionScopeDerivation({...f.input,checkpoint_result_sha256:'a'.repeat(64)})).toThrow('DEDUCTION_SCOPE_CHECKPOINT_BINDING');
  expect(()=>createDeductionScopeDerivation({...f.input,original:{...f.original,extracted_at:'2026-07-05T00:00:00Z'}})).toThrow('DEDUCTION_SCOPE_CHECKPOINT_BINDING');
  expect(()=>assertDeductionScopeDerivation({...receipt,effective_extraction_sha256:'a'.repeat(64)},f.input)).toThrow('DEDUCTION_SCOPE_DERIVATION_BINDING');
  expect(()=>assertDeductionScopeDerivation({...receipt,source_sha256:'a'.repeat(64)},f.input)).toThrow('DEDUCTION_SCOPE_DERIVATION_BINDING');
  expect(()=>assertDeductionScopeDerivation({...receipt,case_id:'foreign-case'},f.input)).toThrow('DEDUCTION_SCOPE_DERIVATION_BINDING');
  expect(()=>createDeductionScopeDerivation({...f.input,document:{...f.document,document_id:'00000000-0000-4000-8000-000000000091'}})).toThrow('DEDUCTION_SCOPE_CHECKPOINT_BINDING');
 });
 it('refuses annotated machine input and does not let a numeric reading change the original scope decision',()=>{
  const f=fixture(),ids=deriveDeductionScope(f.original).derivation!.excluded_candidates.map(c=>c.candidate_id);
  // The ordinary reading adapter validates numeric receipts first, then uses
  // ORIGINAL candidate IDs. Corrected effective text/value cannot reclassify it.
  const effective={...f.original,fields:f.original.fields.map(c=>c.candidate_id===f.candidate.candidate_id?{...c,raw_value:'160.00',normalized_value:normalizeMoney('160.00')}:c)};
  expect(effective.fields.filter(c=>!ids.includes(c.candidate_id)).some(c=>c.candidate_id===f.candidate.candidate_id)).toBe(false);
  expect(()=>deriveDeductionScope({...f.original,customer_readings:[]})).toThrow('DEDUCTION_SCOPE_MACHINE_REQUIRED');
 });
 it('rejects foreign candidate source and duplicate identity before deriving',()=>{
  const f=fixture();f.candidate.source.document_id='00000000-0000-4000-8000-000000000091';
  expect(()=>deriveDeductionScope(f.original)).toThrow('DEDUCTION_SCOPE_SOURCE_BINDING');
  f.candidate.source.document_id=f.document.document_id;f.original.fields.push(f.candidate);
  expect(()=>deriveDeductionScope(f.original)).toThrow('DEDUCTION_SCOPE_SOURCE_BINDING');
 });
 it('captures a scoped receipt in the ordinary review input, omits it historically and rejects foreign/duplicate/out-of-page pins',()=>{
  const f=fixture(),receipt=createDeductionScopeDerivation(f.input)!,period={from:'2026-06-01',to:'2026-06-30'};
  const base={schema_version:'document-review-product-v1',case_id:f.document.case_id,period,
   purchased_scope:{order_id:'synthetic-order',receipt_sha256:'a'.repeat(64),topics:['minimum_wage'],origin:'saved_order'},
   coverage_policy:'document-review-coverage-v1',documents:[{case_id:f.document.case_id,document_id:f.document.document_id,version_id:f.document.document_id,
    file_sha256:f.document.content_sha256,page_count:1,kind:'payslip',label:'Synthetic source',period,reading_origin:'provider_extraction',reading_sha256:f.input.reading_sha256}],
   checks:[],completion_input:null};
  expect(documentReviewInputSchema.parse(base)).not.toHaveProperty('source_semantic_derivations');
  expect(documentReviewInputSchema.parse({...base,source_semantic_derivations:[receipt]}).source_semantic_derivations).toEqual([receipt]);
  for(const altered of [{...receipt,case_id:'foreign-case'},{...receipt,reading_sha256:'b'.repeat(64)},
   {...receipt,source_sha256:'b'.repeat(64)},{...receipt,excluded_candidates:receipt.excluded_candidates.map(c=>({...c,page:2}))}])
   expect(documentReviewInputSchema.safeParse({...base,source_semantic_derivations:[altered]}).success).toBe(false);
  expect(documentReviewInputSchema.safeParse({...base,source_semantic_derivations:[receipt,receipt]}).success).toBe(false);
 });
});
