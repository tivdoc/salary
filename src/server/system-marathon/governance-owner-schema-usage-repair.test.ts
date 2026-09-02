import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  EXPECTED_MIGRATION_CHAIN,
  EXPECTED_MIGRATION_SHA256,
} from "../../../scripts/canonical-persistence-v091/foundation/migrations.mts";

const NAME = "202609010009_governance_owner_schema_usage_repair.sql" as const;
const bytes = readFileSync(new URL(`../../../supabase/migrations/${NAME}`, import.meta.url));
const source = bytes.toString("utf8");

describe("V0.10.2 governance function-owner schema repair", () => {
  it("is an append-only pinned migration after the runtime product repair", () => {
    const index = EXPECTED_MIGRATION_CHAIN.indexOf(NAME);
    expect(index).toBeGreaterThan(0);
    expect(EXPECTED_MIGRATION_CHAIN[index - 1]).toBe("202609010008_runtime_product_forward_repair.sql");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(EXPECTED_MIGRATION_SHA256[NAME]);
  });

  it("grants only the function owner the schema resolution privilege", () => {
    expect(source).toMatch(/grant usage on schema private to tivdoc_governance_owner;/u);
    expect(source).not.toMatch(/grant\s+(?:all|usage)\s+on\s+schema\s+private\s+to\s+(?:public|anon|authenticated|service_role)/iu);
    expect(source).not.toMatch(/grant\s+execute\s+on\s+all\s+functions/iu);
    expect(source).toContain("'tivdoc-governance-owner-schema-usage-repair-v0.10.2'");
  });
});
