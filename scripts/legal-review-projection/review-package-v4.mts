// F4. The human-review package, rebuilt to include the sixty-nine, and built
// twice to the same hash.
//
// This packages what a reviewer needs and nothing that would let a reviewer be
// mistaken for having reviewed: every item is `not_reviewed`, `not_signed`,
// `not_activated`, `not_delivered`, and the package says so per item rather
// than once at the top. The packets it lists are the sixty-nine written by
// `observation-supersede.mts`; the artifacts are the sixty-nine parse artifacts
// with their real parser and normalizer versions and their `ocr_derived` flag.
//
// Determinism is the property under test. Content is written in a fixed order
// from fixed inputs, the ZIP is produced by the same fixed-timestamp helper the
// v0.3 package uses, and the helper builds it twice and refuses to report a
// hash unless both builds match byte for byte.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "v4";
const repoRoot = path.resolve(process.cwd());
const outputRoot = path.join(repoRoot, "output", WAVE);
const packageRoot = path.join(outputRoot, "review-package-v4");
const zipPath = path.join(outputRoot, "review-package-v4.zip");
const resultPath = path.join(outputRoot, "review-package-v4-result.json");
const artifactsRoot = path.join(outputRoot, "observations");
const supersedeReceipt = path.join(outputRoot, "audit", "observation-supersede.json");
const zipHelper = path.join(repoRoot, "scripts", "parallel-wave1-review-package-zip.py");
const venvPython = path.join(repoRoot, "output", "pdf-venv", "Scripts", "python.exe");

if (process.env.TIVDOC_LEGAL_NETWORK_DISABLED !== "1") {
  throw new Error("review_package_v4_must_run_offline");
}

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Order-stable serialization so identical content hashes identically. */
function canonicalJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(Object.keys(input as object).sort()
        .map((key) => [key, sort((input as Record<string, unknown>)[key])]));
    }
    return input;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir)).sort()) {
      const full = path.join(dir, entry);
      if ((await stat(full)).isDirectory()) await walk(full);
      else found.push(path.relative(root, full).replaceAll("\\", "/"));
    }
  };
  await walk(root);
  return found.sort();
}

type Artifact = Readonly<Record<string, unknown> & {
  observation_id: string; outcome: string; parser_version: string;
  normalizer_version: string; ocr_derived: boolean;
}>;

async function main(): Promise<void> {
  if (!existsSync(artifactsRoot) || !existsSync(supersedeReceipt)) {
    throw new Error("review_package_v4_inputs_missing");
  }
  await rm(packageRoot, { recursive: true, force: true });
  await rm(zipPath, { force: true });
  await mkdir(path.join(packageRoot, "artifacts"), { recursive: true });

  const summary = JSON.parse(await readFile(path.join(artifactsRoot, "summary.json"), "utf8")) as {
    parser_version: string; normalizer_version: string; results: Artifact[];
  };
  const parsed = summary.results.filter((row) => row.outcome === "parsed")
    .sort((left, right) => left.observation_id.localeCompare(right.observation_id));
  const supersede = JSON.parse(await readFile(supersedeReceipt, "utf8")) as Record<string, unknown>;

  // One file per artifact, verbatim from the parse run, so a reviewer holds the
  // same bytes the supersession was computed from.
  const artifactEntries: Record<string, unknown>[] = [];
  for (const artifact of parsed) {
    const name = `${artifact.observation_id.replaceAll(":", "_")}.json`;
    const bytes = await readFile(path.join(artifactsRoot, name));
    await writeFile(path.join(packageRoot, "artifacts", name), bytes);
    artifactEntries.push({
      observation_id: artifact.observation_id, file: `artifacts/${name}`,
      sha256: hash(bytes), byte_count: bytes.byteLength,
    });
  }

  // The review state is stated per item, and every item is in the same state.
  const items = parsed.map((artifact) => ({
    observation_id: artifact.observation_id,
    packet_id: `packet:${artifact.observation_id}`,
    parser_version: artifact.parser_version,
    normalizer_version: artifact.normalizer_version,
    ocr_derived: artifact.ocr_derived,
    visual_order: artifact.visual_order,
    raw_artifact_sha256: artifact.raw_artifact_sha256,
    normalized_text_sha256: artifact.normalized_text_sha256,
    review_state: "not_reviewed",
    signature_state: "not_signed",
    activation_state: "not_activated",
    delivery_state: "not_delivered",
  }));

  await writeFile(path.join(packageRoot, "items.json"), canonicalJson({
    schema_version: "tivdoc-review-package-v4-items",
    item_count: items.length,
    ocr_derived_count: items.filter((item) => item.ocr_derived).length,
    every_item_not_reviewed: items.every((item) => item.review_state === "not_reviewed"),
    every_item_not_signed: items.every((item) => item.signature_state === "not_signed"),
    every_item_not_activated: items.every((item) => item.activation_state === "not_activated"),
    every_item_not_delivered: items.every((item) => item.delivery_state === "not_delivered"),
    items,
  }));
  await writeFile(path.join(packageRoot, "artifact-inventory.json"), canonicalJson({
    schema_version: "tivdoc-review-package-v4-artifact-inventory",
    parser_version: summary.parser_version, normalizer_version: summary.normalizer_version,
    artifacts: artifactEntries,
  }));
  await writeFile(path.join(packageRoot, "supersession-accounting.json"), canonicalJson({
    schema_version: "tivdoc-review-package-v4-supersession-accounting",
    three_state: supersede.three_state, packet_link: supersede.packet_link,
    invariant_holds: supersede.invariant_holds, packet_link_holds: supersede.packet_link_holds,
    replay_added_nothing: supersede.replay_added_nothing,
  }));
  await writeFile(path.join(packageRoot, "README.md"), [
    "# Tivdoc legal review package v4",
    "",
    "Sixty-nine parsed observations, each with a pending packet on DEV and a",
    "supersession row beside its immutable blocked record. Every item is",
    "not_reviewed, not_signed, not_activated and not_delivered. Seven artifacts",
    "are OCR-derived and say so; derived text needs human attestation and never",
    "satisfies a citation that requires exact bytes. Sixty-two are in visual",
    "order with digit runs reversed, and say so.",
    "",
    "Nothing in this package is active, reviewed, or a source of truth.",
    "",
  ].join("\n"));

  // Manifest over every file except itself, then the fixed-timestamp ZIP built
  // twice by the helper, which reports a hash only when both builds match.
  const files = (await listFiles(packageRoot)).filter((relative) => relative !== "package-manifest.json");
  const manifest: Record<string, unknown>[] = [];
  for (const relative of files) {
    const bytes = await readFile(path.join(packageRoot, relative));
    manifest.push({ path: relative, byte_count: bytes.byteLength, sha256: hash(bytes) });
  }
  await writeFile(path.join(packageRoot, "package-manifest.json"), canonicalJson({
    schema_version: "tivdoc-review-package-v4-manifest",
    manifest_self_excluded_to_avoid_recursive_hash: true,
    files: manifest,
  }));

  const python = existsSync(venvPython) ? venvPython : "python";
  const zip = spawnSync(python, [zipHelper, packageRoot, zipPath], {
    cwd: repoRoot, encoding: "utf8", windowsHide: true,
  });
  if (zip.status !== 0) throw new Error(`review_package_v4_zip_failed:${zip.stderr.trim().slice(0, 200)}`);
  const zipResult = JSON.parse(zip.stdout.trim()) as Record<string, unknown>;

  const result = {
    schema_version: "tivdoc-review-package-v4-result",
    package_root: path.relative(repoRoot, packageRoot).replaceAll("\\", "/"),
    zip_path: path.relative(repoRoot, zipPath).replaceAll("\\", "/"),
    item_count: items.length,
    ocr_derived_count: items.filter((item) => item.ocr_derived).length,
    manifest_sha256: zipResult.manifest_sha256,
    zip_sha256: zipResult.zip_sha256,
    deterministic_second_build_match: zipResult.deterministic_second_build_match,
    every_item_not_reviewed: true, every_item_not_signed: true,
    every_item_not_activated: true, every_item_not_delivered: true,
  };
  await writeFile(resultPath, canonicalJson(result));
  process.stdout.write(`items=${items.length} ocr=${result.ocr_derived_count}`
    + ` zip_sha256=${String(result.zip_sha256).slice(0, 16)}`
    + ` second_build_match=${String(result.deterministic_second_build_match)}\n`);
  if (result.deterministic_second_build_match !== true) process.exitCode = 1;
}

await main();
