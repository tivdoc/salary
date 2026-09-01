import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { EXPECTED_PRIVATE_GOVERNANCE_POLICY_TABLES } from "../../../../../../scripts/canonical-persistence-v091/foundation/inventory.mts";
import { EXPECTED_MIGRATION_SHA256 } from "../../../../../../scripts/canonical-persistence-v091/foundation/migrations.mts";

const MIGRATION_NAME = "202609010004_durable_governance_workflows.sql" as const;
const MIGRATION_PATH = path.resolve(process.cwd(), "supabase", "migrations", MIGRATION_NAME);

describe("durable governance forward migration contract", () => {
  it("pins the exact immutable migration bytes and complete private table inventory", async () => {
    const bytes = await readFile(MIGRATION_PATH);
    const sql = bytes.toString("utf8").replaceAll("\r\n", "\n");
    expect(createHash("sha256").update(sql, "utf8").digest("hex"))
      .toBe(EXPECTED_MIGRATION_SHA256[MIGRATION_NAME]);

    const tables = [...sql.matchAll(/^create table (private\.governance_[a-z0-9_]+) \(/gmu)]
      .map((match) => match[1])
      .sort();
    expect(tables).toEqual([...EXPECTED_PRIVATE_GOVERNANCE_POLICY_TABLES].sort());
  });

  it("keeps every governance table forced-RLS and directly inaccessible", async () => {
    const sql = (await readFile(MIGRATION_PATH, "utf8")).replaceAll("\r\n", "\n");
    expect(matchCount(sql, /^alter table private\.governance_[a-z0-9_]+ enable row level security;/gmu)).toBe(25);
    expect(matchCount(sql, /^alter table private\.governance_[a-z0-9_]+ force row level security;/gmu)).toBe(25);
    expect(matchCount(sql, /^create policy governance_[a-z0-9_]+_service_tenant$/gmu)).toBe(25);
    expect(sql).toContain("from public, anon, authenticated, service_role;");
    expect(sql).not.toMatch(/grant\s+(?:select|insert|update|delete|all)\s+on\s+table/iu);
  });

  it("exposes exactly 21 repository functions while all helpers stay denied", async () => {
    const sql = (await readFile(MIGRATION_PATH, "utf8")).replaceAll("\r\n", "\n");
    expect(matchCount(sql, /^create function private\.governance_[a-z0-9_]+\(/gmu)).toBe(32);
    expect(matchCount(sql, /^grant execute on function private\.governance_[a-z0-9_]+\(/gmu)).toBe(21);
    expect(matchCount(sql, /^revoke all on function private\.governance_[a-z0-9_]+\(/gmu)).toBe(32);
    expect(matchCount(sql, /^create trigger governance_[a-z0-9_]+_immutable$/gmu)).toBe(23);
    expect(matchCount(sql, /^  if target_tenant is distinct from nullif\(current_setting\('tivdoc\.tenant_id', true\), ''\) then$/gmu))
      .toBe(21);
    expect(sql).not.toContain("target_tenant <> nullif(current_setting('tivdoc.tenant_id'");
    expect(sql).not.toMatch(/grant execute .* to (?:public|anon|authenticated)\b/iu);
  });

  it("binds every admitted human payload and the GT result hash before mutation", async () => {
    const sql = (await readFile(MIGRATION_PATH, "utf8")).replaceAll("\r\n", "\n");
    expect(matchCount(sql, /admission\.payload_json is distinct from/gmu)).toBe(5);
    expect(sql).toContain("private.governance_jsonb_compact_text(target_manifest)");
    expect(sql).toContain("'resulting_manifest_sha256', pg_catalog.encode(public.digest(");
    expect(sql).toContain("message = 'GOVERNANCE_GT_SIGNED_PAYLOAD_MISMATCH'");
    expect(sql).toContain("or target_reason_code is null");
  });

  it("remains non-operative and records the canonical migration metadata", async () => {
    const sql = (await readFile(MIGRATION_PATH, "utf8")).replaceAll("\r\n", "\n");
    expect(sql).not.toMatch(/activation_allowed\s*(?:=|,)\s*true\b/iu);
    expect(sql).toContain("'durable_human_legal_governance'");
    expect(sql).toContain("'tivdoc-durable-governance-v0.10.1'");
    expect(sql).toContain("'202609010004_durable_governance_workflows'");
  });
});

function matchCount(value: string, expression: RegExp): number {
  return [...value.matchAll(expression)].length;
}
