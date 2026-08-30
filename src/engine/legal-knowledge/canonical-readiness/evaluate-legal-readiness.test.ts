import { describe, expect, it } from "vitest";
import { LEGAL_READINESS_CASES, LEGAL_READINESS_CASE_EXPECTATION } from "./case-registry.ts";
import {
  futureLegalActivationAdmission,
  futureLegalShadowAdmission,
  legalCorpusTopicGate,
  legalReadinessDiagnostic,
  legalReadinessStrict,
  legalServerResolverAdmission,
} from "./delegates.ts";
import { evaluateLegalReadiness, LEGAL_READINESS_REASON_CODES, type LegalReadinessCandidate } from "./evaluate-legal-readiness.ts";

const blocked: LegalReadinessCandidate = { source_version_id: "SYNTHETIC@v1", topics: ["minimum_wage"], parse_succeeded: true, citation_verified: false, operative_role_eligible: true, human_reviewed: false, effective_interval_verified: false, verified_sectors: [], verified_populations: [], active: false };

describe("sole canonical legal readiness", () => {
  it("freezes historical/current/missing-sector/placeholder cases for all seven topics", () => {
    expect(LEGAL_READINESS_CASES).toHaveLength(28);
    for (const topic of ["minimum_wage", "working_time", "pension", "travel", "convalescence", "vacation", "sick_leave"]) {
      expect(LEGAL_READINESS_CASES.filter((entry) => entry.topic === topic).map((entry) => entry.kind).sort()).toEqual(["current", "historical", "missing_sector", "sector_placeholder"]);
    }
    expect(LEGAL_READINESS_CASES.every((entry) => evaluateLegalReadiness({ readinessCase: entry, candidates: [] }).status === "BLOCKED_NOT_READY")).toBe(true);
    const parsedOperative = LEGAL_READINESS_CASES.map((entry) => ({ ...blocked, source_version_id: `SYN_${entry.topic}@v1`, topics: [entry.topic] }));
    for (const readinessCase of LEGAL_READINESS_CASES) {
      const decision = evaluateLegalReadiness({ readinessCase, candidates: parsedOperative });
      expect(decision.status).toBe(LEGAL_READINESS_CASE_EXPECTATION.status);
      expect(decision.reason_codes).toEqual(LEGAL_READINESS_CASE_EXPECTATION.reason_codes);
    }
  });

  it("makes all six required adapters byte-identical on the domain decision", () => {
    const readinessCase = LEGAL_READINESS_CASES[1];
    const outputs = [legalReadinessDiagnostic(readinessCase, [blocked]), legalReadinessStrict(readinessCase, [blocked]), legalCorpusTopicGate(readinessCase, [blocked]), legalServerResolverAdmission(readinessCase, [blocked]), futureLegalActivationAdmission(readinessCase, [blocked]), futureLegalShadowAdmission(readinessCase, [blocked])];
    expect(new Set(outputs.map((output) => output.decision.decision_sha256))).toEqual(new Set([outputs[0].decision.decision_sha256]));
    expect(outputs.every((output) => output.decision.decision_source === "evaluateLegalReadiness")).toBe(true);
  });

  it("propagates every gate mutation identically and cannot be overruled by a wrapper", () => {
    const readinessCase = LEGAL_READINESS_CASES[1];
    const complete: LegalReadinessCandidate = { ...blocked, citation_verified: true, human_reviewed: true, effective_interval_verified: true, verified_sectors: ["general"], verified_populations: ["general_workforce"], active: true };
    expect(evaluateLegalReadiness({ readinessCase, candidates: [complete] }).status).toBe("READY");
    const mutations: Array<keyof LegalReadinessCandidate> = ["parse_succeeded", "citation_verified", "operative_role_eligible", "human_reviewed", "effective_interval_verified", "active"];
    for (const field of mutations) {
      const candidate = { ...complete, [field]: false };
      const domain = evaluateLegalReadiness({ readinessCase, candidates: [candidate] });
      const adapters = [legalReadinessDiagnostic(readinessCase, [candidate]), legalReadinessStrict(readinessCase, [candidate]), legalCorpusTopicGate(readinessCase, [candidate]), legalServerResolverAdmission(readinessCase, [candidate]), futureLegalActivationAdmission(readinessCase, [candidate]), futureLegalShadowAdmission(readinessCase, [candidate])];
      expect(domain.status).toBe("BLOCKED_NOT_READY");
      expect(adapters.every((output) => output.decision.decision_sha256 === domain.decision_sha256)).toBe(true);
    }
    for (const field of ["verified_sectors", "verified_populations"] as const) {
      const candidate = { ...complete, [field]: [] };
      const domain = evaluateLegalReadiness({ readinessCase, candidates: [candidate] });
      expect(domain.status).toBe("BLOCKED_NOT_READY");
      expect(legalReadinessStrict(readinessCase, [candidate]).decision.decision_sha256).toBe(domain.decision_sha256);
    }
    expect(new Set(LEGAL_READINESS_REASON_CODES).size).toBe(8);
  });
});
