import path from "node:path";
import { parseCliOptions, writeJsonAtomic } from "../../src/engine/wave2/evidence-audit/common.ts";
import { scanFullChangedFileRange } from "../../src/engine/wave2/evidence-audit/full-diff-scan.ts";

const options = parseCliOptions(process.argv.slice(2));
const report = scanFullChangedFileRange({
  repo_root: path.resolve("."),
  from: typeof options.from === "string" ? options.from : undefined,
  to: typeof options.to === "string" ? options.to : undefined,
});
if (typeof options.output === "string") await writeJsonAtomic(path.resolve(options.output), report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.passed ? 0 : 1;
