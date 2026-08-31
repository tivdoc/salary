import { describe, expect, it } from "vitest";

import { CanonicalPostgresError } from "../runtime/errors.ts";
import { mapPostgresAnalysisError } from "./errors.ts";

describe("PostgreSQL analysis error mapping", () => {
  it("maps a safely preserved unique SQLSTATE to the requested domain code", () => {
    const driverError = new CanonicalPostgresError("POSTGRES_STATEMENT_FAILED", {
      sqlstate: "23505",
    });

    expect(() => mapPostgresAnalysisError(driverError, "ANALYSIS_RUN_ID_COLLISION"))
      .toThrow(expect.objectContaining({
        name: "PostgresAnalysisError",
        code: "ANALYSIS_RUN_ID_COLLISION",
      }));
  });

  it("does not treat arbitrary driver codes as PostgreSQL uniqueness", () => {
    expect(() => mapPostgresAnalysisError({ code: "ECONNRESET" }, "ANALYSIS_RUN_ID_COLLISION"))
      .toThrow(expect.objectContaining({
        name: "PostgresAnalysisError",
        code: "POSTGRES_PERSISTENCE_UNAVAILABLE",
      }));
  });
});
