// L7-3 / D3. Provenance propagates from the facts to the execution.
//
// A prepared input already carries its fact's evidence references, each with
// a source type — documented, declared, derived, inferred — and the grade of
// a draft parameter version is the L6 provenance grade on its candidate. An
// execution's grade is the WORST of all of them, on one ladder that names
// both kinds of weakness, so a case computed from a documented hours figure
// and a parameter read from a page image is graded by the page image, and a
// case computed from text-verified parameters and a declared hours figure is
// graded by the declaration.
//
// The ladder, best first. Each rung says what the weakest link was:
//
//   verified      every input documented; every parameter text_verified
//   lexicon       a parameter bound through the numeral lexicon
//   declared      an input declared by the person (or a parameter bound via
//                 an instrument selection — a choice, not a reading)
//   derived       an input computed from other facts — or, L12-1, a parameter
//                 derived by arithmetic on cited text plus a declared assumption
//   inferred      an input produced by an agent, or a parameter read from a
//                 page image awaiting visual confirmation
//   administrative a parameter from an administrative source (unbound today)
//   agreement_interpretation
//                 a parameter from a party's reading of an agreement or
//                 extension order (L11-5 / D3.6; unbound today)
//
// The grade is displayed, never used to decide: nothing here suppresses,
// rounds, or weights an output by its grade.
import { z } from "zod";
import { factSourceTypeSchema, type FactSourceType } from "../facts/contracts.ts";
import { PROVENANCE_GRADES, worstProvenance, type ProvenanceGrade } from "../legal-knowledge/visual-citation-v1.ts";
import type { RuleInputValueRef } from "../wave2/contracts.ts";

export const EXECUTION_GRADES = ["verified", "lexicon", "declared", "derived", "inferred", "administrative", "agreement_interpretation"] as const;
export const executionGradeSchema = z.enum(EXECUTION_GRADES);
export type ExecutionGrade = z.infer<typeof executionGradeSchema>;

/** Input source types, best first. */
export const INPUT_SOURCE_ORDER: readonly FactSourceType[] = Object.freeze(["documented", "declared", "derived", "inferred"]);

const INPUT_RUNG: Readonly<Record<FactSourceType, ExecutionGrade>> = Object.freeze({
  documented: "verified",
  declared: "declared",
  derived: "derived",
  inferred: "inferred",
});

const PARAMETER_RUNG: Readonly<Record<ProvenanceGrade, ExecutionGrade>> = Object.freeze({
  text_verified: "verified",
  lexicon: "lexicon",
  selection: "declared",
  derived: "derived",
  inferred_visual: "inferred",
  administrative: "administrative",
  agreement_interpretation: "agreement_interpretation",
});

export const inputProvenanceSchema = z.object({
  input_id: z.string(),
  fact_path: z.string(),
  source_fact_id: z.string(),
  /** Every source type on the fact's evidence, sorted; the worst grades the input. */
  source_types: z.array(factSourceTypeSchema).min(1).readonly(),
  worst_source_type: factSourceTypeSchema,
  confidence: z.number().min(0).max(1),
  transformation: z.string(),
}).strict().readonly();

export const parameterProvenanceSchema = z.object({
  ref_id: z.string(),
  parameter_version_id: z.string(),
  provenance_grade: z.enum(PROVENANCE_GRADES),
}).strict().readonly();

export const executionProvenanceSchema = z.object({
  inputs: z.array(inputProvenanceSchema).readonly(),
  parameters: z.array(parameterProvenanceSchema).readonly(),
  worst_input_source_type: factSourceTypeSchema.nullable(),
  worst_parameter_grade: z.enum(PROVENANCE_GRADES).nullable(),
  execution_grade: executionGradeSchema,
}).strict().readonly();

export type InputProvenance = z.infer<typeof inputProvenanceSchema>;
export type ParameterProvenance = z.infer<typeof parameterProvenanceSchema>;
export type ExecutionProvenance = z.infer<typeof executionProvenanceSchema>;

export function worstSourceType(types: readonly FactSourceType[]): FactSourceType {
  if (types.length === 0) throw new Error("EXECUTION_GRADE_NO_SOURCE_TYPES");
  return types.reduce((worst, type) => (INPUT_SOURCE_ORDER.indexOf(type) > INPUT_SOURCE_ORDER.indexOf(worst) ? type : worst), types[0]);
}

export function worstExecutionGrade(grades: readonly ExecutionGrade[]): ExecutionGrade {
  if (grades.length === 0) return "verified";
  return grades.reduce((worst, grade) => (EXECUTION_GRADES.indexOf(grade) > EXECUTION_GRADES.indexOf(worst) ? grade : worst), grades[0]);
}

export function inputProvenance(ref: RuleInputValueRef): InputProvenance {
  const sourceTypes = [...new Set(ref.provenance.map((entry) => entry.source_type))].sort(
    (left, right) => INPUT_SOURCE_ORDER.indexOf(left) - INPUT_SOURCE_ORDER.indexOf(right),
  );
  return inputProvenanceSchema.parse({
    input_id: ref.input_id,
    fact_path: ref.fact_path,
    source_fact_id: ref.source_fact_id,
    source_types: sourceTypes,
    worst_source_type: worstSourceType(sourceTypes),
    confidence: ref.confidence,
    transformation: ref.transformation ? `${ref.transformation.transformation_id}@${ref.transformation.transformation_version}` : "none",
  });
}

/** The grade of one execution: the worst of its inputs' source types and its parameters' grades. */
export function gradeExecution(
  values: readonly RuleInputValueRef[],
  parameters: readonly ParameterProvenance[],
): ExecutionProvenance {
  const inputs = values.map(inputProvenance).sort((left, right) => (left.input_id < right.input_id ? -1 : left.input_id > right.input_id ? 1 : 0));
  const sortedParameters = [...parameters].sort((left, right) => (left.ref_id < right.ref_id ? -1 : left.ref_id > right.ref_id ? 1 : 0));
  const worstInput = inputs.length === 0 ? null : worstSourceType(inputs.map((entry) => entry.worst_source_type));
  const worstParameter = sortedParameters.length === 0 ? null : worstProvenance(sortedParameters.map((entry) => entry.provenance_grade));
  const rungs: ExecutionGrade[] = [
    ...(worstInput === null ? [] : [INPUT_RUNG[worstInput]]),
    ...(worstParameter === null ? [] : [PARAMETER_RUNG[worstParameter]]),
  ];
  return executionProvenanceSchema.parse({
    inputs,
    parameters: sortedParameters,
    worst_input_source_type: worstInput,
    worst_parameter_grade: worstParameter,
    execution_grade: worstExecutionGrade(rungs),
  });
}
