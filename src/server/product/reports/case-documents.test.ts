import { expect, it } from "vitest";
import { listCaseDocuments } from "./case-documents";
import type { CaseAccessDb } from "../case-access/db";

it("renders the same stored month from Postgres DATE objects and PostgREST strings", async () => {
  for (const period_month of [new Date(2026, 7, 1), "2026-08-01"]) {
    const db = { provider: "fake", rpc: async () => [{ id: "doc", document_type: "payslip", slot: "payslip-01", original_filename: "synthetic.pdf", mime_type: "application/pdf", size: "100", period_month, created_at: "2026-09-07T00:00:00Z" }] } as unknown as CaseAccessDb;
    expect((await listCaseDocuments("case", db))[0]?.period_month).toBe("2026-08");
  }
});
