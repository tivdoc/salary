import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import records from "./canonical-entrypoints.v0.10.0.json" with { type: "json" };

// Wave 3 (C4). Every canonical entrypoint record names files and a symbol. Three
// of them named a symbol that does not exist — CEP-033 pointed at
// CANONICAL_PERSISTENCE_WIRING_MAP, CEP-075 and CEP-076 at buildEvidencePackage
// and verifyEvidencePackage — while carrying classifications as strong as
// ALREADY_CANONICAL_AND_PROVEN. A record whose target cannot be resolved proves
// nothing about the thing it claims to describe, and nothing was checking.
//
// `:main` on a CLI record is the convention for "the script's own body", not a
// claim about an export, so it is satisfied by the file existing.

type Record_ = Readonly<{
  entrypoint_id: string;
  kind: string;
  source_path?: string;
  canonical_target?: string;
  dependencies?: readonly string[];
}>;

const ENTRYPOINTS = (records as Readonly<{ entries: readonly Record_[] }>).entries;
const EXPORTED = /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gmu;
const RE_EXPORTED = /^export\s*\{([^}]*)\}/gmu;
const SYMBOL = /^[A-Za-z_$][\w$]*$/u;

async function exportedNames(file: string): Promise<ReadonlySet<string> | null> {
  if (!existsSync(file)) return null;
  const text = await readFile(path.resolve(process.cwd(), file), "utf8");
  const names = new Set<string>();
  for (const match of text.matchAll(EXPORTED)) names.add(match[1] as string);
  for (const match of text.matchAll(RE_EXPORTED)) {
    for (const part of (match[1] as string).split(",")) {
      const name = part.trim().split(/\s+as\s+/u).pop()?.trim();
      if (name) names.add(name);
    }
  }
  if (/^export\s+default\b/mu.test(text)) names.add("default");
  return names;
}

describe("canonical entrypoint claims", () => {
  it("resolves every source path and dependency to a file that exists", () => {
    const missing: string[] = [];
    for (const record of ENTRYPOINTS) {
      if (record.source_path && !existsSync(record.source_path)) {
        missing.push(`${record.entrypoint_id} source_path ${record.source_path}`);
      }
      for (const dependency of record.dependencies ?? []) {
        if (!existsSync(dependency)) missing.push(`${record.entrypoint_id} dependency ${dependency}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("resolves every canonical target symbol to a real export", async () => {
    const dangling: string[] = [];
    for (const record of ENTRYPOINTS) {
      const target = record.canonical_target;
      if (typeof target !== "string" || !target.includes(":")) continue;
      const index = target.lastIndexOf(":");
      const file = target.slice(0, index);
      const symbol = target.slice(index + 1);
      const names = await exportedNames(file);
      if (names === null) {
        dangling.push(`${record.entrypoint_id} target file ${file}`);
        continue;
      }
      if (record.kind === "cli" && symbol === "main") continue;
      if (SYMBOL.test(symbol) && !names.has(symbol)) {
        dangling.push(`${record.entrypoint_id} target symbol ${file}:${symbol}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it("names the seam that CEP-080's blocker is about", () => {
    const record = ENTRYPOINTS.find((entry) => entry.entrypoint_id === "CEP-080") as Record_;
    // DURABLE_PORTS_NOT_INSTALLED is about an installation seam, and the seam is
    // `installInternalOpsPorts` in runtime.ts — ports.ts declares the interfaces
    // and installs nothing. The record listed only ports.ts, so the blocker
    // pointed away from the two symbols that are actually uncalled.
    expect(record.dependencies).toContain("src/server/product/internal-ops/runtime.ts");
    expect(record.dependencies).toContain("src/server/product/internal-ops/ports.ts");
  });
});
