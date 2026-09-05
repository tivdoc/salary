import "../../production-refusal.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  PERSISTENCE_ARCHITECTURE_ANSWERS,
  PERSISTENCE_WIRING_MAP,
  PERSISTENCE_WIRING_SUMMARY,
  renderPersistenceWiringMarkdown,
} from "../../../src/server/platform/persistence/wiring-map.ts";
import { PERSISTENCE_RUNTIME_MODES } from "../../../src/server/platform/persistence/runtime-modes.ts";

const outputRoot = resolveOutputRoot(process.argv.slice(2));
const jsonPath = path.join(outputRoot, "persistence-wiring-map.json");
const markdownPath = path.join(outputRoot, "persistence-wiring-map.md");
const payload = {
  schema_version: "tivdoc-canonical-persistence-wiring-map-v1",
  generated_from_source_of_truth: "src/server/platform/persistence/wiring-map.ts",
  runtime_modes: PERSISTENCE_RUNTIME_MODES,
  summary: PERSISTENCE_WIRING_SUMMARY,
  architecture_answers: PERSISTENCE_ARCHITECTURE_ANSWERS,
  mappings: PERSISTENCE_WIRING_MAP,
};

await mkdir(outputRoot, { recursive: true });
await Promise.all([
  writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "w" }),
  writeFile(markdownPath, renderPersistenceWiringMarkdown(), { encoding: "utf8", flag: "w" }),
]);

process.stdout.write(`${JSON.stringify({
  generator_status: "PASS_WIRING_MAP_GENERATED",
  output: [relative(jsonPath), relative(markdownPath)],
  ...PERSISTENCE_WIRING_SUMMARY,
})}\n`);

function resolveOutputRoot(args: readonly string[]): string {
  const index = args.indexOf("--output-root");
  if (index >= 0) {
    const candidate = args[index + 1];
    if (!candidate) throw new TypeError("OUTPUT_ROOT_VALUE_REQUIRED");
    return path.resolve(candidate);
  }
  return path.resolve("output", "product-integration-v0.8.0", "persistence");
}

function relative(file: string): string {
  return path.relative(path.resolve("."), file).replaceAll("\\", "/");
}
