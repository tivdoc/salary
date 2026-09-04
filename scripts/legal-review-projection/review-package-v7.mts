// E3-8. Review package v7: everything a lawyer needs, in one place, built twice
// to one hash.
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
// The scenario traces are in it now. E3-7 ran the six scenarios against three
// executable specs, once per branch of both open decisions, persisted every
// trace through R-14's table and replayed all of them back out of the database.
// The trace count must be greater than zero or this unit fails, which is the
// difference between v7 and v6.
//
// Four topics still did not run and each says why in its own terms. That list
// stays in the package: a reader must be able to see what was not computed as
// easily as what was.
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
import { POOL_P_CITATION_ANCHORS } from "./pool-p-citation-anchors.mts";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { TENANT } from "./pool-p-parameter-import.mts";

const PACKAGE_ROOT = path.join("output", "next", "review-package-v7");
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
  const sensitivity = readIfPresent("output/next/pool-q/decision-sensitivity-report-v2.json");
  if (!sensitivity) throw new Error("E38_SENSITIVITY_REPORT_V2_MISSING:run decision-sensitivity-run.mts first");
  writeMember(files, "decisions/decision-sensitivity-report.json", sensitivity);
  // The superseded v1, kept beside it. It is the record of what could not be
  // computed before, and a reader comparing the two can see exactly what
  // changed rather than taking the new one on trust.
  const superseded = readIfPresent("output/next/pool-q/decision-sensitivity-report.json");
  if (superseded) writeMember(files, "decisions/decision-sensitivity-report-superseded-v1.json", superseded);

  // --- Everything that needs DEV: the decisions table and the candidates with
  // their real hashes.
  const env = readDevEnvFile();
  const url = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!url) throw new Error("E21_ENV_MISSING");
  const parsed = new URL(url);
  const factory = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: url, max_connections: 4, connection_timeout_ms: 20_000,
    application_name: "tivdoc_review_package_v7",
    remote_dev_target: {
      host: parsed.hostname, port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//u, ""), project_ref: env.get("TIVDOC_DEV_PROJECT_REF") ?? "",
    },
  });
  const client = await factory.acquire();
  let decisionRows: Array<Record<string, unknown>> = [];
  const candidates: Array<Record<string, unknown>> = [];
  try {
    await client.query(statement("v7_begin", "begin", []));
    await client.query(statement("v7_context", "select * from private.runtime_context_install($1,$2,$3)",
      [SYSTEM_SESSION.sid, SYSTEM_SESSION.jti, `v7:${randomUUID().slice(0, 8)}`]));
    const decisions = await client.query(statement("v7_decisions",
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
      const row = await client.query(statement("v7_aggregate",
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
    await client.query(statement("v7_rollback", "rollback", []));
  } finally {
    client.release();
  }

  writeMember(files, "decisions/legal-open-decisions.json", canonicalJson({
    schema_version: "tivdoc-review-package-v7-decisions",
    total: decisionRows.length,
    open: decisionRows.filter((row) => row.resolution_state === "open").length,
    withdrawn: decisionRows.filter((row) => row.resolution_state === "withdrawn").length,
    resolved: decisionRows.filter((row) => row.resolution_state === "resolved").length,
    synthetic_excluded: true,
    note: "Synthetic proof fixtures are excluded by the row flag, not by an id convention. Withdrawn is not resolved. A withdrawn decision was dissolved by reading the source and carries its reason and the citation locator that dissolved it; a resolved one was settled by two independent human attestations naming the same branch. Both are listed; neither is inferred from the other.",
    decisions: decisionRows,
  }));

  writeMember(files, "parameters/draft-parameters.json", canonicalJson({
    schema_version: "tivdoc-review-package-v7-parameters",
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
    schema_version: "tivdoc-review-package-v7-rulespec-templates",
    templates: buildSevenRuleSpecTemplates(),
  }));
  writeMember(files, "rulespecs/executable-sensitivity-specs.json", canonicalJson({
    schema_version: "tivdoc-review-package-v7-sensitivity-specs",
    note: "The specs the run actually executed. Definitional computations only; every legal judgement stays in the unbound slots of the drafts below. Each declares where it is narrower than the draft it stands in for.",
    specs: SENSITIVITY_SPECS.map((entry) => ({ ...entry, ...STATE })),
  }));
  writeMember(files, "rulespecs/drafts.json", canonicalJson({
    schema_version: "tivdoc-review-package-v7-rulespec-drafts",
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
    // The condition that makes this v7 rather than another v6.
    throw new Error(`E38_TRACES_INCLUDED_MUST_EXCEED_ZERO:got_${sensitivityDocument.traces_included}`);
  }
  writeMember(files, "scenarios/scenario-input-fixtures.json", canonicalJson({
    schema_version: "tivdoc-review-package-v7-scenario-fixtures",
    note: "Synthetic inputs only. There is no expected field in this schema: the input half of a golden case is data, the expected half is a legal determination, and only a person may write one.",
    count: buildAllScenarioFixtures().length,
    fixtures: buildAllScenarioFixtures(),
  }));
  writeMember(files, "scenarios/executions-and-traces.json", canonicalJson({
    schema_version: "tivdoc-review-package-v7-executions",
    attempted: sensitivityDocument.scenarios_attempted,
    run: sensitivityDocument.scenarios_run,
    refused: sensitivityDocument.scenarios_refused,
    traces_included: sensitivityDocument.traces_included,
    traces_replayed_from_database: sensitivityDocument.traces_replayed_from_database,
    refusal_note: "Every refusal is a missing_conflicted_facts scenario reaching RULESPEC_INPUT_MISSING. That is the fixture doing its job, not a gap.",
    executions: sensitivityDocument.executions,
  }));
  writeMember(files, "scenarios/topics-not-run.json", canonicalJson({
    schema_version: "tivdoc-review-package-v7-topics-not-run",
    note: "What was not computed, as plainly as what was. A reader who cannot find this list will assume the whole corpus ran.",
    topics_run: sensitivityDocument.topics_run,
    topics_not_run: sensitivityDocument.topics_not_run,
  }));
  writeMember(files, "parameters/citation-anchors.json", canonicalJson({
    schema_version: "tivdoc-review-package-v7-citation-anchors",
    note: "The Hebrew clause fragment each citation must sit beside, and the six cited chunks that can carry no anchor because they are bare table rows with the headers chunked away.",
    anchors: POOL_P_CITATION_ANCHORS,
  }));

  const manifestContent = {
    schema_version: "tivdoc-review-package-v7-manifest",
    package: "review-package-v7",
    tenant: TENANT,
    ...STATE,
    every_item_state: STATE,
    counters: {
      reviewed_sources: 0, active_sources: 0, active_parameters: 0, active_rules: 0,
      attestations: 0, deliveries: 0, findings: 0, human_ground_truth_locked: 0,
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
