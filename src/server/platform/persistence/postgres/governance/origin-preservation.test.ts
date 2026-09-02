import { describe, expect, it } from "vitest";

import type { InternalOpsApplicationPort } from "../../../../product/internal-ops/application-port.ts";
import {
  clearOpsRejectionLog,
  createOperationsHttpHandler,
  readOpsRejectionLog,
} from "../../../../product/routes/operations-http.ts";
import { CanonicalPostgresError } from "../runtime/errors.ts";
import { GovernanceRepositoryError, governanceOriginSqlstate } from "./contracts.ts";

// Wave 1 (A4 / §3.1). The 42501 that cost a run was destroyed one layer below
// the classifier: the repository wrapper threw its own code and kept nothing of
// the origin. These cases pin both halves — the SQLSTATE survives to the top of
// the stack, and the response the caller sees is unchanged.

const ACTOR = Object.freeze({ actor_id: "actor.legal_reviewer.001", role: "legal_reviewer" });

function sessions() {
  return Object.freeze({
    verify: async () => Object.freeze({ actor: ACTOR, csrf_token: "csrf" }) as never,
  });
}

function failingService(error: unknown): InternalOpsApplicationPort {
  return Object.freeze({
    read: async () => Object.freeze({}) as never,
    mutate: async () => Object.freeze({}) as never,
    readLegalReviewQueue: async () => { throw error; },
    readLegalReviewTopics: async () => { throw error; },
    submitLegalReviewAction: async () => { throw error; },
  }) as unknown as InternalOpsApplicationPort;
}

const QUEUE = () => new Request("https://internal.invalid/api/operations/legal-review/queue");

/** What the driver actually produces for a missing GRANT. */
function aclFailure(): CanonicalPostgresError {
  return new CanonicalPostgresError("POSTGRES_STATEMENT_FAILED", { sqlstate: "42501" });
}

describe("Wave 1 origin preservation through the governance wrapper", () => {
  it("keeps the origin SQLSTATE on the error the wrapper substitutes", () => {
    const wrapped = new GovernanceRepositoryError("GOVERNANCE_QUERY_FAILED", "listQueue", aclFailure());
    expect(wrapped.code).toBe("GOVERNANCE_QUERY_FAILED");
    expect(wrapped.origin_sqlstate).toBe("42501");
    expect(wrapped.cause).toBeInstanceOf(CanonicalPostgresError);
  });

  it("reads a SQLSTATE from either shape and refuses anything else", () => {
    expect(governanceOriginSqlstate({ sqlstate: "42501" })).toBe("42501");
    expect(governanceOriginSqlstate({ code: "23505" })).toBe("23505");
    expect(governanceOriginSqlstate({ code: "ECONNRESET" })).toBeNull();
    expect(governanceOriginSqlstate({ code: "not a sqlstate" })).toBeNull();
    expect(governanceOriginSqlstate(new Error("plain"))).toBeNull();
    expect(governanceOriginSqlstate(null)).toBeNull();
  });

  it("stays null when there was no origin, so nothing is invented", () => {
    expect(new GovernanceRepositoryError("GOVERNANCE_QUERY_FAILED", "listQueue").origin_sqlstate).toBeNull();
  });

  it("classifies a deep 42501 as a refusal at the top of the stack", async () => {
    clearOpsRejectionLog();
    const wrapped = new GovernanceRepositoryError("GOVERNANCE_QUERY_FAILED", "listQueue", aclFailure());
    const response = await createOperationsHttpHandler({
      enabled: true, service: failingService(wrapped), sessions: sessions(),
    }).handle(QUEUE(), ["legal-review", "queue"]);
    const body = await response.json() as { code?: string; retryable?: boolean };
    expect(body.code).toBe("OPS_FORBIDDEN");
    expect(body.retryable).toBe(false);
    // A refusal is classified, so it is not logged as an unclassified rejection.
    expect(readOpsRejectionLog()).toEqual([]);
  });

  it("leaves the external response shape byte-identical to an unclassified failure", async () => {
    const shapes: string[] = [];
    for (const error of [
      new GovernanceRepositoryError("GOVERNANCE_QUERY_FAILED", "listQueue", aclFailure()),
      new GovernanceRepositoryError("GOVERNANCE_QUERY_FAILED", "listQueue"),
    ]) {
      const response = await createOperationsHttpHandler({
        enabled: true, service: failingService(error), sessions: sessions(),
      }).handle(QUEUE(), ["legal-review", "queue"]);
      const body = await response.json() as Record<string, unknown>;
      shapes.push(JSON.stringify({
        keys: Object.keys(body).sort(),
        headers: [...response.headers.entries()].sort(),
        retryable: body.retryable,
      }));
      // Never the SQLSTATE, the operation or anything about the origin.
      expect(JSON.stringify(body)).not.toContain("42501");
      expect(JSON.stringify(body)).not.toContain("listQueue");
      expect(JSON.stringify(body)).not.toContain("aclcheck");
    }
    expect(new Set(shapes).size).toBe(1);
  });

  it("records the origin SQLSTATE internally when the failure stays unclassified", async () => {
    clearOpsRejectionLog();
    // 23505 has no external classification, so it falls through to the
    // catch-all — and the catch-all now says which SQLSTATE it was.
    const wrapped = new GovernanceRepositoryError(
      "GOVERNANCE_ROW_MALFORMED", "listQueue",
      new CanonicalPostgresError("POSTGRES_STATEMENT_FAILED", { sqlstate: "23505" }),
    );
    await createOperationsHttpHandler({
      enabled: true, service: failingService(wrapped), sessions: sessions(),
    }).handle(QUEUE(), ["legal-review", "queue"]);
    const recorded = readOpsRejectionLog().at(-1);
    expect(recorded?.kind).toContain("GOVERNANCE_ROW_MALFORMED");
    expect(recorded?.kind).toContain("23505");
  });
});
