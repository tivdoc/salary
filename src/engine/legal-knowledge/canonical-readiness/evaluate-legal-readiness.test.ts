import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { READINESS_MUTATIONS, readinessDelegateMatrix, readinessMutationMatrix } from "../../wave23/corpus-trust/readiness-matrix.ts";
import { SYNTHETIC_READY_CANDIDATE, SYNTHETIC_READY_CASE } from "../../wave23/corpus-trust/synthetic-ready.fixture.ts";
import { auditCanonicalReadinessTopology, auditSyntheticReadyFixtureReachability } from "./canonical-topology.ts";
import { LEGAL_READINESS_CASES, LEGAL_READINESS_CASE_EXPECTATION } from "./case-registry.ts";
import { evaluateLegalReadiness, LEGAL_READINESS_REASON_CODES, type LegalReadinessCandidate } from "./evaluate-legal-readiness.ts";

const legacyBlocked: LegalReadinessCandidate = { source_version_id: "SYNTHETIC@v1", topics: ["minimum_wage"], parse_succeeded: true, citation_verified: false, operative_role_eligible: true, human_reviewed: false, effective_interval_verified: false, verified_sectors: [], verified_populations: [], active: false };

describe("sole canonical legal readiness", () => {
  it("retains fail-closed compatibility for the 28 frozen real registry cases", () => {
    expect(LEGAL_READINESS_CASES).toHaveLength(28);
    expect(LEGAL_READINESS_CASES.every((entry) => evaluateLegalReadiness({ readinessCase: entry, candidates: [] }).status === "BLOCKED_NOT_READY")).toBe(true);
    const candidates = LEGAL_READINESS_CASES.map((entry) => ({ ...legacyBlocked, source_version_id: `SYN_${entry.topic}@v1`, topics: [entry.topic] }));
    for (const readinessCase of LEGAL_READINESS_CASES) {
      const decision = evaluateLegalReadiness({ readinessCase, candidates });
      expect(decision.status).toBe(LEGAL_READINESS_CASE_EXPECTATION.status);
      expect(decision.reason_codes).toEqual(LEGAL_READINESS_CASE_EXPECTATION.reason_codes);
    }
  });

  it("passes one isolated synthetic READY case identically through all six delegates", () => {
    const matrix = readinessDelegateMatrix();
    expect(matrix.totals).toEqual({ delegate_count: 6, ready_count: 6, unique_decision_hash_count: 1 });
    expect(matrix.outputs.every((output) => output.decision.schema_version === "tivdoc-legal-readiness-decision-v0.5.0" && output.decision.decision_source === "evaluateLegalReadiness")).toBe(true);
    expect(matrix.fixture_controls).toMatchObject({ production_manifest_eligible: false, external_persistence_allowed: false, source_activation_allowed: false, product_exposure_allowed: false });
  });

  it("binds the complete normalized input independently of input and collection order", () => {
    const first = evaluateLegalReadiness({ readinessCase: SYNTHETIC_READY_CASE, candidates: [SYNTHETIC_READY_CANDIDATE] });
    const reordered = evaluateLegalReadiness({ readinessCase: { ...SYNTHETIC_READY_CASE }, candidates: [{ ...SYNTHETIC_READY_CANDIDATE, topics: [...SYNTHETIC_READY_CANDIDATE.topics].reverse(), verified_sectors: [...SYNTHETIC_READY_CANDIDATE.verified_sectors].reverse(), verified_populations: [...SYNTHETIC_READY_CANDIDATE.verified_populations].reverse() }] });
    expect(first.status).toBe("READY");
    expect(first.decision_sha256).toBe(reordered.decision_sha256);
    expect(first.normalized_input_sha256).toBe(reordered.normalized_input_sha256);
  });

  it("blocks every independent mutation with stable reasons and hashes", () => {
    const matrix = readinessMutationMatrix();
    expect(READINESS_MUTATIONS).toHaveLength(18);
    expect(matrix.passed).toBe(true);
    expect(matrix.totals).toEqual({ case_count: 18, passed_count: 18, required_reason_code_count: 11, covered_reason_code_count: 11 });
    expect(new Set(LEGAL_READINESS_REASON_CODES).size).toBe(11);
    expect(new Set(matrix.cases.map((entry) => entry.decision_sha256)).size).toBe(18);
  });

  it("rejects alternate evaluator definitions and runtime direct imports", () => {
    const source = readFileSync(resolve("src/engine/legal-knowledge/canonical-readiness/evaluate-legal-readiness.ts"), "utf8");
    const delegates = readFileSync(resolve("src/engine/legal-knowledge/canonical-readiness/delegates.ts"), "utf8");
    const valid = auditCanonicalReadinessTopology([
      { path: "src/engine/legal-knowledge/canonical-readiness/evaluate-legal-readiness.ts", content: source },
      { path: "src/engine/legal-knowledge/canonical-readiness/delegates.ts", content: delegates },
    ]);
    expect(valid.passed).toBe(true);
    const alternate = auditCanonicalReadinessTopology([
      { path: "src/engine/legal-knowledge/canonical-readiness/evaluate-legal-readiness.ts", content: source },
      { path: "src/engine/legal-knowledge/canonical-readiness/delegates.ts", content: delegates },
      { path: "src/server/alternate.ts", content: "import { evaluateLegalReadiness } from '../engine/legal-knowledge/canonical-readiness/evaluate-legal-readiness.ts'; export function evaluateLegalReadiness() {}" },
    ]);
    expect(alternate.passed).toBe(false);
    expect(alternate.violations).toContain("canonical_definition_count_or_path_invalid");
    expect(alternate.violations).toContain("forbidden_runtime_direct_import");
  });

  it("rejects transitive production reachability to the test-only READY fixture", () => {
    const files = [
      { path: "src/engine/wave23/corpus-trust/synthetic-ready.fixture.ts", content: "export const fixture = true" },
      { path: "src/engine/wave23/corpus-trust/readiness-matrix.ts", content: "import { fixture } from './synthetic-ready.fixture.ts'" },
      { path: "src/server/product.ts", content: "import { matrix } from '../engine/wave23/corpus-trust/readiness-matrix.ts'" },
    ];
    const guard = auditSyntheticReadyFixtureReachability(files);
    expect(guard.passed).toBe(false);
    expect(guard.test_fixture_production_reachable).toBe(true);
    expect(guard.production_reachability_paths).toEqual([["src/server/product.ts", "src/engine/wave23/corpus-trust/readiness-matrix.ts", "src/engine/wave23/corpus-trust/synthetic-ready.fixture.ts"]]);
  });
});
