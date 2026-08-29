export const PERMIT_8753_ALLOWED_STATUSES = [
  "generated_url_error",
  "stale_official_catalog_link",
  "official_replacement_found",
  "unavailable_pending_owner_handoff",
] as const;

export type Permit8753Status = typeof PERMIT_8753_ALLOWED_STATUSES[number];

export function classifyPermit8753(input: Readonly<{
  stableId: string;
  exactCatalogUrl: string;
  exactOfficialArtifactUrl: string;
  liveHttpStatus: number | null;
  catalogUrlWasGenerated: boolean;
  explicitOfficialReplacementUrl: string | null;
  explicitOfficialReplacementEvidence: string | null;
}>) {
  let status: Permit8753Status;
  if (input.catalogUrlWasGenerated) status = "generated_url_error";
  else if (input.explicitOfficialReplacementUrl && input.explicitOfficialReplacementEvidence) status = "official_replacement_found";
  else if (input.liveHttpStatus === 404) status = "stale_official_catalog_link";
  else status = "unavailable_pending_owner_handoff";
  return Object.freeze({
    schema_version: "permit-8753-official-catalog-diagnostic-v0.4" as const,
    stable_id_exact: input.stableId,
    catalog_url_exact: input.exactCatalogUrl,
    official_artifact_url_exact: input.exactOfficialArtifactUrl,
    live_http_status: input.liveHttpStatus,
    status,
    bypass_attempted: false as const,
    unofficial_substitution_used: false as const,
    replacement_claimed: status === "official_replacement_found",
    reason_codes: status === "stale_official_catalog_link"
      ? ["exact_url_was_observed_in_official_catalog_snapshot", "exact_official_catalog_url_now_returns_404", "no_explicit_official_replacement_relation_verified"]
      : status === "generated_url_error"
        ? ["url_not_copied_from_official_catalog"]
        : status === "official_replacement_found"
          ? ["explicit_official_replacement_evidence_present"]
          : ["artifact_not_available_and_no_verified_replacement"],
  });
}
