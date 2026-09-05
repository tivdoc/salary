// L8-1 / D2. Every script entry point refuses a production environment before
// anything else — statically here (the guard is the first import), by
// execution in the closure proof (every entry point spawned under
// VERCEL_ENV=production exits 2 with the one code).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { guardPosition, listScriptEntryPoints, PRODUCTION_REFUSAL_CODE } from "./production-closure/entry-points.mjs";

const ROOT = process.cwd();

describe("scripts refuse a production environment", () => {
  const entries = listScriptEntryPoints(ROOT);

  it("the entry-point rule finds the scripts this repository runs", () => {
    expect(entries.length).toBeGreaterThan(100);
    for (const known of [
      "scripts/legal-review-projection/draft-shadow-run-v1.mts",
      "scripts/legal-review-projection/pool-p-batch-16-daily-threshold.mts",
      "scripts/dev-runtime/journey.mts",
      "scripts/legal-sources.mts",
      "scripts/cases-report.mjs",
      "scripts/legal-pdf-ocr.py",
      "scripts/production-closure/prove.mts",
    ]) expect(entries, known).toContain(known);
    expect(entries.some((entry) => /\.test\./u.test(entry))).toBe(false);
  });

  it("every entry point carries the refusal as its first import (or first Python statement)", () => {
    const wrong = entries.filter((entry) => !guardPosition(ROOT, entry).first_is_guard);
    expect(wrong).toEqual([]);
  });

  it("the guard itself refuses by execution, under NODE_ENV and under VERCEL_ENV, and is silent otherwise", () => {
    const run = (environment) => spawnSync(process.execPath, ["--input-type=module", "-e", 'import "./scripts/production-refusal.mjs"; console.log("ran");'], {
      cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...environment },
    });
    for (const environment of [{ NODE_ENV: "production" }, { VERCEL_ENV: "production" }, { VERCEL_ENV: "preview" }, { NODE_ENV: "production", VERCEL_ENV: "production" }]) {
      const result = run(environment);
      expect(result.status, JSON.stringify(environment)).toBe(2);
      expect(result.stderr, JSON.stringify(environment)).toContain(PRODUCTION_REFUSAL_CODE);
      expect(result.stdout).not.toContain("ran");
    }
    const clean = run({ NODE_ENV: "development" });
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain("ran");
  });

  it("a Python entry point refuses by execution too", { timeout: 90_000 }, () => {
    const result = spawnSync("python", [path.join(ROOT, "scripts/legal-pdf-extract.py")], {
      cwd: ROOT, encoding: "utf8", timeout: 60_000,
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA, USERPROFILE: process.env.USERPROFILE, VERCEL_ENV: "production" },
    });
    if (result.error && result.error.code === "ENOENT") return; // no interpreter on this machine: the closure proof records it
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(PRODUCTION_REFUSAL_CODE);
  });
});
