import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Wave 3 (C6). An effect asserter must assert the effect. These do not yet, and
// this records exactly which ones and why, so the gap is tracked rather than
// implied.
//
// The item that produced this arrived as "12 ON_JOURNEY shape-only asserters".
// The count could not be reproduced, and chasing it found the reason: the
// canonical reachability verifier treated `src/instrumentation.ts` as an
// ordinary module. It is the Next.js server startup hook — the framework loads
// it on every boot and nothing in the tree imports it — so every file it
// reaches looked unreachable. Naming it an entrypoint took product-reachable
// files from 49 to 180, and moved these assertions from OFF_JOURNEY to
// ON_JOURNEY.
//
// So: the invalidation port IS on the product path, reached as
// instrumentation.ts -> durable-local-runtime.ts -> postgres-port.ts, and its
// nine effect assertions — five in the port, four in the contract — all read
// values a scripted client was told to return. They are honest tests of the
// port's arithmetic given a database response;
// they are not evidence that any database ever did that. Converting them needs
// an invalidation fixture against DEV — a verified actor, a locked case and an
// idempotency record — which does not exist yet and is not invented here.
//
// This test fails if the chain changes or if the assertions stop being
// shape-only, because either one means this record has gone stale.

const read = (...segments: string[]) => readFileSync(path.resolve(process.cwd(), ...segments), "utf8");

const CHAIN = Object.freeze([
  ["src/instrumentation.ts", "./server/product/runtime/durable-local-runtime"],
  ["src/server/product/runtime/durable-local-runtime.ts", "../dependency-invalidation/postgres-port.ts"],
  ["src/server/product/dependency-invalidation/postgres-port.ts", "./global-invalidation.ts"],
]);

/** Assertions that read an effect field out of a scripted client's answer. */
const SHAPE_ONLY_EFFECT_ASSERTIONS = Object.freeze({
  "src/server/product/dependency-invalidation/postgres-port.test.ts": 5,
  "src/server/product/dependency-invalidation/global-invalidation.test.ts": 4,
});

const EFFECT_FIELDS = Object.freeze([
  "historical_evidence_preserved", "historical_versions_deleted", "approval_invalidated",
  "stale_execution_blocked", "stale_approval_blocked", "stale_download_blocked",
  "cache_versioned", "assertApplied", "assertReceipt",
]);

function effectAssertionCount(file: string): number {
  const lines = read(file).split(/\r?\n/u);
  return lines.filter((line, index) => {
    if (!EFFECT_FIELDS.some((field) => line.includes(field))) return false;
    return /\bexpect\s*\(/u.test(lines.slice(Math.max(0, index - 8), index + 1).join("\n"));
  }).length;
}

describe("effect asserter scope", () => {
  it("keeps the import chain that puts the invalidation port on the product path", () => {
    for (const [file, specifier] of CHAIN) {
      expect(read(file), `${file} -> ${specifier}`).toContain(specifier);
    }
  });

  it("counts the effect assertions that a scripted client answers, not a database", () => {
    for (const [file, expected] of Object.entries(SHAPE_ONLY_EFFECT_ASSERTIONS)) {
      expect(effectAssertionCount(file), file).toBe(expected);
      // The marker of shape-only: the values come from vitest doubles, and the
      // file never opens a connection of its own.
      const text = read(file);
      expect(/\bvi\.(?:fn|mock|spyOn)\b/u.test(text), `${file} uses doubles`).toBe(true);
      expect(/pg\.Client|readDevEnvFile|POSTGRES_URL/u.test(text), `${file} observes a database`).toBe(false);
    }
  });

  it("names the three effects that are still uncomputed and what would compute them", () => {
    const port = read("src/server/product/dependency-invalidation/postgres-port.ts");
    for (const field of ["stale_execution_blocked", "stale_approval_blocked", "stale_download_blocked"]) {
      expect(port, field).toContain(`${field}: "unknown" as const`);
    }
    // `withCurrentAuthorization` is the only enforcement behind those three, and
    // journey-scope-disposition.ts records it as having no caller. Until it has
    // one there is nothing to observe, which is why "unknown" is the honest
    // value rather than a computation waiting to be written.
    const disposition = read("src/server/product/dependency-invalidation/journey-scope-disposition.ts");
    expect(disposition).toContain("withCurrentAuthorization");
  });
});
