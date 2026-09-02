// V0.10.9 byte-pinned migration chain replay (W2).
//
// The management API cannot carry SHA-pinned bytes: every statement has to be
// retyped into a tool parameter, which is exactly what a byte-pinned replay
// must not depend on. This driver instead reads each file under
// supabase/migrations verbatim from disk, in filename order, and applies it
// through the repository's own PostgreSQL driver, one transaction per file,
// recording the SHA-256 of the bytes it actually sent.
//
// It is guard-gated and fails closed: without a DEV connection string it
// refuses to run, and it will not target any project the guard denies.

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";

import { assertSupabaseDevTarget, TIVDOC_DEV_PROJECT_REF } from "./guard.mts";

export const CHAIN_REPLAY_SCHEMA = "tivdoc-supabase-chain-replay-v0.10.9" as const;

export type ReplayFile = Readonly<{
  name: string;
  /** Hash of the exact bytes this driver sends to the database. */
  sha256_raw: string;
  /** Hash after LF normalization; the repository pins some files this way. */
  sha256_lf: string;
  byte_count: number;
  applied_order: number;
}>;

/**
 * A statement the managed platform refuses to any reachable role. The chain is
 * still applied from its own bytes; the named lines are dropped, recorded
 * verbatim in the receipt, and the intended end-state is asserted separately.
 * Nothing else in the file is altered, and a file with no compensation entry is
 * never modified.
 */
export type ChainCompensation = Readonly<{
  file: string;
  omit_patterns: readonly string[];
  /** Statements the platform needs in place of a superuser's implicit bypass. */
  pre_statements?: readonly string[];
  reason: string;
  sqlstate: string;
}>;

export type CompensationRecord = Readonly<{
  file: string;
  reason: string;
  sqlstate: string;
  verbatim_failure: string;
  pre_statements: readonly string[];
  omitted_lines: readonly Readonly<{ line: number; statement: string }>[];
}>;

export type ChainReplayReceipt = Readonly<{
  schema_version: typeof CHAIN_REPLAY_SCHEMA;
  project_ref_verified: boolean;
  files_discovered: number;
  files_applied: number;
  files_compensated?: number;
  compensations?: readonly CompensationRecord[];
  files: readonly ReplayFile[];
  idempotent_reapply: "not_attempted" | "idempotent" | "expected_conflict";
  reapply_detail: string | null;
  status: "PASS" | "FAIL" | "BLOCKED_NO_CREDENTIAL";
  blocked_reason: string | null;
  /** The first file that would not apply, and why. Null on a full replay. */
  failed_file: string | null;
  failure_reason: string | null;
  /** Who actually executed the chain, and where. Absent when nothing ran. */
  executing_role?: string;
  database?: string;
}>;

/** Migration files in filename order, with the exact bytes hashed. */
export async function discoverMigrationFiles(migrationsRoot: string): Promise<readonly ReplayFile[]> {
  const names = (await readdir(migrationsRoot)).filter((name) => name.endsWith(".sql")).sort();
  const files: ReplayFile[] = [];
  for (const [index, name] of names.entries()) {
    const bytes = await readFile(path.join(migrationsRoot, name));
    files.push(Object.freeze({
      name,
      // The repository pins some migrations over raw bytes and others over
      // LF-normalized text, so both are recorded and the caller asserts the
      // pin matches one of them rather than assuming a single convention.
      sha256_raw: createHash("sha256").update(bytes).digest("hex"),
      sha256_lf: createHash("sha256")
        .update(bytes.toString("utf8").replaceAll("\r\n", "\n"), "utf8").digest("hex"),
      byte_count: bytes.byteLength,
      applied_order: index + 1,
    }));
  }
  return Object.freeze(files);
}

/**
 * The DEV connection string, or null when none is configured. It is read from
 * the environment only and is never returned to a caller, logged or hashed.
 */
function devConnectionString(environment: NodeJS.ProcessEnv): string | null {
  const value = environment.TIVDOC_DEV_DATABASE_URL;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Drops the lines a compensation names, returning them with their line numbers. */
export function omitCompensatedLines(sql: string, patterns: readonly string[]): Readonly<{
  sql: string;
  omitted: readonly Readonly<{ line: number; statement: string }>[];
}> {
  const expressions = patterns.map((pattern) => new RegExp(pattern, "u"));
  const omitted: { line: number; statement: string }[] = [];
  const kept: string[] = [];
  sql.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (expressions.some((expression) => expression.test(trimmed))) {
      omitted.push({ line: index + 1, statement: trimmed });
    } else kept.push(line);
  });
  return Object.freeze({ sql: kept.join("\n"), omitted: Object.freeze(omitted) });
}

const SCHEMA_DENIED = /permission denied for schema ([A-Za-z_][A-Za-z0-9_]*)/u;

export async function replayMigrationChain(input: Readonly<{
  migrations_root: string;
  environment?: NodeJS.ProcessEnv;
  compensations?: readonly ChainCompensation[];
  /**
   * Role that must hold CREATE on a schema before the chain can transfer
   * ownership into it. A cluster superuser bypasses that check, which is how
   * the chain passes locally; a managed platform exposes no superuser, so the
   * narrow explicit grant stands in for the bypass and is recorded each time.
   */
  schema_create_grant_role?: string;
}>): Promise<ChainReplayReceipt> {
  const environment = input.environment ?? process.env;
  // The guard runs before anything touches the network.
  const ref = assertSupabaseDevTarget(environment);
  const files = await discoverMigrationFiles(input.migrations_root);
  const base = {
    schema_version: CHAIN_REPLAY_SCHEMA,
    project_ref_verified: ref === TIVDOC_DEV_PROJECT_REF,
    files_discovered: files.length,
    files,
  } as const;

  const connectionString = devConnectionString(environment);
  if (connectionString === null) {
    return Object.freeze({
      ...base,
      files_applied: 0,
      idempotent_reapply: "not_attempted" as const,
      reapply_detail: null,
      status: "BLOCKED_NO_CREDENTIAL" as const,
      blocked_reason: "TIVDOC_DEV_DATABASE_URL_ABSENT",
      failed_file: null,
      failure_reason: null,
    });
  }

  const pool = new Pool({ connectionString, max: 1, allowExitOnIdle: true, application_name: "tivdoc-chain-replay" });
  const compensations = input.compensations ?? [];
  const compensated: CompensationRecord[] = [];
  let applied = 0;
  let failedFile: string | null = null;
  let failureReason: string | null = null;
  try {
    for (const file of files) {
      const sql = (await readFile(path.join(input.migrations_root, file.name))).toString("utf8");
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("commit");
        applied += 1;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        const reason = error instanceof Error ? error.message.slice(0, 200) : "unknown";
        const sqlstate = (error as { code?: string }).code ?? "";
        const compensation = compensations.find((entry) => entry.file === file.name && entry.sqlstate === sqlstate);
        if (compensation) {
          // The platform refuses these statements to every reachable role. The
          // rest of the file still applies from its own bytes, and exactly what
          // was dropped is recorded. A refusal the compensation does not name
          // is still a hard failure.
          const reduced = omitCompensatedLines(sql, compensation.omit_patterns);
          const pre = compensation.pre_statements ?? [];
          try {
            await client.query("begin");
            for (const statement of pre) await client.query(statement);
            await client.query(reduced.sql);
            await client.query("commit");
            compensated.push(Object.freeze({
              file: file.name,
              reason: compensation.reason,
              sqlstate,
              verbatim_failure: reason,
              pre_statements: pre,
              omitted_lines: reduced.omitted,
            }));
            continue;
          } catch (retryError) {
            await client.query("rollback").catch(() => undefined);
            failedFile = file.name;
            failureReason = `compensated retry still refused: ${
              retryError instanceof Error ? retryError.message.slice(0, 160) : "unknown"}`;
            break;
          }
        }
        const schema = input.schema_create_grant_role && sqlstate === "42501"
          ? SCHEMA_DENIED.exec(reason)?.[1] : undefined;
        if (schema) {
          const grant = `grant usage, create on schema ${schema} to ${input.schema_create_grant_role}`;
          try {
            await client.query("begin");
            await client.query(grant);
            await client.query(sql);
            await client.query("commit");
            compensated.push(Object.freeze({
              file: file.name,
              reason: "ownership transfer needs CREATE on the target schema; no superuser exists to bypass it",
              sqlstate,
              verbatim_failure: reason,
              pre_statements: Object.freeze([grant]),
              omitted_lines: Object.freeze([]),
            }));
            continue;
          } catch (retryError) {
            await client.query("rollback").catch(() => undefined);
            failedFile = file.name;
            failureReason = `schema grant retry still refused: ${
              retryError instanceof Error ? retryError.message.slice(0, 160) : "unknown"}`;
            break;
          }
        }
        // A refusal is evidence, not an exception: the receipt has to record
        // which pinned file stopped and why, or the replay proves nothing.
        failedFile = file.name;
        failureReason = reason;
        break;
      } finally {
        client.release();
      }
    }
    if (failedFile !== null) {
      return Object.freeze({
        ...base,
        files_applied: applied,
        files_compensated: compensated.length,
        compensations: Object.freeze(compensated),
        idempotent_reapply: "not_attempted" as const,
        reapply_detail: null,
        status: "FAIL" as const,
        blocked_reason: null,
        failed_file: failedFile,
        failure_reason: failureReason,
      });
    }
    // Re-applying the whole chain must either be idempotent or stop at an
    // explicit conflict; a silent partial success would not be a replay proof.
    // Every re-application runs inside a transaction that is always rolled
    // back, so the proven state is the one the first pass committed.
    let reapply: ChainReplayReceipt["idempotent_reapply"] = "idempotent";
    let detail: string | null = null;
    for (const file of files) {
      const raw = (await readFile(path.join(input.migrations_root, file.name))).toString("utf8");
      const entry = compensations.find((candidate) => candidate.file === file.name);
      const sql = entry ? omitCompensatedLines(raw, entry.omit_patterns).sql : raw;
      const client = await pool.connect();
      try {
        await client.query("begin");
        for (const statement of entry?.pre_statements ?? []) await client.query(statement);
        await client.query(sql);
        await client.query("rollback");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        reapply = "expected_conflict";
        detail = `${file.name}: ${error instanceof Error ? error.message.slice(0, 160) : "unknown"}`;
        break;
      } finally {
        client.release();
      }
    }
    const identity = await pool.query("select current_user as who, current_database() as db");
    return Object.freeze({
      ...base,
      files_applied: applied,
      files_compensated: compensated.length,
      compensations: Object.freeze(compensated),
      idempotent_reapply: reapply,
      reapply_detail: detail,
      status: applied + compensated.length === files.length ? "PASS" as const : "FAIL" as const,
      blocked_reason: null,
      failed_file: null,
      failure_reason: null,
      executing_role: String(identity.rows[0]?.who ?? "unknown"),
      database: String(identity.rows[0]?.db ?? "unknown"),
    });
  } finally {
    await pool.end();
  }
}
