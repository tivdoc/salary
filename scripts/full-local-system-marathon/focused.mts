import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const BASE = "28d18da69108913252736f4b8a39c4ef614984a3";
const git = spawnSync("C:\\Program Files\\Git\\cmd\\git.exe", ["diff", "--name-only", `${BASE}..HEAD`, "--"], {
  cwd: ROOT, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});
if (git.error || git.status !== 0 || git.stderr !== "") throw new Error("MARATHON_FOCUSED_GIT_DIFF_FAILED");
const tests = git.stdout.split(/\r?\n/u)
  .filter((name) => /^src\/.*\.test\.(?:ts|tsx)$/u.test(name))
  .filter((name) => !name.includes(".external.test."))
  .sort();
if (tests.length === 0) throw new Error("MARATHON_FOCUSED_TEST_SET_EMPTY");
run(process.execPath, [path.join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", ...tests, "--reporter=verbose", "--maxWorkers=1"]);
run(process.execPath, [
  path.join(ROOT, "node_modules", "vitest", "vitest.mjs"),
  "run",
  "--config",
  "scripts/platform/supabase/vitest.config.mts",
  "--reporter=verbose",
  "--maxWorkers=1",
]);
process.stdout.write(`${JSON.stringify({ schema_version: "tivdoc-marathon-focused-tests-v0.10.0", status: "PASS", changed_test_count: tests.length, changed_tests: tests, supabase_detector_tests: true })}\n`);

function run(executable: string, args: readonly string[]): void {
  const result = spawnSync(executable, args, {
    cwd: ROOT,
    env: { ...process.env, OPENAI_API_KEY: "", TIVDOC_OPENAI_LIVE_TESTS: "0" },
    encoding: "utf8",
    windowsHide: true,
    timeout: 10 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error || result.status !== 0 || result.signal !== null) process.exit(result.status ?? 1);
}
