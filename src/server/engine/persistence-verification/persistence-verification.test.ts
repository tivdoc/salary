import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED,
  verifyIsolatedTargetIdentity,
} from "./isolated-environment";
import { verifyPersistenceFoundationStatically } from "./static-verifier";
import {
  SyntheticCaseAccessDenied,
  SyntheticPersistenceConflict,
  SyntheticPersistenceStore,
} from "./synthetic-store";
import { SYNTHETIC_ACTOR_ALPHA, SYNTHETIC_ACTOR_BETA, syntheticRecord } from "./synthetic-fixtures";

function repositorySources() {
  return [
    "analysis-run-repository.ts",
    "conversation-repository.ts",
    "document-repository.ts",
    "extraction-repository.ts",
    "investigation-repository.ts",
    "repository-error.ts",
  ]
    .map((file) => readFileSync(join(process.cwd(), "src/server/engine", file), "utf8"))
    .join("\n");
}

describe("isolated persistence environment gate", () => {
  it("fails closed when no verified target identity is supplied", () => {
    expect(verifyIsolatedTargetIdentity(null)).toEqual({
      authorized: false,
      status: PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED,
      reason: "target_identity_not_supplied",
    });
  });

  it("accepts only a non-shared local loopback identity", () => {
    expect(
      verifyIsolatedTargetIdentity({
        kind: "local",
        target_id: "wave1-local",
        host: "127.0.0.1",
        production: false,
        shared: false,
        expires_at: null,
      }),
    ).toMatchObject({ authorized: true, status: "ISOLATED_TARGET_VERIFIED" });

    expect(
      verifyIsolatedTargetIdentity({
        kind: "local",
        target_id: "wave1-local",
        host: "database.example.invalid",
        production: false,
        shared: false,
        expires_at: null,
      }),
    ).toMatchObject({ authorized: false, reason: "local_target_must_be_loopback" });
  });

  it("requires an unexpired disposable identity", () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    expect(
      verifyIsolatedTargetIdentity(
        {
          kind: "disposable",
          target_id: "wave1-disposable",
          host: "ephemeral.example.invalid",
          production: false,
          shared: false,
          expires_at: "2030-01-01T01:00:00.000Z",
        },
        now,
      ),
    ).toMatchObject({ authorized: true });
    expect(
      verifyIsolatedTargetIdentity(
        {
          kind: "disposable",
          target_id: "wave1-disposable",
          host: "ephemeral.example.invalid",
          production: false,
          shared: false,
          expires_at: "2029-12-31T23:59:59.000Z",
        },
        now,
      ),
    ).toMatchObject({ authorized: false, reason: "disposable_target_requires_future_expiry" });
  });
});

describe("persistence foundation offline structural verification", () => {
  it("finds the expected schema, constraints, indexes, RLS, grants, and repository boundaries", () => {
    const report = verifyPersistenceFoundationStatically({
      migration: readFileSync(
        join(process.cwd(), "supabase/migrations/202608290001_engine_persistence_foundation.sql"),
        "utf8",
      ),
      repositories: repositorySources(),
      safeLogging: readFileSync(join(process.cwd(), "src/server/engine/safe-logging.ts"), "utf8"),
    });
    expect(report.passed).toBe(true);
    expect(report.database_semantics_verified).toBe(false);
    expect(report.checks).toHaveLength(63);
  });
});

describe("synthetic persistence model probes", () => {
  it("exercises all repository record kinds without real legal or customer data", () => {
    const store = new SyntheticPersistenceStore();
    const kinds = [
      "analysis_run",
      "conversation",
      "message",
      "document",
      "extraction",
      "hypothesis",
      "finding",
      "confirmation",
      "job",
    ] as const;
    kinds.forEach((kind, index) => store.insert(SYNTHETIC_ACTOR_ALPHA, syntheticRecord(kind, index + 1)));
    expect(store.size()).toBe(kinds.length);
  });

  it("isolates two synthetic tenants and cases", () => {
    const store = new SyntheticPersistenceStore();
    const record = store.insert(SYNTHETIC_ACTOR_ALPHA, syntheticRecord("analysis_run", 1));
    expect(() => store.read(SYNTHETIC_ACTOR_BETA, record.id)).toThrow(SyntheticCaseAccessDenied);
    expect(store.read(SYNTHETIC_ACTOR_ALPHA, record.id)).toEqual(record);
  });

  it("returns identical duplicates and rejects conflicting duplicate payloads", () => {
    const store = new SyntheticPersistenceStore();
    const input = syntheticRecord("finding", 1);
    const first = store.insert(SYNTHETIC_ACTOR_ALPHA, input);
    expect(store.insert(SYNTHETIC_ACTOR_ALPHA, input)).toBe(first);
    expect(() =>
      store.insert(SYNTHETIC_ACTOR_ALPHA, {
        ...input,
        id: "finding-conflict",
        payload: { synthetic: true, sequence: 999 },
      }),
    ).toThrow(SyntheticPersistenceConflict);
  });

  it("detects a stale concurrent write", () => {
    const store = new SyntheticPersistenceStore();
    const original = store.insert(SYNTHETIC_ACTOR_ALPHA, syntheticRecord("job", 1));
    const advanced = store.update(SYNTHETIC_ACTOR_ALPHA, original.id, original.version, {
      synthetic: true,
      status: "retry_scheduled",
      retry_count: 1,
    });
    expect(advanced.version).toBe(2);
    expect(() => store.update(SYNTHETIC_ACTOR_ALPHA, original.id, original.version, original.payload)).toThrow(
      SyntheticPersistenceConflict,
    );
  });

  it("rolls back every write after a partial transaction failure", () => {
    const store = new SyntheticPersistenceStore();
    expect(() =>
      store.transaction((transaction) => {
        transaction.insert(SYNTHETIC_ACTOR_ALPHA, syntheticRecord("analysis_run", 1));
        transaction.insert(SYNTHETIC_ACTOR_ALPHA, syntheticRecord("job", 2));
        throw new Error("synthetic_partial_failure");
      }),
    ).toThrow("synthetic_partial_failure");
    expect(store.size()).toBe(0);
  });
});
