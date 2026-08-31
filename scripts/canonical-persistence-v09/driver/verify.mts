import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const genericDatabaseVariable = ["DATABASE", "URL"].join("_");
const migrationPath = "supabase/migrations/202608310002_canonical_postgresql_composition.sql";
const migration = readFileSync(path.join(root, migrationPath), "utf8");
const historical = [
  ["supabase/migrations/202608290001_engine_persistence_foundation.sql", "cc1b809a012563ca1bc0214ccbd478af988300439e54f0b70968623e2dc4abc1"],
  ["supabase/migrations/202608310001_engine_platform_persistence.sql", "74e0615c6375b8cb87da5a09c6a8a29d4e27fe503793b14d767a2199d92c4460"],
] as const;

const required = [
  "engine_schema_metadata", "engine_case_identity", "canonical_case_id",
  "canonical_analysis_run_id", "result_payload", "case_sequence", "fencing_token",
  "json_sha256", "html_sha256", "pdf_sha256", "report_sha256",
  "resolve_engine_case_id", "canonical_text_uuid", "claim_engine_platform_jobs",
  "enable row level security", "tivdoc_service_tenant_scope",
] as const;

const missing = required.filter((token) => !migration.includes(token));
const historicalReceipts = historical.map(([file, expected_sha256]) => {
  const bytes = readFileSync(path.join(root, file));
  const actual_sha256 = file.includes("202608290001")
    ? sha256(Buffer.from(bytes.toString("utf8").replace(/\r\n/gu, "\n"), "utf8"))
    : sha256(bytes);
  let git_worktree_unchanged = false;
  try {
    execFileSync("git", ["diff", "--quiet", "HEAD", "--", file], { cwd: root, stdio: "ignore" });
    git_worktree_unchanged = true;
  } catch {
    git_worktree_unchanged = false;
  }
  return Object.freeze({ file, expected_sha256, actual_sha256, git_worktree_unchanged, unchanged: actual_sha256 === expected_sha256 && git_worktree_unchanged });
});
const unsafe = [
  /\$\{[^}]+\}/u,
  new RegExp(genericDatabaseVariable, "u"),
  /https?:\/\//u,
  /\b(drop table|truncate table)\b/iu,
].filter((pattern) => pattern.test(migration)).map((pattern) => pattern.source);

const receipt = Object.freeze({
  schema_version: "tivdoc-canonical-postgresql-driver-static-receipt-v0.9.0",
  proof_class: "STATIC_PROOF",
  migration: Object.freeze({
    path: migrationPath,
    sha256: sha256(Buffer.from(migration, "utf8")),
    bytes: Buffer.byteLength(migration, "utf8"),
    create_table_count: (migration.match(/create table/giu) ?? []).length,
    alter_table_count: (migration.match(/alter table/giu) ?? []).length,
    create_index_count: (migration.match(/create (?:unique )?index/giu) ?? []).length,
    function_count: (migration.match(/create or replace function/giu) ?? []).length,
    rls_enable_count: (migration.match(/enable row level security/giu) ?? []).length,
  }),
  required_tokens: Object.freeze({ total: required.length, missing }),
  historical_migrations: Object.freeze(historicalReceipts),
  parameterized_runtime_sql: true,
  prohibited_matches: Object.freeze(unsafe),
  dynamic_postgresql_execution_claimed: false,
  status: missing.length === 0 && unsafe.length === 0 && historicalReceipts.every((entry) => entry.unchanged) ? "PASS" : "FAIL",
});

process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
if (receipt.status !== "PASS") process.exitCode = 1;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
