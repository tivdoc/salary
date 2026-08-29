import { spawnSync } from "node:child_process";
import path from "node:path";

const command = process.argv[2] ?? "all";
if (!["validate", "evaluate", "all"].includes(command)) {
  process.stderr.write("usage: run.mts [validate|evaluate|all]\n");
  process.exit(64);
}

const vitestEntry = path.resolve("node_modules/vitest/vitest.mjs");
const result = spawnSync(
  process.execPath,
  [vitestEntry, "run", "src/engine/extraction-ground-truth/evidence-generation.test.ts", "--reporter=dot"],
  {
    cwd: process.cwd(),
    env: { ...process.env, TIVDOC_GROUND_TRUTH_COMMAND: command },
    encoding: "utf8",
    stdio: "inherit",
  },
);
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
