import {describe,it,expect} from 'vitest';
import {writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {reportDocumentSchema,AI_REPORT_DISCLOSURE} from './report-document';import {PDFDocument} from 'pdf-lib';
import {inquiryText} from './report-inquiry';import {savedReportPdf} from './report-artifacts';
import {S04_HIGH_CERTAINTY,S05_LOW_CERTAINTY_DIRECTION,S04_HIGH_CERTAINTY_FINDING,S06_REFUSED_FOR_APPLICABILITY} from './case-report-projection.fixtures';
describe('saved report artifacts',()=>{
 it('copy never smuggles a figure forbidden by display or supplies a finding for an unchecked topic',()=>{
  const low={...S05_LOW_CERTAINTY_DIRECTION,amount:{currency:'ILS' as const,minor_units:987654}};
  expect(inquiryText(low,'initial','2026-06')).not.toContain('9876');
  if(S04_HIGH_CERTAINTY_FINDING.gate!=='checked')throw new Error('fixture');
  expect(inquiryText({...S04_HIGH_CERTAINTY_FINDING,basis_complete:false},'initial','2026-06')).not.toContain('412.50');
  expect(inquiryText(S06_REFUSED_FOR_APPLICABILITY,'initial','2026-06')).toBe('');
  expect(inquiryText(S04_HIGH_CERTAINTY_FINDING,'initial','2026-06')).toContain('412.50');
 });
 it('renders deterministic parseable Hebrew PDF from the supplied saved projection',async()=>{
  const report={id:'synthetic-report',projection:S04_HIGH_CERTAINTY,document:null,sha256:'a'.repeat(64),publishedAt:'2026-09-07T06:00:00Z'};
  const first=savedReportPdf(report),second=savedReportPdf(report);
  if(process.env.TIVDOC_REPORT_PDF_PROOF)writeFileSync(process.env.TIVDOC_REPORT_PDF_PROOF,first);
  expect(createHash('sha256').update(first).digest('hex')).toBe(createHash('sha256').update(second).digest('hex'));
  expect((await PDFDocument.load(first)).getPageCount()).toBeGreaterThan(0);
  expect(Buffer.from(first).toString('latin1')).toContain('/ActualText');
 });
});

it('the saved AI PDF carries the same readable service disclosure as its envelope',async()=>{
 const projection={...S04_HIGH_CERTAINTY,report_kind:'full' as const},id=randomUUID(),evidenceId=randomUUID();
 const document=reportDocumentSchema.parse({schema_version:'tivdoc-report-document-v3',service_kind:'ai_assisted',publication_policy:'tivdoc-ai-publication-v1',order_offer_sha256:'c'.repeat(64),id,case_id:randomUUID(),order_id:randomUUID(),revision:1,input_sha256:'a'.repeat(64),projection_sha256:canonicalSha256(projection),purchased_period:{from:'2026-06',to:'2026-06'},projection,evidence:[{id:evidenceId,document_id:randomUUID(),version_id:randomUUID(),sha256:'b'.repeat(64),page:1,field:'gross',fact_version:'synthetic-1'}],findings:[{id:randomUUID(),topic:'minimum_wage',evidence_ids:[evidenceId],rule_versions:['synthetic-rule'],parameter_versions:['synthetic-parameter']}],publication:{state:'published',approved_input_sha256:'a'.repeat(64),approval_actor_kind:'automation',published_at:'2026-09-07T06:00:00Z'},correction_policy:'append_new_revision_preserve_published'});
 const bytes=savedReportPdf({id,projection,document,sha256:document.projection_sha256,publishedAt:'2026-09-07T06:00:00Z'});
 expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(0);
 const logical=[...Buffer.from(bytes).toString('latin1').matchAll(/\/ActualText <FEFF([0-9A-F]+)>/gu)].map(m=>String.fromCharCode(...m[1].match(/.{4}/gu)!.map(h=>parseInt(h,16)))).join(' ').replace(/\s+/gu,' ');
 expect(logical).toContain(AI_REPORT_DISCLOSURE);
});
