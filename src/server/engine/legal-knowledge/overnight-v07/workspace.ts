import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalStringify } from "../../../../engine/rule-runtime/canonical.ts";
import { buildSevenTopicReviewWorkspace } from "../../../../engine/legal-knowledge/overnight-v07/review-workspace.ts";
import type { LoadedP3Corpus } from "./corpus.ts";

const LOCAL_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'none'; connect-src 'none'; script-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value: unknown) {
  return `${canonicalStringify(value)}\n`;
}

function escapeHtml(value: string) {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

function topicMarkdown(topic: ReturnType<typeof buildSevenTopicReviewWorkspace>["topics"][number]) {
  const sourceLines = topic.sources.map((source) => `- \`${source.source_version_id}\` — parse=\`${source.parse_status}\`, citation=\`${source.citation_status}\`, artifact=\`${source.artifact_sha256 ?? "missing"}\`, text=\`${source.normalized_text_sha256 ?? "missing"}\``);
  const quarantineLines = topic.quarantines.length === 0 ? ["- none recorded"] : topic.quarantines.map((item) => `- \`${item.source_version_id}\`: \`${item.reason}\``);
  return [
    `# Legal review workspace: ${topic.topic}`,
    "",
    `Status: \`${topic.status}\``,
    `Workspace SHA-256: \`${topic.workspace_sha256}\``,
    "",
    "Automation has not selected legal meaning. Publication and commencement, predecessor/successor relations, effective period, sector and population remain human-review questions.",
    "",
    "## Exact source evidence",
    "",
    ...sourceLines,
    "",
    "## Quarantines and parser/OCR warnings",
    "",
    ...quarantineLines,
    "",
    "## Required human actions",
    "",
    ...topic.questions.map((question) => `- ${question}`),
    "",
    "## Decision",
    "",
    "Use `blank-decision.json`. It is deliberately unsigned and contains no preselected decision. Import requires exact hash binding, distinct reviewer/importer identities and a configured cryptographic trust port.",
    "",
  ].join("\n");
}

function topicHtml(topic: ReturnType<typeof buildSevenTopicReviewWorkspace>["topics"][number]) {
  const encoded = escapeHtml(canonicalStringify(topic));
  return `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(LOCAL_CSP)}"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(topic.topic)} legal review</title><style>body{font-family:system-ui,sans-serif;max-width:80rem;margin:auto;padding:2rem;background:#fafafa;color:#171717}h1{font-size:1.5rem}pre{direction:ltr;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;background:#fff;border:1px solid #bbb;padding:1rem}aside{border-inline-start:.4rem solid #a16207;padding:1rem;background:#fef3c7}</style></head><body><h1>${escapeHtml(topic.topic)}</h1><aside>ממתין לביקורת משפטית אנושית. אין החלטה, הפעלה, פרשנות או חתימה שנוצרו אוטומטית.</aside><p>Workspace SHA-256: <code>${topic.workspace_sha256}</code></p><pre>${encoded}</pre></body></html>`;
}

export async function writeP3ReviewWorkspace(input: Readonly<{
  corpus: LoadedP3Corpus;
  corpus_state_root: string;
  output_root: string;
  acquisition_report_sha256: string | null;
}>) {
  const outputRoot = path.resolve(input.output_root);
  try {
    await access(outputRoot);
    throw new Error("P3_WORKSPACE_OUTPUT_MUST_NOT_EXIST");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(outputRoot, { recursive: false });
  const workspace = buildSevenTopicReviewWorkspace({
    inventory: input.corpus.inventory,
    sources: input.corpus.sources,
    build_records: input.corpus.build_records,
    citation_state: input.corpus.citation_state,
  });
  const artifacts: { path: string; sha256: string; byte_count: number }[] = [];
  const write = async (relative: string, content: string | Uint8Array) => {
    const target = path.join(outputRoot, relative);
    const resolved = path.resolve(target);
    const relativeCheck = path.relative(outputRoot, resolved);
    if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) throw new Error("P3_WORKSPACE_PATH_ESCAPE");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { flag: "wx" });
    artifacts.push({ path: relative.replaceAll("\\", "/"), sha256: sha256(content), byte_count: typeof content === "string" ? Buffer.byteLength(content) : content.byteLength });
  };

  await write("corpus-inventory.json", stableJson(input.corpus.inventory));
  await write("workspace-index.json", stableJson(workspace.index));
  for (const topic of workspace.topics) {
    await write(`${topic.topic}/workspace.json`, stableJson(topic));
    await write(`${topic.topic}/workspace.md`, topicMarkdown(topic));
    await write(`${topic.topic}/workspace.html`, topicHtml(topic));
    await write(`${topic.topic}/blank-decision.json`, stableJson(topic.blank_decision));
  }
  const corpusStateRoot = path.resolve(input.corpus_state_root);
  const evidenceIndex: { source_version_id: string; artifact: string; normalized: string | null; chunks: string | null }[] = [];
  for (const source of input.corpus.sources) {
    const sourceVersionId = `${source.source_id}@${source.source_version}`;
    const build = input.corpus.build_records.find((record) => `${record.source_id}@${record.source_version}` === sourceVersionId);
    if (!build) throw new Error(`P3_PORTABLE_EVIDENCE_BUILD_MISSING:${sourceVersionId}`);
    const safeDirectory = `${source.source_id}-${source.source_version}`;
    const artifactRelative = `evidence/${safeDirectory}/artifact.${source.artifact_format}`;
    const artifactSource = path.join(corpusStateRoot, "eval", "legal-knowledge", "artifacts", source.source_id, source.source_version, `${build.artifact_sha256}.${source.artifact_format}`);
    const artifactBytes = await readFile(artifactSource);
    if (sha256(artifactBytes) !== build.artifact_sha256) throw new Error(`P3_PORTABLE_ARTIFACT_HASH_MISMATCH:${sourceVersionId}`);
    await write(artifactRelative, artifactBytes);
    let normalizedRelative: string | null = null;
    let chunksRelative: string | null = null;
    for (const [kind, sourcePath, expectedHash] of [
      ["normalized", build.normalized_path, build.normalized_output_sha256],
      ["chunks", build.chunks_path, build.chunks_output_sha256],
    ] as const) {
      if (sourcePath === null || sourcePath === undefined) {
        if (expectedHash !== null && expectedHash !== undefined) throw new Error(`P3_PORTABLE_${kind.toUpperCase()}_PATH_MISSING:${sourceVersionId}`);
        continue;
      }
      const resolvedSource = path.resolve(corpusStateRoot, sourcePath);
      const sourceRelative = path.relative(corpusStateRoot, resolvedSource);
      if (sourceRelative.startsWith("..") || path.isAbsolute(sourceRelative)) throw new Error(`P3_PORTABLE_${kind.toUpperCase()}_PATH_ESCAPE:${sourceVersionId}`);
      const bytes = await readFile(resolvedSource);
      if (expectedHash === null || expectedHash === undefined || sha256(bytes) !== expectedHash) throw new Error(`P3_PORTABLE_${kind.toUpperCase()}_HASH_MISMATCH:${sourceVersionId}`);
      const portableRelative = `evidence/${safeDirectory}/${kind}.json`;
      await write(portableRelative, bytes);
      if (kind === "normalized") normalizedRelative = portableRelative;
      else chunksRelative = portableRelative;
    }
    evidenceIndex.push({ source_version_id: sourceVersionId, artifact: artifactRelative, normalized: normalizedRelative, chunks: chunksRelative });
  }
  const pension = input.corpus.inventory.source_specific_gaps.pension_2016 as { renderer?: { page_image_sha256?: string[] } };
  const pensionPageHashes = pension.renderer?.page_image_sha256 ?? [];
  if (pensionPageHashes.length !== 3) throw new Error("P3_PENSION_PAGE_RENDER_HASHES_REQUIRED");
  const pensionEvidenceRoot = path.join(corpusStateRoot, "output", "parallel-wave-1", "review-package-v0.3", "worker-evidence", "batch-a-pension-convalescence", "pension-2016");
  for (let index = 0; index < pensionPageHashes.length; index += 1) {
    const pageBytes = await readFile(path.join(pensionEvidenceRoot, "intermediate", `page-${index + 1}.png`));
    if (sha256(pageBytes) !== pensionPageHashes[index]) throw new Error(`P3_PENSION_PAGE_RENDER_HASH_MISMATCH:${index + 1}`);
    await write(`evidence/pension-2016-render/page-${index + 1}.png`, pageBytes);
  }
  await write("evidence-index.json", stableJson({
    schema_version: "tivdoc-p3-portable-legal-evidence-index-v0.7.0",
    sources: evidenceIndex,
    pension_2016_page_renders: pensionPageHashes.map((hash, index) => ({ page: index + 1, path: `evidence/pension-2016-render/page-${index + 1}.png`, sha256: hash })),
    normalized_and_chunk_files_are_exact_corpus_bytes: true,
    legal_meaning_inferred: false,
  }));
  const ownerActions = Object.freeze({
    schema_version: "tivdoc-p3-owner-action-index-v0.7.0" as const,
    status: "SKIPPED_BLOCKED" as const,
    blockers: Object.freeze([
      {
        item_id: "P3-HUMAN-LEGAL-REVIEW",
        blocker_code: "HUMAN_LEGAL_SOURCE_REVIEW_REQUIRED",
        attempted_action: "built seven deterministic hash-bound review workspaces and blank decision templates",
        evidence: workspace.index.workspace_index_sha256,
        safe_fallback_completed: true,
        affected_acceptance_ids: ["V07-P3-REVIEW-WORKSPACE"],
        direct_downstream_impact: "real sources remain inactive and all seven topics remain not ready",
        next_human_or_environment_action: "authorized legal reviewers must review exact workspace hashes and produce genuine signed decisions",
      },
      {
        item_id: "P3-REVIEWER-TRUST",
        blocker_code: "REVIEWER_IDENTITY_AND_SIGNATURE_VERIFICATION_MISSING",
        attempted_action: "implemented exact-hash import validation and cryptographic verification port",
        evidence: workspace.index.workspace_index_sha256,
        safe_fallback_completed: true,
        affected_acceptance_ids: ["V07-P3-REVIEW-WORKSPACE"],
        direct_downstream_impact: "signed decisions cannot be admitted without an owner-configured trust store",
        next_human_or_environment_action: "configure reviewer identity, key trust, revocation and separation-of-duties verification",
      },
    ]),
    topic_actions: workspace.index.owner_actions,
    acquisition_report_sha256: input.acquisition_report_sha256,
    real_topics_ready: 0,
    real_sources_active: 0,
    real_parameters_active: 0,
    real_rules_active: 0,
  });
  await write("owner-action-index.json", stableJson(ownerActions));
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  const manifestCore = Object.freeze({
    schema_version: "tivdoc-p3-review-workspace-manifest-v0.7.0" as const,
    inventory_sha256: input.corpus.inventory.inventory_sha256,
    workspace_index_sha256: workspace.index.workspace_index_sha256,
    acquisition_report_sha256: input.acquisition_report_sha256,
    csp: LOCAL_CSP,
    artifact_count: artifacts.length,
    artifacts: Object.freeze(artifacts),
    generated_decisions: 0,
    generated_signatures: 0,
    selected_corpus_mutations: 0,
  });
  const manifest = Object.freeze({ ...manifestCore, manifest_sha256: sha256(stableJson(manifestCore)) });
  await writeFile(path.join(outputRoot, "evidence-manifest.json"), stableJson(manifest), { flag: "wx", encoding: "utf8" });
  return Object.freeze({ workspace, manifest, output_root: outputRoot });
}

export async function verifyP3ReviewWorkspace(outputRootInput: string) {
  const outputRoot = path.resolve(outputRootInput);
  const manifest = JSON.parse(await readFile(path.join(outputRoot, "evidence-manifest.json"), "utf8")) as {
    artifact_count: number;
    artifacts: { path: string; sha256: string; byte_count: number }[];
    generated_decisions: number;
    generated_signatures: number;
    selected_corpus_mutations: number;
  };
  if (manifest.artifact_count < 31 || manifest.artifacts.length !== manifest.artifact_count) throw new Error("P3_WORKSPACE_ARTIFACT_CARDINALITY_INVALID");
  if (new Set(manifest.artifacts.map((artifact) => artifact.path)).size !== manifest.artifact_count) throw new Error("P3_WORKSPACE_DUPLICATE_ARTIFACT_PATH");
  for (const artifact of manifest.artifacts) {
    const relative = path.normalize(artifact.path);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("P3_MANIFEST_PATH_ESCAPE");
    const bytes = await readFile(path.join(outputRoot, relative));
    if (bytes.byteLength !== artifact.byte_count || sha256(bytes) !== artifact.sha256) throw new Error(`P3_WORKSPACE_ARTIFACT_HASH_MISMATCH:${artifact.path}`);
    if (artifact.path.endsWith("workspace.html")) {
      const html = bytes.toString("utf8");
      if (!html.includes(escapeHtml(LOCAL_CSP)) || /<script\b|https?:\/\//iu.test(html)) throw new Error(`P3_WORKSPACE_STATIC_HTML_UNSAFE:${artifact.path}`);
    }
    if (artifact.path.endsWith("blank-decision.json")) {
      const decision = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      if (decision.status !== "blank_unsigned_template" || decision.decision !== null || decision.signature !== null || decision.reviewer_identity !== null) throw new Error(`P3_NONBLANK_DECISION_TEMPLATE:${artifact.path}`);
    }
  }
  if (manifest.generated_decisions !== 0 || manifest.generated_signatures !== 0 || manifest.selected_corpus_mutations !== 0) throw new Error("P3_WORKSPACE_ZERO_INVARIANT_FAILED");
  const htmlCount = manifest.artifacts.filter((artifact) => artifact.path.endsWith("workspace.html")).length;
  const blankDecisionCount = manifest.artifacts.filter((artifact) => artifact.path.endsWith("blank-decision.json")).length;
  if (htmlCount !== 7 || blankDecisionCount !== 7 || !manifest.artifacts.some((artifact) => artifact.path === "evidence-index.json")) throw new Error("P3_WORKSPACE_SEVEN_TOPIC_OR_EVIDENCE_INDEX_MISSING");
  return Object.freeze({ passed: true as const, artifact_count: manifest.artifact_count, topic_count: 7, portable_evidence_index: true as const, zero_invariants: true as const });
}
