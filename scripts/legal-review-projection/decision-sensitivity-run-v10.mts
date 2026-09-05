// L13-5 / E1-E7 (long run 10). Report v10: v9's report, with errata #1 —
// owner-closed, no lawyer — recorded as the legal basis it actually is.
//
// What is new in v10, and only that.
//
// 1. `legal_basis` is on the report: `opinion_3ddad7e8 + errata_1_owner_closed`.
//    Every report and evidence package from here carries it, because the basis
//    the engine now runs on is the opinion AS CORRECTED, and the corrections
//    were closed by the owner without a lawyer (approval record §7). A reader
//    who sees only "lawyer_approved_opinion" would be told something untrue.
// 2. The resolutions block no longer claims one basis for all six. Two are
//    re-recordings under `external_review_correction` — the daily threshold
//    (revision 2, conditional_on_schedule) and the pension wage-cap source
//    (revision 2, the 2025 clarification downgraded to a 26.1.2025 draft that
//    does not address the order) — and each names the revision it supersedes.
//    The block states the split and carries both evidence anchors.
// 3. The errata table itself (E1-E7) travels in the report: what changed, what
//    it did NOT change, and which items are wording only. E4 (V5) and the two
//    acquisition items stay open and say so.
// 4. `regular_wage_includes_fixed_contractual_premiums` is a registered draft
//    parameter now (batch 21), text-bound to §18 of the Hours of Work and Rest
//    Law in the corpus; the judgment that applies it is still outside the
//    corpus and is named as authority, not cited as a source (BL-32).
//
// What v10 does NOT change: no source is reviewed, no parameter leaves draft,
// no RuleSpec activates, nothing is attested, the counters stay zero, and
// every figure v9 computed is computed the same way here.
//
// v9 is kept beside v10. (v9's header follows.)
// L12-4 / D4 (run 12). Report v9: v8's report, on the shadow whose recorded
// daily-threshold default executes, with the default-transition table.
//
// What is new in v9, and only what D1–D3 changed. The administrative branch
// of working_time_daily_threshold is bound — as a DERIVED figure, 43/5 hours
// from the 2018 order's 42 and its one-hour reduction under the assumption
// five_day_even_distribution, grade derived, never text_verified — and runs
// as the default beside the statute's eight; the assumption slot is shown on
// the parameter's row and in every rendering, and the identity the engine
// recomputes before it binds (4 × 8.6 + 7.6 = 42) is traced. The provenance
// ladder has `derived` on it. The shadow comparison carries a per-decision
// default-transition table — the pre-resolution default, the new default,
// the months whose outcome the move changed, one such month by id, and the
// class (a) already the selected branch, (b) changed and months changed,
// (c) changed and nothing changed, with the band month added — and this
// report carries that table, bound to the comparison by hash and to the
// shadow by run id. resolutions_recorded stays six; nothing is attested.
//
// v8 is kept beside v9. (v8's header follows.)
// L11-7 / D4 (run 11). Report v8: v7's report, with the owner-recorded
// resolutions as defaults, the corrections of run 11, and nothing attested.
//
// What is new in v8. Six of the open decisions carry a resolution the owner
// recorded on 5.9.2026 on a lawyer-approved opinion (stored by hash, L11-1):
// each names the branch the report and the shadow treat as DEFAULT, with the
// basis, the evidence digests and the status owner_recorded — read from the
// database through its own path and checked against the registry in code, and
// refused if they disagree or if any is attested. Every other branch is still
// computed and shown, with its difference from the default. The multiplicative
// rest-day reading is retired and listed once under branches examined and
// rejected. The convalescence rate carries its convalescence year and its
// knowledge time (D3.4). The hourly-wage and daily-threshold decisions carry
// gap severity classes from the shadow (D3.2). The pension cap decision shows
// the contribution difference at the rates beside the base difference (D3.7).
// A seventh decision, the rest day's own threshold, runs both its computations
// at low confidence and carries no resolution (D3.5). The provenance ladder
// has agreement_interpretation on it (D3.6). No source is reviewed, no
// parameter leaves draft, no RuleSpec activates; the counters are unchanged.
//
// v7 is kept beside v8. (v7's header follows.)
// L8-8 / D7. Report v7: v6's report, rebuilt on the shadow run with fifteen
// specs and population-bound months.
//
// What changed in the shadow beneath it, and nothing else. Two specs run
// under the pension precedence decision beside the employee share — the
// employer share (6% on the 2011 order's 2014 row, 6.5% on the 2016 order's
// 2017 rates) and the severance component (6% on both), each against its
// paid line; long run 7's record that "the employer share is not a registered
// parameter" is retracted, it was batch 13's. And `employment.population` is
// a fact of the month: the youth minimum-wage month binds the youth 16–17
// figure batch 2 registered instead of the adult's, and the record says so.
// The sensitivity run is v6's, unchanged: the P line's specs, scenarios and
// parameters are what they were, so the seven topics compute the same
// figures and this report says so by hash beside v6.
//
// v6 is kept beside v7. (v6's header follows.)
// L7-10. Report v6: the sensitivity report of v5 with the offline shadow
// beside it, and a decision that carries an unbound branch.
//
// Two additions. First, the shadow: the draft shadow run (draft-shadow-run-v1)
// took the synthetic facts corpus through the thirteen draft specs on the
// registered draft values, inside the durable scheduler, with every execution
// traced and replayed; its receipt is read here — never recomputed — and its
// counts, pins, refusals by reason, grades and per-decision comparison sit in
// the report under `shadow`, bound to the receipt by hash. Nothing in it is a
// finding: every output there is a synthetic_shadow_delta or a refusal.
//
// Second, working_time_daily_threshold (L7-9 / D6): a decision with one bound
// branch (the statute's eight hours) and one that is named and NOT bound
// (the administrative 8.6 / 7.6 reading, BL-24). The report runs the bound
// branch, lists the unbound one with its reason, and says plainly that no
// scenario can separate branches of which only one runs.
//
// v5 is kept beside v6. (v5's header follows.)
// L6-8 / D5. Report v5: seven topics of seven, and a provenance grade on every
// bound parameter.
//
// v4 ran six topics. working_time runs now: the §16(א) premiums and the
// §17(א)(1) rest premium are visual citations of the 1951 page, registered
// inferred_visual. Every parameter a scenario binds carries its grade in the
// report — text_verified, lexicon, selection, inferred_visual, administrative
// — read from the candidate row where the row records it and otherwise from
// the batch that registered it; and every execution carries the worst grade
// among its parameters, so a figure read from a page image can never sit in
// an output unlabelled.
//
// Two decisions are new in kind. rest_day_overtime_composition (D2) has
// branches that are different computations over the same parameters, each its
// own spec; the report runs both and compares their outputs per scenario as it
// does for any decision. pension_2011_2016_precedence (D7) runs the 2011
// order's 2014 row beside the 2016 order's 2017 row.
//
// v4 is kept beside v5. (v4's header follows.)
// L5-10. Report v4: every topic attempted.
//
// v3 ran four topics. This run adds the three that could not run before: the
// vacation rule beyond the seventh year (add, subtract, a derived unit), sick
// leave (a rate stated as a word, and two parameters whose units could finally
// meet), and convalescence (a rate inside a selected instrument). working_time
// runs only if the consolidated Hours law lands through the acquisition path;
// otherwise it says so by slot, as before.
//
// One mechanical change: a fixture may carry more facts than any one spec
// declares, because sick leave is two computations. A spec is handed exactly
// the facts it declares. A declared fact the fixture withholds is still a
// refusal — filtering selects, it does not fill.
//
// v3 is kept beside v4, as v2 was kept beside v3. Nothing is overwritten.
// (v3's header follows.)
// L4-4. Report v3: the same run as E3-7's, no longer restricted to money.
//
// v2 could only execute specs whose one parameter was money and whose one
// output was money, because it built the parameter input and rendered the
// output by reaching straight into a money shape. A vacation entitlement is an
// integer day count selected by a seniority band, so under v2 it could not run
// at all — which is why the "no band lookup in the vocabulary" reason in v2's
// topics_not_run was only half the story. The node exists now (L4-2) and so
// does the table it reads (L4-1), and this run binds parameters and renders
// outputs by their declared kind instead of assuming one.
//
// v2 is kept beside v3, as v1 was kept beside v2. Nothing is overwritten.
import "../production-refusal.mjs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { executeRuleSpec } from "../../src/engine/legal-operations/rulespec.ts";
import { buildAllScenarioFixtures } from "../../src/engine/legal-quality/scenario-fixtures.ts";
import { SENSITIVITY_SPECS } from "../../src/engine/legal-quality/sensitivity-rulespecs.ts";
import { APPROVAL_RECORD_ERRATA_SHA256, defaultBranchOf, EXTERNAL_REVIEW_1_RESPONSE_SHA256, OWNER_RECORDED_RESOLUTIONS, REJECTED_BRANCHES, RESOLUTION_HISTORY, resolutionSha256 } from "../../src/engine/legal-quality/decision-resolutions.ts";
import { HAVRAA_RATE_TABLE } from "../../src/engine/legal-quality/convalescence-rate-table.ts";
import { contributionDelta } from "../../src/engine/legal-quality/pension-contribution-delta.ts";
import { GAP_SEVERITY_CLASSES, GAP_SEVERITY_DECISIONS, GAP_SEVERITY_DIMENSIONS_NOT_COMPUTED, GAP_SEVERITY_SENTENCE_HE } from "../../src/engine/shadow/gap-severity.ts";
import { APPROVAL_RECORD_SHA256, APPROVED_ON, LEGAL_OPINION_SHA256 } from "../../src/engine/legal-knowledge/owner-evidence.ts";
import { derivationRecordSchema, derivationSha256, renderExact } from "../../src/engine/legal-operations/derivation.ts";
import { buildSevenRuleSpecDrafts } from "../../src/engine/legal-quality/rulespec-drafts.ts";
import { canonicalSha256 } from "../../src/engine/rule-runtime/canonical.ts";
import { WAVE3_TOPICS } from "../../src/engine/wave3/contracts.ts";
import { createDurableShadowRunEnvelope } from "../../src/server/engine/shadow/durable-contracts.ts";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { TENANT } from "./pool-p-parameter-import.mts";
import { seedSessions, SYNTHETIC_PROOF_TENANT } from "./reviewer-registration.mts";

import type { ParameterValue } from "../../src/engine/legal-operations/contracts.ts";
import type { RuleSpecInputValue } from "../../src/engine/legal-operations/rulespec.ts";

const RECEIPT_ROOT = path.join("output", "next", "pool-q");
const SYSTEM_SESSION = { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import" };
// L4-6 / D4 (BL-17). Parameters are READ from the reference catalogue, because
// that is where the real draft values live. Execution traces are WRITTEN to the
// synthetic proof tenant, because a trace of a synthetic scenario is a proof
// row and has no business in the catalogue. Two tenants, one run, and the
// direction of each is the whole point.
const PROOF_SESSION = { sid: "session.synthetic.proof.sensitivity", jti: "token.synthetic.proof.sensitivity", subject: "system_import" };
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const PIN_SHA = (label: string) => canonicalSha256({ pin: label });

function money(minorUnits: bigint, currency: string): string {
  const negative = minorUnits < BigInt(0);
  const digits = (negative ? -minorUnits : minorUnits).toString().padStart(3, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)} ${currency}`;
}

/** A stored governance value as an executor input, by its own declared kind. */
function toInput(refId: string, value: ParameterValue): RuleSpecInputValue {
  if (value.kind === "money") return { ref_id: refId, value: { kind: "money", currency: value.value.currency, minor_units: value.value.minor_units } };
  if (value.kind === "integer") return { ref_id: refId, value: { kind: "integer", value: value.value, unit: value.unit } };
  return { ref_id: refId, value: { kind: "rational", numerator: value.numerator, denominator: value.denominator, unit: value.unit } };
}

/** A stored governance value, rendered. Money is nested there; runtime money is not. */
function renderParameter(value: ParameterValue): string {
  if (value.kind === "money") return money(BigInt(value.value.minor_units), value.value.currency);
  if (value.kind === "integer") return `${value.value} ${value.unit}`;
  return value.denominator === "1" ? `${value.numerator} ${value.unit}` : `${value.numerator}/${value.denominator} ${value.unit}`;
}

/** What a person reads. Money keeps its two places; a day count stays a day count. */
function render(value: Record<string, unknown> | null): string | null {
  if (!value) return null;
  const kind = String(value.kind);
  if (kind === "money") return money(BigInt(String(value.minor_units)), String(value.currency));
  if (kind === "integer") return `${String(value.value)} ${String(value.unit)}`;
  if (kind === "rational") {
    return String(value.denominator) === "1"
      ? `${String(value.numerator)} ${String(value.unit)}`
      : `${String(value.numerator)}/${String(value.denominator)} ${String(value.unit)}`;
  }
  return String(value.value);
}

/**
 * The scalar two branches are compared on, or null when they cannot be. Money
 * differences are in minor units and day differences are in days; a rational
 * output has no single integer to subtract, and saying so beats inventing one.
 */
function comparable(value: Record<string, unknown> | null): Readonly<{ amount: bigint; unit: string }> | null {
  if (!value) return null;
  if (String(value.kind) === "money") return { amount: BigInt(String(value.minor_units)), unit: String(value.currency) };
  if (String(value.kind) === "integer") return { amount: BigInt(String(value.value)), unit: String(value.unit) };
  return null;
}

function renderDifference(amount: bigint, unit: string, kind: string): string {
  return kind === "money" ? money(amount, unit) : `${amount.toString()} ${unit}`;
}

// Decisions whose branches differ in something a value scenario cannot see.
const BRANCH_NOTES: Readonly<Record<string, string>> = Object.freeze({
  [`${TENANT}.decision.working_time_daily_threshold`]:
    "both computations run: the statute's eight hours (§2(א), bound through the lexicon) and the derived five-day norm (43/5 on the regular day, 38/5 on the shortened day — 42 + 1 spread evenly over five days under the assumption five_day_even_distribution, grade derived; the 2000 framework order's own sentence is not in the corpus and the 43 rests on the 2018 order's one-hour reduction), the owner-recorded default; every scenario with more than eight hours separates them; the nine-hour reading (9 × 4 + 7) is named and not run (V12)",
  [`${TENANT}.decision.convalescence_2026_rate_period`]:
    "all three branches carry 451.50 ILS and differ in period alone — the calendar year 2026, from the order's signature on 27 July 2026, or the convalescence year 1.7.2025–30.6.2026 (havraa_year, the owner-recorded default, known from the publication on 18.8.2026 and retroactive; rate table beside this report); the executor is handed a version, not a date, so no value scenario separates them; the period question is resolved by the owner's record, not attested",
});

// Rows registered before a candidate carried its grade (batches 1–10) are
// graded by the batch that registered them: batch 9 bound through the lexicon,
// batch 10 through instrument selections, everything else from verified text.
// Read from the batch receipts, not typed here.
const GRADE_BY_RECEIPT: Readonly<Record<string, string>> = Object.freeze({ "batch-9-lexicon.json": "lexicon", "batch-10-selections.json": "selection" });
const inferredGradeIndex = new Map<string, string>();
for (const [file, grade] of Object.entries(GRADE_BY_RECEIPT)) {
  const receiptPath = path.join("output", "next", "pool-p", file);
  if (!existsSync(receiptPath)) continue;
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { registered?: string[] };
  for (const id of receipt.registered ?? []) inferredGradeIndex.set(id, grade);
}
function inferredGrade(parameterVersionId: string): string {
  return inferredGradeIndex.get(parameterVersionId) ?? "text_verified";
}
const GRADE_ORDER = ["text_verified", "lexicon", "selection", "derived", "inferred_visual", "administrative", "agreement_interpretation"];
function worstGrade(grades: readonly string[]): string {
  return grades.reduce((worst, grade) => (GRADE_ORDER.indexOf(grade) > GRADE_ORDER.indexOf(worst) ? grade : worst), "text_verified");
}

function provenanceSummary(executions: ReadonlyArray<Record<string, unknown>>) {
  // Each parameter version's own bindings — never another parameter's from
  // the same execution.
  const byVersion = new Map<string, { provenance_grade: string; visual_bindings: Array<{ page_pdf_sha256: string; visual_reading: string }>; derivation: Record<string, unknown> | null }>();
  for (const row of executions) {
    const grades = row.parameter_provenance as Array<{ parameter_version_id: string; provenance_grade: string; visual_bindings: Array<{ page_pdf_sha256: string; visual_reading: string }>; derivation?: Record<string, unknown> | null }>;
    for (const item of grades) {
      if (!byVersion.has(item.parameter_version_id)) byVersion.set(item.parameter_version_id, { provenance_grade: item.provenance_grade, visual_bindings: [...item.visual_bindings], derivation: item.derivation ?? null });
    }
  }
  const rows = [...byVersion.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, entry]) => ({ parameter_version_id: id, ...entry }));
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.provenance_grade] = (counts[row.provenance_grade] ?? 0) + 1;
  return {
    grades: GRADE_ORDER,
    meaning: {
      text_verified: "the figure is in the artifact's text layer and was verified there, with a Hebrew anchor in the same chunk",
      lexicon: "the figure is a word in the text (מחצית, יום וחצי) resolved through legal-numeral-lexicon-v1",
      selection: "the figure is in the text of a draft instrument selection over a multi-instrument gazette issue",
      derived: "the figure is arithmetic on cited text plus one declared assumption, stored as a record the engine recomputes before it binds; the assumption slot is on the row and can be invalidated by the lawyer's answer named on it; never text_verified, never administrative (L12-1 / D1)",
      inferred_visual: "the figure was read from the page image by the session because the text layer is ambiguous or absent; it awaits visual confirmation by a person and cannot be attested without it",
      administrative: "the figure comes from an administrative source, not a statute or an extension order",
      agreement_interpretation: "the figure rests on a party's reading of a collective agreement or extension order (the steering committee's 8.6 / 7.6 under the 42-hour order, as reported by kolzchut), not on an official text; unbound today (L11-5 / D3.6)",
    },
    counts,
    bound_parameter_versions: rows,
  };
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const url = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!url) throw new Error("E37_ENV_MISSING");
  const parsed = new URL(url);
  const factory = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: url, max_connections: 4, connection_timeout_ms: 20_000,
    application_name: "tivdoc_l710_sensitivity",
    remote_dev_target: {
      host: parsed.hostname, port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//u, ""), project_ref: env.get("TIVDOC_DEV_PROJECT_REF") ?? "",
    },
  });

  await seedSessions(SYNTHETIC_PROOF_TENANT, `${SYNTHETIC_PROOF_TENANT}.no-attestation-placeholder`, [PROOF_SESSION]);

  async function tx<T>(label: string, work: (client: import("pg").Client) => Promise<T>, session = SYSTEM_SESSION): Promise<T> {
    const client = await factory.acquire();
    try {
      await client.query(statement(`${label}_begin`, "begin", []));
      await client.query(statement(`${label}_context`, "select * from private.runtime_context_install($1,$2,$3)",
        [session.sid, session.jti, `${label}:${randomUUID().slice(0, 8)}`]));
      const value = await work(client);
      await client.query(statement(`${label}_commit`, "commit", []));
      return value;
    } catch (error) {
      await client.query(statement(`${label}_rollback`, "rollback", [])).catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  // --- Real parameter values, read through the sanctioned aggregate path.
  const valueOf = async (parameterId: string, version: string) => tx("e37_read", async (client) => {
    const row = await client.query(statement("e37_aggregate",
      "select state, content_json from private.governance_aggregate_read($1,$2,$3,$4)",
      [TENANT, "parameter_approval", parameterId, version]));
    if (row.row_count !== 1) throw new Error(`E37_PARAMETER_MISSING:${parameterId}@${version}`);
    const value = row.rows[0] as unknown as {
      state: string;
      content_json: { value: ParameterValue; provenance_grade?: string; visual_bindings?: Array<{ page_pdf_sha256: string; visual_reading: string }>; derivation?: unknown };
    };
    // L12-4 / D4: a derived figure's record travels with it, compacted — the
    // assumption slot, the identity, the outputs and the record's digest — after
    // the same recomputation every binder performs.
    const record = value.content_json.derivation === undefined ? null : derivationRecordSchema.parse(value.content_json.derivation);
    const derivation = record ? {
      assumption_slot: record.assumption.slot,
      assumption_statement: record.assumption.statement,
      assumption_parameters: record.assumption.parameters,
      competing_reading: record.assumption.competing_reading,
      invalidated_by: record.assumption.invalidated_by,
      identity: record.identity.expression,
      steps: record.steps.map((step) => step.expression),
      regular_day: renderExact(record.outputs.regular_day),
      short_day: renderExact(record.outputs.short_day),
      inputs: record.inputs.map((input) => ({ name: input.name, origin: input.origin, value: renderExact(input.value), chunk_id: input.source?.chunk_id ?? null })),
      corroboration: record.corroboration.map((entry) => `${entry.source} (${entry.grade})`),
      derivation_sha256: derivationSha256(record),
    } : null;
    if ((record !== null) !== (value.content_json.provenance_grade === "derived")) throw new Error(`E124_DERIVATION_GRADE_UNPAIRED:${parameterId}@${version}`);
    return {
      state: value.state, value: value.content_json.value,
      provenance_grade: value.content_json.provenance_grade ?? inferredGrade(`${parameterId}@${version}`),
      visual_bindings: value.content_json.visual_bindings ?? null,
      derivation,
    };
  });

  // --- L11-7 / D4: the owner-recorded resolutions, read through their own
  // path and checked against the registry in code. A missing row, a drifted
  // row, or an attested row refuses the report.
  const resolutionRows = await tx("l117_resolutions", async (client) => {
    const rows = await client.query(statement("l117_resolution_read", "select * from private.legal_decision_resolution_read($1)", [TENANT]));
    return (rows.rows as unknown as Array<Record<string, unknown>>).filter((row) => row.synthetic !== true);
  });
  const resolutionMismatches: string[] = [];
  // L13-5: the table is append-only by revision now, so a decision can hold more than one row.
  // The registry names the LATEST revision; the earlier ones are history and are checked below
  // for the one thing that matters about them — that nothing edited them.
  const latestRowFor = (decisionId: string) => resolutionRows
    .filter((entry) => entry.decision_id === decisionId)
    .sort((a, b) => Number(a.revision ?? 1) - Number(b.revision ?? 1))
    .at(-1);
  for (const resolution of OWNER_RECORDED_RESOLUTIONS) {
    const row = latestRowFor(resolution.decision_id);
    if (!row) { resolutionMismatches.push(`${resolution.decision_key}:missing`); continue; }
    if (Number(row.revision ?? 1) !== (resolution.revision ?? 1)) { resolutionMismatches.push(`${resolution.decision_key}:revision_${String(row.revision)}`); continue; }
    if (row.selected_branch !== resolution.selected_branch || row.status !== "owner_recorded" || row.approver_identity !== null
      || row.resolution_sha256 !== resolutionSha256(resolution) || row.evidence_sha256 !== resolution.evidence_sha256 || row.approval_record_sha256 !== resolution.approval_record_sha256) {
      resolutionMismatches.push(`${resolution.decision_key}:drift`);
    }
  }
  // Every superseded revision must still read back exactly as RESOLUTION_HISTORY recorded it.
  for (const past of RESOLUTION_HISTORY) {
    const row = resolutionRows.find((entry) => entry.decision_id === past.decision_id && Number(entry.revision ?? 1) === (past.revision ?? 1));
    if (!row) { resolutionMismatches.push(`${past.decision_key}:r${past.revision}:missing`); continue; }
    if (row.resolution_sha256 !== resolutionSha256(past) || row.selected_branch !== past.selected_branch) resolutionMismatches.push(`${past.decision_key}:r${past.revision}:edited`);
  }
  const expectedRows = OWNER_RECORDED_RESOLUTIONS.length + RESOLUTION_HISTORY.length;
  if (resolutionMismatches.length > 0 || resolutionRows.length !== expectedRows) throw new Error(`E117_RESOLUTIONS_MISMATCH:${resolutionMismatches.join(",")}:rows_${resolutionRows.length}_expected_${expectedRows}`);
  if (resolutionRows.some((row) => row.status === "attested" || row.approver_identity !== null)) throw new Error("E117_ATTESTED_RESOLUTION_UNEXPECTED");
  const resolutions = OWNER_RECORDED_RESOLUTIONS.map((resolution) => ({
    decision_key: resolution.decision_key, decision_id: resolution.decision_id, selected_branch: resolution.selected_branch,
    opinion_branch_label: resolution.opinion_branch_label, basis: resolution.basis, evidence_sha256: resolution.evidence_sha256,
    approval_record_sha256: resolution.approval_record_sha256, approved_on: resolution.approved_on, status: resolution.status,
    approver_identity: null, recorded_by: resolution.recorded_by, resolution_sha256: resolutionSha256(resolution), mapping_note: resolution.mapping_note,
    // L13-5: the lineage travels with the row, so a reader sees which defaults were re-recorded.
    revision: resolution.revision ?? 1,
    supersedes_revision: resolution.supersedes_revision ?? null,
    supersession_basis: resolution.supersession_basis ?? null,
    row_recorded_at: String(latestRowFor(resolution.decision_id)?.recorded_at ?? ""),
  }));

  // --- L11-7 / D3.7: the contribution rates at the precedence decision's
  // default, so a cap difference can be shown as a contribution difference.
  const precedenceEntry = SENSITIVITY_SPECS.find((item) => item.decision_id?.endsWith("pension_2011_2016_precedence"))!;
  const precedenceDefault = defaultBranchOf(precedenceEntry);
  const rateVersion = precedenceEntry.branches.find(([name]) => name === precedenceDefault.branch)?.[1];
  if (!rateVersion) throw new Error("E117_RATE_VERSION_MISSING");
  const rateShares: Array<{ share: string; parameter_version_id: string; rate: { numerator: string; denominator: string } }> = [];
  for (const [share, parameterId] of [["employee", "il.pension.employee_contribution_rate"], ["employer", "il.pension.employer_contribution_rate"], ["severance", "il.pension.severance_contribution_rate"]] as const) {
    const read = await valueOf(parameterId, rateVersion);
    if (read.value.kind !== "rational") throw new Error(`E117_RATE_NOT_RATIONAL:${parameterId}`);
    rateShares.push({ share, parameter_version_id: `${parameterId}@${rateVersion}`, rate: { numerator: read.value.numerator, denominator: read.value.denominator } });
  }

  const envelope = createDurableShadowRunEnvelope({
    schema_version: "tivdoc-durable-offline-shadow-envelope-v0.10.0",
    run_id: "shadow.run.decision-sensitivity-l124",
    execution_mode: "offline_synthetic_only",
    dataset_pin: { pin_id: "pin.dataset.scenario-fixtures", version: "0.9.0", sha256: PIN_SHA("dataset.e37"), classification: "deterministic_synthetic", byte_count: 4096, customer_material: false },
    ground_truth_pin: { pin_id: "pin.ground-truth.blank", version: "0.7.0", sha256: PIN_SHA("ground_truth.e37"), classification: "synthetic_mechanics_ground_truth", customer_material: false, human_ground_truth_count: 0 },
    source_state_pin: { pin_id: "pin.sources.synthetic", version: "0.1.0", sha256: PIN_SHA("sources.e37"), mode: "synthetic_placeholder_only", active_real_source_count: 0, selected_real_source_count: 0 },
    parameter_state_pin: { pin_id: "pin.parameters.draft-only", version: "0.1.0", sha256: PIN_SHA("parameters.e37"), active_real_parameter_count: 0 },
    rule_state_pin: { pin_id: "pin.rules.real-inactive", version: "0.1.0", sha256: PIN_SHA("rules.e37"), active_real_rule_count: 0 },
    approved_baseline_pin: { pin_id: "pin.baseline.none", version: "0.1.0", sha256: PIN_SHA("baseline.e37"), approval_receipt_sha256: PIN_SHA("approval_receipt.e37") },
    candidate_pin: { pin_id: "pin.candidate.e37", version: "0.9.0", sha256: PIN_SHA("candidate.e37") },
    code_pin: { pin_id: "pin.code.e37", version: "0.9.0", sha256: PIN_SHA("code.e37") },
    config_pin: { pin_id: "pin.config.e37", version: "0.9.0", sha256: PIN_SHA("config.e37") },
    threshold_policy_pin: { pin_id: "pin.threshold.none", version: "0.1.0", sha256: PIN_SHA("threshold.e37") },
    requested_at: "2026-09-04T00:00:00.000Z", scheduled_for: "2026-09-04T00:00:00.000Z",
    network_allowed: false, external_provider_allowed: false, customer_input_allowed: false,
    delivery_allowed: false, automatic_customer_promotion: false, automatic_production_promotion: false,
  });

  const fixtures = buildAllScenarioFixtures();
  const runSuffix = randomUUID().slice(0, 10);
  const executions: Array<Record<string, unknown>> = [];
  const persisted: string[] = [];

  for (const entry of SENSITIVITY_SPECS) {
    const branches = entry.branches.length > 0 ? entry.branches : ([[entry.composition_branch ?? "single", "fixed"]] as ReadonlyArray<readonly [string, string]>);
    for (const [branch, version] of branches) {
      // The branch chooses the version of the one binding that left it open;
      // every other binding names its own and does not move between branches.
      const bound = [];
      for (const binding of entry.bindings) {
        const chosen = binding.parameter_version ?? version;
        const read = await valueOf(binding.parameter_id, chosen);
        bound.push({ binding, chosen, read });
      }
      const decisive = bound.find((item) => item.binding.parameter_version === null) ?? bound[0];
      for (const fixture of fixtures.filter((item) => item.topic === entry.spec.topic)) {
        const parameters = bound.map((item) => toInput(item.binding.ref_id, item.read.value));
        const declaredFacts = new Set(entry.spec.facts.map((fact) => fact.ref_id));
        const facts = fixture.inputs.filter((input) => declaredFacts.has(input.ref_id));
        let output: Record<string, unknown> | null = null;
        let refusal: string | null = null;
        let traceSteps = 0;
        let traceWire: Record<string, unknown> | null = null;
        try {
          const execution = executeRuleSpec({ rule: entry.spec, facts: facts as never, parameters });
          output = execution.output as unknown as Record<string, unknown>;
          traceSteps = execution.trace.length;
          traceWire = JSON.parse(JSON.stringify({ trace: execution.trace, output: execution.output },
            (_key, value) => typeof value === "bigint" ? `bigint:${value}` : value)) as Record<string, unknown>;
        } catch (error) {
          refusal = String((error as Error).message ?? "unknown").slice(0, 120);
        }

        // --- Persist the trace through R-14's table, when there is one.
        let executionId: string | null = null;
        if (traceWire) {
          // Two specs share the sick_leave topic, so the id names the spec too; the
          // idempotency key is derived from it and a shared id would be a replay
          // conflict, not a second trace.
          const specSlug = entry.spec.rule_spec_id.replace(/^il.rulespec./u, "");
          executionId = `l124.${entry.spec.topic}.${specSlug}.${fixture.scenario}.${branch}.${runSuffix}`.replaceAll("_", "-");
          const inputsWire = { facts, parameters };
          const traceSha = canonicalSha256(traceWire);
          const payload = {
            execution_id: executionId,
            topic: entry.spec.topic,
            rule_spec_id: entry.spec.rule_spec_id,
            rule_spec_version: entry.spec.rule_spec_version,
            rule_content_sha256: entry.spec.content_sha256,
            snapshot_sha256: canonicalSha256(inputsWire),
            execution_inputs: inputsWire,
            execution_trace: traceWire,
            trace_sha256: traceSha,
            result_sha256: canonicalSha256({ output }),
          };
          await tx("e37_append", (client) => client.query(statement("e37_append_call",
            "select * from private.legal_operations_execution_trace_append($1,$2::jsonb,$3,$4,$5::timestamptz)",
            [SYNTHETIC_PROOF_TENANT, JSON.stringify(payload), `l124.${executionId}`, sha256(`l124:${executionId}:${traceSha}`), new Date().toISOString()])), PROOF_SESSION);
          persisted.push(executionId);
        }

        executions.push({
          topic: entry.spec.topic,
          rule_spec_id: entry.spec.rule_spec_id,
          scenario: fixture.scenario,
          decision_id: entry.decision_id,
          branch,
          parameter_version_id: `${decisive.binding.parameter_id}@${decisive.chosen}`,
          parameter_version_ids: bound.map((item) => `${item.binding.parameter_id}@${item.chosen}`),
          parameter_state: decisive.read.state,
          parameter_states: bound.map((item) => item.read.state),
          parameter_value: renderParameter(decisive.read.value),
          parameter_values: bound.map((item) => `${item.binding.parameter_id}@${item.chosen} = ${renderParameter(item.read.value)}`),
          // D5: the grade of every bound parameter, and the worst of them.
          parameter_provenance: bound.map((item) => ({ parameter_version_id: `${item.binding.parameter_id}@${item.chosen}`, provenance_grade: item.read.provenance_grade, visual_bindings: item.read.visual_bindings ?? [], derivation: item.read.derivation ?? null })),
          provenance_grade: worstGrade(bound.map((item) => item.read.provenance_grade)),
          visual_verification_required: bound.some((item) => item.read.provenance_grade === "inferred_visual"),
          visual_bindings: bound.flatMap((item) => item.read.visual_bindings ?? []),
          fixture_id: fixture.fixture_id,
          fixture_sha256: fixture.content_sha256,
          ran: refusal === null,
          refusal,
          output: render(output),
          output_kind: output ? String(output.kind) : null,
          output_comparable: output ? (comparable(output)?.amount.toString() ?? null) : null,
          output_comparable_unit: output ? (comparable(output)?.unit ?? null) : null,
          trace_steps: traceSteps,
          execution_id: executionId,
        });
      }
    }
  }

  // --- Replay every persisted trace from the database, in one fresh process.
  const replayed: Array<Record<string, unknown>> = [];
  for (const executionId of persisted) {
    try {
      const stdout = execFileSync(process.execPath, [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types",
        "scripts/legal-review-projection/sensitivity-trace-replay.mts", executionId, SYNTHETIC_PROOF_TENANT,
      ], { encoding: "utf8", cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      const verdict = /E37_REPLAY_VERDICT (\{.*\})/u.exec(stdout)?.[1];
      replayed.push(verdict ? JSON.parse(verdict) as Record<string, unknown> : { execution_id: executionId, accepted: false, error: "no verdict" });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      replayed.push({ execution_id: executionId, accepted: false, error: `${failure.stdout ?? ""}${failure.stderr ?? ""}`.slice(0, 200) });
    }
  }

  // --- L7-10: the shadow beside the sensitivity — read from the run's receipt, bound by hash, never recomputed.
  const shadowReceiptPath = path.join("output", "next", "shadow", "draft-shadow-receipt-v1.json");
  if (!existsSync(shadowReceiptPath)) throw new Error("L710_SHADOW_RECEIPT_MISSING:run draft-shadow-run-v1.mts first");
  const shadowReceipt = JSON.parse(readFileSync(shadowReceiptPath, "utf8")) as {
    run_id: string; receipt_sha256: string; envelope_sha256: string; envelope_schema_version: string; execution_mode: string;
    draft_input_pin: Record<string, unknown>; corpus_sha256: string; code_sha256: string;
    counts: Record<string, number>; refusals_by_reason: Record<string, number>; grades: Record<string, number>;
    traces_included: number; traces_replayed_from_database: number; replay_failures: unknown[];
    audit_chain: Record<string, unknown>; extraction_used: boolean; is_finding: boolean; delivery_allowed: boolean;
    comparison: Array<{ decision_id: string; branches: string[]; unbound_branches?: unknown[]; default_branch?: string; default_branch_source?: string; selected_branch?: string | null; selected_branch_bound?: boolean | null; resolution_status?: string | null; gap_severity?: unknown; cases_compared: number; cases_differing: number; cases_not_comparable: number; human_review_required: boolean; automatic_acceptance: boolean }>;
    counters: Record<string, number>;
  };
  if (shadowReceipt.is_finding !== false || shadowReceipt.delivery_allowed !== false || shadowReceipt.extraction_used !== false) throw new Error("L710_SHADOW_RECEIPT_INVARIANT");
  if (shadowReceipt.replay_failures.length > 0) throw new Error("L710_SHADOW_REPLAY_FAILURES");
  // --- L12-4 / D3: the default-transition table, from the comparison the
  // shadow re-run produced (L12-3), bound by hash and by run id.
  const transitionsPath = path.join("output", "next", "shadow", "shadow-run-comparison-l123.json");
  if (!existsSync(transitionsPath)) throw new Error("E124_TRANSITIONS_MISSING:run shadow-run-comparison.mts first");
  const transitionsText = readFileSync(transitionsPath, "utf8");
  const transitionsReceipt = JSON.parse(transitionsText) as {
    verdict: string; previous: { run_id: string; receipt_sha256: string }; current: { run_id: string; receipt_sha256: string };
    transitions: Array<{ decision_id: string; resolution_key: string | null; selected_branch: string | null; previous_default_branch: string | null; new_default_branch: string | null; default_changed: boolean; cases_outcome_changed: number; changed_case_ids: string[]; one_changed_case_id: string | null; classification: string; classification_meaning: string; band_month: string | null; band_month_present: boolean; band_month_outcome_changed: boolean | null }>;
  };
  if (transitionsReceipt.verdict !== "PASS") throw new Error(`E124_TRANSITIONS_NOT_PASS:${transitionsReceipt.verdict}`);
  if (transitionsReceipt.current.run_id !== shadowReceipt.run_id || transitionsReceipt.current.receipt_sha256 !== shadowReceipt.receipt_sha256) throw new Error("E124_TRANSITIONS_STALE");
  const defaultTransitions = {
    comparison_path: transitionsPath.replaceAll("\\", "/"),
    comparison_sha256: sha256(transitionsText),
    previous_run_id: transitionsReceipt.previous.run_id,
    current_run_id: transitionsReceipt.current.run_id,
    verdict: transitionsReceipt.verdict,
    classes: {
      a: "the previous default was already the selected branch; no change expected",
      b: "the branch changed and months changed, listed",
      c: "the branch changed and no month changed: the corpus has no month in the band the branches separate; a band month was added so the comparison is not vacuous",
    },
    rows: transitionsReceipt.transitions,
  };

  // --- The sensitivity: for each decision, which scenarios differ and by how much.
  const decisionIds = [...new Set(SENSITIVITY_SPECS.map((entry) => entry.decision_id).filter((id): id is string => id !== null))];
  const sensitivity = decisionIds.map((decisionId) => {
    const entries = SENSITIVITY_SPECS.filter((item) => item.decision_id === decisionId);
    const entry = entries[0];
    const branchNames = [...new Set(entries.flatMap((item) => item.branches.length > 0 ? item.branches.map(([branch]) => branch) : [item.composition_branch ?? "single"]))];
    // L11-7 / D4: the default — the owner-recorded resolution's branch where one
    // exists and is bound, the first listed otherwise — and the resolution itself.
    const chosen = defaultBranchOf(entry, { composition_branches: entries.map((item) => item.composition_branch).filter((name): name is string => typeof name === "string") });
    const resolution = resolutions.find((item) => item.decision_id === decisionId) ?? null;
    const isCapDecision = decisionId.endsWith("pension_wage_cap_section");
    const mine = executions.filter((row) => row.decision_id === decisionId);
    const scenarios = [...new Set(mine.map((row) => row.scenario as string))].sort();
    const perScenario = scenarios.map((scenario) => {
      const rows = mine.filter((row) => row.scenario === scenario);
      const ran = rows.filter((row) => row.ran === true);
      if (ran.length !== branchNames.length) {
        return {
          scenario, differs: false, ran: false,
          reason: rows.find((row) => row.refusal !== null)?.refusal ?? "not all branches ran",
        };
      }
      if (ran.some((row) => row.output_comparable === null)) {
        return {
          scenario, ran: true, differs: false, comparable: false,
          by_branch: ran.map((row) => ({ branch: row.branch as string, output: row.output as string })),
          reason: "outputs of this kind have no single scalar to subtract; the branch outputs are shown and the difference is not stated",
        };
      }
      const values = ran.map((row) => ({ branch: row.branch as string, amount: BigInt(String(row.output_comparable)), rendered: row.output as string }));
      const low = values.reduce((a, b) => a.amount < b.amount ? a : b);
      const high = values.reduce((a, b) => a.amount > b.amount ? a : b);
      const delta = high.amount - low.amount;
      const kind = String(ran[0].output_kind);
      const unit = String(ran[0].output_comparable_unit);
      const defaultValue = values.find((value) => value.branch === chosen.branch) ?? null;
      const contribution = isCapDecision && kind === "money" ? contributionDelta({ base_delta_minor_units: delta.toString(), shares: rateShares }) : null;
      return {
        scenario, ran: true, comparable: true, differs: delta !== BigInt(0),
        by_branch: values.map((value) => ({
          branch: value.branch, output: value.rendered,
          is_default: value.branch === chosen.branch,
          difference_from_default: defaultValue ? renderDifference(value.amount - defaultValue.amount, unit, kind) : null,
          difference_from_default_minor_units: defaultValue ? (value.amount - defaultValue.amount).toString() : null,
        })),
        difference: renderDifference(delta, unit, kind),
        difference_minor_units: delta.toString(),
        // L11-7 / D3.7: for the cap, the base difference is a difference in the
        // cap; the sum at stake is the contributions on it, at the rates.
        ...(contribution ? {
          base_difference: renderDifference(delta, unit, kind),
          contribution_difference: renderDifference(BigInt(contribution.contribution_delta_minor_units), unit, kind),
          contribution_difference_minor_units: contribution.contribution_delta_minor_units,
          contribution_rate_sum: contribution.rate_sum,
          contribution_components: contribution.components.map((component) => ({ share: component.share, rate: component.rate, difference: renderDifference(BigInt(component.delta_minor_units), unit, kind) })),
        } : {}),
      };
    });
    const differing = perScenario.filter((row) => row.differs);
    return {
      decision_id: decisionId,
      topic: entry.spec.topic,
      rule_spec_id: entries.length === 1 ? entry.spec.rule_spec_id : entries.map((item) => item.spec.rule_spec_id).join(" | "),
      // D2: a decision whose branches are computations names one spec per branch.
      composition: entries.length > 1 ? entries.map((item) => ({ branch: item.composition_branch, rule_spec_id: item.spec.rule_spec_id })) : null,
      narrower_than_draft: entries.map((item) => item.narrower_than_draft).filter((note) => note !== null).join(" ") || null,
      branches: branchNames,
      // L7-9 / D6: a branch named on the decision and not bound — listed with
      // its reason, never run.
      unbound_branches: entries.flatMap((item) => item.unbound_branches ?? []),
      provenance_grade: worstGrade(mine.map((row) => String(row.provenance_grade))),
      // L11-7 / D4: the default and the resolution it rests on; alternatives stay computed above.
      default_branch: chosen.branch,
      default_branch_source: chosen.source,
      selected_branch: chosen.selected_branch,
      selected_branch_bound: chosen.selected_bound,
      resolution,
      gap_severity: GAP_SEVERITY_DECISIONS.find((item) => item.decision_id === decisionId) ?? null,
      contribution_rates: isCapDecision ? rateShares : null,
      // L12-4 / D3: how the resolution moved this decision's default, from the comparison.
      transition: defaultTransitions.rows.find((row) => row.decision_id === decisionId) ?? null,
      // L12-4 / D1: every derived figure this decision binds, with its assumption slot.
      derived_bindings: [...new Map<string, Record<string, unknown>>(mine.flatMap((row) => (row.parameter_provenance as Array<{ parameter_version_id: string; provenance_grade: string; derivation: Record<string, unknown> | null }>)
        .filter((item) => item.derivation !== null)
        .map((item): [string, Record<string, unknown>] => [item.parameter_version_id, { parameter_version_id: item.parameter_version_id, provenance_grade: item.provenance_grade, ...item.derivation }]))).values()],
      scenarios_run: perScenario.filter((row) => row.ran).length,
      scenarios_differing: differing.length,
      scenarios_not_run: perScenario.filter((row) => !row.ran).map((row) => ({ scenario: row.scenario, reason: (row as { reason?: string }).reason })),
      per_scenario: perScenario,
      // L5-10: a decision whose branches carry the same figure cannot be
      // separated by any value scenario — the executor is handed a version, not
      // a date — and the report says so rather than leaving a bare "no".
      branch_note: BRANCH_NOTES[decisionId] ?? null,
      summary: differing.length === 0 ? (BRANCH_NOTES[decisionId] ?? "no scenario in this set separates the branches")
        : `${decisionId}: differs in ${differing.map((row) => row.scenario).join(", ")}; largest difference ${differing.reduce((a, b) => BigInt(a.difference_minor_units!) > BigInt(b.difference_minor_units!) ? a : b).difference}`,
    };
  });

  // --- Topics with no executable spec. Each shortfall is named by the slot it
  // waits on and by what is actually in the way, which after L4-1 and L4-2 is
  // no longer the same answer for all of them.
  const drafts = buildSevenRuleSpecDrafts();
  const runnableTopics = new Set(SENSITIVITY_SPECS.map((entry) => entry.spec.topic));
  // L6-8: empty. working_time runs on visual citations of the 1951 page; the
  // general path below stays for any topic that loses its spec.
  const SHORTFALL: Readonly<Record<string, Readonly<{ slots: readonly string[]; not_run: string; detail: string }>>> = {};
  const notRun = WAVE3_TOPICS.filter((topic) => !runnableTopics.has(topic)).map((topic) => {
    const draft = drafts.find((entry) => entry.topic === topic)!;
    const unbound = draft.parameter_slots.filter((slot) => !slot.bound);
    const stated = SHORTFALL[topic];
    return {
      topic,
      not_run: stated?.not_run ?? (unbound.length > 0 ? "slot_unbound" : "no_definitional_computation_available"),
      slots: stated ? stated.slots : unbound.map((slot) => slot.slot_id),
      draft_unbound_slots: unbound.map((slot) => slot.parameter_id),
      detail: stated?.detail ?? `Unbound: ${unbound.map((slot) => slot.parameter_id).join(", ")}.`,
    };
  });

  const shadow = {
    run_id: shadowReceipt.run_id,
    receipt_sha256: shadowReceipt.receipt_sha256,
    receipt_path: shadowReceiptPath.replaceAll("\\", "/"),
    envelope_sha256: shadowReceipt.envelope_sha256,
    envelope_schema_version: shadowReceipt.envelope_schema_version,
    execution_mode: shadowReceipt.execution_mode,
    draft_input_pin: shadowReceipt.draft_input_pin,
    corpus_sha256: shadowReceipt.corpus_sha256,
    code_sha256: shadowReceipt.code_sha256,
    counts: shadowReceipt.counts,
    refusals_by_reason: shadowReceipt.refusals_by_reason,
    grades: shadowReceipt.grades,
    traces_included: shadowReceipt.traces_included,
    traces_replayed_from_database: shadowReceipt.traces_replayed_from_database,
    audit_chain: shadowReceipt.audit_chain,
    decisions: shadowReceipt.comparison.map((entry) => ({
      decision_id: entry.decision_id, branches: entry.branches, unbound_branches: entry.unbound_branches ?? [],
      default_branch: entry.default_branch ?? null, default_branch_source: entry.default_branch_source ?? null,
      selected_branch: entry.selected_branch ?? null, selected_branch_bound: entry.selected_branch_bound ?? null, resolution_status: entry.resolution_status ?? null,
      gap_severity: entry.gap_severity ?? null,
      cases_compared: entry.cases_compared, cases_differing: entry.cases_differing, cases_not_comparable: entry.cases_not_comparable,
      human_review_required: entry.human_review_required, automatic_acceptance: entry.automatic_acceptance,
    })),
    extraction_used: false,
    is_finding: false,
    delivery_allowed: false,
    counters: shadowReceipt.counters,
    note: "Draft parameter values over synthetic declared facts, through the canonical fact model and the mapping registries, inside the durable offline scheduler. Every output is a synthetic_shadow_delta or a refusal; none is a finding and none is delivered.",
  };

  const content = {
    schema_version: "tivdoc-decision-sensitivity-report-v10-v0.15.0",
    classification: "internal_only",
    // L13-5: the basis the engine actually runs on — the approved opinion as corrected by
    // errata #1, which is owner-recorded and was closed without a lawyer (approval record §7).
    legal_basis: "opinion_3ddad7e8 + errata_1_owner_closed",
    delivery_allowed: false,
    is_finding: false,
    is_legal_advice: false,
    tenant_id: TENANT,
    trace_tenant_id: SYNTHETIC_PROOF_TENANT,
    shadow_envelope_sha256: envelope.envelope_sha256,
    execution_mode: envelope.execution_mode,
    replaces: "tivdoc-decision-sensitivity-report-v9-v0.14.0 (v9 stated one basis, lawyer_approved_opinion, for all six resolutions; two are re-recordings under errata #1, which the owner closed without a lawyer)",
    scope_note:
      "Differences only, computed. This states what the answer to each open question changes in each scenario. Six questions carry a DEFAULT the owner recorded on 5.9.2026 on a lawyer-approved opinion (status owner_recorded; no reviewer identity; no attestation); the default is what the shadow runs first and what the table names as such, and every other branch is still computed and shown with its difference from the default. Nothing here is reviewed, attested or active; the counters are unchanged.",
    scenarios_attempted: executions.length,
    scenarios_run: executions.filter((row) => row.ran).length,
    scenarios_refused: executions.filter((row) => row.ran === false).length,
    traces_included: persisted.length,
    traces_replayed_from_database: replayed.filter((row) => row.accepted === true).length,
    replay_failures: replayed.filter((row) => row.accepted !== true),
    topics_run: [...runnableTopics].sort(),
    topics_run_count: runnableTopics.size,
    topics_total: WAVE3_TOPICS.length,
    topics_not_run: notRun,
    // D5: what grade each bound parameter version carries, over the whole run,
    // and the visual bindings a reviewer must confirm before any of the
    // inferred_visual rows can be attested.
    provenance: provenanceSummary(executions),
    open_decisions: sensitivity,
    // L11-7 / D4: the resolutions — what the owner recorded, on what, and what
    // that did not do.
    resolutions: {
      recorded: resolutions.length,
      attested: 0,
      basis_by_resolution: resolutions.map((entry) => ({
        decision_key: entry.decision_key,
        basis: entry.basis,
        revision: entry.revision ?? 1,
        supersedes_revision: entry.supersedes_revision ?? null,
        supersession_basis: entry.supersession_basis ?? null,
      })),
      evidence: { legal_opinion_sha256: LEGAL_OPINION_SHA256, approval_record_sha256: APPROVAL_RECORD_SHA256, approved_on: APPROVED_ON, source_grade: "owner_evidence", citable_as_source: false },
      statement: "The six defaults below are owner-recorded. Four rest on the lawyer-approved opinion of 5.9.2026 as recorded. Two are re-recordings under errata #1, which the owner closed WITHOUT a lawyer (approval record §7): the daily threshold is conditional on the case's schedule facts rather than a fixed default, and the pension wage-cap source is downgraded (its cited 27.5.2025 clarification is a 26.1.2025 draft that never addresses the order; the branch and the 2026 value are unchanged). No professional reviewed the corrected wording. No attestation occurred: no reviewer identity exists, no source is reviewed, no parameter leaves draft, no RuleSpec activates, and every other branch is still computed and shown.",
      errata_1: {
        closure: "owner_recorded, no lawyer (approval record §7; the approved opinion file is unedited and its hash stands)",
        response_sha256: EXTERNAL_REVIEW_1_RESPONSE_SHA256,
        approval_record_sha256: APPROVAL_RECORD_ERRATA_SHA256,
        items: [
          { id: "E1", subject: "Q2 pension wage-cap source", change: "the cited 27.5.2025 clarification is a 26.1.2025 draft on income-tax regulations and new pension funds that does not address the extension order; binding source is the 2011 order §2(b), §6(c) alone and the proof grade for the 2025 'benefits' choice is low", value_moved: false, recorded: "resolution revision 2" },
          { id: "E2", subject: "Q4 regular-wage base", change: "the statutory composition stays additive (§§50-51); a fixed contractual premium enters the BASE under §18 and may yield 187.5%/225% (§37). multiplicative is not a separate composition", value_moved: false, recorded: "draft parameter il.working_time.regular_wage_includes_fixed_contractual_premiums@1951.1.0, text-bound to §18 in the corpus" },
          { id: "E3", subject: "Q6 daily threshold", change: "8.6/7.6 is a scenario conditional on the schedule facts (days per week, regular day length), not a default; no known pattern is a refusal, not a figure", value_moved: false, recorded: "resolution revision 2, conditional_on_schedule" },
          { id: "E4", subject: "Q3/V5 the 2016 order's gazette", change: "י\"פ 7287, 20.6.2016 — the excerpt is partially verified only; the header line was never read from the image", value_moved: false, recorded: "OPEN: the hosts carrying the excerpt are refused by the controlled path (BL-32)" },
          { id: "E5", subject: "vacation, dossier topic 6", change: "the calendar-day table per §3(א) is 16 (years 1-5), 18, 21, then one further day per year to a ceiling of 28; accrual thresholds are 200 days for a full-year relationship and 240 for part of a year", value_moved: false, recorded: "already registered in the corpus (batches 5, 7, 8); the dossier prose was what was wrong and is corrected" },
          { id: "E6", subject: "the pension example", change: "203 x 12.5% = 25.4 employer debt; 37.6 is the total including the employee's own deduction", value_moved: false, recorded: "wording" },
          { id: "E7", subject: "status language", change: "the legal engine's backlog is closed; the PRODUCT is not complete", value_moved: false, recorded: "wording" },
        ],
      },
      items: resolutions,
    },
    resolutions_recorded: resolutions.length,
    default_transitions: defaultTransitions,
    branches_examined_and_rejected: REJECTED_BRANCHES,
    convalescence_rate_table: {
      schema: "keyed by convalescence year (1.7.Y−1 to 30.6.Y) with knowledge time; a year without a row after the last is rate_not_published, never a silent default",
      rows: HAVRAA_RATE_TABLE,
      retroactive_example: "a payslip of June, July or August 2026 that paid 418.00 a day is short 33.50 a day, tagged retroactive_update_2026-08-18 (the shadow's paid_at_previous_rate month)",
    },
    gap_severity: {
      classes: GAP_SEVERITY_CLASSES,
      decisions: GAP_SEVERITY_DECISIONS,
      not_computed: GAP_SEVERITY_DIMENSIONS_NOT_COMPUTED,
      sentence_he: GAP_SEVERITY_SENTENCE_HE,
      rule: "a class is a field on the finding, never a suppression; classes come from the shadow's per-case deltas and are listed per decision under shadow.decisions",
    },
    shadow,
    executions,
    counters: { reviewed_sources: 0, active_parameters: 0, active_rules: 0, attestations: 0, resolutions_attested: 0, deliveries: 0, findings: 0 },
  };
  const report = { ...content, report_sha256: canonicalSha256(content) };
  writeFileSync(path.join(RECEIPT_ROOT, "decision-sensitivity-report-v10.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  process.stdout.write(`${JSON.stringify({
    report_sha256: report.report_sha256,
    scenarios_attempted: report.scenarios_attempted,
    scenarios_run: report.scenarios_run,
    scenarios_refused: report.scenarios_refused,
    traces_included: report.traces_included,
    traces_replayed_from_database: report.traces_replayed_from_database,
    replay_failures: report.replay_failures.length,
    topics_run: report.topics_run,
    provenance_counts: report.provenance.counts,
    shadow_cases_run: shadow.counts.ran,
    shadow_traces_replayed: shadow.traces_replayed_from_database,
    resolutions_recorded: resolutions.length,
    transitions: defaultTransitions.rows.map((row) => `${row.decision_id.replace(/^.*decision\./u, "")}: ${row.previous_default_branch} -> ${row.new_default_branch} [${row.classification}] changed=${row.cases_outcome_changed}`),
    defaults: sensitivity.map((entry) => `${entry.decision_id.replace(/^.*decision\./u, "")}=${entry.default_branch}(${entry.default_branch_source})`),
    summaries: sensitivity.map((entry) => entry.summary),
  }, null, 2)}\n`);
  if (report.replay_failures.length > 0 || report.traces_included === 0) process.exitCode = 1;
}

await main();
