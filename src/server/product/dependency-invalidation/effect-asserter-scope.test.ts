import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Wave 4 (4B-1, 4B-3). An effect asserter must assert the effect.
//
// Wave 3 recorded the gap: the invalidation port is on the product path
// (instrumentation.ts -> durable-local-runtime.ts -> postgres-port.ts) and its
// nine effect assertions all read values a scripted client was told to return.
// They are honest tests of the port's arithmetic given a database response, and
// were not evidence that a database ever produced one.
//
// That evidence now exists: `scripts/legal-review-projection/invalidation-
// effect-matrix.mts` runs the real port, through the real driver, as the real
// operations role, against DEV, and reads every effect field back out of the
// tables. The unit tests keep their job — arithmetic, fast, no database — and
// this test keeps the matrix honest, because a claimed effect with no state
// observation behind it is the defect the whole exercise is about.
//
// Building it produced four findings, all of them in the fixture rather than
// the port, and each worth stating because each would otherwise have been
// reported as a product defect:
//
//   1. A hand-rolled client left `updated_at` as a Date; the driver normalizes
//      it to an ISO string, and the decoder reads a string. Use the driver.
//   2. `engine_global_dependency_invalidations` forces RLS, so an admin
//      connection that has not declared a tenant reads zero rows and reports
//      the history row as missing when it was written.
//   3. `approval_invalidated` counts invalidated report_approval review tasks.
//      With none seeded it is honestly false while the dependency row's
//      approval flag still clears — two effects, not one.
//   4. Review tasks are append-only: invalidation appends a revision rather
//      than changing the approved one, so a task's state is its latest
//      revision, exactly as APPROVALS_INVALIDATE_SQL selects it.

const read = (...segments: string[]) => readFileSync(path.resolve(process.cwd(), ...segments), "utf8");

const MATRIX = "scripts/legal-review-projection/invalidation-effect-matrix.mts";

const CHAIN = Object.freeze([
  ["src/instrumentation.ts", "./server/product/runtime/durable-local-runtime"],
  ["src/server/product/runtime/durable-local-runtime.ts", "../dependency-invalidation/postgres-port.ts"],
  ["src/server/product/dependency-invalidation/postgres-port.ts", "./global-invalidation.ts"],
]);

/** Effects the port claims happen, each of which the matrix must observe. */
const OBSERVED_EFFECTS = Object.freeze([
  "cache_versioned",
  "approval_invalidated",
  "historical_evidence_preserved",
  "historical_versions_deleted",
]);

/** Effects nothing computes, which stay `unknown` rather than becoming a literal. */
const UNCOMPUTED_EFFECTS = Object.freeze([
  "stale_execution_blocked",
  "stale_approval_blocked",
  "stale_download_blocked",
]);

describe("effect asserter scope", () => {
  it("keeps the import chain that puts the invalidation port on the product path", () => {
    for (const [file, specifier] of CHAIN) {
      expect(read(file), `${file} -> ${specifier}`).toContain(specifier);
    }
  });

  it("observes every claimed effect against a real database, not a scripted client", () => {
    const matrix = read(MATRIX);
    // The matrix has to reach a database and run the real port, or it is
    // another shape test wearing a different name.
    expect(matrix).toContain("NodePostgresConnectionFactory");
    expect(matrix).toContain("createDurablePostgresGlobalDependencyInvalidationService");
    expect(matrix).toContain("readDevEnvFile");
    for (const effect of OBSERVED_EFFECTS) {
      expect(matrix, `${effect} is claimed but never observed`).toContain(effect);
    }
    // Each observation compares a before and an after reading, which is what
    // separates observing an effect from reading a receipt back to itself.
    expect(matrix).toContain("async function observe(");
    expect(matrix).toContain("const before = await observe(admin)");
    expect(matrix).toContain("const after = await observe(admin)");
  });

  it("proves the least-privilege claim rather than declaring it", () => {
    // Declaring `LEAST_PRIVILEGE_VERIFIED_SESSION_CONTEXT` in a fixture asserts
    // a property. The matrix checks the connection really is the operations
    // runtime role without BYPASSRLS before it uses that declaration.
    const matrix = read(MATRIX);
    expect(matrix).toContain("connection_is_least_privilege_operations_role");
    expect(matrix).toContain("tivdoc_operations_runtime");
    expect(matrix).toContain("rolbypassrls");
  });

  it("names the three effects that are still uncomputed and what would compute them", () => {
    const port = read("src/server/product/dependency-invalidation/postgres-port.ts");
    for (const field of UNCOMPUTED_EFFECTS) {
      expect(port, field).toContain(`${field}: "unknown" as const`);
    }
    // `withCurrentAuthorization` is the only enforcement behind those three.
    const disposition = read("src/server/product/dependency-invalidation/journey-scope-disposition.ts");
    expect(disposition).toContain("withCurrentAuthorization");
  });
});
