import path from "node:path";
import { buildWave1ArtifactReconciliation } from "../../src/engine/wave2/evidence-audit/artifact-reconciliation.ts";
import { parseCliOptions, writeJsonAtomic } from "../../src/engine/wave2/evidence-audit/common.ts";

const options = parseCliOptions(process.argv.slice(2));
const report = await buildWave1ArtifactReconciliation({
  repo_root: path.resolve("."),
  evidence_repo_root: path.resolve(typeof options["evidence-repo-root"] === "string" ? options["evidence-repo-root"] : "C:\\dev\\tivdoc\\salary"),
  source_pack_root: path.resolve(typeof options["source-pack-root"] === "string"
    ? options["source-pack-root"]
    : "C:\\dev\\tivdoc-wave1-working-time-permits\\output\\legal-knowledge\\wave1-working-time-permits"),
});
if (typeof options.output === "string") await writeJsonAtomic(path.resolve(options.output), report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
