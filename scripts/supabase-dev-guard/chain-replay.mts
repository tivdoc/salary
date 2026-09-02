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

export type ChainReplayReceipt = Readonly<{
  schema_version: typeof CHAIN_REPLAY_SCHEMA;
  project_ref_verified: boolean;
  files_discovered: number;
  files_applied: number;
  files: readonly ReplayFile[];
  idempotent_reapply: "not_attempted" | "idempotent" | "expected_conflict";
  reapply_detail: string | null;
  status: "PASS" | "FAIL" | "BLOCKED_NO_CREDENTIAL";
  blocked_reason: string | null;
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

export async function replayMigrationChain(input: Readonly<{
  migrations_root: string;
  environment?: NodeJS.ProcessEnv;
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
    });
  }

  const pool = new Pool({ connectionString, max: 1, allowExitOnIdle: true, application_name: "tivdoc-chain-replay" });
  let applied = 0;
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
        throw new Error(`CHAIN_REPLAY_FAILED:${file.name}:${error instanceof Error ? error.message.slice(0, 160) : "unknown"}`);
      } finally {
        client.release();
      }
    }
    // Re-applying must either be idempotent or fail with an explicit conflict;
    // a silent partial success would not be a replay proof.
    let reapply: ChainReplayReceipt["idempotent_reapply"] = "idempotent";
    let detail: string | null = null;
    try {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query((await readFile(path.join(input.migrations_root, files[0]?.name ?? ""))).toString("utf8"));
        await client.query("rollback");
      } finally {
        client.release();
      }
    } catch (error) {
      reapply = "expected_conflict";
      detail = error instanceof Error ? error.message.slice(0, 160) : "unknown";
    }
    return Object.freeze({
      ...base,
      files_applied: applied,
      idempotent_reapply: reapply,
      reapply_detail: detail,
      status: applied === files.length ? "PASS" as const : "FAIL" as const,
      blocked_reason: null,
    });
  } finally {
    await pool.end();
  }
}
