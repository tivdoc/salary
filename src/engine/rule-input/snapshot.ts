import type { EmploymentSnapshot } from "../facts/snapshot.ts";
import type { Wave3Topic } from "../wave3/contracts.ts";
import { employmentSnapshotSchema } from "../facts/snapshot.ts";
import {
  canonicalSha256,
  canonicalStringify,
  deepFreeze,
} from "../rule-runtime/canonical.ts";
import {
  ruleInputSnapshotSchema,
  type RuleInputSnapshot,
} from "../wave1/contracts.ts";

export interface CanonicalRuleInputSnapshot {
  readonly reference: RuleInputSnapshot;
  readonly canonical_snapshot: EmploymentSnapshot;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Canonicalizes only order-insensitive collections from the existing fact
 * schema. It does not alter values, statuses, timestamps, or provenance.
 */
function normalizeEmploymentSnapshot(candidate: EmploymentSnapshot): EmploymentSnapshot {
  const parsed = employmentSnapshotSchema.parse(candidate);
  const facts = parsed.facts
    .map((fact) => ({
      ...fact,
      provenance: [...fact.provenance].sort((left, right) =>
        compareStrings(canonicalStringify(left), canonicalStringify(right)),
      ),
      conflicting_fact_ids: [...fact.conflicting_fact_ids].sort(compareStrings),
      resolution:
        fact.resolution === null
          ? null
          : {
              ...fact.resolution,
              selected_fact_ids: [...fact.resolution.selected_fact_ids].sort(compareStrings),
            },
    }))
    .sort((left, right) =>
      compareStrings(`${left.path}\u0000${left.fact_id}`, `${right.path}\u0000${right.fact_id}`),
    );

  return employmentSnapshotSchema.parse({ ...parsed, facts });
}

/**
 * Produces the frozen Wave 1/Wave 2 RuleInputSnapshot reference from the
 * canonical existing EmploymentSnapshot schema. All timestamps are supplied
 * data; this function never consults the clock or locale.
 */
export function createCanonicalRuleInputSnapshot(
  candidate: EmploymentSnapshot,
): CanonicalRuleInputSnapshot {
  const canonicalSnapshot = normalizeEmploymentSnapshot(candidate);
  const reference = ruleInputSnapshotSchema.parse({
    snapshot_id: canonicalSnapshot.snapshot_id,
    snapshot_version: `canonical-facts:${canonicalSnapshot.schema_version}`,
    snapshot_sha256: canonicalSha256(canonicalSnapshot),
  });

  return deepFreeze({
    reference,
    canonical_snapshot: canonicalSnapshot,
  });
}

/** The ordinary analysis and saved-context verifier share the exact topic pin.
 * This is the original projection recipe; historical references stay identical. */
export function createTopicRuleInputSnapshot(
  facts: EmploymentSnapshot,
  topic: Wave3Topic,
): RuleInputSnapshot {
  const canonical = createCanonicalRuleInputSnapshot(facts);
  return ruleInputSnapshotSchema.parse({
    snapshot_id: `rule-input:${facts.analysis_run_id}:${topic}`,
    snapshot_version: `${canonical.reference.snapshot_version}:${topic}`,
    snapshot_sha256: canonicalSha256({ topic, canonical_rule_input: canonical.reference }),
  });
}
