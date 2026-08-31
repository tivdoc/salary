import { StrictRecordingPostgresDriver } from "../../../src/server/platform/persistence/postgres/runtime/recording-driver.ts";
import { CanonicalPostgresTransactionManager } from "../../../src/server/platform/persistence/postgres/runtime/transaction-manager.ts";
import { statement } from "../../../src/server/platform/persistence/postgres/contracts.ts";

const driver = new StrictRecordingPostgresDriver([
  { statement_name: "transaction_begin" },
  { statement_name: "case_revision_write", result: { rows: [{ revision: "1" }], row_count: 1 } },
  { statement_name: "audit_append", result: { rows: [{ sequence: "1" }], row_count: 1 } },
  { statement_name: "outbox_append", result: { rows: [{ outbox_id: "opaque" }], row_count: 1 } },
  { statement_name: "transaction_commit" },
]);
const manager = new CanonicalPostgresTransactionManager(driver);

await manager.transaction(async (context) => {
  await context.client.query(statement("case_revision_write", "update engine_case_state set revision = revision + 1 where tenant_id = $1 and canonical_case_id = $2 and revision = $3 returning revision", ["tenant-synthetic", "case-synthetic", 0]));
  await context.client.query(statement("audit_append", "insert into engine_platform_audit_events(event_sha256) values ($1) returning sequence", ["a".repeat(64)]));
  await context.client.query(statement("outbox_append", "insert into engine_outbox_events(outbox_id, payload_sha256) values ($1, $2) returning outbox_id", ["outbox-synthetic", "b".repeat(64)]));
});

const inventory = driver.inventory();
process.stdout.write(`${JSON.stringify({
  schema_version: "tivdoc-recording-driver-transaction-receipt-v0.9.0",
  proof_class: inventory.proof_class,
  transaction_group: ["case_revision", "audit", "outbox"],
  acquisitions: inventory.acquisitions,
  releases: inventory.releases,
  remaining_steps: inventory.remaining_steps,
  statements: inventory.statements.map(({ name, parameter_count, transaction_control }) => ({ name, parameter_count, transaction_control })),
  sensitive_parameter_values_recorded: false,
  dynamic_postgresql_execution_claimed: false,
  status: inventory.remaining_steps === 0 && inventory.acquisitions === 1 && inventory.releases === 1 ? "PASS" : "FAIL",
}, null, 2)}\n`);
