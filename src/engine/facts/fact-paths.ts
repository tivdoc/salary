import { z } from "zod";

export const knownFactPaths = [
  "employment.start_date",
  "employment.end_date",
  "compensation.salary_type",
  "compensation.base_monthly_salary",
  "compensation.hourly_rate",
  "work.regular_hours",
  "work.overtime_hours",
  "work.workdays",
  "work.breaks",
  "pension.base_salary",
  "pension.contributions",
  "travel.reimbursement",
  "convalescence.payment",
  "documents.period",
] as const;

export const factPathSchema = z.enum(knownFactPaths);
export type FactPath = z.infer<typeof factPathSchema>;
