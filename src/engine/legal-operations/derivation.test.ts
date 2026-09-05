import { describe, expect, it } from "vitest";
import {
  ASSUMPTION_FIVE_DAY_EVEN_DISTRIBUTION,
  derivationSha256,
  deriveFiveDayDailyNorm,
  renderExact,
  verifyDerivation,
  type FiveDayDerivationInput,
} from "./derivation.ts";

const ORDER = { source_id: "IL_SHORT_WORK_WEEK_EXTENSION_ORDER_2018", source_version: "discovery-v0.1", chunk_id: "IL_SHORT_WORK_WEEK_EXTENSION_ORDER_2018@discovery-v0.1#0001-c383d0ba2158" };

const INPUT: FiveDayDerivationInput = {
  weekly_after: { value: { numerator: "42", denominator: "1", unit: "hours_per_week" }, source: ORDER, locator: "§2.1: the week stands at 42 hours" },
  reduction: { value: { numerator: "1", denominator: "1", unit: "hours" }, source: ORDER, locator: "§2.1–2.2: shortened by one working hour on a defined, fixed day" },
  weekly_before: { value: { numerator: "43", denominator: "1", unit: "hours_per_week" }, source: null, locator: "42 + 1: the week before the reduction; the 2000 framework order's text is not in the corpus", origin: "derived_step" },
  assumption: { days_per_week: 5, reduced_days: 1, statement: "The 43-hour week is spread evenly over five working days; one of them carries the reduced hour.", competing_reading: "nine_hour_day", invalidated_by: "V11" },
  corroboration: [{ source: "steering_committee_2018-04-24", grade: "agreement_interpretation", note: "8.6 / 7.6 as the committee read the order" }],
};

describe("L12-1 / D1: a derived parameter is arithmetic on cited text plus one declared assumption, recomputed before it binds", () => {
  it("derives 8.6 and 7.6 from 42, the one-hour reduction and five even days, and proves 4 × 8.6 + 7.6 = 42", () => {
    const record = deriveFiveDayDailyNorm(INPUT);
    expect(record.outputs.regular_day).toEqual({ numerator: "43", denominator: "5", unit: "hours" });
    expect(record.outputs.short_day).toEqual({ numerator: "38", denominator: "5", unit: "hours" });
    expect(renderExact(record.outputs.regular_day)).toBe("8.6");
    expect(renderExact(record.outputs.short_day)).toBe("7.6");
    expect(record.identity).toMatchObject({ holds: true, lhs: { numerator: "42", denominator: "1" }, rhs: { numerator: "42", denominator: "1" } });
    expect(record.assumption.slot).toBe(ASSUMPTION_FIVE_DAY_EVEN_DISTRIBUTION);
    expect(record.assumption.mandatory).toBe(true);
    expect(record.grade).toBe("derived");
    expect(record.steps.map((step) => step.step)).toEqual(["regular_day", "short_day", "weekly_identity"]);
    expect(verifyDerivation(record)).toEqual(record);
  });

  it("refuses to bind when the identity fails: a week that is not 42 after the reduction", () => {
    expect(() => deriveFiveDayDailyNorm({ ...INPUT, weekly_before: { ...INPUT.weekly_before, value: { numerator: "44", denominator: "1", unit: "hours_per_week" } } }))
      .toThrow("DERIVATION_WEEKLY_BEFORE_INCONSISTENT");
    const record = deriveFiveDayDailyNorm(INPUT);
    const tampered = { ...record, outputs: { ...record.outputs, regular_day: { numerator: "9", denominator: "1", unit: "hours" } } };
    expect(() => verifyDerivation(tampered)).toThrow("DERIVATION_RECOMPUTATION_MISMATCH");
    const broken = { ...record, identity: { ...record.identity, rhs: { numerator: "43", denominator: "1", unit: "hours_per_week" } } };
    expect(() => verifyDerivation(broken)).toThrow("DERIVATION_IDENTITY_FAILED");
  });

  it("refuses a record whose assumption slot was dropped or renamed", () => {
    const record = deriveFiveDayDailyNorm(INPUT);
    const { assumption, ...withoutAssumption } = record;
    void assumption;
    expect(() => verifyDerivation(withoutAssumption)).toThrow();
    expect(() => verifyDerivation({ ...record, assumption: { ...record.assumption, slot: "six_day_even_distribution" } })).toThrow("DERIVATION_ASSUMPTION_MISSING");
    expect(() => verifyDerivation({ ...record, assumption: { ...record.assumption, mandatory: false } })).toThrow();
  });

  it("a different assumption is a different record — the digest moves with the days and with the statement", () => {
    const record = deriveFiveDayDailyNorm(INPUT);
    const restated = deriveFiveDayDailyNorm({ ...INPUT, assumption: { ...INPUT.assumption, statement: "The 43-hour week is spread evenly over five working days, the reduced hour on Sunday." } });
    expect(derivationSha256(record)).not.toBe(derivationSha256(restated));
    expect(derivationSha256(record)).toBe(derivationSha256(deriveFiveDayDailyNorm(INPUT)));
    const sixDay = deriveFiveDayDailyNorm({ ...INPUT, assumption: { ...INPUT.assumption, days_per_week: 6, reduced_days: 1 } });
    expect(renderExact(sixDay.outputs.regular_day)).toBe("7.166666…");
    expect(derivationSha256(sixDay)).not.toBe(derivationSha256(record));
  });

  it("the grade is derived and nothing else: the record cannot say text_verified", () => {
    const record = deriveFiveDayDailyNorm(INPUT);
    expect(() => verifyDerivation({ ...record, grade: "text_verified" })).toThrow();
    expect(() => verifyDerivation({ ...record, grade: "administrative" })).toThrow();
  });
});
