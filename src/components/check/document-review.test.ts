import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
import { DocumentReview, TravelTariffPurposeFields } from "./document-review";
import type { UploadSnapshot } from "@/lib/document-upload";
it.each([null,'2026-06'])('renders authenticated legacy intake %s without a guessed file month, payment CTA or tariff picker',month=>{
 const id='11111111-1111-4111-8111-111111111111',initial:UploadSnapshot={caseId:'case',publicId:'TV-SYNTH001',status:'documents_uploaded',paymentStatus:'not_started',checkPeriodMonth:null,documents:[],
  requests:[{id,code:'legacy.source.document:order',question:'Source required',documentType:'payslip',sourceIntake:{policy:'legacy-source-intake-v1',target_sha256:'a'.repeat(64),month}}]};
 const body=renderToStaticMarkup(createElement(DocumentReview,{initial,initialRequestId:id}));
 expect(body).toContain('אין לבחור חודש');expect(body).toContain('שמירה וחזרה לתיק');expect(body).not.toContain('אישור ומעבר לתשלום');expect(body).not.toContain('חודש הבדיקה הראשונית');expect(body).not.toContain('הוספת מקור תעריפי נסיעה');
 if(month)expect(body).toContain('הבקשה מתייחסת');else expect(body).not.toContain('הבקשה מתייחסת');
});

it("renders saved names, months and explicit per-document replacement controls from persisted state", () => {
  const initial: UploadSnapshot = { caseId: "case", publicId: "TV-SYNTH001", status: "under_review", paymentStatus: "verified", checkPeriodMonth: "2026-08", requests: [], documents: [
    { id: "first", version_id: "v1", document_type: "payslip", slot: "payslip-01", original_filename: "saved-payslip.pdf", mime_type: "application/pdf", size: 100, period_month: "2026-08" },
    { id: "contract", version_id: "v2", document_type: "contract", slot: "contract", original_filename: "saved-contract.pdf", mime_type: "application/pdf", size: 200, period_month: null },
  ] };
  const markup = renderToStaticMarkup(createElement(DocumentReview, { initial }));
  expect(markup).toContain("saved-payslip.pdf"); expect(markup).toContain("saved-contract.pdf");
  expect(markup).toContain("החלפת saved-payslip.pdf"); expect(markup).toContain("החלפת saved-contract.pdf");
  expect(markup).toContain("שמירה וחזרה לתיק"); expect(markup).not.toContain("אישור ומעבר לתשלום");
});
it('shows saved tariff purpose with a PDF-only picker and exact current replacement',()=>{
 const initial:UploadSnapshot={caseId:'case',publicId:'TV-SYNTH001',status:'under_review',paymentStatus:'verified',checkPeriodMonth:'2026-07',requests:[],capacity:{maxPayslips:12,maxCaseBytes:26214400,maxBatchFiles:14,maxBatchBytes:26214400,paidMonths:['2026-07']},documents:[
  {id:'tariff',version_id:'tariff-v1',document_type:'other',slot:'other-01',original_filename:'tariff.pdf',mime_type:'application/pdf',size:100,period_month:null,evidence_purpose:{kind:'travel_tariff',month:'2026-07',page:2,locator:'טבלת נסיעות',page_count:3}},
 ]};
 const html=renderToStaticMarkup(createElement(DocumentReview,{initial,replacementVersionId:'tariff-v1'}));
 expect(html).toContain('מקור תעריפי נסיעה');expect(html).toContain('עמוד 2 מתוך 3');expect(html).toContain('טבלת נסיעות');
 expect(html).toContain('aria-label="הוספת מקור תעריפי נסיעה" accept="application/pdf"');
 expect(html).toContain('aria-label="החלפת tariff.pdf" accept="application/pdf"');
 expect(html).toContain('זה המסמך של השאלה');
 const unsupported=renderToStaticMarkup(createElement(DocumentReview,{initial:{...initial,capacity:{...initial.capacity!,paidMonths:['2026-08']}}}));
 expect(unsupported).not.toContain('aria-label="הוספת מקור תעריפי נסיעה"');
});
it('renders distinct bounded tariff month/page/locator controls without asking for a price or a legal confirmation',()=>{
 const html=renderToStaticMarkup(createElement(TravelTariffPurposeFields,{purpose:{kind:'travel_tariff',month:'2026-07',page:2,locator:'טבלת כרטיסים'},months:['2026-07'],disabled:false,onChange:vi.fn()}));
 expect(html).toContain('חודש הבדיקה של תעריף הנסיעה');expect(html).toContain('עמוד במקור');expect(html).toContain('מיקום התעריף או טבלת הכרטיסים בעמוד');
 expect(html).toContain('min="1" max="100" step="1"');expect(html).toContain('maxLength="120"');
 expect(html).not.toContain('type="checkbox"');expect(html).not.toContain('סכום');
});
it('identifies only the exact current source, retaining other saved documents',()=>{
 const initial:UploadSnapshot={caseId:'case',publicId:'TV-SYNTH001',status:'under_review',paymentStatus:'verified',checkPeriodMonth:'2026-08',requests:[],documents:[
  {id:'first',version_id:'v1',document_type:'payslip',slot:'payslip-01',original_filename:'first.pdf',mime_type:'application/pdf',size:100,period_month:'2026-08'},
  {id:'second',version_id:'v2',document_type:'payslip',slot:'payslip-02',original_filename:'second.pdf',mime_type:'application/pdf',size:100,period_month:'2026-08'},
 ]};
 const html=renderToStaticMarkup(createElement(DocumentReview,{initial,replacementVersionId:'v2'}));
 expect(html.match(/זה המסמך של השאלה/g)).toHaveLength(1);expect(html.indexOf('זה המסמך של השאלה')).toBeGreaterThan(html.indexOf('second.pdf'));expect(html).toContain('first.pdf');
 const stale=renderToStaticMarkup(createElement(DocumentReview,{initial,replacementVersionId:'old-version'}));expect(stale).toContain('המסמך של השאלה כבר השתנה');expect(stale).not.toContain('זה המסמך של השאלה');
});
