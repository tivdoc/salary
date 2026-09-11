import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { guardPosition, PRODUCTION_REFUSAL_CODE } from "../production-closure/entry-points.mjs";

const ROOT = process.cwd();
const SCRIPT_ROOT = path.join(ROOT, "scripts", "private-customer-analysis");
const pythonEntries = ["import-download.py", "test_import_download.py"];
const environments = [
  { NODE_ENV: "production" }, { VERCEL_ENV: "production" },
  { VERCEL_ENV: "preview" }, { NODE_ENV: " Production " },
];
const baseEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !["NODE_ENV", "VERCEL_ENV", "PYTHONPATH"].includes(name)));

function python(args, environment = {}) {
  const result = spawnSync("python", ["-B", ...args], {
    cwd: os.tmpdir(), encoding: "utf8", timeout: 10_000,
    env: { ...baseEnvironment, ...environment },
  });
  if (result.error) throw result.error;
  return result;
}

describe("private customer script entry guards", () => {
  it("uses the existing first-import/statement convention in all four entry files", () => {
    for (const name of [...pythonEntries, "run.mts", "run.mjs"]) {
      expect(guardPosition(ROOT, `scripts/private-customer-analysis/${name}`).first_is_guard, name).toBe(true);
    }
  });

  it("both Python entries refuse before argument handling or test setup from another cwd", () => {
    for (const name of pythonEntries) {
      for (const environment of environments) {
        const result = python([path.join(SCRIPT_ROOT, name)], environment);
        expect(result.status, `${name} ${JSON.stringify(environment)}`).toBe(2);
        expect(result.stderr.trim()).toBe(PRODUCTION_REFUSAL_CODE);
        expect(result.stdout).toBe("");
      }
    }
  });

  it("the Node launcher refuses before argument validation or bundle writes", () => {
    for (const environment of environments) {
      const result = spawnSync(process.execPath, [path.join(SCRIPT_ROOT, "run.mjs")], {
        cwd: os.tmpdir(), encoding: "utf8", timeout: 10_000,
        env: { ...baseEnvironment, ...environment },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(PRODUCTION_REFUSAL_CODE);
      expect(result.stderr).not.toContain("Usage:");
      expect(result.stdout).toBe("");
    }
  });

  it("a development importer starts from another cwd without reading private input", () => {
    const result = python([path.join(SCRIPT_ROOT, "import-download.py"), "--help"], { NODE_ENV: "development" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("--snapshot");
    expect(result.stderr).toBe("");
  });

  it("the Python unittest imports its exact adjacent parent module from another cwd", () => {
    const result = python(["-c", [
      "import importlib.util, pathlib, sys",
      "spec = importlib.util.spec_from_file_location('private_import_tests', sys.argv[1])",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "assert pathlib.Path(module.IMPORTER.__file__).resolve() == pathlib.Path(sys.argv[2]).resolve()",
      "print('PRIVATE_IMPORT_MODULE_BOUND')",
    ].join("\n"), path.join(SCRIPT_ROOT, "test_import_download.py"), path.join(SCRIPT_ROOT, "import-download.py")], { NODE_ENV: "development" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("PRIVATE_IMPORT_MODULE_BOUND");
    expect(result.stderr).toBe("");
  });
});
