import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildSevenTopicReviewWorkspace, importSignedReviewDecision } from "../../../../engine/legal-knowledge/overnight-v07/review-workspace.ts";
import { SafeLegalFetchError } from "../security.ts";
import { attemptP3OfficialTarget, loadP3AcquisitionTargets, runBoundedP3Acquisition, type P3AcquisitionTarget } from "./acquisition.ts";
import { loadCurrentP3Corpus } from "./corpus.ts";
import { verifyP3ReviewWorkspace, writeP3ReviewWorkspace } from "./workspace.ts";

const corpusStateRoot = process.env.TIVDOC_P3_CORPUS_STATE_ROOT;
const tempRoots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-p3-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function target(overrides: Partial<P3AcquisitionTarget> = {}): P3AcquisitionTarget {
  return Object.freeze({
    attempt_id: "P3-SYNTHETIC-OFFICIAL",
    source_id: "P3_SYNTHETIC_OFFICIAL",
    canonical_url: "https://www.gov.il/synthetic.pdf",
    artifact_format: "pdf",
    baseline_sha256: null,
    gap_class: "registered_target",
    historical_safe_error_code: null,
    ...overrides,
  });
}

describe("P3 bounded official acquisition", () => {
  test("preserves a successful official response only as an immutable inactive candidate", async () => {
    const root = await tempRoot();
    const bytes = new Uint8Array(600);
    bytes.set(new TextEncoder().encode("%PDF-"));
    const fetch = vi.fn(async () => ({ bytes, finalUrl: "https://www.gov.il/synthetic.pdf", contentType: "application/pdf", safeHeaders: {}, redirectCount: 0, redirectChain: ["https://www.gov.il/synthetic.pdf"] }));
    const receipt = await attemptP3OfficialTarget({ target: target(), candidate_root: root, fetcher: { fetch }, now: () => "2026-08-30T00:00:00.000Z" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({ status: "inactive_candidate", attempts: 1, selected_corpus_mutated: false, readiness_mutated: false, byte_count: 600 });
    const stored = path.join(root, "P3_SYNTHETIC_OFFICIAL", "candidate-v07", `${receipt.artifact_sha256}.pdf`);
    expect((await readFile(stored)).byteLength).toBe(600);
  });

  test("records one bounded failure without candidate bytes or corpus mutation", async () => {
    const root = await tempRoot();
    const fetch = vi.fn(async () => { throw new SafeLegalFetchError("http_status_403"); });
    const report = await runBoundedP3Acquisition({ targets: [target()], candidate_root: root, fetcher: { fetch }, concurrency: 1, now: () => "2026-08-30T00:00:00.000Z" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(report.totals).toEqual({ attempted: 1, inactive_candidates: 0, blocked: 1, selected_corpus_mutations: 0, readiness_mutations: 0 });
    expect(report.receipts[0]).toMatchObject({ status: "SKIPPED_BLOCKED", blocker_code: "http_status_403", attempts: 1, selected_corpus_mutated: false });
  });
});

describe.runIf(Boolean(corpusStateRoot))("P3 current-byte reconciliation and review workspace", () => {
  test("reconciles current corpus bytes and all seven topics without activation", async () => {
    const corpus = await loadCurrentP3Corpus({ repository_root: process.cwd(), corpus_state_root: corpusStateRoot! });
    expect(corpus.inventory.registered.source_versions).toBe(17);
    expect(corpus.inventory.legacy_build_view).toEqual({ build_records: 17, parsed: 14, failed: 3, chunks: 202 });
    expect(corpus.inventory.lifecycle_reconciliation).toMatchObject({ technical_parsed_sources: 16, technical_failed_sources: 1, parsed_but_instrument_quarantined_sources: 2, extracted_chunks: 274, quarantined_chunk_cardinality: 72, retrievable_review_chunks: 202 });
    expect(corpus.inventory.staged_working_time).toMatchObject({ publications: 20, permit_catalog_entries: 58, permit_artifact_links: 68, acquisition_requested_historical: 88, acquired_artifacts_historical: 72, missing_http_403_historical: 15, missing_http_404_historical: 1 });
    expect(corpus.inventory.topic_coverage).toHaveLength(7);
    expect(corpus.inventory.topic_coverage.every((topic) => topic.status === "not_ready")).toBe(true);
    expect(corpus.inventory.decisions).toEqual({ genuine_signatures: 0, reviewed_sources: 0, active_sources: 0, real_parameters: 0, real_rules: 0 });
    expect(corpus.inventory.selected_corpus_mutated).toBe(false);
  });

  test("builds and verifies 7 JSON/Markdown/static workspaces and rejects unsigned or stale decisions", async () => {
    const corpus = await loadCurrentP3Corpus({ repository_root: process.cwd(), corpus_state_root: corpusStateRoot! });
    const bundle = buildSevenTopicReviewWorkspace({ inventory: corpus.inventory, sources: corpus.sources, build_records: corpus.build_records, citation_state: corpus.citation_state });
    expect(bundle.topics).toHaveLength(7);
    expect(bundle.topics.every((topic) => topic.blank_decision.decision === null && topic.blank_decision.signature === null)).toBe(true);
    const topic = bundle.topics[0];
    const decision = {
      schema_version: "tivdoc-legal-review-decision-v0.7.0" as const,
      status: "signed_human_decision" as const,
      topic: topic.topic,
      workspace_sha256: topic.workspace_sha256,
      source_set_sha256: topic.source_set_sha256,
      artifact_set_sha256: topic.artifact_set_sha256,
      text_set_sha256: topic.text_set_sha256,
      interval_scope_sha256: topic.interval_scope_sha256,
      decision: "needs_changes" as const,
      reviewer_identity: "reviewer_001",
      importer_identity: "importer_002",
      reviewer_trust_id: "trust_001",
      reviewed_at: "2026-08-30T00:00:00.000Z",
      signature_algorithm: "ed25519",
      signature_key_id: "key_001",
      signature: "synthetic-signature-do-not-trust",
      legal_findings: [],
    };
    await expect(importSignedReviewDecision(topic, decision, null)).resolves.toMatchObject({ accepted_for_review_record: false, blocker_code: "REVIEWER_IDENTITY_AND_SIGNATURE_VERIFICATION_MISSING", activation_changed: false, usable_for_rules: false });
    await expect(importSignedReviewDecision(topic, { ...decision, workspace_sha256: "0".repeat(64) }, { verify: async () => true })).rejects.toThrow("P3_DECISION_BINDING_MISMATCH");
    await expect(importSignedReviewDecision(topic, decision, { verify: async () => true })).resolves.toMatchObject({ accepted_for_review_record: true, blocker_code: null, activation_changed: false, usable_for_rules: false });

    const root = await tempRoot();
    const output = path.join(root, "workspace");
    const written = await writeP3ReviewWorkspace({ corpus, corpus_state_root: corpusStateRoot!, output_root: output, acquisition_report_sha256: null });
    expect(written.manifest.artifact_count).toBeGreaterThan(31);
    await expect(verifyP3ReviewWorkspace(output)).resolves.toMatchObject({ passed: true, topic_count: 7, portable_evidence_index: true, zero_invariants: true });
  });

  test("loads all known bounded official acquisition targets from actual evidence", async () => {
    const targets = await loadP3AcquisitionTargets({ repository_root: process.cwd(), corpus_state_root: corpusStateRoot! });
    expect(targets).toHaveLength(25);
    expect(targets.filter((item) => item.historical_safe_error_code === "http_status_403")).toHaveLength(15);
    expect(targets.filter((item) => item.historical_safe_error_code === "http_status_404")).toHaveLength(1);
    expect(targets.every((item) => ["www.gov.il", "gov.il", "main.knesset.gov.il", "fs.knesset.gov.il", "www.btl.gov.il", "btl.gov.il"].includes(new URL(item.canonical_url).hostname))).toBe(true);
  });
});
