import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Wave 3 (C2). The half of the SECURITY DEFINER contract that migration text
// can settle on its own.
//
// Whether a definer function is *gated* is a property of the live schema —
// ownership, policies, and which roles those policies bind — and is asserted by
// `scripts/legal-review-projection/secdef-surface-matrix.mts` against DEV,
// because three separate attempts to answer it from source shapes produced
// three different wrong counts. What source text does settle exactly is the
// search_path: a definer function without a pinned empty search_path resolves
// unqualified names through whatever the caller put in front of it, which turns
// every bare identifier in the body into a hook. There is no case where that is
// acceptable, so there is no allowlist here.

const MIGRATION_ROOT = path.resolve(process.cwd(), "supabase", "migrations");

/** Definition count, not distinct names: `create or replace` redefines. */
const EXPECTED_SECURITY_DEFINER_DEFINITIONS = 122;

const DEFINITION = /create\s+(?:or\s+replace\s+)?function\s+((?:public|private)\.[a-z0-9_]+)\s*\(([\s\S]*?)\)\s*returns([\s\S]*?)\bas\s+\$\$/gu;
const PINNED_EMPTY_SEARCH_PATH = /set\s+search_path\s*=\s*(?:''|"")/u;

type Definition = Readonly<{ file: string; name: string; header: string }>;

async function securityDefinerDefinitions(): Promise<readonly Definition[]> {
  const files = (await readdir(MIGRATION_ROOT)).filter((name) => name.endsWith(".sql")).sort();
  const found: Definition[] = [];
  for (const file of files) {
    const sql = (await readFile(path.join(MIGRATION_ROOT, file), "utf8")).replaceAll("\r\n", "\n");
    for (const match of sql.matchAll(DEFINITION)) {
      const header = match[3] as string;
      if (!/security\s+definer/u.test(header)) continue;
      found.push({ file, name: match[1] as string, header });
    }
  }
  return found;
}

describe("security definer search_path contract", () => {
  it("pins an empty search_path on every security definer function in the chain", async () => {
    const definitions = await securityDefinerDefinitions();
    const unpinned = definitions
      .filter((definition) => !PINNED_EMPTY_SEARCH_PATH.test(definition.header))
      .map((definition) => `${definition.file}: ${definition.name}`);
    expect(unpinned).toEqual([]);
  });

  it("counts the definer surface so a new one cannot arrive unnoticed", async () => {
    const definitions = await securityDefinerDefinitions();
    expect(definitions).toHaveLength(EXPECTED_SECURITY_DEFINER_DEFINITIONS);
  });

  it("never schema-qualifies a parser construct", async () => {
    // `coalesce`, `nullif`, `greatest` and `least` are constructs, not
    // `pg_catalog` functions, so qualifying one raises 42883 the first time the
    // statement runs — which is exactly how the identity rotate and revoke
    // paths shipped broken in this same wave. Pinning search_path to '' invites
    // the mistake, because every other name in the body does need qualifying.
    const files = (await readdir(MIGRATION_ROOT)).filter((name) => name.endsWith(".sql")).sort();
    const offenders: string[] = [];
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATION_ROOT, file), "utf8");
      for (const match of sql.matchAll(/pg_catalog\.(coalesce|nullif|greatest|least)\s*\(/gu)) {
        offenders.push(`${file}: pg_catalog.${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
