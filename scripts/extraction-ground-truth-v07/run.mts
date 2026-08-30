import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const mode = process.argv[2] ?? "all";
if (!["workspace", "fixtures", "quality", "verify", "all"].includes(mode)) {
  process.stderr.write("usage: run.mts workspace|fixtures|quality|verify|all\n");
  process.exit(2);
}

const vitestEntry = path.resolve("node_modules/vitest/vitest.mjs");
const result = spawnSync(process.execPath, [vitestEntry, "run", "src/engine/extraction-ground-truth/overnight-v07/evidence-generation.test.ts", "--reporter=dot", "--maxWorkers=1"], {
  cwd: process.cwd(),
  env: { ...process.env, TIVDOC_GT_V07_COMMAND: mode },
  encoding: "utf8",
  stdio: "inherit",
});
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
