// L7-6 / D1–D5. The draft shadow run, in the engine: every case of the
// synthetic corpus through every shadow spec it names, on draft parameter
// values the caller hands in (read from governance state by the script; from
// a fixture in tests), with preparation, the bridge, the executor, the grade,
// the paid component and the delta — and the trace of each execution, so the
// script can append it to the R-14 table and replay it byte-identically.
//
// This module does no I/O. It computes one deterministic result from the
// corpus, the specs and the parameter values, and hashes it. The scheduler
// runs it inside a lease; the envelope names the mode; nothing here is a
// finding or a report.
import { executeRuleSpecAtomic, type RuleSpecInputValue } from "../legal-operations/rulespec.ts";
import { prepareRuleInputs, type PreparedRuleInputs } from "../rule-input/preparation.ts";
import { createCanonicalRuleInputSnapshot } from "../rule-input/snapshot.ts";
import { canonicalSha256 } from "../rule-runtime/canonical.ts";
import { DRAFT_SHADOW_SPECS, type DraftShadowSpec } from "./draft-shadow-specs.ts";
import { gradeExecution, type ExecutionProvenance, type ParameterProvenance } from "./execution-grade.ts";
import { bridgePreparedInputs } from "./prepared-input-bridge.ts";
import { SYNTHETIC_CORPUS, SYNTHETIC_CORPUS_SHA256, type SyntheticCase } from "./synthetic-corpus.ts";
import { computeSyntheticDelta, paidComponentBinding, type SyntheticShadowDelta } from "./synthetic-delta.ts";
import { SYNTHETIC_PREPARED_AT, SYNTHETIC_PROOF_TENANT } from "./synthetic-payslip-month.ts";

export const DRAFT_SHADOW_RUN_SCHEMA = "tivdoc-draft-shadow-run-v1" as const;

/** A bound draft parameter: its value as an executor input and its grade. */
export type BoundDraftParameter = Readonly<{
  ref_id: string;
  parameter_version_id: string;
  state: string;
  value: RuleSpecInputValue["value"];
  provenance_grade: ParameterProvenance["provenance_grade"];
}>;

/** The caller's binding of every spec's parameters, per branch when the spec carries a decision. */
export type DraftParameterBindings = (spec: DraftShadowSpec, branch: string | null) => readonly BoundDraftParameter[];

export type ShadowExecutionRecord = Readonly<{
  execution_id: string;
  case_id: string;
  topic: string;
  scenario: string;
  family: "golden" | "edge";
  shadow_id: string;
  rule_spec_id: string;
  rule_spec_version: string;
  rule_content_sha256: string;
  decision_id: string | null;
  branch: string | null;
  parameter_version_ids: readonly string[];
  parameter_states: readonly string[];
  snapshot_sha256: string;
  preparation_sha256: string;
  status: "ran" | "preparation_refused" | "executor_refused";
  rejection_codes: readonly string[];
  error_code: string | null;
  output: Record<string, unknown> | null;
  provenance: ExecutionProvenance | null;
  delta: SyntheticShadowDelta | null;
  /** The executor's inputs and trace, on the wire, for the R-14 table. */
  execution_inputs: Readonly<{ facts: readonly RuleSpecInputValue[]; parameters: readonly RuleSpecInputValue[] }> | null;
  execution_trace: Record<string, unknown> | null;
  trace_sha256: string | null;
  result_sha256: string | null;
}>;

export type DraftShadowRunResult = Readonly<{
  schema_version: typeof DRAFT_SHADOW_RUN_SCHEMA;
  run_id: string;
  tenant_id: typeof SYNTHETIC_PROOF_TENANT;
  execution_mode: "draft_parameters_synthetic_inputs";
  corpus_sha256: string;
  prepared_at: string;
  branch_policy: "primary" | "all";
  executions: readonly ShadowExecutionRecord[];
  counts: Readonly<{
    cases: number;
    executions: number;
    ran: number;
    preparation_refused: number;
    executor_refused: number;
    deltas_computed: number;
    deltas_not_applicable: number;
    deltas_paid_refused: number;
    draft_parameter_versions: number;
    active_real_parameter_count: 0;
    monetary_output_count: 0;
    finding_count: 0;
    customer_report_count: 0;
  }>;
  refusals_by_reason: Readonly<Record<string, number>>;
  grades: Readonly<Record<string, number>>;
  result_sha256: string;
}>;

function wire(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? `bigint:${item}` : item))) as Record<string, unknown>;
}

function count(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of [...values].sort()) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** The branches a spec runs under: its decision's branches, or a single unnamed one. */
export function branchesOf(spec: DraftShadowSpec, policy: "primary" | "all"): readonly (string | null)[] {
  if (spec.branches.length === 0) return [spec.composition_branch];
  const names = spec.branches.map(([branch]) => branch);
  return policy === "all" ? names : [names[0]];
}

export function executeShadowCase(input: Readonly<{
  entry: SyntheticCase;
  spec: DraftShadowSpec;
  branch: string | null;
  parameters: readonly BoundDraftParameter[];
  execution_id: string;
  prepared_at?: string;
}>): ShadowExecutionRecord {
  const preparedAt = input.prepared_at ?? SYNTHETIC_PREPARED_AT;
  const snapshot = createCanonicalRuleInputSnapshot(input.entry.snapshot);
  const prepared: PreparedRuleInputs = prepareRuleInputs(snapshot, input.spec.input_mappings, preparedAt);
  const base = {
    execution_id: input.execution_id,
    case_id: input.entry.case_id,
    topic: input.entry.topic,
    scenario: input.entry.scenario,
    family: input.entry.family,
    shadow_id: input.spec.shadow_id,
    rule_spec_id: input.spec.spec.rule_spec_id,
    rule_spec_version: input.spec.spec.rule_spec_version,
    rule_content_sha256: input.spec.spec.content_sha256,
    decision_id: input.spec.decision_id,
    branch: input.branch,
    parameter_version_ids: input.parameters.map((parameter) => parameter.parameter_version_id),
    parameter_states: input.parameters.map((parameter) => parameter.state),
    snapshot_sha256: input.entry.snapshot_sha256,
    preparation_sha256: prepared.preparation_sha256,
  };
  if (prepared.result.status !== "ready") {
    return Object.freeze({
      ...base, status: "preparation_refused", rejection_codes: prepared.result.rejection_codes, error_code: null,
      output: null, provenance: null, delta: null, execution_inputs: null, execution_trace: null, trace_sha256: null, result_sha256: null,
    });
  }
  const facts = bridgePreparedInputs(prepared, input.spec.input_mappings);
  const parameters = input.parameters.map((parameter) => ({ ref_id: parameter.ref_id, value: parameter.value }));
  const outcome = executeRuleSpecAtomic({ rule: input.spec.spec, facts, parameters } as never);
  const provenance = gradeExecution(prepared.result.values, input.parameters.map((parameter) => ({
    ref_id: parameter.ref_id, parameter_version_id: parameter.parameter_version_id, provenance_grade: parameter.provenance_grade,
  })));
  if (!outcome.execution) {
    return Object.freeze({
      ...base, status: "executor_refused", rejection_codes: [], error_code: outcome.error_code,
      output: null, provenance, delta: null, execution_inputs: { facts, parameters }, execution_trace: null, trace_sha256: null, result_sha256: null,
    });
  }
  const output = wire(outcome.execution.output);
  const trace = wire({ trace: outcome.execution.trace, output: outcome.execution.output });
  const binding = paidComponentBinding(input.spec.shadow_id);
  const paid = binding ? prepareRuleInputs(snapshot, binding.registry, preparedAt) : prepared;
  const delta = computeSyntheticDelta({ shadow_id: input.spec.shadow_id, spec: input.spec.spec, entitlement: output as never, paid });
  return Object.freeze({
    ...base, status: "ran", rejection_codes: [], error_code: null,
    output, provenance, delta,
    execution_inputs: { facts, parameters },
    execution_trace: trace,
    trace_sha256: canonicalSha256(trace),
    result_sha256: canonicalSha256({ output }),
  });
}

export function runDraftShadow(input: Readonly<{
  run_id: string;
  bindings: DraftParameterBindings;
  branch_policy?: "primary" | "all";
  corpus?: readonly SyntheticCase[];
  prepared_at?: string;
}>): DraftShadowRunResult {
  const policy = input.branch_policy ?? "primary";
  const corpus = input.corpus ?? SYNTHETIC_CORPUS;
  const executions: ShadowExecutionRecord[] = [];
  for (const entry of corpus) {
    for (const shadowId of entry.shadow_ids) {
      const spec = DRAFT_SHADOW_SPECS.find((candidate) => candidate.shadow_id === shadowId);
      if (!spec) throw new Error(`DRAFT_SHADOW_SPEC_UNKNOWN:${shadowId}`);
      for (const branch of branchesOf(spec, policy)) {
        const parameters = input.bindings(spec, branch);
        const executionId = `${input.run_id}.${entry.case_id}.${shadowId}${branch ? `.${branch}` : ""}`.replaceAll("_", "-");
        executions.push(executeShadowCase({ entry, spec, branch, parameters, execution_id: executionId, prepared_at: input.prepared_at }));
      }
    }
  }
  const versions = new Set(executions.flatMap((execution) => execution.parameter_version_ids));
  const counts = {
    cases: corpus.length,
    executions: executions.length,
    ran: executions.filter((execution) => execution.status === "ran").length,
    preparation_refused: executions.filter((execution) => execution.status === "preparation_refused").length,
    executor_refused: executions.filter((execution) => execution.status === "executor_refused").length,
    deltas_computed: executions.filter((execution) => execution.delta?.status === "computed").length,
    deltas_not_applicable: executions.filter((execution) => execution.delta?.status === "not_applicable").length,
    deltas_paid_refused: executions.filter((execution) => execution.delta?.status === "paid_refused").length,
    draft_parameter_versions: versions.size,
    active_real_parameter_count: 0 as const,
    monetary_output_count: 0 as const,
    finding_count: 0 as const,
    customer_report_count: 0 as const,
  };
  const refusals = count([
    ...executions.flatMap((execution) => execution.rejection_codes.map((code) => `preparation:${code}`)),
    ...executions.flatMap((execution) => (execution.error_code ? [`executor:${execution.error_code}`] : [])),
    ...executions.flatMap((execution) => (execution.delta?.status === "paid_refused" ? execution.delta.rejection_codes.map((code) => `paid:${code}`) : [])),
  ]);
  const grades = count(executions.flatMap((execution) => (execution.provenance ? [execution.provenance.execution_grade] : [])));
  const content = {
    schema_version: DRAFT_SHADOW_RUN_SCHEMA,
    run_id: input.run_id,
    tenant_id: SYNTHETIC_PROOF_TENANT as typeof SYNTHETIC_PROOF_TENANT,
    execution_mode: "draft_parameters_synthetic_inputs" as const,
    corpus_sha256: SYNTHETIC_CORPUS_SHA256,
    prepared_at: input.prepared_at ?? SYNTHETIC_PREPARED_AT,
    branch_policy: policy,
    executions,
    counts,
    refusals_by_reason: refusals,
    grades,
  };
  return Object.freeze({ ...content, result_sha256: canonicalSha256(content) });
}
