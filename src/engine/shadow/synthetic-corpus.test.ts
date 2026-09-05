// L7-4 / D5. The corpus is a pure function of its file: forty-two golden
// months and the edge cases, each a canonical snapshot with its hash, the
// whole pinned. Every case's label is proven by running it.
import { describe, expect, it } from "vitest";
import { GOLDEN_SCENARIOS } from "../legal-quality/golden-case-templates.ts";
import { executeRuleSpecAtomic } from "../legal-operations/rulespec.ts";
import { prepareRuleInputs } from "../rule-input/preparation.ts";
import { createCanonicalRuleInputSnapshot } from "../rule-input/snapshot.ts";
import { employmentSnapshotSchema } from "../facts/snapshot.ts";
import { DRAFT_SHADOW_SPECS, DRAFT_SHADOW_TOPICS } from "./draft-shadow-specs.ts";
import { bridgePreparedInputs } from "./prepared-input-bridge.ts";
import { SYNTHETIC_CORPUS, SYNTHETIC_CORPUS_SHA256, syntheticCase, type SyntheticCase } from "./synthetic-corpus.ts";
import { SYNTHETIC_PREPARED_AT, syntheticUuid } from "./synthetic-payslip-month.ts";
import { populationOf } from "./population-selection.ts";
import { testParametersFor } from "./test-support.ts";

/** Pinned. A change here is a change to what the shadow runs on, and the state doc must say why. */
// L8-3 / D4: the severance fact beside the contributions in the six pension months; the low-confidence edge month names four pension specs.
// L8-4 / D5: every golden month declares its population as a fact.
// L11-4 / D3.3 and D3.4: the multiplicative rest-day reading left the set; two convalescence edge months joined it
// (June 2026 paid at the 2023 rate; a 2027 month whose rate is not published).
// L12-2 / D2: every working-time month declares its five-day schedule and runs the derived norm.
// L12-3 / D3: two band months — a wage between the two pension caps, an hourly rate between the two divisors' floors.
const CORPUS_SHA256 = "1c7d48541894642d013c7b796441d40fc261b4121ff42145a293827b4ed3ec59";

function runCase(entry: SyntheticCase, shadowId: string) {
  const spec = DRAFT_SHADOW_SPECS.find((candidate) => candidate.shadow_id === shadowId)!;
  const prepared = prepareRuleInputs(createCanonicalRuleInputSnapshot(entry.snapshot), spec.input_mappings, SYNTHETIC_PREPARED_AT);
  const outcome = prepared.result.status === "ready"
    ? executeRuleSpecAtomic({ rule: spec.spec, facts: bridgePreparedInputs(prepared, spec.input_mappings), parameters: testParametersFor(spec, null, populationOf(entry.snapshot)) } as never)
    : null;
  return { prepared, outcome };
}

describe("the synthetic corpus", () => {
  it("is forty-two golden months — one per scenario family per topic — and sixteen edge cases", () => {
    const golden = SYNTHETIC_CORPUS.filter((entry) => entry.family === "golden");
    expect(golden).toHaveLength(DRAFT_SHADOW_TOPICS.length * GOLDEN_SCENARIOS.length);
    expect(golden).toHaveLength(42);
    expect(SYNTHETIC_CORPUS.filter((entry) => entry.family === "edge")).toHaveLength(16);
    expect(new Set(SYNTHETIC_CORPUS.map((entry) => entry.case_id)).size).toBe(SYNTHETIC_CORPUS.length);
    for (const topic of DRAFT_SHADOW_TOPICS) {
      expect(golden.filter((entry) => entry.topic === topic).map((entry) => entry.scenario)).toEqual([...GOLDEN_SCENARIOS]);
    }
  });

  it("every case is synthetic by construction: a canonical snapshot, derived ids, the proof tenant's case", () => {
    for (const entry of SYNTHETIC_CORPUS) {
      expect(entry.synthetic).toBe(true);
      expect(employmentSnapshotSchema.safeParse(entry.snapshot).success, entry.case_id).toBe(true);
      expect(entry.snapshot.case_id).toBe(syntheticUuid(`${entry.case_id.startsWith("synthetic.") ? seedOf(entry) : ""}:case`));
      expect(entry.snapshot.facts.some((fact) => fact.path === "documents.period"), entry.case_id).toBe(true);
      for (const fact of entry.snapshot.facts) {
        if (fact.status === "conflicted") {
          expect(fact.value).toBeNull();
          expect(fact.conflicting_fact_ids.length).toBeGreaterThanOrEqual(2);
          expect(fact.resolution).toBeNull();
        }
      }
    }
  });

  it("mixes provenance on purpose: documented, declared, derived and inferred all occur", () => {
    const types = new Set(SYNTHETIC_CORPUS.flatMap((entry) => entry.snapshot.facts.flatMap((fact) => fact.provenance.map((evidence) => evidence.source_type))));
    expect([...types].sort()).toEqual(["declared", "derived", "documented", "inferred"]);
  });

  it("is pinned whole, and each snapshot's hash is its content's", () => {
    for (const entry of SYNTHETIC_CORPUS) expect(entry.snapshot_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(SYNTHETIC_CORPUS_SHA256).toBe(CORPUS_SHA256);
  });

  it("names every shadow spec at least once, and every named spec exists", () => {
    const known = new Set(DRAFT_SHADOW_SPECS.map((entry) => entry.shadow_id));
    const named = new Set(SYNTHETIC_CORPUS.flatMap((entry) => entry.shadow_ids));
    for (const id of named) expect(known.has(id), id).toBe(true);
    expect([...named].sort()).toEqual([...known].sort());
  });

  it("proves every label by running the case", () => {
    let ran = 0;
    let refused = 0;
    const seen = new Map(SYNTHETIC_CORPUS.map((entry) => [entry.case_id, new Set<string>()] as const));
    for (const entry of SYNTHETIC_CORPUS) {
      for (const shadowId of entry.shadow_ids) {
        const { prepared, outcome } = runCase(entry, shadowId);
        const label = `${entry.case_id} / ${shadowId}`;
        switch (entry.expected.kind) {
          case "runs":
            expect(prepared.result.status, label).toBe("ready");
            expect(outcome?.error_code, label).toBeNull();
            ran += 1;
            break;
          case "preparation_refuses":
            expect(prepared.result.status, label).toBe("rejected");
            for (const code of prepared.result.rejection_codes) expect(entry.expected.codes, label).toContain(code);
            expect(prepared.result.values, label).toEqual([]);
            for (const code of prepared.result.rejection_codes) seen.get(entry.case_id)!.add(code);
            refused += 1;
            break;
          case "executor_refuses":
            expect(prepared.result.status, label).toBe("ready");
            expect(outcome?.error_code, label).toBe(entry.expected.error_code);
            expect(outcome?.execution, label).toBeNull();
            refused += 1;
            break;
        }
      }
    }
    // Every code a refusing case names occurs on at least one of its specs.
    for (const entry of SYNTHETIC_CORPUS) {
      if (entry.expected.kind !== "preparation_refuses") continue;
      expect([...seen.get(entry.case_id)!].sort(), entry.case_id).toEqual([...entry.expected.codes].sort());
    }
    // L11-4: minus the retired multiplicative reading (five runs, two refusals), plus two convalescence months that run.
    // L12-2: the derived five-day norm runs on six golden months and one edge month, refuses the unconfirmed wage.
    // L12-3: two band months, both run.
    expect(ran).toBe(81);
    expect(refused).toBe(33);
  });

  it("finds a case by id and refuses an unknown one", () => {
    expect(syntheticCase("synthetic.minimum_wage.golden.current").topic).toBe("minimum_wage");
    expect(() => syntheticCase("synthetic.nothing")).toThrow("SYNTHETIC_CASE_UNKNOWN");
  });
});

function seedOf(entry: SyntheticCase): string {
  return `${entry.family}.${entry.topic}.${entry.scenario}`;
}
