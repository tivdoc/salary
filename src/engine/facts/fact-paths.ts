import { z } from "zod";

export const knownFactPaths = [
  "employment.start_date",
  "employment.end_date",
  // L8-4 / D5: the population the month belongs to — an adult, a working
  // youth by the 1987 regulations' age band, an apprentice — so a draft whose
  // parameter differs by population can bind that population's figure.
  "employment.population",
  "compensation.salary_type",
  "compensation.base_monthly_salary",
  "compensation.hourly_rate",
  "compensation.gross_salary",
  "compensation.net_salary",
  // L7-5 / D4: what the payslip paid for the components a draft computes.
  "compensation.overtime_pay",
  "compensation.weekly_rest_pay",
  "work.regular_hours",
  "work.overtime_hours",
  "work.overtime_125_hours",
  "work.overtime_150_hours",
  // L7-2 / D2, D6: hours worked in a day and overtime hours worked on the
  // weekly rest, per day — the working-time drafts derive the day's overtime
  // from hours worked and the daily threshold.
  "work.hours_worked_day",
  "work.rest_day_overtime_hours",
  // L7-2: the count of workdays in the payslip month, for the travel draft.
  "work.workdays_in_month",
  "work.workdays",
  "work.breaks",
  "pension.base_salary",
  "pension.contributions",
  "pension.severance_contribution",
  "leave.vacation_balance",
  "leave.sick_balance",
  // L7-2 / D2: the absence the sick-pay draft prices, as dates; the day index
  // is derived from them, never declared. L7-5 / D4: what was paid.
  "leave.sick_absence",
  "leave.sick_pay",
  "leave.vacation_days_paid",
  "travel.reimbursement",
  "convalescence.payment",
  "documents.period",
] as const;

export const factPathSchema = z.enum(knownFactPaths);
export type FactPath = z.infer<typeof factPathSchema>;
