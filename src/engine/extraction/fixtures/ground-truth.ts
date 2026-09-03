import type { PayslipFieldKey } from "../contracts.ts";

export type SyntheticGroundTruth = Readonly<{
  fixture_id: string;
  expected_fields: Partial<Record<PayslipFieldKey, unknown>>;
  expected_absent_fields: readonly PayslipFieldKey[];
  expected_validation_issue_codes: readonly string[];
}>;

const money = (minor_units: number) => ({ currency: "ILS", minor_units });
const period = { year: 2026, month: 8, start_date: "2026-08-01", end_date: "2026-08-31" };
const hours = (amount: string) => ({ amount, unit: "hours_per_month" });

export const syntheticPayslipGroundTruth: readonly SyntheticGroundTruth[] = [
  {
    fixture_id: "clean_monthly",
    expected_fields: {
      document_type: "payslip",
      salary_period: period,
      employment_start_date: "2020-01-15",
      salary_type: "monthly",
      base_monthly_salary: money(850_000),
      gross_salary: money(850_000),
      net_salary: money(720_000),
      vacation_balance: { amount: "10", unit: "days" },
      sick_balance: { amount: "20", unit: "days" },
    },
    expected_absent_fields: [],
    expected_validation_issue_codes: [],
  },
  {
    fixture_id: "clean_hourly",
    expected_fields: {
      document_type: "payslip",
      salary_period: period,
      salary_type: "hourly",
      hourly_rate: money(5_000),
      regular_hours: hours("182.5"),
      base_monthly_salary: money(912_500),
      gross_salary: money(912_500),
      net_salary: money(775_000),
    },
    expected_absent_fields: [],
    expected_validation_issue_codes: [],
  },
  {
    fixture_id: "overtime_bands",
    expected_fields: {
      document_type: "payslip",
      salary_period: period,
      salary_type: "monthly",
      base_monthly_salary: money(850_000),
      overtime_125_hours: hours("12.5"),
      overtime_150_hours: hours("4.25"),
      gross_salary: money(965_000),
    },
    expected_absent_fields: [],
    expected_validation_issue_codes: [],
  },
  {
    fixture_id: "pension_components",
    expected_fields: {
      document_type: "payslip",
      salary_period: period,
      salary_type: "monthly",
      base_monthly_salary: money(1_000_000),
      gross_salary: money(1_000_000),
      pension_base: money(1_000_000),
      pension_employee_rate: { basis_points: 600 },
      pension_employee_contribution: money(60_000),
      pension_employer_rate: { basis_points: 650 },
      pension_employer_contribution: money(65_000),
      severance_rate: { basis_points: 833 },
      severance_contribution: money(83_300),
    },
    expected_absent_fields: [],
    expected_validation_issue_codes: [],
  },
  {
    fixture_id: "travel_component",
    expected_fields: {
      document_type: "payslip",
      salary_period: period,
      salary_type: "monthly",
      base_monthly_salary: money(850_000),
      travel_amount: money(50_000),
      gross_salary: money(900_000),
    },
    expected_absent_fields: [],
    expected_validation_issue_codes: [],
  },
  {
    fixture_id: "missing_base_salary",
    expected_fields: {
      document_type: "payslip",
      salary_period: period,
      salary_type: "monthly",
      gross_salary: money(850_000),
      net_salary: money(720_000),
    },
    expected_absent_fields: ["base_monthly_salary"],
    expected_validation_issue_codes: [],
  },
  {
    fixture_id: "contradictory_arithmetic",
    expected_fields: {
      document_type: "payslip",
      salary_period: period,
      salary_type: "monthly",
      base_monthly_salary: money(850_000),
      travel_amount: money(50_000),
      gross_salary: money(1_200_000),
    },
    expected_absent_fields: [],
    expected_validation_issue_codes: ["gross_component_mismatch"],
  },
  {
    fixture_id: "ocr_magnitude_ambiguity",
    expected_fields: {
      document_type: "payslip",
      salary_period: period,
      salary_type: "monthly",
      base_monthly_salary: money(850_000),
      gross_salary: money(850_000),
    },
    expected_absent_fields: [],
    expected_validation_issue_codes: ["ocr_value_ambiguous", "ocr_scale_mismatch"],
  },
  {
    fixture_id: "hebrew_rtl_labels",
    expected_fields: {
      document_type: "payslip",
      salary_period: period,
      salary_type: "monthly",
      base_monthly_salary: money(850_000),
      gross_salary: money(850_000),
      regular_hours: hours("182"),
    },
    expected_absent_fields: [],
    expected_validation_issue_codes: [],
  },
  {
    fixture_id: "unknown_component",
    expected_fields: {
      document_type: "payslip",
      salary_period: period,
      salary_type: "monthly",
      base_monthly_salary: money(800_000),
      gross_salary: money(875_000),
    },
    expected_absent_fields: [],
    expected_validation_issue_codes: [],
  },
];
