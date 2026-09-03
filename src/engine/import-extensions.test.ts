import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// H-6 (Addendum 4). The engine's relative imports were rewritten to carry
// explicit extensions (52 files) because scripts load engine modules under
// Node's `--experimental-strip-types`, which resolves nothing implicitly: an
// extensionless relative import that tsc and every existing test tolerate
// (via its own module resolution) throws `ERR_MODULE_NOT_FOUND` the moment a
// `.mts` script imports the same module directly. Nothing catches a new
// extensionless import from returning — eslint has no bundled rule for it and
// `eslint-plugin-import` cannot be added without an `npm install` — so this
// walks every source file under `src/engine` by hand and fails on the first
// relative import specifier that does not end in a recognized extension.
//
// A specifier ending in "/" or naming a bare directory (`./sub`) is exactly
// the class that broke before: tsc resolves it via `index.ts`, and Node's
// strip-types loader does not. The fix each time was the explicit form
// (`./sub/index.ts` or `./sub.ts`), so that is what this test requires.

const ENGINE_ROOT = path.resolve(process.cwd(), "src", "engine");
const RECOGNIZED_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".json", ".js", ".jsx", ".mjs", ".cjs"];
const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*["'](\.\.?\/[^"']+)["']/gu;

function walk(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      files.push(...walk(absolute));
    } else if (/\.(?:ts|tsx|mts|cts)$/u.test(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

function extensionlessImports(file: string): readonly string[] {
  const source = readFileSync(file, "utf8");
  const offenders: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1]!;
    if (!RECOGNIZED_EXTENSIONS.some((extension) => specifier.endsWith(extension))) {
      offenders.push(specifier);
    }
  }
  return offenders;
}

describe("engine relative imports carry an explicit extension", () => {
  it("has no extensionless relative import anywhere under src/engine", () => {
    const files = walk(ENGINE_ROOT).filter((file) => statSync(file).isFile());
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of extensionlessImports(file)) {
        offenders.push(`${path.relative(process.cwd(), file).replaceAll("\\", "/")}: "${specifier}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
