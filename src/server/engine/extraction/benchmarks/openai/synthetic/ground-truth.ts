import "server-only";
import type { PayslipFieldKey } from "@/engine/extraction/contracts";

export type RenderedPayslipGroundTruth = Readonly<{
  fixture_id: string;
  expected_fields: Partial<Record<PayslipFieldKey, unknown>>;
  expected_absent_fields: readonly PayslipFieldKey[];
  critical_fields: readonly PayslipFieldKey[];
  expected_validation_issue_codes: readonly string[];
}>;

const money = (minor_units: number) => ({ currency: "ILS", minor_units });
const hours = (amount: string) => ({ amount, unit: "hours_per_month" });
const period = { year: 2026, month: 8, start_date: "2026-08-01", end_date: "2026-08-31" };

export const renderedPayslipGroundTruth: readonly RenderedPayslipGroundTruth[] = [
  {
    fixture_id: "clean_monthly_pdf",
    expected_fields: {
      document_type: "payslip", salary_period: period, salary_type: "monthly",
      base_monthly_salary: money(850_000), travel_amount: money(50_000), gross_salary: money(900_000),
      net_salary: money(765_000), vacation_balance: { amount: "10", unit: "days" },
      sick_balance: { amount: "20", unit: "days" },
    },
    expected_absent_fields: [],
    critical_fields: ["salary_period", "salary_type", "gross_salary"],
    expected_validation_issue_codes: [],
  },
  {
    fixture_id: "clean_hourly_png",
    expected_fields: {
      document_type: "payslip", salary_period: period, salary_type: "hourly", hourly_rate: money(4_500),
      regular_hours: hours("182.5"), base_monthly_salary: money(821_250), gross_salary: money(821_250), net_salary: money(701_000),
    },
    expected_absent_fields: [],
    critical_fields: ["salary_period", "salary_type", "hourly_rate", "regular_hours", "gross_salary"],
    expected_validation_issue_codes: [],
  },
  {
    fixture_id: "overtime_jpg",
    expected_fields: {
      document_type: "payslip", salary_period: period, salary_type: "monthly", base_monthly_salary: money(850_000),
      overtime_125_hours: hours("18.25"), overtime_150_hours: hours("6.5"), gross_salary: money(1_014_500), net_salary: money(854_000),
    },
    expected_absent_fields: [],
    critical_fields: ["salary_period", "salary_type", "gross_salary", "overtime_125_hours", "overtime_150_hours"],
    expected_validation_issue_codes: [],
  },
  {
    fixture_id: "pension_heavy_pdf",
    expected_fields: {
      document_type: "payslip", salary_period: period, salary_type: "monthly", base_monthly_salary: money(1_000_000),
      pension_base: money(1_000_000), pension_employee_contribution: money(60_000), pension_employee_rate: { basis_points: 600 },
      pension_employer_contribution: money(65_000), pension_employer_rate: { basis_points: 650 },
      severance_contribution: money(83_300), severance_rate: { basis_points: 833 }, gross_salary: money(1_000_000), net_salary: money(840_000),
    },
    expected_absent_fields: [],
    critical_fields: ["salary_period", "salary_type", "gross_salary", "pension_base", "pension_employee_contribution", "pension_employer_contribution", "severance_contribution"],
    expected_validation_issue_codes: [],
  },
  {
    fixture_id: "hebrew_rtl_dense_png",
    expected_fields: {
      document_type: "payslip", salary_period: period, salary_type: "monthly", base_monthly_salary: money(850_000),
      regular_hours: hours("182"), travel_amount: money(50_000), convalescence_amount: money(45_000), pension_base: money(850_000),
      pension_employee_contribution: money(51_000), pension_employee_rate: { basis_points: 600 },
      pension_employer_contribution: money(55_250), pension_employer_rate: { basis_points: 650 },
      severance_contribution: money(70_805), severance_rate: { basis_points: 833 }, gross_salary: money(945_000), net_salary: money(798_000),
    },
    expected_absent_fields: [],
    critical_fields: ["salary_period", "salary_type", "gross_salary", "pension_base", "pension_employee_contribution", "pension_employer_contribution", "severance_contribution"],
    expected_validation_issue_codes: [],
  },
  {
    fixture_id: "low_resolution_jpg",
    expected_fields: {
      document_type: "payslip", salary_period: period, salary_type: "hourly", hourly_rate: money(4_500),
      regular_hours: hours("182.5"), gross_salary: money(821_250), net_salary: money(701_000),
    },
    expected_absent_fields: [],
    critical_fields: ["salary_period", "salary_type", "hourly_rate", "regular_hours", "gross_salary"],
    expected_validation_issue_codes: [],
  },
  {
    fixture_id: "rotated_scan_png",
    expected_fields: {
      document_type: "payslip", salary_period: period, salary_type: "monthly", base_monthly_salary: money(850_000),
      travel_amount: money(50_000), gross_salary: money(900_000), net_salary: money(765_000),
    },
    expected_absent_fields: [],
    critical_fields: ["salary_period", "salary_type", "gross_salary"],
    expected_validation_issue_codes: [],
  },
  {
    fixture_id: "blurred_compressed_scan_jpg",
    expected_fields: {
      document_type: "payslip", salary_period: period, salary_type: "monthly", base_monthly_salary: money(850_000),
      convalescence_amount: money(45_000), gross_salary: money(895_000), net_salary: money(758_000),
    },
    expected_absent_fields: [],
    critical_fields: ["salary_period", "salary_type", "gross_salary"],
    expected_validation_issue_codes: [],
  },
  {
    fixture_id: "ambiguous_number_pdf",
    expected_fields: {
      document_type: "payslip", salary_period: period, salary_type: "monthly", base_monthly_salary: money(8_500_000),
      gross_salary: money(850_000), net_salary: money(720_000), regular_hours: hours("182.5"),
    },
    expected_absent_fields: [],
    critical_fields: ["salary_period", "salary_type", "gross_salary"],
    expected_validation_issue_codes: ["ocr_scale_mismatch"],
  },
  {
    fixture_id: "contradictory_arithmetic_png",
    expected_fields: {
      document_type: "payslip", salary_period: period, salary_type: "monthly", base_monthly_salary: money(850_000),
      travel_amount: money(50_000), gross_salary: money(1_200_000), net_salary: money(1_010_000),
    },
    expected_absent_fields: [],
    critical_fields: ["salary_period", "salary_type", "gross_salary"],
    expected_validation_issue_codes: ["gross_component_mismatch"],
  },
];
