import { describe, expect, it } from "vitest";

import {
  accountFor,
  blockReasonFor,
  digestCountsFor,
  OBSERVATION_BLOCK_REASONS,
  projectObservations,
  provenanceFor,
  REQUIRED_BINDING_FIELDS,
  type AcquiredObservation,
} from "./observation-projection.ts";

const DIGEST = "a".repeat(64);

function observation(overrides: Partial<AcquiredObservation> = {}): AcquiredObservation {
  return Object.freeze({
    observation_id: "ACQOBS:WAVE1:0001",
    official_url: "https://example.invalid/a.pdf",
    final_url: null,
    declared_media_type: "application/pdf",
    media_validation_passed: true,
    byte_count: 1_024,
    raw_artifact_sha256: DIGEST,
    normalized_text_sha256: null,
    manifest_sha256: null,
    parser_version: null,
    normalizer_version: null,
    source_version_id: "IL_SYNTHETIC@v1",
    retrieved_at: "2026-01-02T03:04:05.000Z",
    http_status: 200,
    redirect_chain: null,
    ...overrides,
  });
}

const complete = (overrides: Partial<AcquiredObservation> = {}) => observation({
  normalized_text_sha256: "b".repeat(64),
  manifest_sha256: "c".repeat(64),
  parser_version: "synthetic-parser-v1",
  normalizer_version: "synthetic-normalizer-v1",
  ...overrides,
});

describe("Wave 1 observation projection", () => {
  it("blocks an acquired but unparsed observation and names every missing field", () => {
    const [row] = projectObservations([observation()]);
    expect(row?.disposition).toBe("blocked");
    expect(row?.reason_code).toBe("BYTES_PRESENT_NOT_PARSED");
    expect([...(row?.missing_binding_fields ?? [])]).toEqual([
      "normalized_text_sha256", "manifest_sha256", "parser_version", "normalizer_version",
    ]);
  });

  it("projects only an observation whose binding is genuinely complete", () => {
    const [row] = projectObservations([complete()]);
    expect(row?.disposition).toBe("projected");
    expect(row?.reason_code).toBeNull();
    expect(row?.missing_binding_fields).toEqual([]);
    // Every required field is checked, so a future field cannot be forgotten.
    for (const field of REQUIRED_BINDING_FIELDS) {
      const [missing] = projectObservations([complete({ [field]: null } as never)]);
      expect(missing?.disposition, field).toBe("blocked");
    }
  });

  it("treats an empty string as absent rather than as a value", () => {
    const [row] = projectObservations([complete({ parser_version: "   " })]);
    expect(row?.disposition).toBe("blocked");
    expect([...(row?.missing_binding_fields ?? [])]).toContain("parser_version");
  });

  it("separates no bytes, rejected media and duplicate bytes", () => {
    const counts = digestCountsFor([observation(), observation({ observation_id: "b" })]);
    expect(blockReasonFor(observation({ raw_artifact_sha256: null }), counts)).toBe("RETRIEVAL_FAILED_NO_BYTES");
    expect(blockReasonFor(observation({ byte_count: 0 }), counts)).toBe("RETRIEVAL_FAILED_NO_BYTES");
    expect(blockReasonFor(observation({ media_validation_passed: false }), counts)).toBe("BYTES_REJECTED_MEDIA");
    expect(blockReasonFor(observation(), counts)).toBe("BYTES_REJECTED_DUPLICATE");
    expect(blockReasonFor(observation({ raw_artifact_sha256: "d".repeat(64) }), counts))
      .toBe("BYTES_PRESENT_NOT_PARSED");
  });

  it("only ever produces a declared reason code", () => {
    const rows = projectObservations([
      observation(), observation({ observation_id: "b", raw_artifact_sha256: null }),
      observation({ observation_id: "c", media_validation_passed: false }),
    ]);
    for (const row of rows) {
      if (row.reason_code === null) continue;
      expect(OBSERVATION_BLOCK_REASONS as readonly string[]).toContain(row.reason_code);
    }
  });

  it("carries only provenance that exists and never a placeholder", () => {
    const sparse = provenanceFor(observation({
      official_url: null, final_url: "", declared_media_type: null,
      retrieved_at: null, http_status: null, raw_artifact_sha256: null, byte_count: null,
    }));
    expect(sparse).toEqual({});
    const full = provenanceFor(observation({ redirect_chain: ["https://example.invalid/a"] }));
    expect(full).toMatchObject({
      source_url: "https://example.invalid/a.pdf",
      media_type: "application/pdf",
      http_status: 200,
      raw_artifact_sha256: DIGEST,
      byte_count: 1_024,
      redirect_chain: ["https://example.invalid/a"],
    });
    expect(Object.values(full)).not.toContain("");
    expect(Object.values(full)).not.toContain(null);
  });

  it("uses the observation id as the idempotency key on both sides", () => {
    const rows = projectObservations([observation(), complete({ observation_id: "ACQOBS:WAVE1:0002" })]);
    expect(rows.map((row) => row.idempotency_key)).toEqual(["ACQOBS:WAVE1:0001", "ACQOBS:WAVE1:0002"]);
  });

  it("balances accounted = projected + blocked against the denominator", () => {
    const rows = projectObservations([
      observation(), observation({ observation_id: "b", raw_artifact_sha256: "e".repeat(64) }),
      complete({ observation_id: "c", raw_artifact_sha256: "f".repeat(64) }),
    ]);
    const accounting = accountFor(rows, 3);
    expect(accounting).toMatchObject({ denominator: 3, projected: 1, blocked: 2, accounted: 3, balanced: true });
    expect(accounting.duplicate_ids).toEqual([]);
  });

  it("refuses to balance when a denominator, a count or an identity disagrees", () => {
    const rows = projectObservations([observation(), observation({ observation_id: "b" })]);
    expect(accountFor(rows, 3).balanced).toBe(false);
    const duplicated = projectObservations([observation(), observation()]);
    const accounting = accountFor(duplicated, 2);
    expect(accounting.balanced).toBe(false);
    expect(accounting.duplicate_ids).toEqual(["ACQOBS:WAVE1:0001"]);
  });
});
