import { describe, expect, it } from "vitest";
import {
  mappingFor,
  REFUSAL_MAPPINGS,
  reminderTimes,
  requestFor,
  REQUEST_TIMING,
  slaPaused,
  type ThreadRequest,
} from "./refusal-requests.ts";
import { MIXED_S04_S05_S06 } from "./case-report-projection.fixtures.ts";

const CASE = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-06T09:00:00.000Z");

describe("S3.3: every refusal becomes a question, a line of text, or is not a refusal", () => {
  it("maps each code to exactly one outcome, and only a request can block", () => {
    for (const mapping of REFUSAL_MAPPINGS) {
      if (mapping.outcome === "request") {
        expect(mapping.question, mapping.code).not.toBeNull();
        expect(mapping.answer_kind, mapping.code).not.toBe("none");
      } else {
        // Nothing to ask: no question, no answer kind, and it can never block the case.
        expect(mapping.question, mapping.code).toBeNull();
        expect(mapping.answer_kind, mapping.code).toBe("none");
        expect(mapping.blocking, mapping.code).toBe(false);
      }
      // A topic that says "not checked" always says why — that is the point of the table.
      expect(mapping.not_checked_text.length, mapping.code).toBeGreaterThan(4);
    }
  });

  it("maps every code the projection can carry, so no topic reads 'not checked' without a reason", () => {
    const codes = MIXED_S04_S05_S06.topics.flatMap((topic) => (topic.gate === "refused" ? [topic.not_checked.code] : topic.gate === "awaiting_verification" ? ["awaiting_verification"] : []));
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) expect(mappingFor(code), code).not.toBeNull();
  });

  it("falls back to the family when a field-specific code is new, instead of losing it", () => {
    expect(mappingFor("low_confidence:hours_regular")?.field_crop).toBe("hours_regular");
    // A field nobody mapped still produces a question rather than vanishing.
    const unknown = mappingFor("low_confidence:some_new_field");
    expect(unknown).not.toBeNull();
    expect(unknown?.outcome).toBe("request");
    expect(mappingFor("a_code_from_nowhere")).toBeNull();
  });
});

describe("S3.3: the three named codes behave as the brief specifies", () => {
  it("schedule_unknown is a blocking question with the days-per-week choice", () => {
    const request = requestFor("schedule_unknown", { caseId: CASE, now: NOW })!;
    expect(request.blocking).toBe(true);
    expect(request.question).toBe("כמה ימים בשבוע אתה עובד?");
    expect(request.options).toEqual(["5", "6"]);
  });

  it("low_confidence carries the field crop and does not block", () => {
    const request = requestFor("low_confidence:hours_regular", { caseId: CASE, now: NOW })!;
    expect(request.blocking).toBe(false);
    expect(request.field_crop).toBe("hours_regular");
  });

  it("rate_not_published asks nothing — there is no answer anyone could give", () => {
    expect(requestFor("rate_not_published", { caseId: CASE, now: NOW })).toBeNull();
    expect(mappingFor("rate_not_published")?.not_checked_text).toContain("טרם פורסם ברשומות");
  });

  it("awaiting_verification asks nothing either: the work is ours, not the customer's", () => {
    expect(requestFor("awaiting_verification", { caseId: CASE, now: NOW })).toBeNull();
    expect(mappingFor("awaiting_verification")?.not_checked_text).toBe("ממתין לאימות בסיום הפיתוח");
  });
});

describe("S3.3: the clock (D-7.2) and the deadlines (D-9)", () => {
  const blocking = requestFor("schedule_unknown", { caseId: CASE, now: NOW })!;
  const nonBlocking = requestFor("low_confidence:hours_regular", { caseId: CASE, now: NOW })!;

  it("expires ten days from opening", () => {
    expect(REQUEST_TIMING.expiry_days).toBe(10);
    expect(new Date(blocking.expires_at).getTime() - NOW.getTime()).toBe(10 * 24 * 3_600 * 1_000);
  });

  it("reminds at 48 hours and at five days", () => {
    expect(reminderTimes(NOW).map((at) => (at.getTime() - NOW.getTime()) / 3_600_000)).toEqual([48, 120]);
  });

  it("pauses the SLA only while a blocking request is unanswered", () => {
    expect(slaPaused([])).toBe(false);
    expect(slaPaused([nonBlocking])).toBe(false);
    expect(slaPaused([blocking])).toBe(true);
    const answered: ThreadRequest = { ...blocking, answered_at: NOW.toISOString() };
    expect(slaPaused([answered])).toBe(false);
    expect(slaPaused([answered, nonBlocking])).toBe(false);
  });
});
