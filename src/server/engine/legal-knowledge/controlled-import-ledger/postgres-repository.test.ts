import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  PostgresClient,
  PostgresQueryResult,
  PostgresStatement,
  PostgresTransactionContext,
} from "../../../platform/persistence/postgres/contracts.ts";
import {
  controlledImportSha256,
  createControlledImportCommand,
  type ExactByteReopenSource,
} from "./contracts.ts";
import { PostgresControlledImportLedgerRepository } from "./postgres-repository.ts";
import { controlledImportMigrationRequest } from "./sql.ts";
import { CanonicalPostgresError } from "../../../platform/persistence/postgres/runtime/errors.ts";

class QueueClient implements PostgresClient {
  readonly statements: PostgresStatement[] = [];
  readonly #results: PostgresQueryResult[];

  constructor(results: PostgresQueryResult[]) {
    this.#results = [...results];
  }

  async query(statement: PostgresStatement) {
    this.statements.push(statement);
    const result = this.#results.shift();
    if (!result) throw new Error("unexpected query");
    return result;
  }
}

function result(...rows: Readonly<Record<string, unknown>>[]): PostgresQueryResult {
  return { rows, row_count: rows.length };
}

const requestedAt = "2026-09-01T00:00:00.000Z";
const command = createControlledImportCommand({
  idempotency_key: "IMPORT:MC11:SYNTHETIC:001",
  source_id: "SOURCE:SYNTHETIC:001",
  actor_id: "ACTOR:SYNTHETIC:001",
  request_payload: { fixture: "synthetic", persistent_owner_import: false },
  expected_artifact_sha256: null,
  requested_at: requestedAt,
});

function status(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    operation_id: command.operation_id,
    source_id: command.source_id,
    actor_id: command.actor_id,
    request_sha256: command.request_sha256,
    expected_artifact_sha256: null,
    artifact_sha256: null,
    byte_count: null,
    state: "received",
    fencing_token: 0,
    publication_id: null,
    publication_receipt_sha256: null,
    visible: false,
    rejection_reason: null,
    ...overrides,
  };
}

function context(client: PostgresClient): PostgresTransactionContext {
  return { client, transaction_id: "postgres-transaction-synthetic-001" };
}

describe("MC-11 canonical PostgreSQL controlled import ledger", () => {
  it("binds idempotency, exact reopened bytes, a fencing lease and atomic publication visibility", async () => {
    const bytes = Buffer.from("synthetic exact controlled import bytes");
    const artifactSha256 = controlledImportSha256(bytes);
    const lease = {
      operation_id: command.operation_id,
      worker_id: "WORKER:SYNTHETIC:001",
      fencing_token: 1,
      lease_expires_at: "2026-09-01T00:05:00.000Z",
      state: "leased" as const,
    };
    const publicationId = controlledImportSha256(`${JSON.stringify({
      artifact_sha256: artifactSha256,
      operation_id: command.operation_id,
      request_sha256: command.request_sha256,
    })}\n`);
    const client = new QueueClient([
      result(status()),
      result(lease),
      result(status({ state: "validated", fencing_token: 1, artifact_sha256: artifactSha256, byte_count: bytes.byteLength })),
      result(status({ state: "validated", fencing_token: 1, artifact_sha256: artifactSha256, byte_count: bytes.byteLength })),
      result(status({
        state: "published",
        fencing_token: 1,
        artifact_sha256: artifactSha256,
        byte_count: bytes.byteLength,
        publication_id: publicationId,
        publication_receipt_sha256: "e".repeat(64),
        visible: true,
      })),
      result({ artifact_bytes: bytes, artifact_sha256: artifactSha256, byte_count: bytes.byteLength }),
    ]);
    const repository = new PostgresControlledImportLedgerRepository();
    const tx = context(client);
    await expect(repository.reserve(tx, command)).resolves.toMatchObject({ state: "received", visible: false });
    await expect(repository.claimRecoverable(tx, {
      worker_id: lease.worker_id,
      now: requestedAt,
      lease_ms: 300_000,
      limit: 1,
    })).resolves.toEqual([lease]);
    let reopens = 0;
    const source: ExactByteReopenSource = {
      async reopenExact() {
        reopens += 1;
        return { bytes, identity_token: "synthetic-device:synthetic-inode:37:revision-1" };
      },
    };
    await expect(repository.stageExactBytes(tx, {
      lease,
      source,
      expected_artifact_sha256: null,
      occurred_at: "2026-09-01T00:01:00.000Z",
    })).resolves.toMatchObject({ status: { state: "validated", visible: false } });
    expect(reopens).toBe(2);
    await expect(repository.getStatus(tx, command.operation_id)).resolves.toMatchObject({ state: "validated", visible: false });
    await expect(repository.publish(tx, {
      lease: { ...lease, state: "validated" },
      request_sha256: command.request_sha256,
      artifact_sha256: artifactSha256,
      occurred_at: "2026-09-01T00:02:00.000Z",
    })).resolves.toMatchObject({ state: "published", visible: true, publication_id: publicationId });
    await expect(repository.openPublishedBytes(tx, command.operation_id)).resolves.toMatchObject({
      artifact_sha256: artifactSha256,
      byte_count: bytes.byteLength,
    });
    expect(client.statements.map((entry) => entry.name)).toEqual([
      "controlled_import_reserve",
      "controlled_import_claim_recovery",
      "controlled_import_stage_exact_bytes",
      "controlled_import_status",
      "controlled_import_publish",
      "controlled_import_open_published",
    ]);
    expect(client.statements.every((entry) => !entry.text.includes(command.source_id))).toBe(true);
  });

  it("rejects a TOCTOU reopen mismatch before PostgreSQL receives any byte", async () => {
    const client = new QueueClient([]);
    const repository = new PostgresControlledImportLedgerRepository();
    let call = 0;
    await expect(repository.stageExactBytes(context(client), {
      lease: {
        operation_id: command.operation_id,
        worker_id: "WORKER:SYNTHETIC:002",
        fencing_token: 1,
        lease_expires_at: "2026-09-01T00:05:00.000Z",
        state: "leased",
      },
      source: {
        async reopenExact() {
          call += 1;
          return { bytes: Buffer.from(call === 1 ? "first bytes" : "changed bytes"), identity_token: `revision-${call}` };
        },
      },
      expected_artifact_sha256: null,
      occurred_at: "2026-09-01T00:01:00.000Z",
    })).rejects.toThrow("IMPORT_TOCTOU_REOPEN_MISMATCH");
    expect(client.statements).toHaveLength(0);
  });

  it.each([
    ["CI001", "IMPORT_IDEMPOTENCY_BINDING_MISMATCH"],
    ["CI002", "IMPORT_LEASE_FENCED"],
    ["CI003", "IMPORT_INVALID_STATE"],
    ["42P01", "IMPORT_DATABASE_CONTRACT_MISSING"],
    ["42883", "IMPORT_DATABASE_CONTRACT_MISSING"],
  ] as const)("maps canonical driver sqlstate %s without exposing database text", async (sqlstate, expected) => {
    const repository = new PostgresControlledImportLedgerRepository();
    const failingClient: PostgresClient = {
      async query() {
        throw new CanonicalPostgresError("POSTGRES_STATEMENT_FAILED", { sqlstate });
      },
    };
    await expect(repository.reserve(context(failingClient), command)).rejects.toThrow(expected);
  });

  it("keeps the installed forward migration explicit and bypass-resistant", async () => {
    const migration = await readFile(path.join(import.meta.dirname, "migration-request.sql"), "utf8");
    const installed = await readFile(path.resolve(
      import.meta.dirname,
      "..", "..", "..", "..", "..",
      controlledImportMigrationRequest.requested_path,
    ), "utf8");
    expect(installed.replaceAll("\r\n", "\n").trimEnd()).toBe(migration.replaceAll("\r\n", "\n").trimEnd());
    expect(controlledImportMigrationRequest).toMatchObject({
      status: "CANONICAL_FORWARD_MIGRATION_INSTALLED",
      product_wiring_enabled: false,
      isolated_dynamic_verification_required: true,
    });
    for (const required of [
      "pg_advisory_xact_lock",
      "for update skip locked",
      "CONTROLLED_IMPORT_APPEND_ONLY",
      "controlled_import_publication_markers",
      "open_controlled_import_published_bytes",
      "octet_length(artifact_bytes) = byte_count",
      "digest(artifact_bytes, 'sha256')",
      "revoke all on private.controlled_import_requests",
      "grant execute on function private.controlled_import_publish",
      "security definer",
    ]) expect(migration.toLocaleLowerCase("en-US")).toContain(required.toLocaleLowerCase("en-US"));
  });
});
