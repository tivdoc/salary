import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
import { DocumentReview } from "./document-review";
import type { UploadSnapshot } from "@/lib/document-upload";

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
it('identifies only the exact current source, retaining other saved documents',()=>{
 const initial:UploadSnapshot={caseId:'case',publicId:'TV-SYNTH001',status:'under_review',paymentStatus:'verified',checkPeriodMonth:'2026-08',requests:[],documents:[
  {id:'first',version_id:'v1',document_type:'payslip',slot:'payslip-01',original_filename:'first.pdf',mime_type:'application/pdf',size:100,period_month:'2026-08'},
  {id:'second',version_id:'v2',document_type:'payslip',slot:'payslip-02',original_filename:'second.pdf',mime_type:'application/pdf',size:100,period_month:'2026-08'},
 ]};
 const html=renderToStaticMarkup(createElement(DocumentReview,{initial,replacementVersionId:'v2'}));
 expect(html.match(/זה המסמך של השאלה/g)).toHaveLength(1);expect(html.indexOf('זה המסמך של השאלה')).toBeGreaterThan(html.indexOf('second.pdf'));expect(html).toContain('first.pdf');
 const stale=renderToStaticMarkup(createElement(DocumentReview,{initial,replacementVersionId:'old-version'}));expect(stale).toContain('המסמך של השאלה כבר השתנה');expect(stale).not.toContain('זה המסמך של השאלה');
});
