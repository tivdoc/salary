export type LegalSourceObservation = Readonly<{
  artifact_sha256: string;
  normalized_text_sha256: string | null;
  final_url: string;
  content_type: string;
  effective_metadata_hash: string;
  source_status?: "draft" | "fetched" | "parsed" | "candidate" | "verified" | "reviewed" | "active" | "superseded" | "needs_review" | "rejected" | "unavailable";
}>;

export type StoredLegalFetchObservation = Readonly<{
  source_id: string;
  source_version: string;
  artifact_sha256: string;
  status: "fetched" | "content_change_review_required";
}>;

export function selectLegalSourceObservation<T extends StoredLegalFetchObservation>(
  observations: readonly T[],
  source: Readonly<{ source_id: string; source_version: string; content_sha256: string | null }>,
) {
  const matching = [...observations].reverse().filter((entry) => entry.source_id === source.source_id && entry.source_version === source.source_version);
  if (source.content_sha256) {
    return matching.find((entry) => entry.artifact_sha256 === source.content_sha256 && entry.status === "fetched")
      ?? matching.find((entry) => entry.artifact_sha256 === source.content_sha256)
      ?? null;
  }
  return matching.find((entry) => entry.status === "fetched") ?? null;
}

export function detectLegalSourceChange(
  previous: LegalSourceObservation | null,
  current: LegalSourceObservation | null,
) {
  if (!current) return { status: "url_unavailable" as const, reviewRequired: true, changes: ["source_unavailable"] };
  if (current.source_status === "superseded") {
    return { status: "source_version_superseded" as const, reviewRequired: false, changes: ["source_version_superseded"] };
  }
  if (!previous) return { status: "new_source_version_pending_review" as const, reviewRequired: true, changes: ["new_source"] };
  const changes: string[] = [];
  if (previous.final_url !== current.final_url) changes.push("redirect_changed");
  if (previous.artifact_sha256 !== current.artifact_sha256) changes.push("bytes_changed");
  if (previous.normalized_text_sha256 && current.normalized_text_sha256 && previous.normalized_text_sha256 !== current.normalized_text_sha256) {
    changes.push("normalized_text_changed");
  }
  if (previous.content_type !== current.content_type) changes.push("content_type_changed");
  if (previous.effective_metadata_hash !== current.effective_metadata_hash) changes.push("metadata_or_effective_date_changed");
  if (changes.length === 0) return { status: "source_unchanged" as const, reviewRequired: false, changes };
  return { status: "new_source_version_pending_review" as const, reviewRequired: true, changes };
}
