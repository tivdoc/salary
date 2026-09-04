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
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { executeRuleSpec } from "../../src/engine/legal-operations/rulespec.ts";
import { buildAllScenarioFixtures } from "../../src/engine/legal-quality/scenario-fixtures.ts";
import { SENSITIVITY_SPECS } from "../../src/engine/legal-quality/sensitivity-rulespecs.ts";
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
  [`${TENANT}.decision.convalescence_2026_rate_period`]:
    "both branches carry 451.50 ILS and differ only in effective period (the calendar year 2026, or from the order's signature on 27 July 2026); the executor is handed a version, not a date, so no value scenario can separate them — the period is the review question, and it is left open here",
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
const GRADE_ORDER = ["text_verified", "lexicon", "selection", "inferred_visual", "administrative"];
function worstGrade(grades: readonly string[]): string {
  return grades.reduce((worst, grade) => (GRADE_ORDER.indexOf(grade) > GRADE_ORDER.indexOf(worst) ? grade : worst), "text_verified");
}

function provenanceSummary(executions: ReadonlyArray<Record<string, unknown>>) {
  // Each parameter version's own bindings — never another parameter's from
  // the same execution.
  const byVersion = new Map<string, { provenance_grade: string; visual_bindings: Array<{ page_pdf_sha256: string; visual_reading: string }> }>();
  for (const row of executions) {
    const grades = row.parameter_provenance as Array<{ parameter_version_id: string; provenance_grade: string; visual_bindings: Array<{ page_pdf_sha256: string; visual_reading: string }> }>;
    for (const item of grades) {
      if (!byVersion.has(item.parameter_version_id)) byVersion.set(item.parameter_version_id, { provenance_grade: item.provenance_grade, visual_bindings: [...item.visual_bindings] });
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
      inferred_visual: "the figure was read from the page image by the session because the text layer is ambiguous or absent; it awaits visual confirmation by a person and cannot be attested without it",
      administrative: "the figure comes from an administrative source, not a statute or an extension order",
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
    application_name: "tivdoc_e37_sensitivity",
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
      content_json: { value: ParameterValue; provenance_grade?: string; visual_bindings?: Array<{ page_pdf_sha256: string; visual_reading: string }> };
    };
    return {
      state: value.state, value: value.content_json.value,
      provenance_grade: value.content_json.provenance_grade ?? inferredGrade(`${parameterId}@${version}`),
      visual_bindings: value.content_json.visual_bindings ?? null,
    };
  });

  const envelope = createDurableShadowRunEnvelope({
    schema_version: "tivdoc-durable-offline-shadow-envelope-v0.10.0",
    run_id: "shadow.run.decision-sensitivity-e37",
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
          executionId = `l68.${entry.spec.topic}.${specSlug}.${fixture.scenario}.${branch}.${runSuffix}`.replaceAll("_", "-");
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
            [SYNTHETIC_PROOF_TENANT, JSON.stringify(payload), `l68.${executionId}`, sha256(`l68:${executionId}:${traceSha}`), new Date().toISOString()])), PROOF_SESSION);
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
          parameter_provenance: bound.map((item) => ({ parameter_version_id: `${item.binding.parameter_id}@${item.chosen}`, provenance_grade: item.read.provenance_grade, visual_bindings: item.read.visual_bindings ?? [] })),
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

  // --- The sensitivity: for each decision, which scenarios differ and by how much.
  const decisionIds = [...new Set(SENSITIVITY_SPECS.map((entry) => entry.decision_id).filter((id): id is string => id !== null))];
  const sensitivity = decisionIds.map((decisionId) => {
    const entries = SENSITIVITY_SPECS.filter((item) => item.decision_id === decisionId);
    const entry = entries[0];
    const branchNames = [...new Set(entries.flatMap((item) => item.branches.length > 0 ? item.branches.map(([branch]) => branch) : [item.composition_branch ?? "single"]))];
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
      return {
        scenario, ran: true, comparable: true, differs: delta !== BigInt(0),
        by_branch: values.map((value) => ({ branch: value.branch, output: value.rendered })),
        difference: renderDifference(delta, unit, kind),
        difference_minor_units: delta.toString(),
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
      provenance_grade: worstGrade(mine.map((row) => String(row.provenance_grade))),
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

  const content = {
    schema_version: "tivdoc-decision-sensitivity-report-v5-v0.10.18",
    classification: "internal_only",
    delivery_allowed: false,
    is_finding: false,
    is_legal_advice: false,
    tenant_id: TENANT,
    trace_tenant_id: SYNTHETIC_PROOF_TENANT,
    shadow_envelope_sha256: envelope.envelope_sha256,
    execution_mode: envelope.execution_mode,
    replaces: "tivdoc-decision-sensitivity-report-v4-v0.10.17 (v4 ran 6 topics of 7)",
    scope_note:
      "Differences only, computed. This states what the answer to each open question changes in each scenario; it does not answer any of them, and nothing here is reviewed, attested or active.",
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
    executions,
    counters: { reviewed_sources: 0, active_parameters: 0, active_rules: 0, attestations: 0, deliveries: 0, findings: 0 },
  };
  const report = { ...content, report_sha256: canonicalSha256(content) };
  writeFileSync(path.join(RECEIPT_ROOT, "decision-sensitivity-report-v5.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

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
    summaries: sensitivity.map((entry) => entry.summary),
  }, null, 2)}\n`);
  if (report.replay_failures.length > 0 || report.traces_included === 0) process.exitCode = 1;
}

await main();
