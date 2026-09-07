import {describe,it,expect,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
vi.mock('server-only',()=>({}));
import {inspectExtractionBytes,loadVerifiedUpload} from './verified-upload-source';
import {criticalFieldThresholds,assessExtractionConfidence} from '@/engine/extraction/confidence-policy';
import {syntheticPayslipFixtures} from '@/engine/extraction/fixtures/source-fixtures';
import {normalizePayslipExtraction} from '@/engine/extraction/normalization';
import {validatePayslipGate0} from '@/engine/extraction/validation';
async function pdf(pages=1){const doc=await PDFDocument.create();for(let i=0;i<pages;i++)doc.addPage();return doc.save();}
describe('P03 verified saved document boundary',()=>{
 it('accepts a real multipage PDF and rejects oversized page count/corruption',async()=>{
  expect((await inspectExtractionBytes(await pdf(2),'application/pdf')).pages).toBe(2);
  await expect(inspectExtractionBytes(await pdf(13),'application/pdf')).rejects.toThrow('document_limit');
  await expect(inspectExtractionBytes(new Uint8Array([1,2]),'application/pdf')).rejects.toThrow('invalid_document');
 });
 it('binds actual bytes to case and version and refuses mutation and foreign scope',async()=>{
  const bytes=await pdf(),caseId=randomUUID(),versionId=randomUUID();
  const row={id:randomUUID(),case_id:caseId,version_id:versionId,document_type:'payslip',storage_path:`cases/${caseId}/versions/${versionId}.pdf`,original_filename:'synthetic.pdf',mime_type:'application/pdf',size:String(bytes.length),content_sha256:createHash('sha256').update(bytes).digest('hex'),created_at:new Date().toISOString()};
  const query=vi.fn(async()=>({rows:[row]})),download=vi.fn(async()=>({data:new Blob([Buffer.from(bytes)]),error:null}));
  const loaded=await loadVerifiedUpload(caseId,versionId,{query},{download});
  expect(await loaded.source.read(loaded.document)).toEqual(bytes);
  expect(query.mock.calls[0]).toEqual(['select id,case_id,version_id,document_type,storage_path,original_filename,mime_type,size,content_sha256,period_month,created_at from public.documents where case_id=$1 and version_id=$2',[caseId,versionId]]);
  await expect(loaded.source.read({...loaded.document,case_id:randomUUID()})).rejects.toThrow('source_scope');
  download.mockResolvedValueOnce({data:new Blob(['corrupted']),error:null});await expect(loaded.source.read(loaded.document)).rejects.toThrow('source_changed');
  await expect(loadVerifiedUpload(randomUUID(),versionId,{query},{download})).rejects.toThrow('source_scope');
 });
 it('does not promote uncalibrated 0.94 confidence by changing its value',()=>{
  expect(Object.values(criticalFieldThresholds).every(v=>v===0.95)).toBe(true);
  const fixture=syntheticPayslipFixtures.find(f=>f.fixture_id==='clean_monthly')!;
  const normalized=normalizePayslipExtraction({...fixture.extraction,fields:fixture.extraction.fields.map(f=>({...f,confidence:0.94}))});
  const assessment=assessExtractionConfidence(normalized,validatePayslipGate0(normalized));
  expect(assessment.decisions.filter(d=>d.applicable).every(d=>d.status==='needs_confirmation')).toBe(true);
 });
 it.each([100,101])('enforces an absolute one-shekel arithmetic tolerance: %i agorot',delta=>{
  const fixture=syntheticPayslipFixtures.find(f=>f.fixture_id==='clean_monthly')!;
  const template=fixture.extraction.fields[0];
  const normalized=normalizePayslipExtraction({...fixture.extraction,earnings_components_complete:false,fields:[
   {...template,candidate_id:randomUUID(),field:'gross_salary',raw_value:'8500.00'},
   {...template,candidate_id:randomUUID(),field:'total_deductions',raw_value:'1500.00'},
   {...template,candidate_id:randomUUID(),field:'net_salary',raw_value:((700000+delta)/100).toFixed(2)},
  ]});
  expect(validatePayslipGate0(normalized).issues.some(i=>i.code==='payslip_totals_mismatch')).toBe(delta>100);
 });
});
