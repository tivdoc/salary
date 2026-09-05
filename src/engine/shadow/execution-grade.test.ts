// L7-3 / D3. The grade of an execution is the worst of what went into it.
import { describe, expect, it } from "vitest";
import { prepareRuleInputs } from "../rule-input/preparation.ts";
import { createCanonicalRuleInputSnapshot } from "../rule-input/snapshot.ts";
import { DRAFT_SHADOW_SPECS } from "./draft-shadow-specs.ts";
import { EXECUTION_GRADES, gradeExecution, inputProvenance, worstExecutionGrade, worstSourceType, type ParameterProvenance } from "./execution-grade.ts";
import { SYNTHETIC_PREPARED_AT, buildSyntheticPayslipMonth, periodFact, type SyntheticFactSeed, type SyntheticSourceType } from "./synthetic-payslip-month.ts";

const overtime = DRAFT_SHADOW_SPECS.find((entry) => entry.shadow_id === "working.time.overtime.pay")!;

function preparedWith(hoursSource: SyntheticSourceType, wageSource: SyntheticSourceType) {
  const facts: SyntheticFactSeed[] = [
    periodFact("grade", "2026-07-01", "2026-07-31"),
    { path: "work.overtime_hours", value: { amount: "3", unit: "hours_per_day" }, source_type: hoursSource, confidence: 0.95 },
    { path: "compensation.hourly_rate", value: { currency: "ILS", minor_units: 4_000 }, source_type: wageSource },
  ];
  const snapshot = createCanonicalRuleInputSnapshot(buildSyntheticPayslipMonth({ seed: "grade", facts }));
  return prepareRuleInputs(snapshot, overtime.input_mappings, SYNTHETIC_PREPARED_AT);
}

const parameter = (refId: string, grade: ParameterProvenance["provenance_grade"]): ParameterProvenance => ({ ref_id: refId, parameter_version_id: `il.working_time.x@1951.1.0`, provenance_grade: grade });

describe("the execution grade", () => {
  it("is one ladder, best first", () => {
    expect(EXECUTION_GRADES).toEqual(["verified", "lexicon", "declared", "derived", "inferred", "administrative", "agreement_interpretation"]);
    expect(worstExecutionGrade([])).toBe("verified");
    expect(worstExecutionGrade(["verified", "derived", "lexicon"])).toBe("derived");
    expect(worstSourceType(["documented", "inferred", "declared"])).toBe("inferred");
  });

  it("carries every prepared input's source types, fact id, confidence and transformation", () => {
    const prepared = preparedWith("documented", "declared");
    expect(prepared.result.status).toBe("ready");
    const provenance = prepared.result.values.map(inputProvenance);
    expect(provenance.map((entry) => [entry.input_id, entry.fact_path, entry.worst_source_type, entry.confidence, entry.transformation])).toEqual([
      ["fact.overtime.hours.day", "work.overtime_hours", "documented", 0.95, "canonical.hours.per.day.integer@1.0.0"],
      ["fact.regular.hourly.wage", "compensation.hourly_rate", "declared", 1, "canonical.money.identity@1.0.0"],
    ]);
    for (const entry of provenance) expect(entry.source_fact_id).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("is the worst input when the parameters are text-verified", () => {
    const parameters = [parameter("parameter.rate.first", "text_verified"), parameter("parameter.rate.second", "text_verified")];
    const cases: Array<[SyntheticSourceType, SyntheticSourceType, string]> = [
      ["documented", "documented", "verified"],
      ["documented", "declared", "declared"],
      ["derived", "declared", "derived"],
      ["inferred", "documented", "inferred"],
    ];
    for (const [hours, wage, expected] of cases) {
      const graded = gradeExecution(preparedWith(hours, wage).result.values, parameters);
      expect(graded.execution_grade, `${hours}/${wage}`).toBe(expected);
      expect(graded.worst_parameter_grade).toBe("text_verified");
    }
  });

  // L13T-6 (Lane B, run 13-T), fields split by the external review #1
  // (finding 7): a documented figure the extractor read off the page is a
  // document reference, not a verified reading. It grades `inferred` — the
  // rung the page-image parameter sits on — until a person reads it or
  // confirms the machine's reading.
  it("keeps a machine-read, unconfirmed documented input off the verified rung", () => {
    const parameters = [parameter("parameter.rate.first", "text_verified"), parameter("parameter.rate.second", "text_verified")];
    const values = preparedWith("documented", "documented").result.values;
    const withReading = (read_by: "machine" | "person" | null, index: number, verified?: boolean) => values.map((ref, at) => (at !== index || read_by === null ? ref : {
      ...ref,
      provenance: ref.provenance.map((entry) => (entry.source_type === "documented" ? { ...entry, read_by, ...(verified === undefined ? {} : { verified }) } : entry)),
    }));
    // Unmarked evidence is what every fixture and every older fact carries: unchanged, verified.
    expect(gradeExecution(values, parameters).execution_grade).toBe("verified");
    expect(inputProvenance(values[0]!).read_by).toBe("unstated");
    expect(inputProvenance(values[0]!).verified).toBe(false);
    // The extractor's reading on one input grades the execution inferred, and says which input.
    const machine = withReading("machine", 0);
    const graded = gradeExecution(machine, parameters);
    expect(inputProvenance(machine[0]!).read_by).toBe("machine");
    expect(inputProvenance(machine[0]!).verified).toBe(false);
    expect(graded.worst_input_source_type).toBe("documented");
    expect(graded.execution_grade).toBe("inferred");
    // A person's reading is not the machine's; and the machine's reading a person confirmed is verified, too.
    expect(gradeExecution(withReading("person", 0), parameters).execution_grade).toBe("verified");
    const confirmed = withReading("machine", 0, true);
    expect(inputProvenance(confirmed[0]!)).toMatchObject({ read_by: "machine", verified: true });
    expect(gradeExecution(confirmed, parameters).execution_grade).toBe("verified");
    // `verified: false` written out is what the resolver writes: still inferred.
    expect(gradeExecution(withReading("machine", 0, false), parameters).execution_grade).toBe("inferred");
    // The same fact read by both: not only the machine, so not machine-read.
    const both = values.map((ref, at) => (at !== 0 ? ref : {
      ...ref,
      provenance: [...ref.provenance.map((entry) => (entry.source_type === "documented" ? { ...entry, read_by: "machine" as const } : entry)),
        ...ref.provenance.filter((entry) => entry.source_type === "documented").map((entry) => ({ ...entry, read_by: "person" as const }))],
    }));
    expect(inputProvenance(both[0]!).read_by).toBe("person");
  });

  it("is the worst parameter when the inputs are documented", () => {
    const values = preparedWith("documented", "documented").result.values;
    expect(gradeExecution(values, [parameter("parameter.rate.first", "lexicon")]).execution_grade).toBe("lexicon");
    expect(gradeExecution(values, [parameter("parameter.rate.first", "selection")]).execution_grade).toBe("declared");
    expect(gradeExecution(values, [parameter("parameter.rate.first", "text_verified"), parameter("parameter.rate.second", "inferred_visual")]).execution_grade).toBe("inferred");
    expect(gradeExecution(values, [parameter("parameter.rate.first", "administrative")]).execution_grade).toBe("administrative");
  });

  it("takes the worse side when both are weak — never an average", () => {
    const graded = gradeExecution(preparedWith("inferred", "documented").result.values, [parameter("parameter.rate.first", "lexicon")]);
    expect(graded.worst_input_source_type).toBe("inferred");
    expect(graded.worst_parameter_grade).toBe("lexicon");
    expect(graded.execution_grade).toBe("inferred");
    const other = gradeExecution(preparedWith("declared", "documented").result.values, [parameter("parameter.rate.first", "inferred_visual")]);
    expect(other.execution_grade).toBe("inferred");
  });

  it("is deterministic in the order of inputs and parameters", () => {
    const values = preparedWith("declared", "derived").result.values;
    const a = gradeExecution(values, [parameter("b", "lexicon"), parameter("a", "text_verified")]);
    const b = gradeExecution([...values].reverse(), [parameter("a", "text_verified"), parameter("b", "lexicon")]);
    expect(a).toEqual(b);
  });

  it("a rejected preparation has no inputs to grade — the case did not run", () => {
    const facts: SyntheticFactSeed[] = [
      periodFact("grade", "2026-07-01", "2026-07-31"),
      { path: "work.overtime_hours", value: null, status: "conflicted" },
      { path: "compensation.hourly_rate", value: { currency: "ILS", minor_units: 4_000 } },
    ];
    const prepared = prepareRuleInputs(createCanonicalRuleInputSnapshot(buildSyntheticPayslipMonth({ seed: "grade", facts })), overtime.input_mappings, SYNTHETIC_PREPARED_AT);
    expect(prepared.result.status).toBe("rejected");
    expect(prepared.result.rejection_codes).toEqual(["fact.conflicted"]);
    expect(prepared.result.values).toEqual([]);
  });
});
