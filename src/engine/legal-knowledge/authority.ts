import type { LegalAuthority, LegalSource } from "./contracts.ts";
import type { LegalSector } from "./taxonomy.ts";

const bindingRank: Readonly<Record<LegalAuthority["binding_level"], number>> = {
  primary_binding: 4,
  official_implementation: 3,
  official_guidance: 2,
  secondary_explanatory: 1,
};

export function authorityPrecedence(authority: LegalAuthority, sector: LegalSector) {
  return {
    binding_level: bindingRank[authority.binding_level],
    sector_specificity: authority.scope === "sector_specific" && sector !== "general" ? 2 : authority.scope === "general" ? 1 : 0,
    operative: authority.operative ? 1 : 0,
    official: authority.kind === "secondary_professional_source" ? 0 : 1,
  } as const;
}

export function compareSourceAuthority(left: LegalSource, right: LegalSource, sector: LegalSector) {
  const leftRank = authorityPrecedence(left.authority, sector);
  const rightRank = authorityPrecedence(right.authority, sector);
  for (const key of ["binding_level", "sector_specificity", "operative", "official"] as const) {
    const difference = rightRank[key] - leftRank[key];
    if (difference !== 0) return difference;
  }
  return left.source_id.localeCompare(right.source_id);
}

/**
 * The authority half of the monetary rule, independent of source lifecycle.
 * Review workflows need it before anything is active, so it is shared rather
 * than restated: secondary explanatory material never qualifies.
 */
export function authorityCanIndependentlySupportMonetaryRule(authority: LegalAuthority) {
  return authority.can_independently_support_monetary_rule &&
    authority.binding_level !== "secondary_explanatory" &&
    authority.operative;
}

export function canSourceIndependentlySupportMonetaryRule(source: LegalSource) {
  return source.status === "active" && authorityCanIndependentlySupportMonetaryRule(source.authority);
}

export function validateMonetaryAuthoritySet(sources: readonly LegalSource[]) {
  const issues: string[] = [];
  if (sources.length === 0) issues.push("monetary_rule_source_required");
  if (!sources.some(canSourceIndependentlySupportMonetaryRule)) issues.push("primary_or_official_operative_source_required");
  if (sources.every((source) => source.authority.binding_level === "secondary_explanatory")) {
    issues.push("secondary_source_cannot_be_sole_monetary_authority");
  }
  return { passed: issues.length === 0, issues };
}
