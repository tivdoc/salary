// Addendum 7 A7-2. One test per dimension: changing exactly one of the
// eleven the tracker's invalidation rule names (§7.3) — and nothing else —
// must change the resulting bindings_sha256 (the hash of the whole
// bindings object; this is the hash governance_parameter_attestation_append
// actually compares against a candidate's stored value). Pure and offline:
// no DEV connection, no file reads — see pool-p-dependency-hash.mts.
import { describe, expect, it } from "vitest";
import { legalOperationsSha256 } from "../../src/engine/legal-operations/canonical.ts";
import { computeElevenDimensionBindings } from "./pool-p-dependency-hash.mts";

// The same function the DB port and every candidate builder use — not a
// reimplementation, so this test can't drift from what actually gets
// compared as GOVERNANCE_PARAMETER_ATTESTATION_BINDING_MISMATCH.
function bindingsSha256(bindings) {
  return legalOperationsSha256(bindings);
}

const BASE = Object.freeze({
  topic: "minimum_wage",
  sourceSet: ["IL_MIN_WAGE_LAW@discovery-v0", "IL_AVERAGE_WAGE_OFFICIAL_RATES@discovery-v0"],
  sources: [
    { source_id: "IL_MIN_WAGE_LAW", source_version: "discovery-v0", artifact_sha256: "a".repeat(64), parsed_version_id: "IL_MIN_WAGE_LAW@discovery-v0#parsed-1", parser_version: "pypdf-layout-v1", normalizer_version: "legal-normalizer-v0" },
    { source_id: "IL_AVERAGE_WAGE_OFFICIAL_RATES", source_version: "discovery-v0", artifact_sha256: "b".repeat(64), parsed_version_id: "IL_AVERAGE_WAGE_OFFICIAL_RATES@discovery-v0#parsed-1", parser_version: "html-v1", normalizer_version: "legal-normalizer-v0" },
  ],
  citations: [
    { source_id: "IL_MIN_WAGE_LAW", source_version: "discovery-v0", chunk_id: "chunk-1", locator: "§6 derivation" },
    { source_id: "IL_AVERAGE_WAGE_OFFICIAL_RATES", source_version: "discovery-v0", chunk_id: "chunk-2", locator: "average wage table row" },
  ],
  dossierSha256: "6ad2caa0995b67e42dc85bc6bb8690b0901f8679ffeb2440713964813c806422",
  value: { kind: "money", value: { currency: "ILS", minor_units: 644385 } },
  unit: "currency.ils",
  effective_from: "2026-04-01",
  effective_to: null,
  sectors: ["general"],
  populations: ["general"],
  parameter_id: "il.minimum_wage.monthly",
  parameter_version: "2026.1.0",
  rounding_policy: "exact",
});

function hashOf(overrides) {
  return bindingsSha256(computeElevenDimensionBindings({ ...BASE, ...overrides }));
}

describe("Addendum 7 A7-2: dependency-hash formula covers all eleven dimensions", () => {
  const baseline = hashOf({});

  it("is deterministic — the same eleven dimensions hash the same way twice", () => {
    expect(hashOf({})).toBe(baseline);
  });

  it("dim 1 — artifact SHA-256: a byte change in a cited source moves the hash", () => {
    const sources = BASE.sources.map((s, i) => (i === 0 ? { ...s, artifact_sha256: "c".repeat(64) } : s));
    expect(hashOf({ sources })).not.toBe(baseline);
  });

  it("dim 2 — parsed version hash: a re-parse of the same bytes moves the hash", () => {
    const sources = BASE.sources.map((s, i) => (i === 0 ? { ...s, parsed_version_id: "IL_MIN_WAGE_LAW@discovery-v0#parsed-2" } : s));
    expect(hashOf({ sources })).not.toBe(baseline);
  });

  it("dim 3 — parser version: an upgraded extractor moves the hash", () => {
    const sources = BASE.sources.map((s, i) => (i === 0 ? { ...s, parser_version: "pypdf-layout-v2" } : s));
    expect(hashOf({ sources })).not.toBe(baseline);
  });

  it("dim 3 — normalizer version: an upgraded normalizer moves the hash", () => {
    const sources = BASE.sources.map((s, i) => (i === 0 ? { ...s, normalizer_version: "legal-normalizer-v1" } : s));
    expect(hashOf({ sources })).not.toBe(baseline);
  });

  it("dim 4 — exact citation locator: a different chunk or wording moves the hash", () => {
    const citations = BASE.citations.map((c, i) => (i === 0 ? { ...c, locator: "§6 derivation, revised wording" } : c));
    expect(hashOf({ citations })).not.toBe(baseline);
  });

  it("dim 5 — value: a different numeric value moves the hash", () => {
    expect(hashOf({ value: { kind: "money", value: { currency: "ILS", minor_units: 1 } } })).not.toBe(baseline);
  });

  it("dim 6 — unit: a different unit moves the hash", () => {
    expect(hashOf({ unit: "currency.usd" })).not.toBe(baseline);
  });

  it("dim 7 — effective interval: a different effective_from moves the hash", () => {
    expect(hashOf({ effective_from: "2025-04-01" })).not.toBe(baseline);
  });

  it("dim 8 — sector: a different sector list moves the hash", () => {
    expect(hashOf({ sectors: ["public"] })).not.toBe(baseline);
  });

  it("dim 9 — population: a different population list moves the hash", () => {
    expect(hashOf({ populations: ["youth_16_17"] })).not.toBe(baseline);
  });

  it("L12-1 / D1 (R-8) — a derived parameter's assumption: the derivation digest moves the hash, and its absence leaves every earlier hash alone", () => {
    expect(hashOf({ derivation_sha256: "e".repeat(64) })).not.toBe(baseline);
    expect(hashOf({ derivation_sha256: "f".repeat(64) })).not.toBe(hashOf({ derivation_sha256: "e".repeat(64) }));
    expect(hashOf({ derivation_sha256: undefined })).toBe(baseline);
  });

  it("dim 10 — dossier SHA-256: a revised research dossier moves the hash", () => {
    expect(hashOf({ dossierSha256: "d".repeat(64) })).not.toBe(baseline);
  });

  it("dim 11 — source-set hash: adding a citation without changing any existing one's bytes moves the hash", () => {
    const extraSource = { source_id: "IL_MIN_WAGE_LAW", source_version: "discovery-v0.2", artifact_sha256: "a".repeat(64), parsed_version_id: "x", parser_version: "x", normalizer_version: "x" };
    const extraCitation = { source_id: "IL_MIN_WAGE_LAW", source_version: "discovery-v0.2", chunk_id: "chunk-3", locator: "extra" };
    expect(hashOf({
      sourceSet: [...BASE.sourceSet, "IL_MIN_WAGE_LAW@discovery-v0.2"],
      sources: [...BASE.sources, extraSource],
      citations: [...BASE.citations, extraCitation],
    })).not.toBe(baseline);
  });

  it("rule_spec/golden_cases/reviewer_decisions stay deterministic sentinels, not real hashes, until Pool Q and attestation exist", () => {
    const bindings = computeElevenDimensionBindings(BASE);
    expect(bindings.rule_spec_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(bindings.rule_spec_sha256).toBe(computeElevenDimensionBindings(BASE).rule_spec_sha256);
    expect(bindings.rule_spec_sha256).not.toBe(bindings.golden_cases_sha256);
    expect(bindings.golden_cases_sha256).not.toBe(bindings.reviewer_decisions_sha256);
  });
});
