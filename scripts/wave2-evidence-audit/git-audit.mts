import path from "node:path";
import { writeJsonAtomic } from "../../src/engine/wave2/evidence-audit/common.ts";
import { generateWave1GitAudit } from "../../src/engine/wave2/evidence-audit/git-audit.ts";

const output = process.argv[2];
const report = generateWave1GitAudit({ repo_root: path.resolve(".") });
if (output) await writeJsonAtomic(path.resolve(output), report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
