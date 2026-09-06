import { describe, expect, it } from "vitest";
import { WAVE3_TOPICS } from "@/engine/wave3/contracts";
import {
  caseReportProjectionSchema,
  CERTAINTY_SENTENCE,
  displayForCertainty,
  parseProjection,
  PROJECTION_LEGAL_BASIS,
  PROJECTION_TOPICS,
  renderPermission,
  SEVERITY_TEXT,
} from "./case-report-projection.ts";
import {
  ALL_AWAITING_VERIFICATION,
  MIXED_S04_S05_S06,
  S04_HIGH_CERTAINTY_FINDING,
  S05_LOW_CERTAINTY_DIRECTION,
  S06_REFUSED_FOR_APPLICABILITY,
} from "./case-report-projection.fixtures.ts";

// S3.2's acceptance. The contract's whole job is to make a wrong report
// impossible to construct, so these tests mostly try to construct wrong ones.

describe("S3.2: the contract's vocabulary", () => {
  // The product declares its own topic list because the product half imports nothing
  // from the engine. This is the guard that keeps the two from drifting apart.
  it("names exactly the engine's seven topics", () => {
    expect([...PROJECTION_TOPICS].sort()).toEqual([...WAVE3_TOPICS].sort());
  });

  it("carries the errata-corrected legal basis on every document", () => {
    expect(PROJECTION_LEGAL_BASIS).toBe("opinion_3ddad7e8 + errata_1_owner_closed");
    expect(ALL_AWAITING_VERIFICATION.legal_basis).toBe(PROJECTION_LEGAL_BASIS);
    expect(MIXED_S04_S05_S06.legal_basis).toBe(PROJECTION_LEGAL_BASIS);
  });

  it("reports on all seven topics or not at all — a silently missing topic tells the reader nothing", () => {
    const short = { ...MIXED_S04_S05_S06, topics: MIXED_S04_S05_S06.topics.slice(0, 6) };
    expect(() => parseProjection(short)).toThrow();
    const duplicated = { ...MIXED_S04_S05_S06, topics: [...MIXED_S04_S05_S06.topics.slice(0, 6), MIXED_S04_S05_S06.topics[0]] };
    expect(() => parseProjection(duplicated)).toThrow();
  });
});

describe("S3.2 gate 1 — activation: a topic that is not active shows no number, and cannot be made to", () => {
  // This is the test the brief names: a draft parameter ⇒ no amount.
  it("today's real state: every topic awaits verification and not one carries a figure", () => {
    expect(ALL_AWAITING_VERIFICATION.topics).toHaveLength(7);
    for (const topic of ALL_AWAITING_VERIFICATION.topics) {
      expect(topic.gate).toBe("awaiting_verification");
      expect(topic.status).toBe("not_checked");
      // The fields do not exist on this shape at all — not set to null, absent.
      expect(topic).not.toHaveProperty("certainty");
      expect(topic).not.toHaveProperty("display");
      expect(topic).not.toHaveProperty("amount");
      expect(topic).not.toHaveProperty("range");
      expect(topic).not.toHaveProperty("direction");
      const permission = renderPermission(topic);
      expect(permission.showsNumber).toBe(false);
      expect(permission.showsDirection).toBe(false);
      expect(permission.line).toBe("ממתין לאימות בסיום הפיתוח");
    }
    expect(JSON.stringify(ALL_AWAITING_VERIFICATION)).not.toMatch(/minor_units/u);
  });

  it("refuses a document that gives an unverified topic a certainty or an amount", () => {
    const awaiting = ALL_AWAITING_VERIFICATION.topics[0]!;
    for (const smuggled of [
      { ...awaiting, certainty: "high" },
      { ...awaiting, amount: { currency: "ILS", minor_units: 5_000 } },
      { ...awaiting, display: "amount" },
      { ...awaiting, activation: "active" },
    ]) {
      expect(() => parseProjection({ ...ALL_AWAITING_VERIFICATION, topics: [smuggled, ...ALL_AWAITING_VERIFICATION.topics.slice(1)] })).toThrow();
    }
  });

  it("says which grades activation is waiting on, so an operator can see the blocker", () => {
    const workingTime = ALL_AWAITING_VERIFICATION.topics.find((topic) => topic.topic === "working_time")!;
    expect(workingTime.gate === "awaiting_verification" && workingTime.blocked_by_grades).toEqual(["derived"]);
  });
});

describe("S3.2 gate 2 — applicability: a missing fact is a question, never a weak answer", () => {
  it("refuses rather than downgrades, and names the fact the request will ask for", () => {
    expect(S06_REFUSED_FOR_APPLICABILITY.gate).toBe("refused");
    expect(S06_REFUSED_FOR_APPLICABILITY).not.toHaveProperty("certainty");
    expect(S06_REFUSED_FOR_APPLICABILITY.gate === "refused" && S06_REFUSED_FOR_APPLICABILITY.applicability.refused).toBe("days_per_week");
    expect(renderPermission(S06_REFUSED_FOR_APPLICABILITY).showsNumber).toBe(false);
  });

  it("treats a derived parameter's assumption slot as an applicability fact, stated in one sentence", () => {
    const assumptions = S06_REFUSED_FOR_APPLICABILITY.gate === "refused" ? S06_REFUSED_FOR_APPLICABILITY.assumptions : [];
    expect(assumptions).toHaveLength(1);
    expect(assumptions[0]!.slot).toBe("five_day_even_distribution");
    expect(assumptions[0]!.statement.length).toBeGreaterThan(20);
  });

  it("requires at least one missing fact on a refusal — a refusal with nothing to ask for is not a refusal", () => {
    const empty = { ...S06_REFUSED_FOR_APPLICABILITY, missing_facts: [] };
    expect(() => parseProjection({ ...MIXED_S04_S05_S06, topics: MIXED_S04_S05_S06.topics.map((t) => (t.topic === "working_time" ? empty : t)) })).toThrow();
  });
});

describe("S3.2 gate 3 — certainty, and the display that follows from it mechanically", () => {
  it("derives display from certainty and refuses any other pairing", () => {
    expect(displayForCertainty("high")).toBe("amount");
    expect(displayForCertainty("medium")).toBe("range");
    expect(displayForCertainty("low")).toBe("direction");
    const wrong = { ...S05_LOW_CERTAINTY_DIRECTION, display: "amount" as const };
    expect(() => parseProjection({ ...MIXED_S04_S05_S06, topics: MIXED_S04_S05_S06.topics.map((t) => (t.topic === "pension" ? wrong : t)) })).toThrow();
  });

  it("D-6.3 mechanically: at low certainty there is no amount and no range anywhere", () => {
    expect(S05_LOW_CERTAINTY_DIRECTION.gate === "checked" && S05_LOW_CERTAINTY_DIRECTION.amount).toBeNull();
    expect(S05_LOW_CERTAINTY_DIRECTION.gate === "checked" && S05_LOW_CERTAINTY_DIRECTION.range).toBeNull();
    expect(renderPermission(S05_LOW_CERTAINTY_DIRECTION).showsNumber).toBe(false);
    for (const smuggled of [
      { ...S05_LOW_CERTAINTY_DIRECTION, amount: { currency: "ILS", minor_units: 1 } },
      { ...S05_LOW_CERTAINTY_DIRECTION, range: { low: { currency: "ILS", minor_units: 1 }, high: { currency: "ILS", minor_units: 2 } } },
    ]) {
      expect(() => parseProjection({ ...MIXED_S04_S05_S06, topics: MIXED_S04_S05_S06.topics.map((t) => (t.topic === "pension" ? smuggled : t)) })).toThrow();
    }
  });

  it("shows a sum only at high certainty, and carries D-6.2's sentence for the level", () => {
    expect(S04_HIGH_CERTAINTY_FINDING.gate === "checked" && S04_HIGH_CERTAINTY_FINDING.display).toBe("amount");
    expect(S04_HIGH_CERTAINTY_FINDING.gate === "checked" && S04_HIGH_CERTAINTY_FINDING.amount).toEqual({ currency: "ILS", minor_units: 41_250 });
    expect(renderPermission(S04_HIGH_CERTAINTY_FINDING)).toMatchObject({ showsNumber: true, line: CERTAINTY_SENTENCE.high });
    expect(renderPermission(S05_LOW_CERTAINTY_DIRECTION).line).toBe(CERTAINTY_SENTENCE.low);
  });

  it("a finding carries a severity class, and each class has the customer's own words", () => {
    expect(S04_HIGH_CERTAINTY_FINDING.gate === "checked" && S04_HIGH_CERTAINTY_FINDING.severity_class).toBe("statutory_violation");
    expect(SEVERITY_TEXT.statutory_violation).toBe("מתחת לרצפת החוק");
    expect(SEVERITY_TEXT.order_entitlement).toContain("זכות הניתנת לתביעה");
    const noSeverity = { ...S04_HIGH_CERTAINTY_FINDING, severity_class: null };
    expect(() => parseProjection({ ...MIXED_S04_S05_S06, topics: MIXED_S04_S05_S06.topics.map((t) => (t.topic === "minimum_wage" ? noSeverity : t)) })).toThrow();
  });
});

describe("S3.2: the document's own shape", () => {
  it("an initial check is one month, and the checked month is inside the coverage", () => {
    expect(() => parseProjection({ ...MIXED_S04_S05_S06, months_covered: ["2026-05", "2026-06"] })).toThrow();
    expect(() => parseProjection({ ...MIXED_S04_S05_S06, check_period_month: "2026-01" })).toThrow();
    expect(caseReportProjectionSchema.parse({ ...MIXED_S04_S05_S06, report_kind: "full", months_covered: ["2026-05", "2026-06"] }).report_kind).toBe("full");
  });
});
