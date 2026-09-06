import { describe, expect, it } from "vitest";
import { questionnaireSchema, type QuestionnaireInput } from "@/lib/validation";
import { questionnaireFacts, schedulePattern, topicExclusions } from "./questionnaire-facts.ts";
import { mappingFor } from "./refusal-requests.ts";

const answers: QuestionnaireInput = questionnaireSchema.parse({
  firstName: "נועה",
  phone: "050-1234567",
  email: "noa@example.com",
  stillEmployed: true,
  salaryType: "monthly",
  typicalHoursPerDay: "8.6",
  workDaysPerWeek: "5",
  worksFriday: false,
  worksSaturday: false,
  payslipAvailable: true,
  employmentStartMonth: "2023-04",
  birthYear: "1994",
  sex: "female",
  hadPensionFundAtHire: false,
  employerProvidesTransport: false,
  commuteOver500m: true,
  managerialOrTrustRole: false,
});

describe("S3.1: every answer is a fact, and every fact says a person gave it", () => {
  it("marks all of them declared, person-read, unverified, capped at medium", () => {
    const facts = questionnaireFacts(answers);
    expect(facts.length).toBeGreaterThanOrEqual(12);
    for (const item of facts) {
      expect(item.source, item.path).toBe("declared");
      expect(item.read_by, item.path).toBe("person");
      expect(item.verified, item.path).toBe(false);
      // D-6.1: an answer is not a document, so its topic can never reach a sum.
      expect(item.certainty_ceiling, item.path).toBe("medium");
    }
  });

  it("supplies the applicability facts the working-hours topic would otherwise refuse for", () => {
    const paths = questionnaireFacts(answers).map((item) => item.path);
    expect(paths).toContain("employment.days_per_week");
    expect(paths).toContain("employment.regular_day_hours");
  });

  it("carries the inputs each topic needs: seniority, age, pension at hire, and the two travel answers", () => {
    const paths = questionnaireFacts(answers).map((item) => item.path);
    for (const path of ["employment.start_month", "person.birth_year", "pension.fund_at_hire", "travel.employer_provides_transport", "travel.commute_over_500m"]) {
      expect(paths).toContain(path);
    }
  });
});

describe("S3.1: §30(א) is an applicability answer, not a certainty one", () => {
  it("excludes the working-hours topic and gives the reason the report prints", () => {
    expect(topicExclusions(answers)).toEqual([]);
    const managerial = topicExclusions({ ...answers, managerialOrTrustRole: true });
    expect(managerial).toHaveLength(1);
    expect(managerial[0]!.topic).toBe("working_time");
    expect(managerial[0]!.refusal_code).toBe("section_30a_excluded");
    expect(managerial[0]!.reason).toContain("30(א)");
  });

  it("asks the customer nothing about it — there is no question to ask", () => {
    const mapping = mappingFor("section_30a_excluded")!;
    expect(mapping.outcome).toBe("not_checked_only");
    expect(mapping.question).toBeNull();
    expect(mapping.blocking).toBe(false);
  });
});

describe("S3.1: the schedule pattern feeds Q6's conditional resolution", () => {
  it("recognises the three patterns the errata named", () => {
    expect(schedulePattern({ ...answers, workDaysPerWeek: 6, typicalHoursPerDay: 8 }).pattern).toBe("8");
    expect(schedulePattern({ ...answers, workDaysPerWeek: 5, typicalHoursPerDay: 8.6 }).pattern).toBe("8.6-7.6");
    expect(schedulePattern({ ...answers, workDaysPerWeek: 5, typicalHoursPerDay: 9 }).pattern).toBe("9");
  });

  it("refuses an unrecognised schedule instead of defaulting to one", () => {
    const odd = schedulePattern({ ...answers, workDaysPerWeek: 4, typicalHoursPerDay: 10 });
    expect(odd.pattern).toBeNull();
    expect(odd.refusal).toBe("schedule_unknown");
    // And that refusal is a blocking question, not a quiet assumption.
    expect(mappingFor("schedule_unknown")!.blocking).toBe(true);
  });
});
