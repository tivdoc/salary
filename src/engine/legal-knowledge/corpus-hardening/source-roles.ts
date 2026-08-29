import { z } from "zod";
import type { LegalSource } from "../contracts.ts";

/**
 * A derived safety classification over the canonical LegalSource contract.
 * It does not replace binding_level or source status and cannot activate a source.
 */
export const corpusArtifactRoleSchema = z.enum([
  "binding_operative_instrument_version",
  "official_implementation_or_corroboration",
  "official_guidance",
  "secondary_explanatory_material",
  "acquisition_only_staged_artifact",
]);

export const corpusRoleAssignmentSchema = z.object({
  source_version_id: z.string().min(3),
  artifact_id: z.string().min(3).nullable(),
  role: corpusArtifactRoleSchema,
  lifecycle: z.enum(["registered_candidate", "acquisition_only_staged"]),
  eligible_for_operative_resolution: z.boolean(),
  eligible_to_independently_support_monetary_parameter: z.boolean(),
  reason_codes: z.array(z.string().min(1)).min(1).readonly(),
}).strict().superRefine((assignment, context) => {
  const binding = assignment.role === "binding_operative_instrument_version";
  if (assignment.eligible_for_operative_resolution !== (binding && assignment.lifecycle === "registered_candidate")) {
    context.addIssue({ code: "custom", message: "operative_resolution_role_mismatch" });
  }
  if (assignment.eligible_to_independently_support_monetary_parameter && !(binding && assignment.lifecycle === "registered_candidate")) {
    context.addIssue({ code: "custom", message: "monetary_support_role_mismatch" });
  }
  if (assignment.lifecycle === "acquisition_only_staged" && assignment.role !== "acquisition_only_staged_artifact") {
    context.addIssue({ code: "custom", message: "staged_lifecycle_requires_staged_role" });
  }
}).readonly();

export type CorpusRoleAssignment = z.infer<typeof corpusRoleAssignmentSchema>;

function sourceVersionId(source: Pick<LegalSource, "source_id" | "source_version">) {
  return `${source.source_id}@${source.source_version}`;
}

export function classifyRegisteredSourceRole(source: LegalSource): CorpusRoleAssignment {
  const role = source.authority.binding_level === "primary_binding" && source.authority.operative
    ? "binding_operative_instrument_version" as const
    : source.authority.binding_level === "official_implementation"
      ? "official_implementation_or_corroboration" as const
      : source.authority.binding_level === "official_guidance"
        ? "official_guidance" as const
        : "secondary_explanatory_material" as const;
  const binding = role === "binding_operative_instrument_version";
  return corpusRoleAssignmentSchema.parse({
    source_version_id: sourceVersionId(source),
    artifact_id: source.content_sha256 ? `artifact:${source.source_id}:${source.content_sha256}` : null,
    role,
    lifecycle: "registered_candidate",
    eligible_for_operative_resolution: binding,
    eligible_to_independently_support_monetary_parameter: binding && source.authority.can_independently_support_monetary_rule,
    reason_codes: binding
      ? ["canonical_primary_binding_and_operative_classification_only"]
      : role === "official_implementation_or_corroboration"
        ? ["official_implementation_is_corroborative_only"]
        : role === "official_guidance"
          ? ["official_guidance_is_non_operative"]
          : ["secondary_material_is_explanatory_only"],
  });
}

export function classifyStagedArtifact(input: Readonly<{
  sourceVersionId: string;
  artifactId: string;
}>): CorpusRoleAssignment {
  return corpusRoleAssignmentSchema.parse({
    source_version_id: input.sourceVersionId,
    artifact_id: input.artifactId,
    role: "acquisition_only_staged_artifact",
    lifecycle: "acquisition_only_staged",
    eligible_for_operative_resolution: false,
    eligible_to_independently_support_monetary_parameter: false,
    reason_codes: ["bytes_acquired_but_not_a_registered_corpus_version"],
  });
}

export function selectOperativeResolutionCandidates(assignments: readonly CorpusRoleAssignment[]) {
  return assignments
    .map((assignment) => corpusRoleAssignmentSchema.parse(assignment))
    .filter((assignment) => assignment.eligible_for_operative_resolution)
    .sort((left, right) => left.source_version_id.localeCompare(right.source_version_id));
}

export function proveKnownNonOperativeRoles(sources: readonly LegalSource[]) {
  const byId = new Map(sources.map((source) => [source.source_id, source]));
  const research = byId.get("IL_CONVALESCENCE_KNESSET_RESEARCH_2025");
  const rates = byId.get("IL_MIN_WAGE_OFFICIAL_RATES");
  if (!research) throw new Error("knesset_research_source_missing");
  if (!rates) throw new Error("btl_rates_source_missing");
  const researchAssignment = classifyRegisteredSourceRole(research);
  const ratesAssignment = classifyRegisteredSourceRole(rates);
  if (researchAssignment.role !== "secondary_explanatory_material") throw new Error("knesset_research_role_not_secondary");
  if (ratesAssignment.role !== "official_implementation_or_corroboration") throw new Error("btl_rates_role_not_corroborative");
  const operativeIds = selectOperativeResolutionCandidates([researchAssignment, ratesAssignment]).map((entry) => entry.source_version_id);
  return Object.freeze({
    knesset_research: researchAssignment,
    btl_rates: ratesAssignment,
    operative_candidate_ids: operativeIds,
    assertions: Object.freeze({
      knesset_research_excluded_from_operative_candidates: !operativeIds.includes(researchAssignment.source_version_id),
      btl_rates_cannot_independently_support_monetary_parameter: !ratesAssignment.eligible_to_independently_support_monetary_parameter,
    }),
  });
}
