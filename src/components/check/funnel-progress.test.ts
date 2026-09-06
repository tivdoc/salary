// Site S4 (2.1) acceptance. The funnel had two progress indicators that
// disagreed; this proves the one that replaced them measures the whole journey
// monotonically and describes itself in words rather than as a bare number.
import { describe, expect, it } from "vitest";
import { FUNNEL_STAGES, funnelFraction, funnelValueText } from "./funnel-progress.tsx";

describe("the funnel's one progress indicator", () => {
  it("covers the four stages the funnel actually has", () => {
    expect(FUNNEL_STAGES.map((stage) => stage.path)).toEqual([
      "/check", "/check/upload", "/check/payment", "/check/received",
    ]);
  });

  it("never goes backwards as a person walks the funnel", () => {
    const walk: number[] = [];
    // Nine questions inside the first stage, then the three stages after it.
    for (let question = 1; question <= 9; question += 1) {
      walk.push(funnelFraction(0, { index: question, count: 9 }));
    }
    for (let stage = 1; stage < FUNNEL_STAGES.length; stage += 1) {
      walk.push(funnelFraction(stage, null));
    }
    for (let index = 1; index < walk.length; index += 1) {
      expect(walk[index]!, `step ${index}`).toBeGreaterThanOrEqual(walk[index - 1]!);
    }
    expect(walk.at(-1)).toBe(1);
  });

  it("keeps the questions inside the first stage's share of the bar", () => {
    // The old failure: a nine-question bar and a four-stage bar side by side,
    // one at 100% while the other was at 25%.
    expect(funnelFraction(0, { index: 9, count: 9 })).toBeCloseTo(0.25, 10);
    expect(funnelFraction(0, { index: 0, count: 9 })).toBe(0);
    expect(funnelFraction(1, null)).toBeCloseTo(0.5, 10);
  });

  it("reads as a sentence rather than a number", () => {
    expect(funnelValueText(0, { index: 3, count: 9 })).toBe("שלב 1 מתוך 4: כמה פרטים, שאלה 3 מתוך 9");
    expect(funnelValueText(2, null)).toBe("שלב 3 מתוך 4: תשלום");
  });

  it("survives nonsense rather than rendering it", () => {
    expect(funnelFraction(-4, null)).toBeCloseTo(0.25, 10);
    expect(funnelFraction(99, null)).toBe(1);
    expect(funnelFraction(0, { index: 40, count: 9 })).toBeCloseTo(0.25, 10);
    expect(funnelFraction(0, { index: 1, count: 0 })).toBeCloseTo(0.25, 10);
    expect(funnelValueText(99, null)).toContain("שלב 100 מתוך 4".slice(0, 4));
  });
});
