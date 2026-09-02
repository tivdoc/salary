import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  EXPECTED_MIGRATION_CHAIN,
  EXPECTED_MIGRATION_SHA256,
} from "../../../scripts/canonical-persistence-v091/foundation/migrations.mts";

const NAME = "202609010010_runtime_canonical_helper_acl_repair.sql" as const;

describe("V0.10.2 runtime canonical helper ACL repair", () => {
  it("pins the forward-only migration and grants only the two exact helpers", async () => {
    const bytes = await readFile(resolve("supabase/migrations", NAME));
    const sql = bytes.toString("utf8");
    const index = EXPECTED_MIGRATION_CHAIN.indexOf(NAME);
    expect(index).toBeGreaterThan(0);
    expect(EXPECTED_MIGRATION_CHAIN[index - 1]).toBe("202609010009_governance_owner_schema_usage_repair.sql");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(EXPECTED_MIGRATION_SHA256[NAME]);
    for (const signature of [
      "private.resolve_engine_case_id(text,text)",
      "private.canonical_text_uuid(text,text)",
    ]) {
      expect(sql).toContain(`grant execute on function ${signature}`);
      expect(sql).toContain(`alter function ${signature}\n  owner to tivdoc_governance_owner`);
      expect(sql).toContain(`alter function ${signature}\n  set search_path = ''`);
    }
    expect(sql).toContain("to tivdoc_operations_runtime, tivdoc_worker_runtime");
    expect(sql).toContain("from public, anon, authenticated, service_role");
    expect(sql).not.toMatch(/grant\s+(?:all|select|insert|update|delete)\s+on\s+(?:table|all)/iu);
  });
});
