import { statement, type PostgresParameter } from "../../../platform/persistence/postgres/contracts.ts";

type SqlDefinition = Readonly<{ name: string; text: string }>;

export const CONTROLLED_IMPORT_SQL = Object.freeze({
  reserve: Object.freeze({
    name: "controlled_import_reserve",
    text: `select * from private.controlled_import_reserve(
      $1, $2, $3, $4, $5::jsonb, $6, $7, $8::timestamptz
    )`,
  }),
  claimRecovery: Object.freeze({
    name: "controlled_import_claim_recovery",
    text: `select * from private.claim_controlled_import_recovery(
      $1, $2::timestamptz, $3 * interval '1 millisecond', $4
    )`,
  }),
  stageExactBytes: Object.freeze({
    name: "controlled_import_stage_exact_bytes",
    text: `select * from private.controlled_import_stage_exact_bytes(
      $1, $2, $3, $4::bytea, $5, $6, $7::timestamptz
    )`,
  }),
  reject: Object.freeze({
    name: "controlled_import_reject",
    text: `select * from private.controlled_import_reject(
      $1, $2, $3, $4, $5::timestamptz
    )`,
  }),
  publish: Object.freeze({
    name: "controlled_import_publish",
    text: `select * from private.controlled_import_publish(
      $1, $2, $3, $4, $5, $6::timestamptz
    )`,
  }),
  status: Object.freeze({
    name: "controlled_import_status",
    text: `select operation_id, source_id, actor_id, request_sha256,
      expected_artifact_sha256, artifact_sha256, byte_count, state,
      fencing_token, publication_id, publication_receipt_sha256, visible,
      rejection_reason
    from public.controlled_import_publication_status_v1
    where operation_id = $1`,
  }),
  openPublishedBytes: Object.freeze({
    name: "controlled_import_open_published",
    text: `select artifact_bytes, artifact_sha256, byte_count
    from private.open_controlled_import_published_bytes($1)`,
  }),
} satisfies Readonly<Record<string, SqlDefinition>>);

export function controlledImportStatement(definition: SqlDefinition, values: readonly PostgresParameter[]) {
  return statement(definition.name, definition.text, values);
}

export const controlledImportMigrationRequest = Object.freeze({
  migration_id: "202609010001_controlled_import_ledger",
  requested_path: "supabase/migrations/202609010001_controlled_import_ledger.sql",
  draft_path: "src/server/engine/legal-knowledge/controlled-import-ledger/migration-request.sql",
  status: "ORCHESTRATOR_MIGRATION_INTEGRATION_REQUIRED" as const,
  product_wiring_enabled: false as const,
  affected_acceptance_ids: Object.freeze(["MC-11"]),
});
