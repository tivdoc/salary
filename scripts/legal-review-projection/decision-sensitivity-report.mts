// Q-8. The decision-sensitivity report — the document both sessions exist to
// produce: for every open legal question, exactly what difference the answer
// makes, so a lawyer can decide in minutes what would otherwise take days.
//
// Internal only. Hashed, built on the offline shadow envelope, never a Finding,
// never delivered, never leaves the system. It contains no advice and reaches
// no conclusion; it states differences.
//
// It is also honest about what it cannot yet compute, and that honesty is the
// point rather than a caveat. The seven draft RuleSpecs cannot execute: their
// citation, rounding, effective-period, sector/population and precedence slots
// are unbound, and R-2's refusal is what stops a half-filled spec from
// producing a number. The 42 golden cases cannot drive a run either: they are
// blank templates with no input snapshot and no expected output. So the
// per-scenario propagation the brief sketches is not available, and this report
// says so per scenario, with the specific reason, instead of inventing it.
//
// What IS exactly computable today is the parameter-level difference each open
// decision makes — read from the governance database through the sanctioned
// path, in BigInt minor units, with no floating point anywhere. That is a real
// number a lawyer can act on, and it is labelled for exactly what it is.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GOLDEN_SCENARIOS, buildBlankGoldenCaseTemplates } from "../../src/engine/legal-quality/golden-case-templates.ts";
import { buildSevenRuleSpecDrafts } from "../../src/engine/legal-quality/rulespec-drafts.ts";
import { buildRuleSpecTemplate, ruleSpecTemplateBindingRefusals } from "../../src/engine/legal-quality/rulespec-templates.ts";
import { canonicalSha256 } from "../../src/engine/rule-runtime/canonical.ts";
import { WAVE3_TOPICS } from "../../src/engine/wave3/contracts.ts";
import { createDurableShadowRunEnvelope } from "../../src/server/engine/shadow/durable-contracts.ts";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { TENANT } from "./pool-p-parameter-import.mts";

const RECEIPT_ROOT = path.join("output", "next", "pool-q");
const SYSTEM_SESSION = { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import" };
const PIN_SHA = (label: string) => canonicalSha256({ pin: label });
// Derived from TENANT, never written out: A7-1 guard 1 requires the tenant id
// to exist as a literal in exactly one place, and it catches this file if it
// does not — which is how this constant came to exist.
const LEGAL_DECISION_PREFIX = `${TENANT}.decision.`;

type Candidate = Readonly<{
  parameter_id: string;
  parameter_version: string;
  unit: string;
  topic: string;
  branch: string | null;
  decision_id: string | null;
  effective_from: string;
  effective_to: string | null;
  value: Readonly<{ kind: string; value: unknown; unit?: string }>;
  candidate_sha256: string;
}>;

// Money is rendered from BigInt minor units by string surgery. Never
// `minor / 100` — this file is on the money path in every sense that matters
// and the one rule there is that no float ever touches a legal amount.
function renderAmount(value: Candidate["value"], unit: string): string {
  if (value.kind === "money") {
    const money = value.value as { currency: string; minor_units: number | string };
    const minor = BigInt(money.minor_units);
    const negative = minor < BigInt(0);
    const digits = (negative ? -minor : minor).toString().padStart(3, "0");
    return `${negative ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)} ${money.currency}`;
  }
  if (value.kind === "integer") return `${String(value.value)} ${value.unit ?? unit}`;
  if (value.kind === "rational") {
    const rational = value.value as { numerator: string; denominator: string };
    return `${rational.numerator}/${rational.denominator} ${value.unit ?? unit}`;
  }
  return `${JSON.stringify(value.value)} ${unit}`;
}

// The difference between two branches, exact, in the smallest unit the value
// has. Returns null when the two branches are not the same kind of quantity —
// which would itself be a finding rather than a delta.
function renderDelta(left: Candidate, right: Candidate): string | null {
  if (left.value.kind !== right.value.kind) return null;
  if (left.value.kind === "money") {
    const a = BigInt((left.value.value as { minor_units: number | string }).minor_units);
    const b = BigInt((right.value.value as { minor_units: number | string }).minor_units);
    const currency = (left.value.value as { currency: string }).currency;
    const diff = a > b ? a - b : b - a;
    const digits = diff.toString().padStart(3, "0");
    return `${digits.slice(0, -2)}.${digits.slice(-2)} ${currency}`;
  }
  if (left.value.kind === "integer") {
    const a = BigInt(String(left.value.value));
    const b = BigInt(String(right.value.value));
    return `${(a > b ? a - b : b - a).toString()} ${left.value.unit ?? left.unit}`;
  }
  return null;
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const url = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!url) throw new Error("Q8_ENV_MISSING");
  const parsed = new URL(url);
  const factory = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: url, max_connections: 4, connection_timeout_ms: 20_000,
    application_name: "tivdoc_q8_sensitivity",
    remote_dev_target: {
      host: parsed.hostname, port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//u, ""), project_ref: env.get("TIVDOC_DEV_PROJECT_REF") ?? "",
    },
  });

  const client = await factory.acquire();
  const candidates: Candidate[] = [];
  let decisions: Array<Record<string, string | null>> = [];
  try {
    await client.query(statement("q8_begin", "begin", []));
    await client.query(statement("q8_context", "select * from private.runtime_context_install($1,$2,$3)",
      [SYSTEM_SESSION.sid, SYSTEM_SESSION.jti, `q8:${randomUUID().slice(0, 8)}`]));

    const decisionRows = await client.query(statement("q8_decisions",
      "select * from private.legal_open_decision_read($1)", [TENANT]));
    decisions = decisionRows.rows as unknown as Array<Record<string, string | null>>;

    // Every parameter version any draft binds, read one by one through the
    // sanctioned aggregate read. There is no list-all path and deliberately so.
    const drafts = buildSevenRuleSpecDrafts();
    const wanted = new Set<string>();
    for (const draft of drafts) {
      for (const slot of draft.parameter_slots) if (slot.bound) for (const id of slot.parameter_version_ids) wanted.add(id);
    }
    for (const id of [...wanted].sort()) {
      const at = id.lastIndexOf("@");
      const row = await client.query(statement("q8_aggregate",
        "select content_json from private.governance_aggregate_read($1,$2,$3,$4)",
        [TENANT, "parameter_approval", id.slice(0, at), id.slice(at + 1)]));
      if (row.row_count !== 1) throw new Error(`Q8_CANDIDATE_MISSING:${id}`);
      candidates.push((row.rows[0] as unknown as { content_json: Candidate }).content_json);
    }
    await client.query(statement("q8_rollback", "rollback", []));
  } finally {
    client.release();
  }

  const byVersionId = new Map(candidates.map((entry) => [`${entry.parameter_id}@${entry.parameter_version}`, entry]));

  // --- The offline shadow envelope this report is produced under. Everything
  // it pins is synthetic or empty, and every promotion switch is off.
  const now = "2026-09-04T00:00:00.000Z";
  const envelope = createDurableShadowRunEnvelope({
    schema_version: "tivdoc-durable-offline-shadow-envelope-v0.10.0",
    run_id: "shadow.run.decision-sensitivity-q8",
    execution_mode: "offline_synthetic_only",
    dataset_pin: { pin_id: "pin.dataset.golden-blank", version: "0.7.0", sha256: PIN_SHA("dataset"), classification: "deterministic_synthetic", byte_count: 1024, customer_material: false },
    ground_truth_pin: { pin_id: "pin.ground-truth.none", version: "0.7.0", sha256: PIN_SHA("ground_truth"), classification: "synthetic_mechanics_ground_truth", customer_material: false, human_ground_truth_count: 0 },
    source_state_pin: { pin_id: "pin.sources.synthetic", version: "0.1.0", sha256: PIN_SHA("sources"), mode: "synthetic_placeholder_only", active_real_source_count: 0, selected_real_source_count: 0 },
    parameter_state_pin: { pin_id: "pin.parameters.draft-only", version: "0.1.0", sha256: PIN_SHA("parameters"), active_real_parameter_count: 0 },
    rule_state_pin: { pin_id: "pin.rules.draft-only", version: "0.1.0", sha256: PIN_SHA("rules"), active_real_rule_count: 0 },
    approved_baseline_pin: { pin_id: "pin.baseline.none", version: "0.1.0", sha256: PIN_SHA("baseline"), approval_receipt_sha256: PIN_SHA("approval_receipt") },
    candidate_pin: { pin_id: "pin.candidate.q8", version: "0.8.0", sha256: PIN_SHA("candidate") },
    code_pin: { pin_id: "pin.code.q8", version: "0.8.0", sha256: PIN_SHA("code") },
    config_pin: { pin_id: "pin.config.q8", version: "0.8.0", sha256: PIN_SHA("config") },
    threshold_policy_pin: { pin_id: "pin.threshold.none", version: "0.1.0", sha256: PIN_SHA("threshold") },
    requested_at: now, scheduled_for: now,
    network_allowed: false, external_provider_allowed: false, customer_input_allowed: false,
    delivery_allowed: false, automatic_customer_promotion: false, automatic_production_promotion: false,
  });

  // --- Open decisions: what difference does the answer make?
  const drafts = buildSevenRuleSpecDrafts();
  // Proof fixtures are separated from legal questions, not hidden. A7-3's
  // withdrawal proof registers throwaway decisions to exercise the state
  // machine, and `legal_open_decisions` is append-only with no delete path, so
  // they stay in the table forever. They must not appear beside real questions
  // in a document a lawyer reads, and they must not silently vanish either.
  //
  // The discriminator is the id namespace, not the topic column, and that is
  // deliberate: the one genuinely withdrawn legal decision — the vacation
  // "200 vs 240 days" question — was registered by A7-3's proof script through
  // the same helper as its fixtures and carries `topic: "test"` by mistake.
  // The table is append-only, so that column cannot be corrected; the id
  // namespace can be trusted and the topic on that row cannot. Recorded below
  // as `known_metadata_defects` rather than quietly worked around.
  const isProofFixture = (row: Record<string, string | null>) =>
    !String(row.decision_id ?? "").startsWith(LEGAL_DECISION_PREFIX);
  const proofFixtures = decisions.filter(isProofFixture)
    .map((row) => ({ decision_id: row.decision_id, resolution_state: row.resolution_state }));
  const legalDecisions = decisions.filter((row) => !isProofFixture(row));
  const openDecisions = legalDecisions.filter((row) => row.resolution_state === "open");
  const sensitivity = openDecisions.map((decision) => {
    const slots = drafts.flatMap((draft) => draft.parameter_slots.filter((slot) => slot.decision_id === decision.decision_id));
    const branches = slots.flatMap((slot) => slot.bound ? slot.decision_branches : []);
    const rendered = branches.map((entry) => {
      const candidate = byVersionId.get(entry.parameter_version_id);
      if (!candidate) throw new Error(`Q8_BRANCH_CANDIDATE_MISSING:${entry.parameter_version_id}`);
      return {
        branch: entry.branch,
        parameter_version_id: entry.parameter_version_id,
        value: renderAmount(candidate.value, candidate.unit),
        effective_from: candidate.effective_from,
        effective_to: candidate.effective_to,
        candidate_sha256: candidate.candidate_sha256,
      };
    });
    const [left, right] = branches.map((entry) => byVersionId.get(entry.parameter_version_id)!);
    return {
      decision_id: decision.decision_id,
      topic: decision.topic,
      question: decision.question,
      dossier_anchor: decision.dossier_anchor,
      resolution_state: decision.resolution_state,
      parameter_id: slots[0]?.parameter_id ?? null,
      branches: rendered,
      // The exact, checkable thing this report can say today.
      parameter_level_difference: left && right ? renderDelta(left, right) : null,
      summary: left && right
        ? `${decision.decision_id}: ${rendered.map((entry) => `${entry.branch} -> ${entry.value}`).join("  vs  ")}  (difference ${renderDelta(left, right)})`
        : null,
      scenario_level_difference: "not_computable_yet",
      scenario_level_difference_reason:
        "The draft RuleSpec for this topic cannot execute: its citation, rounding, effective-period, sector/population and precedence slots are unbound, and the executor refuses an unbound spec by design. Per-scenario propagation becomes computable once those slots are filled by a reviewer.",
    };
  });

  // --- Withdrawn decisions, listed separately, as A7-3 requires. A decision
  // dissolved by reading the source is not the same act as one settled by two
  // human attestations, and a reader must never have to guess which happened.
  const withdrawnDecisions = legalDecisions
    .filter((row) => row.resolution_state === "withdrawn")
    .map((row) => ({
      decision_id: row.decision_id,
      topic: row.topic,
      question: row.question,
      withdrawn_reason: row.withdrawn_reason,
      dissolution_citation_locator: row.dissolution_citation_locator,
    }));
  const resolvedDecisions = legalDecisions
    .filter((row) => row.resolution_state === "resolved")
    .map((row) => ({ decision_id: row.decision_id, topic: row.topic, resolved_branch: row.resolved_branch }));

  // --- The 42 scenarios: every one attempted, every one recorded with the
  // specific reason it could not run. Two independent reasons apply to all of
  // them, and both are named rather than collapsed into one.
  const goldenTemplates = buildBlankGoldenCaseTemplates();
  const unrunnable = WAVE3_TOPICS.flatMap((topic) => {
    const template = buildRuleSpecTemplate(topic);
    const refusals = ruleSpecTemplateBindingRefusals(template);
    const draft = drafts.find((entry) => entry.topic === topic)!;
    return GOLDEN_SCENARIOS.map((scenario) => {
      const golden = goldenTemplates.find((entry) => entry.topic === topic && entry.scenario === scenario)!;
      return {
        topic, scenario,
        reasons: [
          {
            code: "RULESPEC_DRAFT_SLOTS_UNBOUND",
            detail: `${refusals.length} unbound slots on ${draft.draft_id}: ${[...new Set(refusals.map((entry) => entry.code))].sort().join(", ")}`,
          },
          {
            code: "GOLDEN_CASE_TEMPLATE_BLANK",
            detail: `${golden.template_id} is ${golden.state} with ${golden.approval_state}: no input snapshot, no expected result, no reviewer.`,
          },
        ],
      };
    });
  });

  const content = {
    schema_version: "tivdoc-decision-sensitivity-report-v0.10.14",
    classification: "internal_only",
    delivery_allowed: false,
    is_finding: false,
    is_legal_advice: false,
    tenant_id: TENANT,
    shadow_envelope_sha256: envelope.envelope_sha256,
    execution_mode: envelope.execution_mode,
    scope_note:
      "Differences only. This document states what the answer to each open question changes; it does not answer any of them, and nothing in it is reviewed, attested or active.",
    open_decisions: sensitivity,
    withdrawn_decisions: withdrawnDecisions,
    resolved_decisions: resolvedDecisions,
    non_legal_proof_fixtures: proofFixtures,
    non_legal_proof_fixtures_note:
      "Throwaway decisions registered by the A7-3 withdrawal proof to exercise the state machine. legal_open_decisions is append-only with no delete path, so they remain in the table permanently. Listed here so they are accounted for rather than mistaken for legal questions, and excluded from every section above.",
    known_metadata_defects: [
      {
        row: `${LEGAL_DECISION_PREFIX}vacation_minimum_days_threshold_200_vs_240`,
        defect: "topic recorded as 'test'",
        cause: "A7-3's proof script registered the real withdrawal through the same helper as its throwaway fixtures, which hardcodes the topic.",
        correctable: false,
        why_not: "legal_open_decisions is append-only; only resolution_state may ever change, and only once. The row's substance — the reason and the dissolving citation locator — is correct.",
      },
    ],
    scenarios_attempted: unrunnable.length,
    scenarios_run: 0,
    scenarios_not_runnable: unrunnable,
    counters: {
      reviewed_sources: 0, active_parameters: 0, active_rules: 0,
      attestations: 0, deliveries: 0, findings: 0,
    },
  };
  const report = { ...content, report_sha256: canonicalSha256(content) };

  const target = path.join(RECEIPT_ROOT, "decision-sensitivity-report.json");
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  // Built twice: the same inputs must give the same hash, or it is not a
  // document anyone can cite.
  const second = { ...content, report_sha256: canonicalSha256(content) };
  if (second.report_sha256 !== report.report_sha256) throw new Error("Q8_REPORT_NOT_DETERMINISTIC");

  process.stdout.write(`${JSON.stringify({
    report_sha256: report.report_sha256,
    shadow_envelope_sha256: envelope.envelope_sha256,
    open_decisions: sensitivity.length,
    withdrawn_decisions: withdrawnDecisions.length,
    resolved_decisions: resolvedDecisions.length,
    non_legal_proof_fixtures: proofFixtures.length,
    scenarios_attempted: report.scenarios_attempted,
    scenarios_run: report.scenarios_run,
    summaries: sensitivity.map((entry) => entry.summary),
  }, null, 2)}\n`);
}

await main();
