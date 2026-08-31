import { canonicalSha256 } from "../../canonical.ts";
import {
  PlatformPersistenceError,
  type AtomicCommand,
  type TransactionReceipt,
} from "../../contracts.ts";
import { statement, type PostgresTransactionContext } from "../contracts.ts";
import { assertSha256, rowBoolean, rowJson, rowObject, rowSafeInteger, rowSha256, rowString } from "./codec.ts";

const RESERVE = `
insert into public.engine_idempotency_records (
  tenant_id, canonical_case_id, scope, idempotency_key, command_sha256, state, created_at
) values ($1, $2, $3, $4, $5, 'reserved', $6::timestamptz)
on conflict (tenant_id, scope, idempotency_key) do nothing
returning tenant_id, case_id::text as case_id, scope, idempotency_key,
          command_sha256, state, result_sha256, result_payload`;

const LOCK = `
select tenant_id, coalesce(canonical_case_id, case_id::text) as case_id,
       scope, idempotency_key, command_sha256, state, result_sha256, result_payload
from public.engine_idempotency_records
where tenant_id = $1 and scope = $2 and idempotency_key = $3
for update`;

const COMMIT = `
update public.engine_idempotency_records
set state = 'committed', result_sha256 = $5, result_payload = $6::jsonb,
    committed_at = $7::timestamptz
where tenant_id = $1 and scope = $2 and idempotency_key = $3
  and command_sha256 = $4 and state = 'reserved'
returning tenant_id`;

export class PostgresIdempotencyRepository {
  async execute(
    context: PostgresTransactionContext,
    command: AtomicCommand,
    operation: () => Promise<TransactionReceipt>,
  ): Promise<TransactionReceipt> {
    validateCommand(command);
    await context.client.query(statement("idempotency_reserve", RESERVE, [
      command.tenant_id,
      command.case_id,
      command.scope,
      command.idempotency_key,
      command.command_sha256,
      command.occurred_at,
    ]));

    const locked = await context.client.query(statement("idempotency_lock", LOCK, [
      command.tenant_id,
      command.scope,
      command.idempotency_key,
    ]));
    if (locked.row_count !== 1 || locked.rows.length !== 1) throw new PlatformPersistenceError("RECORD_NOT_FOUND");
    const row = rowObject(locked.rows[0]);
    if (rowString(row, "command_sha256") !== command.command_sha256) {
      throw new PlatformPersistenceError("IDEMPOTENCY_KEY_COMMAND_MISMATCH");
    }

    if (rowString(row, "state") === "committed") {
      return Object.freeze({ ...decodeReceipt(rowJson(row, "result_payload")), idempotent_replay: true });
    }
    if (rowString(row, "state") !== "reserved") throw new PlatformPersistenceError("INVALID_STATE_TRANSITION");

    const receipt = await operation();
    validateReceipt(command, receipt);
    const persisted = Object.freeze({ ...receipt, idempotent_replay: false });
    const resultSha256 = canonicalSha256(persisted);
    const committed = await context.client.query(statement("idempotency_commit", COMMIT, [
      command.tenant_id,
      command.scope,
      command.idempotency_key,
      command.command_sha256,
      resultSha256,
      JSON.stringify(persisted),
      command.occurred_at,
    ]));
    if (committed.row_count !== 1) throw new PlatformPersistenceError("IDEMPOTENCY_KEY_COMMAND_MISMATCH");
    return persisted;
  }
}

function validateCommand(command: AtomicCommand): void {
  assertSha256(command.command_sha256);
  if (canonicalSha256(command.command) !== command.command_sha256) {
    throw new PlatformPersistenceError("PAYLOAD_HASH_MISMATCH");
  }
  if (!Number.isSafeInteger(command.expected_case_revision) || command.expected_case_revision < 0) {
    throw new PlatformPersistenceError("CASE_REVISION_CONFLICT");
  }
}

function validateReceipt(command: AtomicCommand, receipt: TransactionReceipt): void {
  if (receipt.tenant_id !== command.tenant_id || receipt.case_id !== command.case_id) {
    throw new PlatformPersistenceError("RECORD_NOT_FOUND");
  }
  if (receipt.command_sha256 !== command.command_sha256 || receipt.idempotent_replay) {
    throw new PlatformPersistenceError("PAYLOAD_HASH_MISMATCH");
  }
  assertSha256(receipt.audit_event_sha256);
  if (!Number.isSafeInteger(receipt.case_revision) || receipt.case_revision < 0) {
    throw new PlatformPersistenceError("CASE_REVISION_CONFLICT");
  }
}

function decodeReceipt(value: unknown): TransactionReceipt {
  const row = rowObject(value);
  const outbox = row.outbox_ids;
  if (!Array.isArray(outbox) || outbox.some((entry) => typeof entry !== "string")) {
    throw new TypeError("POSTGRES_ROW_MALFORMED");
  }
  return Object.freeze({
    tenant_id: rowString(row, "tenant_id"),
    case_id: rowString(row, "case_id"),
    case_revision: rowSafeInteger(row, "case_revision"),
    command_sha256: rowSha256(row, "command_sha256"),
    audit_event_sha256: rowSha256(row, "audit_event_sha256"),
    outbox_ids: Object.freeze([...outbox]) as readonly string[],
    idempotent_replay: rowBoolean(row, "idempotent_replay"),
  });
}
