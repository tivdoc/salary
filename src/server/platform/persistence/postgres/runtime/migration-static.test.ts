import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const migrationPath = path.resolve(process.cwd(), "supabase/migrations/202608310002_canonical_postgresql_composition.sql");
const sql = readFileSync(migrationPath, "utf8");
const platformSql = readFileSync(path.resolve(process.cwd(), "supabase/migrations/202608310001_engine_platform_persistence.sql"), "utf8");

describe("V0.9 forward-only canonical PostgreSQL migration", () => {
  it("does not alter historical migration bytes", () => {
    expect(digest("supabase/migrations/202608290001_engine_persistence_foundation.sql", true))
      .toBe("cc1b809a012563ca1bc0214ccbd478af988300439e54f0b70968623e2dc4abc1");
    expect(digest("supabase/migrations/202608310001_engine_platform_persistence.sql"))
      .toBe("74e0615c6375b8cb87da5a09c6a8a29d4e27fe503793b14d767a2199d92c4460");
    expect(() => execFileSync("git", ["diff", "--quiet", "HEAD", "--",
      "supabase/migrations/202608290001_engine_persistence_foundation.sql",
      "supabase/migrations/202608310001_engine_platform_persistence.sql",
    ], { cwd: process.cwd(), stdio: "ignore" })).not.toThrow();
  });

  it("adds lossless canonical identifiers, exact report hashes and atomic receipts", () => {
    for (const token of [
      "engine_case_identity", "canonical_case_id", "canonical_analysis_run_id",
      "json_sha256", "html_sha256", "pdf_sha256", "report_sha256",
      "result_payload", "case_sequence",
    ]) expect(sql).toContain(token);
    expect(platformSql).toContain("logical_effect_sha256");
    expect(sql).toContain("private.resolve_engine_case_id");
    expect(sql).toContain("private.canonical_text_uuid");
  });

  it("keeps tenant ownership, RLS, leases, fences and forward-only discipline explicit", () => {
    expect(sql).toContain("tivdoc_service_tenant_scope");
    expect(sql).toContain("current_setting(''tivdoc.tenant_id'', true)");
    expect(sql).toContain("attempt_count < max_attempts");
    expect(sql).toContain("fencing_token = job.fencing_token + 1");
    expect(sql).not.toMatch(/\btruncate table\b/iu);
    expect(sql).not.toMatch(/\bdrop table\b/iu);
    expect(sql).not.toContain(["DATABASE", "URL"].join("_"));
  });
});

function digest(relativePath: string, normalizeLineEndings = false): string {
  const bytes = readFileSync(path.resolve(process.cwd(), relativePath));
  const content = normalizeLineEndings ? Buffer.from(bytes.toString("utf8").replace(/\r\n/gu, "\n"), "utf8") : bytes;
  return createHash("sha256").update(content).digest("hex");
}
