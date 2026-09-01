import { z } from "zod";
import type { PostgresQueryResult, PostgresTransactionContext } from "../../../platform/persistence/postgres/contracts.ts";
import {
  captureExactBytesForImport,
  controlledImportCanonicalJson,
  controlledImportCommandSchema,
  ControlledImportLedgerError,
  controlledImportLeaseSchema,
  controlledImportSha256,
  controlledImportStatusSchema,
  createControlledImportCommand,
  type ControlledImportCommand,
  type ControlledImportLease,
  type ExactByteReopenSource,
} from "./contracts.ts";
import { CONTROLLED_IMPORT_SQL, controlledImportStatement } from "./sql.ts";

const publishedBytesRowSchema = z.object({
  artifact_bytes: z.instanceof(Uint8Array),
  artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  byte_count: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/u)]),
}).passthrough();

function one(result: PostgresQueryResult) {
  if (result.row_count !== 1 || result.rows.length !== 1 || !result.rows[0]) throw new ControlledImportLedgerError("IMPORT_ROW_MALFORMED");
  return result.rows[0];
}

function parseStatus(row: Readonly<Record<string, unknown>>) {
  const status = controlledImportStatusSchema.safeParse(row);
  if (!status.success) throw new ControlledImportLedgerError("IMPORT_ROW_MALFORMED");
  const publicationComplete = status.data.publication_id !== null && status.data.publication_receipt_sha256 !== null;
  if (status.data.visible !== (status.data.state === "published" && publicationComplete)) {
    throw new ControlledImportLedgerError("IMPORT_ROW_MALFORMED");
  }
  return Object.freeze(status.data);
}

function assertCommandBinding(commandInput: ControlledImportCommand) {
  const command = controlledImportCommandSchema.parse(commandInput);
  const rebuilt = createControlledImportCommand({
    idempotency_key: command.idempotency_key,
    source_id: command.source_id,
    actor_id: command.actor_id,
    request_payload: command.request_payload,
    expected_artifact_sha256: command.expected_artifact_sha256,
    requested_at: command.requested_at,
  });
  if (rebuilt.operation_id !== command.operation_id || rebuilt.request_sha256 !== command.request_sha256) {
    throw new ControlledImportLedgerError("IMPORT_IDEMPOTENCY_BINDING_MISMATCH");
  }
  return command;
}

function assertLease(input: ControlledImportLease) {
  return controlledImportLeaseSchema.parse(input);
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof ControlledImportLedgerError) throw error;
  const candidate = error as { code?: unknown; sqlstate?: unknown };
  const code = typeof candidate.sqlstate === "string" ? candidate.sqlstate : candidate.code;
  if (code === "CI001") throw new ControlledImportLedgerError("IMPORT_IDEMPOTENCY_BINDING_MISMATCH");
  if (code === "CI002") throw new ControlledImportLedgerError("IMPORT_LEASE_FENCED");
  if (code === "CI003") throw new ControlledImportLedgerError("IMPORT_INVALID_STATE");
  if (code === "42P01" || code === "42883") throw new ControlledImportLedgerError("IMPORT_DATABASE_CONTRACT_MISSING");
  throw new ControlledImportLedgerError("IMPORT_ROW_MALFORMED");
}

export class PostgresControlledImportLedgerRepository {
  async reserve(context: PostgresTransactionContext, commandInput: ControlledImportCommand) {
    const command = assertCommandBinding(commandInput);
    try {
      const result = await context.client.query(controlledImportStatement(CONTROLLED_IMPORT_SQL.reserve, [
        command.operation_id,
        command.idempotency_key,
        command.source_id,
        command.actor_id,
        controlledImportCanonicalJson(command.request_payload),
        command.request_sha256,
        command.expected_artifact_sha256,
        command.requested_at,
      ]));
      const status = parseStatus(one(result));
      if (status.operation_id !== command.operation_id
        || status.source_id !== command.source_id
        || status.actor_id !== command.actor_id
        || status.request_sha256 !== command.request_sha256
        || status.expected_artifact_sha256 !== command.expected_artifact_sha256) {
        throw new ControlledImportLedgerError("IMPORT_IDEMPOTENCY_BINDING_MISMATCH");
      }
      return status;
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async claimRecoverable(context: PostgresTransactionContext, input: Readonly<{
    worker_id: string;
    now: string;
    lease_ms: number;
    limit: number;
  }>) {
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{2,127}$/u.test(input.worker_id)
      || !Number.isSafeInteger(input.lease_ms) || input.lease_ms < 100
      || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new ControlledImportLedgerError("IMPORT_ROW_MALFORMED");
    }
    try {
      const result = await context.client.query(controlledImportStatement(CONTROLLED_IMPORT_SQL.claimRecovery, [
        input.worker_id, input.now, input.lease_ms, input.limit,
      ]));
      return Object.freeze(result.rows.map((row) => controlledImportLeaseSchema.parse(row)));
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async stageExactBytes(context: PostgresTransactionContext, input: Readonly<{
    lease: ControlledImportLease;
    source: ExactByteReopenSource;
    expected_artifact_sha256: string | null;
    occurred_at: string;
    max_bytes?: number;
  }>) {
    const lease = assertLease(input.lease);
    const captured = await captureExactBytesForImport(input.source, { max_bytes: input.max_bytes ?? 20 * 1024 * 1024 });
    if (input.expected_artifact_sha256 && captured.artifact_sha256 !== input.expected_artifact_sha256) {
      throw new ControlledImportLedgerError("IMPORT_ARTIFACT_HASH_MISMATCH");
    }
    try {
      const result = await context.client.query(controlledImportStatement(CONTROLLED_IMPORT_SQL.stageExactBytes, [
        lease.operation_id,
        lease.worker_id,
        lease.fencing_token,
        captured.bytes,
        captured.artifact_sha256,
        captured.identity_token_sha256,
        input.occurred_at,
      ]));
      const status = parseStatus(one(result));
      if (status.operation_id !== lease.operation_id
        || status.artifact_sha256 !== captured.artifact_sha256
        || status.byte_count !== captured.byte_count
        || status.visible) throw new ControlledImportLedgerError("IMPORT_ROW_MALFORMED");
      return Object.freeze({ status, captured });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async reject(context: PostgresTransactionContext, input: Readonly<{
    lease: ControlledImportLease;
    reason: string;
    occurred_at: string;
  }>) {
    const lease = assertLease(input.lease);
    if (!/^[A-Z0-9_]{3,96}$/u.test(input.reason)) throw new ControlledImportLedgerError("IMPORT_ROW_MALFORMED");
    try {
      const result = await context.client.query(controlledImportStatement(CONTROLLED_IMPORT_SQL.reject, [
        lease.operation_id, lease.worker_id, lease.fencing_token, input.reason, input.occurred_at,
      ]));
      const status = parseStatus(one(result));
      if (status.state !== "rejected" || status.visible) throw new ControlledImportLedgerError("IMPORT_ROW_MALFORMED");
      return status;
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async publish(context: PostgresTransactionContext, input: Readonly<{
    lease: ControlledImportLease;
    request_sha256: string;
    artifact_sha256: string;
    occurred_at: string;
  }>) {
    const lease = assertLease(input.lease);
    const publicationId = controlledImportSha256(controlledImportCanonicalJson({
      operation_id: lease.operation_id,
      request_sha256: input.request_sha256,
      artifact_sha256: input.artifact_sha256,
    }));
    try {
      const result = await context.client.query(controlledImportStatement(CONTROLLED_IMPORT_SQL.publish, [
        lease.operation_id,
        lease.worker_id,
        lease.fencing_token,
        publicationId,
        input.artifact_sha256,
        input.occurred_at,
      ]));
      const status = parseStatus(one(result));
      if (!status.visible || status.state !== "published" || status.publication_id !== publicationId) {
        throw new ControlledImportLedgerError("IMPORT_PUBLICATION_INVISIBLE");
      }
      return status;
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async getStatus(context: PostgresTransactionContext, operationId: string) {
    try {
      const result = await context.client.query(controlledImportStatement(CONTROLLED_IMPORT_SQL.status, [operationId]));
      return result.row_count === 0 ? null : parseStatus(one(result));
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async openPublishedBytes(context: PostgresTransactionContext, operationId: string) {
    try {
      const result = await context.client.query(controlledImportStatement(CONTROLLED_IMPORT_SQL.openPublishedBytes, [operationId]));
      if (result.row_count === 0) throw new ControlledImportLedgerError("IMPORT_PUBLICATION_INVISIBLE");
      const parsed = publishedBytesRowSchema.safeParse(one(result));
      if (!parsed.success) throw new ControlledImportLedgerError("IMPORT_ROW_MALFORMED");
      const bytes = Buffer.from(parsed.data.artifact_bytes);
      const byteCount = typeof parsed.data.byte_count === "string" ? Number(parsed.data.byte_count) : parsed.data.byte_count;
      if (bytes.byteLength !== byteCount || controlledImportSha256(bytes) !== parsed.data.artifact_sha256) {
        throw new ControlledImportLedgerError("IMPORT_ARTIFACT_HASH_MISMATCH");
      }
      return Object.freeze({ bytes: Uint8Array.from(bytes), artifact_sha256: parsed.data.artifact_sha256, byte_count: byteCount });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }
}
