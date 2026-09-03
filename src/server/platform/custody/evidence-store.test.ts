import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EVIDENCE_ACCESS_LOG_FILE, EVIDENCE_INDEX_FILE, ImmutableEvidenceStore } from "./evidence-store.ts";

// Wave 6 (K-1, K-2). Every break the walk must catch, produced by hand on a
// real directory: a changed byte, a missing file, a file nobody indexed, an
// edited index line, an edited access-log line, an overwrite. And the log:
// every read and write named with actor and purpose, chained, and fail-closed.

const ACTOR = Object.freeze({ actor_id: "custody.test.actor", purpose: "custody_test" });
const bytes = (text: string) => new TextEncoder().encode(text);
const roots: string[] = [];

function store() {
  const root = mkdtempSync(path.join(tmpdir(), "tivdoc-evidence-"));
  roots.push(root);
  let tick = 0;
  return new ImmutableEvidenceStore({ root, clock: () => new Date(Date.UTC(2035, 0, 1, 0, 0, tick++)).toISOString() });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function seeded() {
  const evidence = store();
  await evidence.append({ ...ACTOR, relative_path: "receipts/one.json", bytes: bytes("{\"one\":1}") });
  await evidence.append({ ...ACTOR, relative_path: "receipts/two.json", bytes: bytes("{\"two\":2}") });
  return evidence;
}

function rootOf(): string {
  return roots[roots.length - 1]!;
}

describe("immutable evidence store", () => {
  it("chains the index, walks clean, and logs every append, read and walk with actor and purpose", async () => {
    const evidence = await seeded();
    const read = await evidence.read({ ...ACTOR, relative_path: "receipts/one.json" });
    expect(new TextDecoder().decode(read)).toBe("{\"one\":1}");
    const report = await evidence.walk(ACTOR);
    expect(report.valid).toBe(true);
    expect(report.entry_count).toBe(2);
    expect(report.breaks).toEqual([]);
    const index = await evidence.index();
    expect(index[0]?.previous_entry_sha256).toBeNull();
    expect(index[1]?.previous_entry_sha256).toBe(index[0]?.entry_sha256);
    expect(report.index_head_sha256).toBe(index[1]?.entry_sha256);
    const log = await evidence.accessLog();
    expect(log.map((entry) => [entry.operation, entry.relative_path, entry.actor_id, entry.purpose])).toEqual([
      ["append", "receipts/one.json", ACTOR.actor_id, ACTOR.purpose],
      ["append", "receipts/two.json", ACTOR.actor_id, ACTOR.purpose],
      ["read", "receipts/one.json", ACTOR.actor_id, ACTOR.purpose],
      ["walk", null, ACTOR.actor_id, ACTOR.purpose],
    ]);
    expect(log[3]?.previous_entry_sha256).toBe(log[2]?.entry_sha256);
    expect(evidence.proof()).toMatchObject({
      store_class: "local_immutable_filesystem", managed_platform_verified: false, off_host_replicated: false,
    });
  });

  it("refuses to overwrite an indexed path", async () => {
    const evidence = await seeded();
    await expect(evidence.append({ ...ACTOR, relative_path: "receipts/one.json", bytes: bytes("changed") }))
      .rejects.toThrow("EVIDENCE_IMMUTABLE_PATH_EXISTS");
    expect(new TextDecoder().decode(readFileSync(path.join(rootOf(), "receipts", "one.json")))).toBe("{\"one\":1}");
  });

  it("fails the walk on a changed byte, and refuses the read", async () => {
    const evidence = await seeded();
    writeFileSync(path.join(rootOf(), "receipts", "one.json"), "{\"one\":9}");
    const report = await evidence.walk(ACTOR);
    expect(report.valid).toBe(false);
    expect(report.breaks).toEqual([{ code: "EVIDENCE_FILE_HASH_MISMATCH", relative_path: "receipts/one.json", sequence: 1 }]);
    await expect(evidence.read({ ...ACTOR, relative_path: "receipts/one.json" })).rejects.toThrow("EVIDENCE_FILE_HASH_MISMATCH");
  });

  it("fails the walk on a missing file and on a file nobody indexed", async () => {
    const evidence = await seeded();
    unlinkSync(path.join(rootOf(), "receipts", "two.json"));
    writeFileSync(path.join(rootOf(), "receipts", "stray.json"), "{}");
    const report = await evidence.walk(ACTOR);
    expect(report.valid).toBe(false);
    expect(report.breaks).toEqual([
      { code: "EVIDENCE_FILE_MISSING", relative_path: "receipts/two.json", sequence: 2 },
      { code: "EVIDENCE_UNINDEXED_FILE", relative_path: "receipts/stray.json", sequence: null },
    ]);
  });

  it("fails the walk on an edited index line and refuses to append behind it", async () => {
    const evidence = await seeded();
    const indexPath = path.join(rootOf(), EVIDENCE_INDEX_FILE);
    const lines = readFileSync(indexPath, "utf8").split("\n").filter(Boolean);
    const edited = JSON.parse(lines[0]!) as Record<string, unknown>;
    edited.byte_count = 1;
    writeFileSync(indexPath, `${[JSON.stringify(edited), ...lines.slice(1)].join("\n")}\n`);
    const report = await evidence.walk(ACTOR);
    expect(report.valid).toBe(false);
    expect(report.breaks[0]).toMatchObject({ code: "EVIDENCE_INDEX_CHAIN_BREAK", sequence: 1 });
    await expect(evidence.append({ ...ACTOR, relative_path: "receipts/three.json", bytes: bytes("{}") }))
      .rejects.toThrow("EVIDENCE_INDEX_BROKEN");
  });

  it("fails the walk on an edited access-log line and stops custody there", async () => {
    const evidence = await seeded();
    const logPath = path.join(rootOf(), EVIDENCE_ACCESS_LOG_FILE);
    const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    const edited = JSON.parse(lines[1]!) as Record<string, unknown>;
    edited.actor_id = "someone.else";
    writeFileSync(logPath, `${[lines[0], JSON.stringify(edited)].join("\n")}\n`);
    const report = await evidence.walk(ACTOR);
    expect(report.valid).toBe(false);
    expect(report.breaks).toEqual([{ code: "EVIDENCE_ACCESS_LOG_CHAIN_BREAK", relative_path: null, sequence: 2 }]);
    // The walk did not write into the broken log, and nothing else may either.
    expect(readFileSync(logPath, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
    await expect(evidence.append({ ...ACTOR, relative_path: "receipts/three.json", bytes: bytes("{}") }))
      .rejects.toThrow("EVIDENCE_ACCESS_LOG_BROKEN");
    await expect(evidence.read({ ...ACTOR, relative_path: "receipts/one.json" })).rejects.toThrow("EVIDENCE_ACCESS_LOG_BROKEN");
  });

  it("refuses traversal, ledger names, and unnamed actors or purposes", async () => {
    const evidence = store();
    await expect(evidence.append({ ...ACTOR, relative_path: "../escape.json", bytes: bytes("{}") })).rejects.toThrow("EVIDENCE_PATH_INVALID");
    await expect(evidence.append({ ...ACTOR, relative_path: EVIDENCE_INDEX_FILE, bytes: bytes("{}") })).rejects.toThrow("EVIDENCE_PATH_INVALID");
    await expect(evidence.append({ actor_id: "", purpose: "custody_test", relative_path: "a/b.json", bytes: bytes("{}") })).rejects.toThrow("EVIDENCE_ACTOR_INVALID");
    await expect(evidence.append({ actor_id: "custody.test.actor", purpose: "No Purpose", relative_path: "a/b.json", bytes: bytes("{}") })).rejects.toThrow("EVIDENCE_PURPOSE_INVALID");
  });
});
