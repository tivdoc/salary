// Site S2.3 / S3.4 — the documents already on a case, as the case screen shows
// them. Reading only: uploading goes through the same signed-URL path the funnel
// uses, so there is one way a file reaches storage and one place it is checked.
import { resolveCaseAccessDb, type CaseAccessDb } from "../case-access/db.ts";

export type CaseDocument = Readonly<{
  id: string;
  document_type: string;
  slot: string;
  original_filename: string;
  mime_type: string;
  size: number;
  period_month: string | null;
  created_at: string;
}>;

type DocumentRow = Readonly<{
  id: string;
  document_type: string;
  slot: string;
  original_filename: string;
  mime_type: string;
  size: number | string;
  period_month: string | null;
  created_at: string;
}>;

export async function listCaseDocuments(caseId: string, db?: CaseAccessDb | null): Promise<readonly CaseDocument[]> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return [];
  const rows = await store.rpc<DocumentRow>("case_documents_list", { target_case: caseId });
  return rows.map((row) => ({
    id: row.id,
    document_type: row.document_type,
    slot: row.slot,
    original_filename: row.original_filename,
    mime_type: row.mime_type,
    size: Number(row.size),
    period_month: row.period_month === null ? null : String(row.period_month).slice(0, 7),
    created_at: new Date(row.created_at).toISOString(),
  }));
}

/** Which payslip slots are still free — what an upload after payment may use (S2.3). */
export function freePayslipSlots(documents: readonly CaseDocument[], max = 12): readonly string[] {
  const used = new Set(documents.map((document) => document.slot));
  return Array.from({ length: max }, (_, index) => `payslip-${String(index + 1).padStart(2, "0")}`)
    .filter((slot) => !used.has(slot));
}
