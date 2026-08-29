import "server-only";
import type { PayslipFieldKey } from "@/engine/extraction/contracts";

export type RealPublicLayoutMetadata = Readonly<{
  approximate_year: number;
  pay_period: string;
  vendor_style: string;
  density: "dense" | "moderate" | "sparse";
  table_complexity: "high" | "medium" | "low";
  source_kind: "raster_image";
  hebrew_rtl_quality: "clear" | "mostly_clear" | "soft";
  font_size: "small" | "very_small";
  quality_issues: readonly string[];
  visible_pii_categories: readonly string[];
}>;

export type RealPublicGroundTruth = Readonly<{
  fixture_id: string;
  expected_fields: Partial<Record<PayslipFieldKey, unknown>>;
  ambiguous_fields: readonly Readonly<{ field: PayslipFieldKey; reason_code: string }>[];
  expected_absent_fields: readonly PayslipFieldKey[];
  critical_fields: readonly PayslipFieldKey[];
  expected_validation_issue_codes: readonly string[];
  classification_complete: true;
  additional_component_observations: readonly Readonly<{
    observation_id: string;
    amount: Readonly<{ currency: "ILS"; minor_units: number }>;
    classification: "clear_unmapped_component";
  }>[];
  layout: RealPublicLayoutMetadata;
}>;

const money = (minor_units: number) => ({ currency: "ILS" as const, minor_units });
const hours = (amount: string) => ({ amount, unit: "hours_per_month" as const });
const days = (amount: string) => ({ amount, unit: "days" as const });
const period = (year: number, month: number, endDay: number) => ({
  year,
  month,
  start_date: `${year}-${month.toString().padStart(2, "0")}-01`,
  end_date: `${year}-${month.toString().padStart(2, "0")}-${endDay.toString().padStart(2, "0")}`,
});

const visiblePii = [
  "employee_name",
  "national_id",
  "address",
  "bank_account",
  "employer_identity",
] as const;

export const realPublicPayslipGroundTruth: readonly RealPublicGroundTruth[] = [
  {
    fixture_id: "REAL_PUBLIC_001",
    classification_complete: true,
    expected_fields: {
      document_type: "payslip",
      salary_period: period(2022, 7, 31),
      salary_type: "hourly",
      hourly_rate: money(2_912),
      regular_hours: hours("14.42"),
      overtime_125_hours: hours("2"),
      overtime_150_hours: hours("1.28"),
      gross_salary: money(719_960),
      net_salary: money(705_740),
      travel_amount: money(6_500),
      pension_employee_contribution: money(2_520),
    },
    ambiguous_fields: [
      { field: "pension_base", reason_code: "multiple_pension_totals_without_clear_current_period_label" },
      { field: "pension_employer_contribution", reason_code: "multiple_pension_columns_without_unambiguous_total" },
      { field: "severance_contribution", reason_code: "multiple_pension_columns_without_unambiguous_total" },
      { field: "pension_employee_rate", reason_code: "rate_not_clearly_labeled" },
      { field: "pension_employer_rate", reason_code: "rate_not_clearly_labeled" },
      { field: "severance_rate", reason_code: "rate_not_clearly_labeled" },
    ],
    expected_absent_fields: [
      "employment_start_date", "base_monthly_salary", "convalescence_amount", "vacation_balance", "sick_balance",
    ],
    critical_fields: [
      "salary_period", "salary_type", "hourly_rate", "regular_hours", "overtime_125_hours",
      "overtime_150_hours", "gross_salary", "pension_employee_contribution",
    ],
    expected_validation_issue_codes: [],
    additional_component_observations: [
      { observation_id: "ADDITIONAL_001", amount: money(264_710), classification: "clear_unmapped_component" },
      { observation_id: "ADDITIONAL_002", amount: money(280_950), classification: "clear_unmapped_component" },
    ],
    layout: {
      approximate_year: 2022,
      pay_period: "2022-07",
      vendor_style: "legacy_israeli_tabular_payroll",
      density: "dense",
      table_complexity: "high",
      source_kind: "raster_image",
      hebrew_rtl_quality: "mostly_clear",
      font_size: "very_small",
      quality_issues: ["medium_resolution", "small_text", "dense_multi_table_layout"],
      visible_pii_categories: visiblePii,
    },
  },
  {
    fixture_id: "REAL_PUBLIC_002",
    classification_complete: true,
    expected_fields: {
      document_type: "payslip",
      salary_period: period(2023, 1, 31),
      salary_type: "monthly",
      base_monthly_salary: money(1_630_038),
      gross_salary: money(1_655_738),
      net_salary: money(515_442),
      pension_base: money(1_630_038),
      pension_employee_contribution: money(156_396),
      severance_contribution: money(135_782),
    },
    ambiguous_fields: [
      { field: "travel_amount", reason_code: "reimbursement_rows_not_unambiguously_travel" },
      { field: "pension_employer_contribution", reason_code: "employer_total_combines_multiple_fund_categories" },
      { field: "pension_employee_rate", reason_code: "multiple_fund_rows" },
      { field: "pension_employer_rate", reason_code: "multiple_fund_rows" },
      { field: "severance_rate", reason_code: "multiple_fund_rows" },
    ],
    expected_absent_fields: [
      "employment_start_date", "hourly_rate", "regular_hours", "overtime_125_hours", "overtime_150_hours",
      "convalescence_amount", "vacation_balance", "sick_balance",
    ],
    critical_fields: [
      "salary_period", "salary_type", "gross_salary", "pension_base", "pension_employee_contribution",
      "severance_contribution",
    ],
    expected_validation_issue_codes: [],
    additional_component_observations: [
      { observation_id: "ADDITIONAL_001", amount: money(-14_013), classification: "clear_unmapped_component" },
      { observation_id: "ADDITIONAL_002", amount: money(25_700), classification: "clear_unmapped_component" },
    ],
    layout: {
      approximate_year: 2023,
      pay_period: "2023-01",
      vendor_style: "legacy_israeli_tabular_payroll",
      density: "dense",
      table_complexity: "high",
      source_kind: "raster_image",
      hebrew_rtl_quality: "clear",
      font_size: "small",
      quality_issues: ["medium_resolution", "dense_pension_table", "many_legacy_component_codes"],
      visible_pii_categories: visiblePii,
    },
  },
  {
    fixture_id: "REAL_PUBLIC_003",
    classification_complete: true,
    expected_fields: {
      document_type: "payslip",
      salary_period: period(2023, 4, 30),
      salary_type: "hourly",
      hourly_rate: money(3_193),
      regular_hours: hours("104.05"),
      overtime_125_hours: hours("12.45"),
      overtime_150_hours: hours("4.48"),
      gross_salary: money(712_769),
      net_salary: money(635_950),
      travel_amount: money(29_250),
      pension_employee_contribution: money(34_922),
    },
    ambiguous_fields: [
      { field: "convalescence_amount", reason_code: "legacy_component_label_not_visually_unambiguous" },
    ],
    expected_absent_fields: [
      "employment_start_date", "base_monthly_salary", "pension_base", "pension_employer_contribution",
      "severance_contribution", "pension_employee_rate", "pension_employer_rate", "severance_rate",
      "vacation_balance", "sick_balance",
    ],
    critical_fields: [
      "salary_period", "salary_type", "hourly_rate", "regular_hours", "overtime_125_hours",
      "overtime_150_hours", "gross_salary", "pension_employee_contribution",
    ],
    expected_validation_issue_codes: [],
    additional_component_observations: [
      { observation_id: "ADDITIONAL_001", amount: money(90_681), classification: "clear_unmapped_component" },
      { observation_id: "ADDITIONAL_002", amount: money(68_292), classification: "clear_unmapped_component" },
    ],
    layout: {
      approximate_year: 2023,
      pay_period: "2023-04",
      vendor_style: "legacy_israeli_tabular_payroll",
      density: "dense",
      table_complexity: "high",
      source_kind: "raster_image",
      hebrew_rtl_quality: "soft",
      font_size: "very_small",
      quality_issues: ["medium_resolution", "soft_text", "dense_legacy_component_codes"],
      visible_pii_categories: visiblePii,
    },
  },
  {
    fixture_id: "REAL_PUBLIC_004",
    classification_complete: true,
    expected_fields: {
      document_type: "payslip",
      salary_period: period(2023, 2, 28),
      salary_type: "hourly",
      hourly_rate: money(3_400),
      regular_hours: hours("46"),
      overtime_125_hours: hours("4.17"),
      overtime_150_hours: hours("4.1"),
      gross_salary: money(632_015),
      net_salary: money(574_398),
      pension_base: money(570_275),
      pension_employee_contribution: money(34_217),
      pension_employer_contribution: money(57_068),
      severance_contribution: money(47_504),
    },
    ambiguous_fields: [
      { field: "travel_amount", reason_code: "reimbursement_row_not_unambiguously_travel" },
    ],
    expected_absent_fields: [
      "employment_start_date", "base_monthly_salary", "convalescence_amount", "pension_employee_rate",
      "pension_employer_rate", "severance_rate", "vacation_balance", "sick_balance",
    ],
    critical_fields: [
      "salary_period", "salary_type", "hourly_rate", "regular_hours", "overtime_125_hours",
      "overtime_150_hours", "gross_salary", "pension_base", "pension_employee_contribution",
      "pension_employer_contribution", "severance_contribution",
    ],
    expected_validation_issue_codes: [],
    additional_component_observations: [
      { observation_id: "ADDITIONAL_001", amount: money(108_800), classification: "clear_unmapped_component" },
      { observation_id: "ADDITIONAL_002", amount: money(100_055), classification: "clear_unmapped_component" },
    ],
    layout: {
      approximate_year: 2023,
      pay_period: "2023-02",
      vendor_style: "legacy_israeli_tabular_payroll",
      density: "dense",
      table_complexity: "high",
      source_kind: "raster_image",
      hebrew_rtl_quality: "clear",
      font_size: "very_small",
      quality_issues: ["medium_resolution", "dense_component_table", "many_legacy_percentage_rows"],
      visible_pii_categories: visiblePii,
    },
  },
  {
    fixture_id: "REAL_PUBLIC_005",
    classification_complete: true,
    expected_fields: {
      document_type: "payslip",
      salary_period: period(2024, 1, 31),
      salary_type: "hourly",
      hourly_rate: money(3_061),
      regular_hours: hours("3"),
      gross_salary: money(10_280),
      net_salary: money(9_430),
      travel_amount: money(1_100),
      pension_employee_contribution: money(550),
      pension_employer_contribution: money(600),
      severance_contribution: money(760),
      vacation_balance: days("4"),
      sick_balance: days("4.37"),
    },
    ambiguous_fields: [
      { field: "pension_base", reason_code: "pension_base_not_explicitly_labeled" },
    ],
    expected_absent_fields: [
      "employment_start_date", "base_monthly_salary", "overtime_125_hours", "overtime_150_hours",
      "convalescence_amount", "pension_employee_rate", "pension_employer_rate", "severance_rate",
    ],
    critical_fields: [
      "salary_period", "salary_type", "hourly_rate", "regular_hours", "gross_salary",
      "pension_employee_contribution", "pension_employer_contribution", "severance_contribution",
    ],
    expected_validation_issue_codes: [],
    additional_component_observations: [],
    layout: {
      approximate_year: 2024,
      pay_period: "2024-01",
      vendor_style: "legacy_israeli_tabular_payroll",
      density: "moderate",
      table_complexity: "medium",
      source_kind: "raster_image",
      hebrew_rtl_quality: "mostly_clear",
      font_size: "small",
      quality_issues: ["medium_resolution", "very_low_salary_values", "small_pension_values"],
      visible_pii_categories: visiblePii,
    },
  },
];
