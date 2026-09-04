// E3-7. The real sensitivity run: scenarios executed against real draft
// parameter values, once per branch of every open decision the spec touches,
// with every trace persisted through R-14's table and replayed back out of it.
//
// This replaces the "not run" report. Both hashes are recorded so the two are
// comparable rather than one quietly overwriting the other.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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

const RECEIPT_ROOT = path.join("output", "next", "pool-q");
const SYSTEM_SESSION = { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import" };
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const PIN_SHA = (label: string) => canonicalSha256({ pin: label });

function money(minorUnits: bigint, currency: string): string {
  const negative = minorUnits < BigInt(0);
  const digits = (negative ? -minorUnits : minorUnits).toString().padStart(3, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)} ${currency}`;
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

  async function tx<T>(label: string, work: (client: import("pg").Client) => Promise<T>): Promise<T> {
    const client = await factory.acquire();
    try {
      await client.query(statement(`${label}_begin`, "begin", []));
      await client.query(statement(`${label}_context`, "select * from private.runtime_context_install($1,$2,$3)",
        [SYSTEM_SESSION.sid, SYSTEM_SESSION.jti, `${label}:${randomUUID().slice(0, 8)}`]));
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
    const value = row.rows[0] as unknown as { state: string; content_json: { value: { kind: string; value: { currency: string; minor_units: number } } } };
    return { state: value.state, money: value.content_json.value.value };
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
    const branches = entry.branches.length > 0 ? entry.branches : ([["single", entry.spec.parameters[0].parameter_version]] as ReadonlyArray<readonly [string, string]>);
    for (const [branch, version] of branches) {
      const parameter = await valueOf(entry.parameter_id, version);
      for (const fixture of fixtures.filter((item) => item.topic === entry.spec.topic)) {
        const parameters = [{ ref_id: entry.parameter_ref, value: { kind: "money" as const, currency: parameter.money.currency, minor_units: parameter.money.minor_units } }];
        let output: Record<string, unknown> | null = null;
        let refusal: string | null = null;
        let traceSteps = 0;
        let traceWire: Record<string, unknown> | null = null;
        try {
          const execution = executeRuleSpec({ rule: entry.spec, facts: fixture.inputs as never, parameters });
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
          executionId = `e37.${entry.spec.topic}.${fixture.scenario}.${branch}.${runSuffix}`.replaceAll("_", "-");
          const inputsWire = { facts: fixture.inputs, parameters };
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
            [TENANT, JSON.stringify(payload), `e37.${executionId}`, sha256(`e37:${executionId}:${traceSha}`), new Date().toISOString()])));
          persisted.push(executionId);
        }

        executions.push({
          topic: entry.spec.topic,
          rule_spec_id: entry.spec.rule_spec_id,
          scenario: fixture.scenario,
          decision_id: entry.decision_id,
          branch,
          parameter_version_id: `${entry.parameter_id}@${version}`,
          parameter_state: parameter.state,
          parameter_value: money(BigInt(parameter.money.minor_units), parameter.money.currency),
          fixture_id: fixture.fixture_id,
          fixture_sha256: fixture.content_sha256,
          ran: refusal === null,
          refusal,
          output: output ? money(BigInt(String((output as { minor_units: string | number }).minor_units)), String((output as { currency: string }).currency)) : null,
          output_minor_units: output ? String((output as { minor_units: string | number }).minor_units) : null,
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
        "scripts/legal-review-projection/sensitivity-trace-replay.mts", executionId,
      ], { encoding: "utf8", cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      const verdict = /E37_REPLAY_VERDICT (\{.*\})/u.exec(stdout)?.[1];
      replayed.push(verdict ? JSON.parse(verdict) as Record<string, unknown> : { execution_id: executionId, accepted: false, error: "no verdict" });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      replayed.push({ execution_id: executionId, accepted: false, error: `${failure.stdout ?? ""}${failure.stderr ?? ""}`.slice(0, 200) });
    }
  }

  // --- The sensitivity: for each decision, which scenarios differ and by how much.
  const sensitivity = SENSITIVITY_SPECS.filter((entry) => entry.decision_id !== null).map((entry) => {
    const mine = executions.filter((row) => row.decision_id === entry.decision_id);
    const scenarios = [...new Set(mine.map((row) => row.scenario as string))].sort();
    const perScenario = scenarios.map((scenario) => {
      const rows = mine.filter((row) => row.scenario === scenario);
      const ran = rows.filter((row) => row.ran === true);
      if (ran.length !== entry.branches.length) {
        return {
          scenario, differs: false, ran: false,
          reason: rows.find((row) => row.refusal !== null)?.refusal ?? "not all branches ran",
        };
      }
      const values = ran.map((row) => ({ branch: row.branch as string, minor: BigInt(String(row.output_minor_units)), rendered: row.output as string }));
      const low = values.reduce((a, b) => a.minor < b.minor ? a : b);
      const high = values.reduce((a, b) => a.minor > b.minor ? a : b);
      const delta = high.minor - low.minor;
      return {
        scenario, ran: true, differs: delta !== BigInt(0),
        by_branch: values.map((value) => ({ branch: value.branch, output: value.rendered })),
        difference: money(delta, "ILS"),
        difference_minor_units: delta.toString(),
      };
    });
    const differing = perScenario.filter((row) => row.differs);
    return {
      decision_id: entry.decision_id,
      topic: entry.spec.topic,
      rule_spec_id: entry.spec.rule_spec_id,
      narrower_than_draft: entry.narrower_than_draft,
      branches: entry.branches.map(([branch]) => branch),
      scenarios_run: perScenario.filter((row) => row.ran).length,
      scenarios_differing: differing.length,
      scenarios_not_run: perScenario.filter((row) => !row.ran).map((row) => ({ scenario: row.scenario, reason: (row as { reason?: string }).reason })),
      per_scenario: perScenario,
      summary: differing.length === 0 ? "no scenario in this set separates the branches"
        : `${entry.decision_id}: differs in ${differing.map((row) => row.scenario).join(", ")}; largest difference ${differing.reduce((a, b) => BigInt(a.difference_minor_units!) > BigInt(b.difference_minor_units!) ? a : b).difference}`,
    };
  });

  // --- Topics with no executable spec, each with its own reason.
  const drafts = buildSevenRuleSpecDrafts();
  const runnableTopics = new Set(SENSITIVITY_SPECS.map((entry) => entry.spec.topic));
  const notRun = WAVE3_TOPICS.filter((topic) => !runnableTopics.has(topic)).map((topic) => {
    const draft = drafts.find((entry) => entry.topic === topic)!;
    const unbound = draft.parameter_slots.filter((slot) => !slot.bound);
    return {
      topic,
      not_run: unbound.length > 0 ? "slot_unbound" : "no_definitional_computation_available",
      slots: unbound.map((slot) => slot.slot_id),
      detail: unbound.length > 0
        ? `Unbound: ${unbound.map((slot) => slot.parameter_id).join(", ")}.`
        : "Every slot is bound, but the entitlement is an integer day count selected by seniority band, and the node vocabulary has no band lookup. Expressing it would mean encoding a legal rule in the spec, which is the one thing a draft may not do.",
    };
  });

  const content = {
    schema_version: "tivdoc-decision-sensitivity-report-v2-v0.10.15",
    classification: "internal_only",
    delivery_allowed: false,
    is_finding: false,
    is_legal_advice: false,
    tenant_id: TENANT,
    shadow_envelope_sha256: envelope.envelope_sha256,
    execution_mode: envelope.execution_mode,
    replaces: "tivdoc-decision-sensitivity-report-v0.10.14 (scenarios_run: 0)",
    scope_note:
      "Differences only, computed. This states what the answer to each open question changes in each scenario; it does not answer any of them, and nothing here is reviewed, attested or active.",
    scenarios_attempted: executions.length,
    scenarios_run: executions.filter((row) => row.ran).length,
    scenarios_refused: executions.filter((row) => row.ran === false).length,
    traces_included: persisted.length,
    traces_replayed_from_database: replayed.filter((row) => row.accepted === true).length,
    replay_failures: replayed.filter((row) => row.accepted !== true),
    topics_run: [...runnableTopics].sort(),
    topics_not_run: notRun,
    open_decisions: sensitivity,
    executions,
    counters: { reviewed_sources: 0, active_parameters: 0, active_rules: 0, attestations: 0, deliveries: 0, findings: 0 },
  };
  const report = { ...content, report_sha256: canonicalSha256(content) };
  writeFileSync(path.join(RECEIPT_ROOT, "decision-sensitivity-report-v2.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  process.stdout.write(`${JSON.stringify({
    report_sha256: report.report_sha256,
    scenarios_attempted: report.scenarios_attempted,
    scenarios_run: report.scenarios_run,
    scenarios_refused: report.scenarios_refused,
    traces_included: report.traces_included,
    traces_replayed_from_database: report.traces_replayed_from_database,
    replay_failures: report.replay_failures.length,
    topics_run: report.topics_run,
    summaries: sensitivity.map((entry) => entry.summary),
  }, null, 2)}\n`);
  if (report.replay_failures.length > 0 || report.traces_included === 0) process.exitCode = 1;
}

await main();
