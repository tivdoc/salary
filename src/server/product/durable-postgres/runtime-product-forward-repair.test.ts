import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DURABLE_REPORT_IDENTITY_SQL_TEXT } from "./boundary-sql.ts";

const MIGRATION = resolve(
  "supabase/migrations/202609010008_runtime_product_forward_repair.sql",
);

describe("V0.10.2 runtime product forward repair", () => {
  it("restores only the operations resolver and exact owner-scoped portal identity reads", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    expect(sql).toContain("grant execute on function private.resolve_engine_case_id(text,text)");
    expect(sql).toContain("to tivdoc_operations_runtime");
    for (const table of [
      "engine_report_versions",
      "engine_review_task_versions",
      "product_case_owners",
    ]) {
      expect(sql).toContain(`create policy tivdoc_portal_web_owned_case on public.${table}`);
    }
    expect(sql.match(/private\.runtime_web_owns_case\(tenant_id, canonical_case_id\)/gu))
      .toHaveLength(3);
    expect(sql).not.toMatch(/grant\s+(?:all|select\s+on\s+table)/iu);
    expect(sql).not.toContain("service_role");
    expect(DURABLE_REPORT_IDENTITY_SQL_TEXT).toContain("run.status = 'completed'");
    expect(DURABLE_REPORT_IDENTITY_SQL_TEXT).toContain("owner.status = 'active'");
    expect(DURABLE_REPORT_IDENTITY_SQL_TEXT).toContain("review.invalidated_at is null");
  });
});
