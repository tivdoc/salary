import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WAVE1_ARTIFACT_PARTITION_BUILDER_COMMAND,
  WAVE1_ARTIFACT_PARTITION_RELATIVE_PATH,
  buildWave1ArtifactPartitionDocument,
  serializeWave1ArtifactPartition,
} from "./wave1-artifact-partition-builder.ts";
import { WAVE1_PARTITION_SCOPE_SOURCE_VERSION_IDS } from "./wave1-partition-scope.ts";
import { localArtifacts } from "../../../test-support/host.ts";

// B-0 drift guard. The committed partition had no builder and no guard: the
// only way to move it was to edit it, and its own tamper test then failed. Now
// it is derived, and this rebuilds it from the ledger and compares bytes. A
// hand edit cannot land silently — it fails here, naming the command that
// would have produced it legitimately.

const REPO_ROOT = path.resolve(".");

describe.skipIf(!(localArtifacts(["eval/legal-knowledge/manifests/fetch-state.json"])).holds)("Wave 1 artifact partition is derived, not hand-edited (B-0)", () => {
  it("rebuilds byte-identical to the committed file", async () => {
    const rebuilt = serializeWave1ArtifactPartition(await buildWave1ArtifactPartitionDocument(REPO_ROOT));
    const committed = (await readFile(path.join(REPO_ROOT, WAVE1_ARTIFACT_PARTITION_RELATIVE_PATH), "utf8"))
      .replaceAll("\r\n", "\n");
    if (rebuilt !== committed) {
      throw new Error(`REGENERATE_VIA_${WAVE1_ARTIFACT_PARTITION_BUILDER_COMMAND}`);
    }
    expect(rebuilt).toBe(committed);
  }, 30_000);

  it("is scoped to the seventeen frozen Wave-1 source versions, and says so in code", async () => {
    expect(WAVE1_PARTITION_SCOPE_SOURCE_VERSION_IDS).toHaveLength(17);
    expect(new Set(WAVE1_PARTITION_SCOPE_SOURCE_VERSION_IDS).size).toBe(17);
    const document = await buildWave1ArtifactPartitionDocument(REPO_ROOT);
    expect(document.distinct_source_versions).toBe(17);
    expect(document.entries.map((entry) => entry.source_version_id).sort())
      .toEqual([...WAVE1_PARTITION_SCOPE_SOURCE_VERSION_IDS].sort());
  }, 30_000);

  it("corpus growth beyond Wave 1 is out of scope by construction, not by a count that has to be maintained", async () => {
    // The live manifest is larger than the frozen scope — that is the whole
    // point. If a later session adds a source and this assertion starts
    // failing because the manifest shrank to 17, the corpus regressed.
    const manifest = JSON.parse(await readFile(
      path.join(REPO_ROOT, "src", "server", "engine", "legal-knowledge", "legal-sources.v0.json"), "utf8",
    )) as { sources: Array<{ source_id: string; source_version: string }> };
    expect(manifest.sources.length).toBeGreaterThanOrEqual(WAVE1_PARTITION_SCOPE_SOURCE_VERSION_IDS.length);
    const scope = new Set<string>(WAVE1_PARTITION_SCOPE_SOURCE_VERSION_IDS);
    const outOfScope = manifest.sources
      .map((source) => `${source.source_id}@${source.source_version}`)
      .filter((id) => !scope.has(id));
    const document = await buildWave1ArtifactPartitionDocument(REPO_ROOT);
    const built = new Set(document.entries.map((entry) => entry.source_version_id));
    for (const id of outOfScope) expect(built.has(id)).toBe(false);
  }, 30_000);

  it("refuses to build if a frozen Wave-1 source version has vanished from the ledger", async () => {
    // Named scope means a DROP is still tampering even though growth is not.
    // Proven against a ledger the builder is pointed at, not by mocking.
    await expect(buildWave1ArtifactPartitionDocument(path.join(REPO_ROOT, "src")))
      .rejects.toThrow();
  }, 30_000);
});
