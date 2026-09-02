// Wave 1. Classifies each acquired observation into the one place it belongs:
// a review packet, or a blocked record with a reason.
//
// An observation that was acquired but never parsed has no normalized text, no
// manifest, no parser and no normalizer version. There is nothing for a
// reviewer to read, so it is not a review packet and must never become one.
// Supplying those fields to satisfy the enqueue validation would be fabricated
// evidence, so this module never invents one: an absent field stays absent and
// becomes a reason code instead.

export const OBSERVATION_PROJECTION_SCHEMA = "tivdoc-observation-projection-wave1" as const;

/** The closed set the durable store accepts. */
export const OBSERVATION_BLOCK_REASONS = Object.freeze([
  "BYTES_PRESENT_NOT_PARSED",
  "BYTES_REJECTED_MEDIA",
  "BYTES_REJECTED_ENCODING",
  "BYTES_REJECTED_DUPLICATE",
  "BYTES_REJECTED_EMPTY_NORMALIZED_TEXT",
  "RETRIEVAL_FAILED_NO_BYTES",
] as const);

export type ObservationBlockReason = (typeof OBSERVATION_BLOCK_REASONS)[number];

/** Binding fields `packet_enqueue` requires before a packet may exist. */
export const REQUIRED_BINDING_FIELDS = Object.freeze([
  "raw_artifact_sha256",
  "normalized_text_sha256",
  "manifest_sha256",
  "parser_version",
  "normalizer_version",
  "source_version_id",
] as const);

export type AcquiredObservation = Readonly<{
  observation_id: string;
  official_url: string | null;
  final_url: string | null;
  declared_media_type: string | null;
  media_validation_passed: boolean | null;
  byte_count: number | null;
  raw_artifact_sha256: string | null;
  normalized_text_sha256: string | null;
  manifest_sha256: string | null;
  parser_version: string | null;
  normalizer_version: string | null;
  source_version_id: string | null;
  retrieved_at: string | null;
  http_status: number | null;
  redirect_chain: readonly string[] | null;
}>;

export type ObservationDisposition = Readonly<{
  observation_id: string;
  disposition: "projected" | "blocked";
  reason_code: ObservationBlockReason | null;
  missing_binding_fields: readonly string[];
  idempotency_key: string;
  provenance: Readonly<Record<string, unknown>>;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;

function present(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The reason an observation cannot become a packet. Duplicate bytes are decided
 * against the whole population, so the caller supplies the digest counts.
 */
export function blockReasonFor(
  observation: AcquiredObservation,
  digestCounts: ReadonlyMap<string, number>,
): ObservationBlockReason | null {
  const hasBytes = SHA256.test(observation.raw_artifact_sha256 ?? "")
    && typeof observation.byte_count === "number" && observation.byte_count > 0;
  if (!hasBytes) return "RETRIEVAL_FAILED_NO_BYTES";
  if (observation.media_validation_passed === false) return "BYTES_REJECTED_MEDIA";
  if ((digestCounts.get(observation.raw_artifact_sha256 as string) ?? 0) > 1) return "BYTES_REJECTED_DUPLICATE";
  if (present(observation.normalized_text_sha256) && observation.normalized_text_sha256?.trim() === "") {
    return "BYTES_REJECTED_EMPTY_NORMALIZED_TEXT";
  }
  return "BYTES_PRESENT_NOT_PARSED";
}

export function digestCountsFor(observations: readonly AcquiredObservation[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const observation of observations) {
    const digest = observation.raw_artifact_sha256;
    if (SHA256.test(digest ?? "")) counts.set(digest as string, (counts.get(digest as string) ?? 0) + 1);
  }
  return counts;
}

/** Provenance that genuinely exists. Anything absent stays absent. */
export function provenanceFor(observation: AcquiredObservation): Readonly<Record<string, unknown>> {
  const provenance: Record<string, unknown> = {};
  if (present(observation.official_url)) provenance.source_url = observation.official_url;
  if (present(observation.final_url)) provenance.final_url = observation.final_url;
  if (present(observation.declared_media_type)) provenance.media_type = observation.declared_media_type;
  if (present(observation.retrieved_at)) provenance.retrieved_at = observation.retrieved_at;
  if (typeof observation.http_status === "number") provenance.http_status = observation.http_status;
  if (Array.isArray(observation.redirect_chain)) provenance.redirect_chain = observation.redirect_chain;
  if (SHA256.test(observation.raw_artifact_sha256 ?? "")) provenance.raw_artifact_sha256 = observation.raw_artifact_sha256;
  if (typeof observation.byte_count === "number") provenance.byte_count = observation.byte_count;
  return Object.freeze(provenance);
}

/**
 * One disposition per observation, and exactly one. The observation id is the
 * idempotency key on both sides, so a replay reaches the same row.
 */
export function projectObservations(
  observations: readonly AcquiredObservation[],
): readonly ObservationDisposition[] {
  const counts = digestCountsFor(observations);
  return Object.freeze(observations.map((observation) => {
    const missing = REQUIRED_BINDING_FIELDS.filter((field) => !present(observation[field]));
    const projected = missing.length === 0;
    return Object.freeze({
      observation_id: observation.observation_id,
      disposition: projected ? "projected" as const : "blocked" as const,
      reason_code: projected ? null : blockReasonFor(observation, counts),
      missing_binding_fields: Object.freeze(missing),
      idempotency_key: observation.observation_id,
      provenance: provenanceFor(observation),
    });
  }));
}

export type ProjectionAccounting = Readonly<{
  denominator: number;
  projected: number;
  blocked: number;
  accounted: number;
  balanced: boolean;
  duplicate_ids: readonly string[];
  reason_histogram: Readonly<Record<string, number>>;
}>;

/**
 * `accounted = projected + blocked` is the invariant, and it is only true when
 * every observation appears exactly once. A duplicate id would let a row be
 * counted on both sides, so it is reported rather than absorbed.
 */
export function accountFor(
  dispositions: readonly ObservationDisposition[],
  denominator: number,
): ProjectionAccounting {
  const seen = new Map<string, number>();
  for (const row of dispositions) seen.set(row.observation_id, (seen.get(row.observation_id) ?? 0) + 1);
  const projected = dispositions.filter((row) => row.disposition === "projected").length;
  const blocked = dispositions.filter((row) => row.disposition === "blocked").length;
  const histogram: Record<string, number> = {};
  for (const row of dispositions) {
    if (row.reason_code === null) continue;
    histogram[row.reason_code] = (histogram[row.reason_code] ?? 0) + 1;
  }
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort();
  return Object.freeze({
    denominator,
    projected,
    blocked,
    accounted: projected + blocked,
    balanced: projected + blocked === denominator
      && dispositions.length === denominator
      && duplicates.length === 0,
    duplicate_ids: Object.freeze(duplicates),
    reason_histogram: Object.freeze(histogram),
  });
}
