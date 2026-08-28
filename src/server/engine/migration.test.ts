import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/202608290001_engine_persistence_foundation.sql"),
  "utf8",
).toLowerCase();
const uploadRoute = readFileSync(join(process.cwd(), "src/app/api/documents/complete/route.ts"), "utf8");
const validation = readFileSync(join(process.cwd(), "src/lib/validation.ts"), "utf8");

const sensitiveTables = [
  "analysis_runs",
  "employment_snapshots",
  "analysis_hypotheses",
  "case_conversations",
  "case_messages",
  "analysis_findings",
  "document_extractions",
  "case_confirmations",
  "analysis_jobs",
];

describe("engine persistence migration safety", () => {
  it("enables RLS and revokes browser roles on every sensitive table", () => {
    for (const table of sensitiveTables) {
      expect(migration).toContain(`alter table public.${table} enable row level security`);
      expect(migration).toContain(`revoke all on table public.${table} from anon, authenticated`);
    }
  });

  it("preserves the current document slot constraint and upsert behavior", () => {
    expect(migration).not.toMatch(/drop\s+constraint[^;]*documents/i);
    expect(migration).not.toMatch(/drop\s+index[^;]*documents/i);
    expect(uploadRoute).toContain('.upsert(records, { onConflict: "case_id,document_type" })');
    expect(uploadRoute).toContain("storageBaseName(file.documentType)");
    expect(validation).toContain('if (documentType === "payslip") return "payslip-01"');
  });

  it("requires UUID-addressed paths only for future immutable records", () => {
    expect(migration).toContain("storage_layout in ('legacy_slot', 'immutable_v1')");
    expect(migration).toContain("'cases/' || case_id::text || '/documents/' || id::text || '/original.%'");
    expect(migration).toContain("storage_layout = 'legacy_slot'");
  });

  it("declares cascade ownership for case-scoped sensitive records", () => {
    expect(migration).toMatch(/case_id uuid not null references public\.cases\(id\) on delete cascade/g);
    expect(migration).toContain("analysis_run_id uuid not null unique references public.analysis_runs(id) on delete cascade");
    expect(migration).toContain("document_id uuid not null references public.documents(id) on delete cascade");
    expect(migration).toContain("before insert or update on public.analysis_jobs");
  });

  it("keeps append-only analysis artifacts out of the service-role update grants", () => {
    for (const table of ["employment_snapshots", "analysis_hypotheses", "case_messages", "analysis_findings"]) {
      expect(migration).toContain(`grant select, insert on table public.${table} to service_role`);
      expect(migration).not.toContain(`grant select, insert, update on table public.${table} to service_role`);
    }
  });

  it("guards terminal runs, terminal extractions, and cross-case references", () => {
    expect(migration).toContain("terminal analysis runs are immutable");
    expect(migration).toContain("terminal document extractions are immutable");
    expect(migration).toContain("create or replace function private.enforce_engine_case_scope()");
  });
});
