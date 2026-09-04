// L6-8 / D5. Review package v10: v9's package, rebuilt on sensitivity report v5.
//
// What is new in v10. Every topic runs — seven of seven — and every bound
// parameter carries a provenance grade the report and the Hebrew rendering
// both show. For every parameter graded inferred_visual, the package carries
// the cited page extracted from the stored artifact as a standalone PDF, its
// hash the very page_pdf_sha256 the candidate's visual bindings name, under
// visual-pages/ with an index that maps each binding to its member: the
// reviewer confirms a reading against the page in the package, not against a
// file they must go and find. The topics-run floor is seven.
//
// (v9's header follows.)
// L5-10. Review package v9: v8's package, rebuilt on sensitivity report v4.
//
// What is new in v9. The report runs six topics of seven — vacation beyond the
// seventh year, sick leave and convalescence joined — and the one that does
// not, working_time, says so by slot and by the acquisition attempt that was
// refused. The topics-run gate is monotonic against the LAST PACKAGE, read
// from its manifest, with a floor of six: a report that runs fewer topics than
// the package before it is refused, whatever the number. v3 travels beside v4
// as a superseded report, as v2 and v1 did beside v3.
//
// (v8's header follows; everything it says still holds.)
//
// L4-9. Review package v8: everything a lawyer needs, in one place, built twice
// to one hash — and now including a version they can read.
//
// What it bundles: the research dossier, the Q-8 decision-sensitivity report,
// the `legal_open_decisions` export with reasons, every registered draft
// parameter with its artifact hashes and citation locators, the sixty-nine
// supersession packets index, the seven draft RuleSpecs, and the Hebrew
// reviewer runbook.
//
// Every item is `not_reviewed`, `not_signed`, `not_activated`, `not_delivered`,
// stated per item rather than once at the top — a blanket header is how one
// item quietly differs from the rest.
//
// Three things make this v8.
//
// The sensitivity report is v3: four topics of seven instead of three, because
// the vacation entitlement table can be executed now, and outputs are no longer
// restricted to money.
//
// The Hebrew rendering of that report travels with it, in both forms, and the
// build refuses unless the rendering was generated from THIS report. A document
// quoting one set of figures beside a report stating another is worse than no
// document, and a hash comparison is all that stands between them.
//
// And the reports it replaces travel with it, v2 and v1 both, so a reader
// comparing three versions can see what changed rather than taking the newest
// on trust.
//
// Three topics still did not run and each says why in its own terms, named by
// the slot it waits on. That list stays in the package: a reader must be able
// to see what was not computed as easily as what was.
//
// Determinism is the property under test: content is written in a fixed order
// from fixed inputs with an order-stable serializer, the manifest is built
// twice, and the hash is only reported if both builds match byte for byte.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildSevenRuleSpecDrafts } from "../../src/engine/legal-quality/rulespec-drafts.ts";
import { buildSevenRuleSpecTemplates } from "../../src/engine/legal-quality/rulespec-templates.ts";
import { buildAllScenarioFixtures } from "../../src/engine/legal-quality/scenario-fixtures.ts";
import { SENSITIVITY_SPECS } from "../../src/engine/legal-quality/sensitivity-rulespecs.ts";
import { SYNTHETIC_CORPUS, SYNTHETIC_CORPUS_SHA256 } from "../../src/engine/shadow/synthetic-corpus.ts";
import { POOL_P_CITATION_ANCHORS } from "./pool-p-citation-anchors.mts";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { TENANT } from "./pool-p-parameter-import.mts";
import { extractPagePdf } from "./visual-page.mts";

const fetchState = JSON.parse(readFileSync(path.resolve("eval/legal-knowledge/manifests/fetch-state.json"), "utf8")) as {
  observations: Array<{ source_id: string; source_version: string; artifact_path: string; artifact_sha256: string }>;
};
const buildState = JSON.parse(readFileSync(path.resolve("eval/legal-knowledge/manifests/build-state.json"), "utf8")) as {
  records: Array<{ source_id: string; source_version: string; artifact_sha256: string }>;
};
const artifactBytesOf = (artifactPath: string) => readFileSync(path.resolve(artifactPath));

const PACKAGE_ROOT = path.join("output", "next", "review-package-v11");
const SYSTEM_SESSION = { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import" };
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Order-stable serialization, so identical content hashes identically. */
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

const STATE = Object.freeze({
  review_state: "not_reviewed",
  signature_state: "not_signed",
  activation_state: "not_activated",
  delivery_state: "not_delivered",
});

type Written = Readonly<{ file: string; sha256: string; byte_count: number }>;

function writeMember(files: Written[], relative: string, content: string): void {
  const target = path.join(PACKAGE_ROOT, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
  files.push({ file: relative, sha256: hash(content), byte_count: Buffer.byteLength(content) });
}

/** The same, for a member that is not text. The PDF is the only one so far. */
function writeBinaryMember(files: Written[], relative: string, content: Uint8Array): void {
  const target = path.join(PACKAGE_ROOT, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  files.push({ file: relative, sha256: hash(content), byte_count: content.byteLength });
}

function readIfPresent(relative: string): string | null {
  return existsSync(relative) ? readFileSync(relative, "utf8") : null;
}

async function build(): Promise<{ manifest_sha256: string; files: Written[]; item_count: number }> {
  rmSync(PACKAGE_ROOT, { recursive: true, force: true });
  mkdirSync(PACKAGE_ROOT, { recursive: true });
  const files: Written[] = [];

  // --- The dossier, copied verbatim so the reviewer holds the same bytes the
  // parameters bind to.
  const dossierPath = "docs/legal/research-dossier-2026-09-03.md";
  const dossier = readIfPresent(dossierPath);
  if (!dossier) throw new Error("E21_DOSSIER_MISSING");
  writeMember(files, "dossier/research-dossier-2026-09-03.md", dossier);

  const runbook = readIfPresent("docs/legal/reviewer-runbook.he.md");
  if (runbook) writeMember(files, "runbook/reviewer-runbook.he.md", runbook);

  // --- The sensitivity report and the decisions export, straight through.
  const sensitivity = readIfPresent("output/next/pool-q/decision-sensitivity-report-v6.json");
  if (!sensitivity) throw new Error("E48_SENSITIVITY_REPORT_V6_MISSING:run decision-sensitivity-run-v6.mts first");
  writeMember(files, "decisions/decision-sensitivity-report.json", sensitivity);
  // The two it replaces, kept beside it. v1 could compute nothing and v2 could
  // compute only money; a reader comparing the three can see exactly what
  // changed rather than taking the newest on trust.
  const supersededV5 = readIfPresent("output/next/pool-q/decision-sensitivity-report-v5.json");
  if (supersededV5) writeMember(files, "decisions/decision-sensitivity-report-superseded-v5.json", supersededV5);
  const supersededV4 = readIfPresent("output/next/pool-q/decision-sensitivity-report-v4.json");
  if (supersededV4) writeMember(files, "decisions/decision-sensitivity-report-superseded-v4.json", supersededV4);
  const supersededV3 = readIfPresent("output/next/pool-q/decision-sensitivity-report-v3.json");
  if (supersededV3) writeMember(files, "decisions/decision-sensitivity-report-superseded-v3.json", supersededV3);
  const supersededV2 = readIfPresent("output/next/pool-q/decision-sensitivity-report-v2.json");
  if (supersededV2) writeMember(files, "decisions/decision-sensitivity-report-superseded-v2.json", supersededV2);
  const superseded = readIfPresent("output/next/pool-q/decision-sensitivity-report.json");
  if (superseded) writeMember(files, "decisions/decision-sensitivity-report-superseded-v1.json", superseded);

  // --- The Hebrew rendering, in both forms, bound to THIS report by hash.
  const hebrewReceipt = readIfPresent("output/next/pool-q/sensitivity-report-hebrew.json");
  if (!hebrewReceipt) throw new Error("E48_HEBREW_RENDERING_MISSING:run sensitivity-report-hebrew.mts first");
  const hebrew = JSON.parse(hebrewReceipt) as {
    source_report_sha256: string;
    markdown: { path: string; sha256: string };
    pdf: { path: string; sha256: string };
  };
  const reportSha256 = (JSON.parse(sensitivity) as { report_sha256: string }).report_sha256;
  if (hebrew.source_report_sha256 !== reportSha256) {
    // A Hebrew document quoting one set of figures, shipped beside a report
    // stating another, is worse than no document at all. A hash comparison is
    // the only thing standing between the two, so it is made rather than assumed.
    throw new Error(`E48_HEBREW_RENDERING_STALE:rendered_from_${hebrew.source_report_sha256.slice(0, 16)}_report_is_${reportSha256.slice(0, 16)}`);
  }
  const hebrewMarkdown = readIfPresent(hebrew.markdown.path);
  if (!hebrewMarkdown) throw new Error("E48_HEBREW_MARKDOWN_MISSING");
  if (hash(hebrewMarkdown) !== hebrew.markdown.sha256) throw new Error("E48_HEBREW_MARKDOWN_HASH_MISMATCH");
  writeMember(files, "report/sensitivity-report.he.md", hebrewMarkdown);
  if (!existsSync(hebrew.pdf.path)) throw new Error("E48_HEBREW_PDF_MISSING");
  const hebrewPdf = readFileSync(hebrew.pdf.path);
  if (hash(hebrewPdf) !== hebrew.pdf.sha256) throw new Error("E48_HEBREW_PDF_HASH_MISMATCH");
  writeBinaryMember(files, "report/sensitivity-report.he.pdf", hebrewPdf);
  writeMember(files, "report/hebrew-rendering-receipt.json", hebrewReceipt);

  // --- Everything that needs DEV: the decisions table and the candidates with
  // their real hashes.
  const env = readDevEnvFile();
  const url = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!url) throw new Error("E21_ENV_MISSING");
  const parsed = new URL(url);
  const factory = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: url, max_connections: 4, connection_timeout_ms: 20_000,
    application_name: "tivdoc_review_package_v11",
    remote_dev_target: {
      host: parsed.hostname, port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//u, ""), project_ref: env.get("TIVDOC_DEV_PROJECT_REF") ?? "",
    },
  });
  const client = await factory.acquire();
  let decisionRows: Array<Record<string, unknown>> = [];
  const candidates: Array<Record<string, unknown>> = [];
  try {
    await client.query(statement("v11_begin", "begin", []));
    await client.query(statement("v11_context", "select * from private.runtime_context_install($1,$2,$3)",
      [SYSTEM_SESSION.sid, SYSTEM_SESSION.jti, `v11:${randomUUID().slice(0, 8)}`]));
    const decisions = await client.query(statement("v11_decisions",
      "select * from private.legal_open_decision_read($1)", [TENANT]));
    // E3-3: synthetic rows never reach a legal export. The flag is on the row
    // now, so this is a filter rather than a naming convention.
    decisionRows = (decisions.rows as unknown as Array<Record<string, unknown>>).filter((row) => row.synthetic !== true);
    const wanted = new Set<string>();
    for (const draft of buildSevenRuleSpecDrafts()) {
      for (const slot of draft.parameter_slots) if (slot.bound) for (const id of slot.parameter_version_ids) wanted.add(id);
    }
    for (const id of [...wanted].sort()) {
      const at = id.lastIndexOf("@");
      const row = await client.query(statement("v11_aggregate",
        "select state, revision, activation_allowed, content_sha256, content_json from private.governance_aggregate_read($1,$2,$3,$4)",
        [TENANT, "parameter_approval", id.slice(0, at), id.slice(at + 1)]));
      if (row.row_count !== 1) continue;
      const value = row.rows[0] as unknown as { state: string; activation_allowed: boolean; content_sha256: string; content_json: Record<string, unknown> };
      candidates.push({
        parameter_version_id: id,
        state: value.state,
        activation_allowed: value.activation_allowed,
        candidate_sha256: value.content_sha256,
        // The eleven binding dimensions' hashes, and the artifact the value is
        // bound to. This is what makes the citation checkable rather than
        // quotable.
        bindings: value.content_json.bindings,
        operative_source_version_ids: value.content_json.operative_source_version_ids,
        effective_from: value.content_json.effective_from,
        effective_to: value.content_json.effective_to,
        sectors: value.content_json.sectors,
        populations: value.content_json.populations,
        unit: value.content_json.unit,
        value: value.content_json.value,
        decision_id: value.content_json.decision_id,
        branch: value.content_json.branch,
        ...STATE,
      });
    }
    await client.query(statement("v11_rollback", "rollback", []));
  } finally {
    client.release();
  }

  writeMember(files, "decisions/legal-open-decisions.json", canonicalJson({
    schema_version: "tivdoc-review-package-v11-decisions",
    total: decisionRows.length,
    open: decisionRows.filter((row) => row.resolution_state === "open").length,
    withdrawn: decisionRows.filter((row) => row.resolution_state === "withdrawn").length,
    resolved: decisionRows.filter((row) => row.resolution_state === "resolved").length,
    synthetic_excluded: true,
    note: "Synthetic proof fixtures are excluded by the row flag, not by an id convention. Withdrawn is not resolved. A withdrawn decision was dissolved by reading the source and carries its reason and the citation locator that dissolved it; a resolved one was settled by two independent human attestations naming the same branch. Both are listed; neither is inferred from the other.",
    decisions: decisionRows,
  }));

  writeMember(files, "parameters/draft-parameters.json", canonicalJson({
    schema_version: "tivdoc-review-package-v11-parameters",
    count: candidates.length,
    every_item_not_reviewed: candidates.every((entry) => entry.review_state === "not_reviewed"),
    every_item_not_signed: candidates.every((entry) => entry.signature_state === "not_signed"),
    every_item_not_activated: candidates.every((entry) => entry.activation_state === "not_activated"),
    every_item_not_delivered: candidates.every((entry) => entry.delivery_state === "not_delivered"),
    none_activatable: candidates.every((entry) => entry.activation_allowed === false),
    parameters: candidates,
  }));

  // --- The citation locators, from the batch scripts that declared them: the
  // governance database keeps only the hash of the citation set, so the
  // locators themselves live in the import scripts.
  const citationRecheck = readIfPresent("output/next/normalizer-v1/normalizer-v1-citation-recheck.json");
  if (citationRecheck) writeMember(files, "parameters/citation-recheck-v0-vs-v1.json", citationRecheck);

  // --- The seven templates and the seven drafts.
  writeMember(files, "rulespecs/templates.json", canonicalJson({
    schema_version: "tivdoc-review-package-v11-rulespec-templates",
    templates: buildSevenRuleSpecTemplates(),
  }));
  writeMember(files, "rulespecs/executable-sensitivity-specs.json", canonicalJson({
    schema_version: "tivdoc-review-package-v11-sensitivity-specs",
    note: "The specs the run actually executed. Definitional computations only; every legal judgement stays in the unbound slots of the drafts below. Each declares where it is narrower than the draft it stands in for.",
    specs: SENSITIVITY_SPECS.map((entry) => ({ ...entry, ...STATE })),
  }));
  writeMember(files, "rulespecs/drafts.json", canonicalJson({
    schema_version: "tivdoc-review-package-v11-rulespec-drafts",
    drafts: buildSevenRuleSpecDrafts().map((draft) => ({ ...draft, ...STATE })),
  }));

  // --- The sixty-nine supersession packets index, verbatim from the run that
  // produced them.
  const items = readIfPresent("output/v4/review-package-v4/items.json");
  const supersession = readIfPresent("output/v4/audit/observation-supersede.json");
  if (items) writeMember(files, "packets/supersession-packets-index.json", items);
  if (supersession) writeMember(files, "packets/supersession-accounting.json", supersession);

  // --- The scenarios, and the traces. Everything here is read out of the
  // sensitivity report so the package and the report can never disagree.
  const sensitivityDocument = JSON.parse(sensitivity) as {
    scenarios_attempted: number; scenarios_run: number; scenarios_refused: number;
    traces_included: number; traces_replayed_from_database: number;
    topics_run: string[]; topics_not_run: unknown[]; executions: unknown[];
  };
  if (!(sensitivityDocument.traces_included > 0)) {
    throw new Error(`E38_TRACES_INCLUDED_MUST_EXCEED_ZERO:got_${sensitivityDocument.traces_included}`);
  }
  // The monotonic gate (D8): topics_run may go up, never down. The floor is
  // what THIS run reached, six, and the bar is whatever the previous package
  // shipped — read from its manifest, not typed here, so the gate follows the
  // packages rather than a number someone has to remember to raise.
  // v8's manifest did not record the count; its topics member did. From v9 on
  // the manifest carries it under `sensitivity`, so the next package reads one
  // field and falls back to the member only for v8.
  const previousManifest = readIfPresent("output/next/review-package-v10/manifest.json");
  const previousTopicsMember = readIfPresent("output/next/review-package-v10/scenarios/topics-not-run.json");
  const previousTopicsRun = previousManifest
    ? ((JSON.parse(previousManifest) as { sensitivity?: { topics_run?: number } }).sensitivity?.topics_run
      ?? (previousTopicsMember ? (JSON.parse(previousTopicsMember) as { topics_run?: string[] }).topics_run?.length ?? 0 : 0))
    : 0;
  const topicsRunFloor = Math.max(7, previousTopicsRun);
  if (!(sensitivityDocument.topics_run.length >= topicsRunFloor)) {
    throw new Error(`E48_TOPICS_RUN_REGRESSED:got_${sensitivityDocument.topics_run.length}_floor_${topicsRunFloor}`);
  }
  writeMember(files, "scenarios/scenario-input-fixtures.json", canonicalJson({
    schema_version: "tivdoc-review-package-v11-scenario-fixtures",
    note: "Synthetic inputs only. There is no expected field in this schema: the input half of a golden case is data, the expected half is a legal determination, and only a person may write one.",
    count: buildAllScenarioFixtures().length,
    fixtures: buildAllScenarioFixtures(),
  }));
  writeMember(files, "scenarios/executions-and-traces.json", canonicalJson({
    schema_version: "tivdoc-review-package-v11-executions",
    attempted: sensitivityDocument.scenarios_attempted,
    run: sensitivityDocument.scenarios_run,
    refused: sensitivityDocument.scenarios_refused,
    traces_included: sensitivityDocument.traces_included,
    traces_replayed_from_database: sensitivityDocument.traces_replayed_from_database,
    refusal_note: "Every refusal is a missing_conflicted_facts scenario reaching RULESPEC_INPUT_MISSING. That is the fixture doing its job, not a gap.",
    executions: sensitivityDocument.executions,
  }));
  writeMember(files, "scenarios/topics-not-run.json", canonicalJson({
    schema_version: "tivdoc-review-package-v11-topics-not-run",
    note: "What was not computed, as plainly as what was. A reader who cannot find this list will assume the whole corpus ran.",
    topics_run: sensitivityDocument.topics_run,
    topics_not_run: sensitivityDocument.topics_not_run,
  }));
  // --- L7-10: the offline shadow, and its own monotonic gate. The receipt the
  // draft shadow run wrote is copied through, bound to the report by hash;
  // shadow_cases_run may go up, never down, and must exceed zero; a receipt
  // with a replay failure, a finding, a delivery or extraction is refused.
  const shadowReceiptText = readIfPresent("output/next/shadow/draft-shadow-receipt-v1.json");
  if (!shadowReceiptText) throw new Error("E710_SHADOW_RECEIPT_MISSING:run draft-shadow-run-v1.mts first");
  const shadowReceipt = JSON.parse(shadowReceiptText) as {
    run_id: string; receipt_sha256: string; envelope_sha256: string; execution_mode: string;
    counts: { ran: number; cases: number; executions: number; deltas_computed: number }; replay_failures: unknown[];
    traces_included: number; traces_replayed_from_database: number; comparison: unknown;
    extraction_used: boolean; is_finding: boolean; delivery_allowed: boolean;
  };
  const reportShadow = (JSON.parse(sensitivity) as { shadow?: { receipt_sha256?: string; run_id?: string } }).shadow;
  if (reportShadow?.receipt_sha256 !== shadowReceipt.receipt_sha256 || reportShadow?.run_id !== shadowReceipt.run_id) {
    throw new Error(`E710_SHADOW_RECEIPT_STALE:report_${String(reportShadow?.receipt_sha256).slice(0, 16)}_receipt_${shadowReceipt.receipt_sha256.slice(0, 16)}`);
  }
  if (shadowReceipt.replay_failures.length > 0 || shadowReceipt.is_finding !== false || shadowReceipt.delivery_allowed !== false || shadowReceipt.extraction_used !== false) {
    throw new Error("E710_SHADOW_RECEIPT_INVARIANT");
  }
  const previousShadowCasesRun = previousManifest
    ? ((JSON.parse(previousManifest) as { shadow?: { shadow_cases_run?: number } }).shadow?.shadow_cases_run ?? 0)
    : 0;
  const shadowCasesRunFloor = Math.max(1, previousShadowCasesRun);
  if (!(shadowReceipt.counts.ran >= shadowCasesRunFloor)) {
    throw new Error(`E710_SHADOW_CASES_RUN_REGRESSED:got_${shadowReceipt.counts.ran}_floor_${shadowCasesRunFloor}`);
  }
  writeMember(files, "shadow/draft-shadow-receipt-v1.json", shadowReceiptText);
  const shadowSummaryText = readIfPresent("output/next/shadow/draft-shadow-summary-v1.json");
  if (!shadowSummaryText) throw new Error("E710_SHADOW_SUMMARY_MISSING");
  writeMember(files, "shadow/draft-shadow-summary-v1.json", shadowSummaryText);
  writeMember(files, "shadow/branch-comparison.json", canonicalJson({
    schema_version: "tivdoc-review-package-v11-branch-comparison",
    note: "For each open decision, every synthetic month under each branch and the exact difference between the branches. human_review_required is true on every row and nothing here accepts a branch; a branch that is named and not bound is listed with its reason and never run.",
    decisions: shadowReceipt.comparison,
  }));
  writeMember(files, "shadow/synthetic-corpus-index.json", canonicalJson({
    schema_version: "tivdoc-review-package-v11-synthetic-corpus-index",
    note: "The synthetic facts corpus the shadow ran on: one payslip month per golden scenario family per topic and the edge cases each spec refuses. Every month is synthetic by construction — ids derived from a seed, the proof tenant's case — and its snapshot hash is pinned here; the snapshots themselves are in the repository test tree, not in this package.",
    corpus_sha256: SYNTHETIC_CORPUS_SHA256,
    cases: SYNTHETIC_CORPUS.map((entry) => ({ case_id: entry.case_id, topic: entry.topic, family: entry.family, scenario: entry.scenario, population: entry.population, shadow_ids: entry.shadow_ids, snapshot_sha256: entry.snapshot_sha256, expected: entry.expected })),
  }));

  // --- D1: the cited page beside every visual citation, bytes from the stored
  // artifact, hash checked against the receipt the batch wrote.
  const visualReceipts = ["batch-11-visual.json", "batch-13-pension-visual.json", "batch-15-threshold-visual.json"];
  const visualIndex: Array<Record<string, unknown>> = [];
  const extracted = new Map<string, string>();
  for (const receiptName of visualReceipts) {
    const receiptText = readIfPresent(`output/next/pool-p/${receiptName}`);
    if (!receiptText) throw new Error(`E68_VISUAL_RECEIPT_MISSING:${receiptName}`);
    const receipt = JSON.parse(receiptText) as {
      registered: string[];
      visual_citations: Array<{ source_version_id: string; page: number; page_pdf_sha256: string; visual_reading: string; region: unknown; anchor: string | null; anchor_absent: string | null; locator: string }>;
    };
    for (const citation of receipt.visual_citations) {
      const key = `${citation.source_version_id}#p${citation.page}`;
      let member = extracted.get(key);
      if (!member) {
        const [sourceId, sourceVersion] = citation.source_version_id.split("@");
        // The artifact the build record names — a source may carry earlier
        // observations (a challenge page, a superseded fetch) that are not it.
        const record = buildState.records.find((entry) => entry.source_id === sourceId && entry.source_version === sourceVersion);
        const observation = fetchState.observations.find((entry) => entry.source_id === sourceId && entry.source_version === sourceVersion && entry.artifact_sha256 === record?.artifact_sha256);
        if (!record || !observation) throw new Error(`E68_VISUAL_ARTIFACT_MISSING:${citation.source_version_id}`);
        if (hash(artifactBytesOf(observation.artifact_path)) !== record.artifact_sha256) throw new Error(`E68_VISUAL_ARTIFACT_HASH_MISMATCH:${citation.source_version_id}`);
        const pagePdf = await extractPagePdf(artifactBytesOf(observation.artifact_path), citation.page);
        const pageSha = hash(pagePdf);
        if (pageSha !== citation.page_pdf_sha256) throw new Error(`E68_VISUAL_PAGE_HASH_MISMATCH:${key}:${pageSha.slice(0, 16)}`);
        member = `visual-pages/${sourceId}.p${citation.page}.${pageSha.slice(0, 16)}.pdf`;
        writeBinaryMember(files, member, pagePdf);
        extracted.set(key, member);
      }
      visualIndex.push({
        source_version_id: citation.source_version_id, page: citation.page, member, page_pdf_sha256: citation.page_pdf_sha256,
        visual_reading: citation.visual_reading, region: citation.region, anchor: citation.anchor, anchor_absent: citation.anchor_absent, locator: citation.locator,
        registered_in: receiptName, parameter_version_ids: receipt.registered,
      });
    }
  }
  writeMember(files, "visual-pages/index.json", canonicalJson({
    schema_version: "tivdoc-review-package-v11-visual-pages",
    note: "Every figure graded inferred_visual was read from the page image because the artifact's text layer is ambiguous or absent. The page is here, extracted from the stored artifact and hashed; the reviewer confirms the reading against it, and an attestation without visual_confirmed against this page hash and reading is refused by the database.",
    pages: visualIndex,
  }));

  writeMember(files, "parameters/citation-anchors.json", canonicalJson({
    schema_version: "tivdoc-review-package-v11-citation-anchors",
    note: "The Hebrew clause fragment each citation must sit beside, and the six cited chunks that can carry no anchor because they are bare table rows with the headers chunked away.",
    anchors: POOL_P_CITATION_ANCHORS,
  }));

  // --- L7-9: the lexicon binding of §2's eight hours, the receipt the batch wrote.
  const batch16 = readIfPresent("output/next/pool-p/batch-16-daily-threshold.json");
  if (!batch16) throw new Error("E79_BATCH16_RECEIPT_MISSING:run pool-p-batch-16-daily-threshold.mts first");
  writeMember(files, "parameters/batch-16-daily-threshold.json", batch16);

  const manifestContent = {
    schema_version: "tivdoc-review-package-v11-manifest",
    package: "review-package-v11",
    tenant: TENANT,
    ...STATE,
    every_item_state: STATE,
    counters: {
      reviewed_sources: 0, active_sources: 0, active_parameters: 0, active_rules: 0,
      attestations: 0, deliveries: 0, findings: 0, human_ground_truth_locked: 0,
    },
    sensitivity: {
      report_sha256: reportSha256,
      topics_run: sensitivityDocument.topics_run.length,
      topics_not_run: sensitivityDocument.topics_not_run.length,
      traces_included: sensitivityDocument.traces_included,
      topics_run_floor: topicsRunFloor,
      previous_package_topics_run: previousTopicsRun,
    },
    shadow: {
      receipt_sha256: shadowReceipt.receipt_sha256,
      run_id: shadowReceipt.run_id,
      execution_mode: shadowReceipt.execution_mode,
      envelope_sha256: shadowReceipt.envelope_sha256,
      shadow_cases: shadowReceipt.counts.cases,
      shadow_executions: shadowReceipt.counts.executions,
      shadow_cases_run: shadowReceipt.counts.ran,
      shadow_deltas_computed: shadowReceipt.counts.deltas_computed,
      traces_included: shadowReceipt.traces_included,
      traces_replayed_from_database: shadowReceipt.traces_replayed_from_database,
      shadow_cases_run_floor: shadowCasesRunFloor,
      previous_package_shadow_cases_run: previousShadowCasesRun,
      is_finding: false,
      delivery_allowed: false,
    },
    file_count: files.length,
    files: [...files].sort((left, right) => left.file.localeCompare(right.file)),
  };
  const manifest = canonicalJson(manifestContent);
  writeFileSync(path.join(PACKAGE_ROOT, "manifest.json"), manifest, "utf8");
  return { manifest_sha256: hash(manifest), files, item_count: candidates.length + decisionRows.length };
}

const first = await build();
const second = await build();
if (first.manifest_sha256 !== second.manifest_sha256) throw new Error("E21_PACKAGE_NOT_DETERMINISTIC");
if (first.files.length !== second.files.length) throw new Error("E21_PACKAGE_FILE_COUNT_DRIFT");
for (const [index, file] of first.files.entries()) {
  if (file.sha256 !== second.files[index].sha256) throw new Error(`E21_MEMBER_NOT_DETERMINISTIC:${file.file}`);
}

process.stdout.write(`${JSON.stringify({
  manifest_sha256: first.manifest_sha256,
  built_twice_identical: true,
  file_count: first.files.length,
  files: first.files.map((file) => file.file),
  reviewed: 0, signed: 0, activated: 0, delivered: 0,
}, null, 2)}\n`);
