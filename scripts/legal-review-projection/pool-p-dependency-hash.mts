// Addendum 7 A7-2. The pure formula, in its own module with no top-level
// file reads or network access, so pool-p-dependency-hash.test.mjs can
// import it directly under vitest without needing eval/legal-knowledge/'s
// generated (git-ignored) manifests on disk. pool-p-parameter-import.mts
// re-exports everything here and is the only module that resolves real
// dimension values from those manifests before calling this formula.
import { legalOperationsSha256 } from "../../src/engine/legal-operations/canonical.ts";
import { dependencyBindingsSchema, type DependencyBindings } from "../../src/engine/legal-operations/contracts.ts";
import type { Wave3Topic } from "../../src/engine/wave3/contracts.ts";

export function sentinel(kind: "rule_spec" | "golden_cases" | "reviewer_decisions", topic: Wave3Topic) {
  return legalOperationsSha256({ pool_p_unassigned: true, kind, topic });
}

// Every argument is one of the eleven dimensions the tracker's invalidation
// rule names (§7.3): artifact SHA-256, parsed version hash, parser
// version, normalizer version, exact citation locator, value, unit,
// effective interval, sector, population, dossier SHA-256, source-set
// hash. sourceSet + each entry of sources together cover dims 1-3 and 11;
// the rest are one dimension each.
export type ElevenDimensionInput = Readonly<{
  topic: Wave3Topic;
  sourceSet: readonly string[]; // dim 11
  sources: readonly Readonly<{
    source_id: string; source_version: string;
    artifact_sha256: string; // dim 1
    parsed_version_id: string; // dim 2
    parser_version: string; normalizer_version: string; // dim 3
  }>[];
  citations: readonly Readonly<{ source_id: string; source_version: string; chunk_id: string; locator: string }>[]; // dim 4
  dossierSha256: string; // dim 10
  value: unknown; unit: string; // dims 5, 6
  effective_from: string; effective_to: string | null; // dim 7
  sectors: readonly string[]; populations: readonly string[]; // dims 8, 9
  parameter_id: string;
  parameter_version: string;
  rounding_policy: string;
}>;

export function computeElevenDimensionBindings(input: ElevenDimensionInput): DependencyBindings {
  return dependencyBindingsSchema.parse({
    source_bytes_sha256: legalOperationsSha256({ source_set: input.sourceSet, sources: input.sources }),
    citations_sha256: legalOperationsSha256({ citations: input.citations, dossier_sha256: input.dossierSha256 }),
    interval_sha256: legalOperationsSha256({ effective_from: input.effective_from, effective_to: input.effective_to }),
    scope_sha256: legalOperationsSha256({ sectors: input.sectors, populations: input.populations }),
    parameter_set_sha256: legalOperationsSha256({
      parameter_id: input.parameter_id, parameter_version: input.parameter_version,
      value: input.value, unit: input.unit, rounding_policy: input.rounding_policy,
    }),
    rule_spec_sha256: sentinel("rule_spec", input.topic),
    golden_cases_sha256: sentinel("golden_cases", input.topic),
    reviewer_decisions_sha256: sentinel("reviewer_decisions", input.topic),
  });
}
