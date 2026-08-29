import type { LegalParameter, LegalSource } from "./contracts.ts";
import { canSourceIndependentlySupportMonetaryRule } from "./authority.ts";

export function canConsumeLegalParameter(parameter: LegalParameter, source: LegalSource | undefined) {
  const issues: string[] = [];
  if (parameter.verification_status !== "active") issues.push("parameter_not_active");
  if (parameter.verified_by.length < 2) issues.push("parameter_dual_verification_required");
  if (!source) issues.push("parameter_source_missing");
  else if (!canSourceIndependentlySupportMonetaryRule(source)) issues.push("parameter_source_not_eligible");
  if (source && (source.source_id !== parameter.source_id || source.source_version !== parameter.source_version)) {
    issues.push("parameter_source_version_mismatch");
  }
  return { passed: issues.length === 0, issues };
}
