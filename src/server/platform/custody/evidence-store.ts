import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalSha256, deepFreeze } from "../../../engine/rule-runtime/canonical.ts";

// Wave 6 (K-1, K-2). An immutable local evidence store: a directory tree whose
// every file is named in an append-only, hash-chained index, and whose every
// read and write is named in an append-only, hash-chained access log. A walk
// verifies both chains and the tree against each other and fails on any break:
// a changed byte, a missing file, a file nobody indexed, an edited index line,
// an edited log line. The store refuses to append while either chain is
// broken, so a break stops custody rather than being papered over.
//
// Nothing here is a managed or off-host destination; the store is local by
// construction and says so in its proof. Off-host custody stays
// `blocked_external` (replication.ts, offHostCustodyCapability).

export const EVIDENCE_STORE_SCHEMA_VERSION = "tivdoc-immutable-evidence-store-v0.10.0" as const;
export const EVIDENCE_INDEX_FILE = "index.ndjson" as const;
export const EVIDENCE_ACCESS_LOG_FILE = "access-log.ndjson" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const RELATIVE_PATH = /^(?!\.)(?:[A-Za-z0-9][A-Za-z0-9._@:-]*)(?:\/[A-Za-z0-9][A-Za-z0-9._@:-]*)*$/u;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,159}$/u;
const PURPOSE = /^[a-z][a-z0-9_]{2,63}$/u;
const LEDGERS = new Set<string>([EVIDENCE_INDEX_FILE, EVIDENCE_ACCESS_LOG_FILE]);

export type EvidenceIndexEntry = Readonly<{
  sequence: number;
  relative_path: string;
  sha256: string;
  byte_count: number;
  recorded_at: string;
  actor_id: string;
  purpose: string;
  previous_entry_sha256: string | null;
  entry_sha256: string;
}>;

export type EvidenceAccessEntry = Readonly<{
  sequence: number;
  operation: "append" | "read" | "walk";
  relative_path: string | null;
  sha256: string | null;
  actor_id: string;
  purpose: string;
  occurred_at: string;
  previous_entry_sha256: string | null;
  entry_sha256: string;
}>;

export type EvidenceBreak = Readonly<{
  code:
    | "EVIDENCE_INDEX_LINE_MALFORMED"
    | "EVIDENCE_INDEX_CHAIN_BREAK"
    | "EVIDENCE_INDEX_SEQUENCE_BREAK"
    | "EVIDENCE_FILE_MISSING"
    | "EVIDENCE_FILE_HASH_MISMATCH"
    | "EVIDENCE_FILE_LENGTH_MISMATCH"
    | "EVIDENCE_UNINDEXED_FILE"
    | "EVIDENCE_PATH_INDEXED_TWICE"
    | "EVIDENCE_ACCESS_LOG_LINE_MALFORMED"
    | "EVIDENCE_ACCESS_LOG_CHAIN_BREAK"
    | "EVIDENCE_ACCESS_LOG_SEQUENCE_BREAK";
  relative_path: string | null;
  sequence: number | null;
}>;

export type EvidenceWalkReport = Readonly<{
  schema_version: typeof EVIDENCE_STORE_SCHEMA_VERSION;
  valid: boolean;
  entry_count: number;
  byte_count: number;
  index_head_sha256: string | null;
  access_count: number;
  access_head_sha256: string | null;
  breaks: readonly EvidenceBreak[];
}>;

export type EvidenceStoreProof = Readonly<{
  schema_version: typeof EVIDENCE_STORE_SCHEMA_VERSION;
  store_class: "local_immutable_filesystem";
  managed_platform_verified: false;
  off_host_replicated: false;
  index_append_only_hash_chained: true;
  access_log_append_only_hash_chained: true;
  walk_fails_on_any_break: true;
  root_binding_sha256: string;
}>;

type Access = Readonly<{ actor_id: string; purpose: string }>;

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertRelativePath(value: string): void {
  if (!RELATIVE_PATH.test(value) || value.includes("..") || LEDGERS.has(value)) {
    throw new Error("EVIDENCE_PATH_INVALID");
  }
}

function assertAccess(access: Access): void {
  if (!ACTOR.test(access.actor_id)) throw new Error("EVIDENCE_ACTOR_INVALID");
  if (!PURPOSE.test(access.purpose)) throw new Error("EVIDENCE_PURPOSE_INVALID");
}

function assertTime(value: string): void {
  if (Number.isNaN(Date.parse(value))) throw new Error("EVIDENCE_TIME_INVALID");
}

function sealIndexEntry(core: Omit<EvidenceIndexEntry, "entry_sha256">): EvidenceIndexEntry {
  return deepFreeze({ ...core, entry_sha256: canonicalSha256(core) });
}

function sealAccessEntry(core: Omit<EvidenceAccessEntry, "entry_sha256">): EvidenceAccessEntry {
  return deepFreeze({ ...core, entry_sha256: canonicalSha256(core) });
}

/**
 * Reads one ndjson ledger and verifies its own chain. Returns the verified
 * entries and the breaks found; a malformed or broken ledger still returns
 * the entries before the break so a walk can name where custody ended.
 */
async function readLedger<T extends { sequence: number; previous_entry_sha256: string | null; entry_sha256: string }>(
  file: string,
  codes: Readonly<{ malformed: EvidenceBreak["code"]; chain: EvidenceBreak["code"]; sequence: EvidenceBreak["code"] }>,
): Promise<Readonly<{ entries: readonly T[]; head: string | null; breaks: readonly EvidenceBreak[] }>> {
  if (!existsSync(file)) return { entries: Object.freeze([]), head: null, breaks: Object.freeze([]) };
  const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line.length > 0);
  const entries: T[] = [];
  const breaks: EvidenceBreak[] = [];
  let head: string | null = null;
  let expected = 1;
  for (const line of lines) {
    let parsed: T;
    try {
      parsed = JSON.parse(line) as T;
    } catch {
      breaks.push({ code: codes.malformed, relative_path: null, sequence: expected });
      break;
    }
    const { entry_sha256, ...core } = parsed;
    if (typeof entry_sha256 !== "string" || canonicalSha256(core) !== entry_sha256) {
      breaks.push({ code: codes.chain, relative_path: null, sequence: parsed.sequence ?? expected });
      break;
    }
    if (parsed.previous_entry_sha256 !== head) {
      breaks.push({ code: codes.chain, relative_path: null, sequence: parsed.sequence });
      break;
    }
    if (parsed.sequence !== expected) {
      breaks.push({ code: codes.sequence, relative_path: null, sequence: parsed.sequence });
      break;
    }
    entries.push(deepFreeze(parsed));
    head = entry_sha256;
    expected += 1;
  }
  return { entries: Object.freeze(entries), head, breaks: Object.freeze(breaks) };
}

async function listFiles(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(root, full));
    else if (entry.isFile()) out.push(path.relative(root, full).replaceAll("\\", "/"));
  }
  return out;
}

export class ImmutableEvidenceStore {
  readonly #root: string;
  readonly #clock: () => string;
  readonly #rootBindingSha256: string;

  constructor(input: Readonly<{ root: string; clock?: () => string }>) {
    if (!path.isAbsolute(input.root)) throw new Error("EVIDENCE_ROOT_MUST_BE_ABSOLUTE");
    this.#root = path.resolve(input.root);
    this.#clock = input.clock ?? (() => new Date().toISOString());
    const normalized = (process.platform === "win32" ? this.#root.toLowerCase() : this.#root).replaceAll("\\", "/");
    this.#rootBindingSha256 = createHash("sha256").update(normalized, "utf8").digest("hex");
  }

  proof(): EvidenceStoreProof {
    return deepFreeze({
      schema_version: EVIDENCE_STORE_SCHEMA_VERSION,
      store_class: "local_immutable_filesystem",
      managed_platform_verified: false,
      off_host_replicated: false,
      index_append_only_hash_chained: true,
      access_log_append_only_hash_chained: true,
      walk_fails_on_any_break: true,
      root_binding_sha256: this.#rootBindingSha256,
    });
  }

  /** Appends one file. Refuses an existing path, and refuses while either chain is broken. */
  async append(input: Readonly<{ relative_path: string; bytes: Uint8Array } & Access>): Promise<EvidenceIndexEntry> {
    assertRelativePath(input.relative_path);
    assertAccess(input);
    await mkdir(this.#root, { recursive: true });
    const index = await this.#index();
    const access = await this.#accessLog();
    if (index.breaks.length > 0) throw new Error("EVIDENCE_INDEX_BROKEN");
    if (access.breaks.length > 0) throw new Error("EVIDENCE_ACCESS_LOG_BROKEN");
    const target = path.join(this.#root, ...input.relative_path.split("/"));
    if (index.entries.some((entry) => entry.relative_path === input.relative_path) || existsSync(target)) {
      throw new Error("EVIDENCE_IMMUTABLE_PATH_EXISTS");
    }
    const recorded_at = this.#clock();
    assertTime(recorded_at);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, input.bytes, { flag: "wx" });
    const entry = sealIndexEntry({
      sequence: index.entries.length + 1,
      relative_path: input.relative_path,
      sha256: sha256Bytes(input.bytes),
      byte_count: input.bytes.byteLength,
      recorded_at,
      actor_id: input.actor_id,
      purpose: input.purpose,
      previous_entry_sha256: index.head,
    });
    await appendFile(path.join(this.#root, EVIDENCE_INDEX_FILE), `${JSON.stringify(entry)}\n`, "utf8");
    await this.#recordAccess({ operation: "append", relative_path: entry.relative_path, sha256: entry.sha256 }, input, access);
    return entry;
  }

  /** Reads one file by its indexed digest; a mismatch is a refusal, not a return. */
  async read(input: Readonly<{ relative_path: string } & Access>): Promise<Uint8Array> {
    assertRelativePath(input.relative_path);
    assertAccess(input);
    const index = await this.#index();
    const access = await this.#accessLog();
    if (index.breaks.length > 0) throw new Error("EVIDENCE_INDEX_BROKEN");
    if (access.breaks.length > 0) throw new Error("EVIDENCE_ACCESS_LOG_BROKEN");
    const entry = index.entries.find((candidate) => candidate.relative_path === input.relative_path);
    if (!entry) throw new Error("EVIDENCE_PATH_NOT_INDEXED");
    const bytes = await readFile(path.join(this.#root, ...input.relative_path.split("/")));
    if (bytes.byteLength !== entry.byte_count || sha256Bytes(bytes) !== entry.sha256) {
      throw new Error("EVIDENCE_FILE_HASH_MISMATCH");
    }
    await this.#recordAccess({ operation: "read", relative_path: entry.relative_path, sha256: entry.sha256 }, input, access);
    return Uint8Array.from(bytes);
  }

  /** The verification walk. Reads everything, trusts nothing, and is itself logged. */
  async walk(access: Access): Promise<EvidenceWalkReport> {
    assertAccess(access);
    const index = await this.#index();
    const log = await this.#accessLog();
    const breaks: EvidenceBreak[] = [...index.breaks, ...log.breaks];
    const seen = new Set<string>();
    let byteCount = 0;
    for (const entry of index.entries) {
      if (seen.has(entry.relative_path)) {
        breaks.push({ code: "EVIDENCE_PATH_INDEXED_TWICE", relative_path: entry.relative_path, sequence: entry.sequence });
        continue;
      }
      seen.add(entry.relative_path);
      const target = path.join(this.#root, ...entry.relative_path.split("/"));
      if (!existsSync(target)) {
        breaks.push({ code: "EVIDENCE_FILE_MISSING", relative_path: entry.relative_path, sequence: entry.sequence });
        continue;
      }
      const size = (await stat(target)).size;
      if (size !== entry.byte_count) {
        breaks.push({ code: "EVIDENCE_FILE_LENGTH_MISMATCH", relative_path: entry.relative_path, sequence: entry.sequence });
        continue;
      }
      const bytes = await readFile(target);
      if (sha256Bytes(bytes) !== entry.sha256) {
        breaks.push({ code: "EVIDENCE_FILE_HASH_MISMATCH", relative_path: entry.relative_path, sequence: entry.sequence });
        continue;
      }
      byteCount += size;
    }
    if (existsSync(this.#root)) {
      for (const file of await listFiles(this.#root)) {
        if (LEDGERS.has(file) || seen.has(file)) continue;
        breaks.push({ code: "EVIDENCE_UNINDEXED_FILE", relative_path: file, sequence: null });
      }
    }
    const report = deepFreeze({
      schema_version: EVIDENCE_STORE_SCHEMA_VERSION,
      valid: breaks.length === 0,
      entry_count: index.entries.length,
      byte_count: byteCount,
      index_head_sha256: index.head,
      access_count: log.entries.length + (log.breaks.length === 0 ? 1 : 0),
      access_head_sha256: log.head,
      breaks: Object.freeze(breaks.map((item) => deepFreeze({ ...item }))),
    });
    // A walk over a broken access log is still reported, but not recorded into
    // the broken chain: appending after a break would hide where it happened.
    if (log.breaks.length === 0 && existsSync(this.#root)) {
      await this.#recordAccess({ operation: "walk", relative_path: null, sha256: index.head }, access, log);
    }
    return report;
  }

  async index(): Promise<readonly EvidenceIndexEntry[]> {
    return (await this.#index()).entries;
  }

  async accessLog(): Promise<readonly EvidenceAccessEntry[]> {
    return (await this.#accessLog()).entries;
  }

  #index() {
    return readLedger<EvidenceIndexEntry>(path.join(this.#root, EVIDENCE_INDEX_FILE), {
      malformed: "EVIDENCE_INDEX_LINE_MALFORMED",
      chain: "EVIDENCE_INDEX_CHAIN_BREAK",
      sequence: "EVIDENCE_INDEX_SEQUENCE_BREAK",
    });
  }

  #accessLog() {
    return readLedger<EvidenceAccessEntry>(path.join(this.#root, EVIDENCE_ACCESS_LOG_FILE), {
      malformed: "EVIDENCE_ACCESS_LOG_LINE_MALFORMED",
      chain: "EVIDENCE_ACCESS_LOG_CHAIN_BREAK",
      sequence: "EVIDENCE_ACCESS_LOG_SEQUENCE_BREAK",
    });
  }

  async #recordAccess(
    event: Readonly<{ operation: EvidenceAccessEntry["operation"]; relative_path: string | null; sha256: string | null }>,
    access: Access,
    log: Readonly<{ entries: readonly EvidenceAccessEntry[]; head: string | null }>,
  ): Promise<void> {
    const occurred_at = this.#clock();
    assertTime(occurred_at);
    if (event.sha256 !== null && !SHA256.test(event.sha256)) throw new Error("EVIDENCE_ACCESS_DIGEST_INVALID");
    const entry = sealAccessEntry({
      sequence: log.entries.length + 1,
      operation: event.operation,
      relative_path: event.relative_path,
      sha256: event.sha256,
      actor_id: access.actor_id,
      purpose: access.purpose,
      occurred_at,
      previous_entry_sha256: log.head,
    });
    await appendFile(path.join(this.#root, EVIDENCE_ACCESS_LOG_FILE), `${JSON.stringify(entry)}\n`, "utf8");
  }
}
