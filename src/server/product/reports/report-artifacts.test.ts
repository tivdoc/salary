import {describe,it,expect} from 'vitest';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';import {PDFDocument} from 'pdf-lib';
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
