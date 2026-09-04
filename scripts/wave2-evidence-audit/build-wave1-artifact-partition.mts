// B-0 writer. The only sanctioned way the committed Wave-1 artifact partition
// ever changes. Derivation is in the engine module so the drift guard can call
// exactly the same code the writer does; this script is the file-system half.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/wave2-evidence-audit/build-wave1-artifact-partition.mts
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  WAVE1_ARTIFACT_PARTITION_RELATIVE_PATH,
  buildWave1ArtifactPartitionDocument,
  serializeWave1ArtifactPartition,
} from "../../src/engine/wave2/evidence-audit/wave1-artifact-partition-builder.ts";

const repoRoot = process.cwd();
const document = await buildWave1ArtifactPartitionDocument(repoRoot);
const target = path.join(repoRoot, WAVE1_ARTIFACT_PARTITION_RELATIVE_PATH);
await writeFile(target, serializeWave1ArtifactPartition(document), "utf8");
process.stdout.write(`${JSON.stringify({
  wrote: WAVE1_ARTIFACT_PARTITION_RELATIVE_PATH,
  distinct_source_versions: document.distinct_source_versions,
  historical_quarantine_observations: document.historical_quarantine_observations.length,
  unavailable_source_versions: document.unavailable_source_versions.length,
  diff_ledger_expectation: document.diff_ledger_expectation,
})}\n`);
