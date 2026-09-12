import {expect,it} from 'vitest';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentSourceStructureTarget} from './document-source-structure';
import {documentFieldVerificationDisplay} from './reading-verification';

it('projects a period target using pinned refs, without exposing target hashes or proposing new numbers',()=>{
 const fixture=buildSyntheticCaseFixture({fixture_id:'synthetic-period-display',mode:'real'}),document=fixture.stored.documents[0];
 const extraction=normalizedPayslipExtractionSchema.parse(fixture.stored.extractions[0]),field=extraction.fields.find(f=>f.field==='gross_salary');
 if(!field)throw Error('TEST_GROSS_FIELD_REQUIRED');
 const result={final_extraction:extraction,first_pass:{normalized_extraction:extraction}},checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:document.case_id,
  product_document_id:'88888888-8888-4888-8888-888888888888',version_id:document.document_id,input_sha256:document.content_sha256,
  expected_month:'2025-01',period_mismatch:false,result_sha256:canonicalSha256(result),run:{result}};
 const target=documentSourceStructureTarget({checkpoint,policyVersion:'synthetic-period-display-v1',selector:{kind:'period_association',refs:[{kind:'field',id:field.candidate_id}]}});
 const before=canonicalSha256(target),display=documentFieldVerificationDisplay(target);
 expect(display).toMatchObject({field:'source_structure.period_association',raw_value:null,actions:['correct','unreadable','unknown'],scope:'source_structure_reading_only',
  structure_context:{kind:'period_association',month:'2025-01',refs:[{raw_value:field.raw_value,page:field.source.page}],proposed_value:null}});
 if(!('structure_context' in display))throw Error('TEST_STRUCTURE_DISPLAY_REQUIRED');
 const wire=JSON.stringify(display.structure_context);expect(wire).not.toContain('sha256');expect(wire).not.toContain(field.candidate_id);expect(wire).not.toContain('confidence');
 expect(display.source.page).toBe(field.source.page);expect(canonicalSha256(target)).toBe(before);
});
