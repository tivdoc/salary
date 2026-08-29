import "server-only";

export type RenderedFixtureFormat = "pdf" | "png" | "jpg";
export type RenderedFixtureQuality = "clean" | "dense" | "low_resolution" | "rotated" | "blurred" | "ambiguous" | "contradictory";

export type RenderedPayslipRow = Readonly<{
  label: string;
  value: string;
  quantity?: string;
  rate?: string;
}>;

export type RenderedPayslipFixtureSpec = Readonly<{
  fixture_id: string;
  title: string;
  format: RenderedFixtureFormat;
  quality: RenderedFixtureQuality;
  salary_period: string;
  salary_type: "monthly" | "hourly" | "mixed";
  employee_name: string;
  employer_name: string;
  employee_id: string;
  dense: boolean;
  earnings_components_complete: boolean;
  rows: readonly RenderedPayslipRow[];
}>;

const identity = (number: number) => ({
  employee_name: `עובד/ת בדוי/ה ${number.toString().padStart(3, "0")}`,
  employer_name: `חברת ניסוי דמיונית ${number.toString().padStart(3, "0")} בע"מ`,
  employee_id: `0000000${number.toString().padStart(2, "0")}`,
});

export const renderedPayslipFixtureSpecs: readonly RenderedPayslipFixtureSpec[] = [
  {
    fixture_id: "clean_monthly_pdf",
    title: "Clean monthly payslip",
    format: "pdf",
    quality: "clean",
    salary_period: "08/2026",
    salary_type: "monthly",
    ...identity(1),
    dense: false,
    earnings_components_complete: true,
    rows: [
      { label: "Base monthly salary / שכר יסוד", value: "8,500.00" },
      { label: "Travel / נסיעות", value: "500.00" },
      { label: "Gross / ברוטו", value: "9,000.00" },
      { label: "Net / נטו", value: "7,650.00" },
      { label: "Vacation balance / יתרת חופשה", value: "10 days" },
      { label: "Sick balance / יתרת מחלה", value: "20 days" },
    ],
  },
  {
    fixture_id: "clean_hourly_png",
    title: "Clean hourly payslip",
    format: "png",
    quality: "clean",
    salary_period: "08/2026",
    salary_type: "hourly",
    ...identity(2),
    dense: false,
    earnings_components_complete: true,
    rows: [
      { label: "Hourly rate / תעריף שעה", value: "45.00" },
      { label: "Regular hours / שעות רגילות", value: "182.50" },
      { label: "Base pay / שכר בסיס", value: "8,212.50" },
      { label: "Gross / ברוטו", value: "8,212.50" },
      { label: "Net / נטו", value: "7,010.00" },
    ],
  },
  {
    fixture_id: "overtime_jpg",
    title: "Overtime payslip",
    format: "jpg",
    quality: "clean",
    salary_period: "08/2026",
    salary_type: "monthly",
    ...identity(3),
    dense: false,
    earnings_components_complete: true,
    rows: [
      { label: "Base monthly salary / שכר יסוד", value: "8,500.00" },
      { label: "Overtime 125% / שעות נוספות 125%", value: "18.25 hours" },
      { label: "Overtime 150% / שעות נוספות 150%", value: "6.5 hours" },
      { label: "Gross / ברוטו", value: "10,145.00" },
      { label: "Net / נטו", value: "8,540.00" },
    ],
  },
  {
    fixture_id: "pension_heavy_pdf",
    title: "Pension-heavy payslip",
    format: "pdf",
    quality: "clean",
    salary_period: "08/2026",
    salary_type: "monthly",
    ...identity(4),
    dense: false,
    earnings_components_complete: true,
    rows: [
      { label: "Base monthly salary / שכר יסוד", value: "10,000.00" },
      { label: "Pension base / שכר מבוטח", value: "10,000.00" },
      { label: "Employee pension / עובד", value: "600.00", rate: "6%" },
      { label: "Employer pension / מעסיק", value: "650.00", rate: "6.5%" },
      { label: "Severance / פיצויים", value: "833.00", rate: "8.33%" },
      { label: "Gross / ברוטו", value: "10,000.00" },
      { label: "Net / נטו", value: "8,400.00" },
    ],
  },
  {
    fixture_id: "hebrew_rtl_dense_png",
    title: "Hebrew RTL dense payslip",
    format: "png",
    quality: "dense",
    salary_period: "אוגוסט 2026",
    salary_type: "monthly",
    ...identity(5),
    dense: true,
    earnings_components_complete: true,
    rows: [
      { label: "שכר יסוד", value: "8,500.00" },
      { label: "שעות רגילות", value: "182 שעות" },
      { label: "נסיעות", value: "500.00" },
      { label: "הבראה", value: "450.00" },
      { label: "בסיס לפנסיה", value: "8,500.00" },
      { label: "תגמולי עובד", value: "510.00", rate: "6%" },
      { label: "תגמולי מעסיק", value: "552.50", rate: "6.5%" },
      { label: "פיצויים", value: "708.05", rate: "8.33%" },
      { label: "ברוטו", value: "9,450.00" },
      { label: "נטו", value: "7,980.00" },
    ],
  },
  {
    fixture_id: "low_resolution_jpg",
    title: "Low-resolution scan",
    format: "jpg",
    quality: "low_resolution",
    salary_period: "08/2026",
    salary_type: "hourly",
    ...identity(6),
    dense: false,
    earnings_components_complete: true,
    rows: [
      { label: "Hourly rate / תעריף שעה", value: "45.00" },
      { label: "Regular hours / שעות רגילות", value: "182.50" },
      { label: "Gross / ברוטו", value: "8,212.50" },
      { label: "Net / נטו", value: "7,010.00" },
    ],
  },
  {
    fixture_id: "rotated_scan_png",
    title: "Mildly rotated scan",
    format: "png",
    quality: "rotated",
    salary_period: "08/2026",
    salary_type: "monthly",
    ...identity(7),
    dense: false,
    earnings_components_complete: true,
    rows: [
      { label: "Base monthly salary / שכר יסוד", value: "8,500.00" },
      { label: "Travel / נסיעות", value: "500.00" },
      { label: "Gross / ברוטו", value: "9,000.00" },
      { label: "Net / נטו", value: "7,650.00" },
    ],
  },
  {
    fixture_id: "blurred_compressed_scan_jpg",
    title: "Blurred compressed scan",
    format: "jpg",
    quality: "blurred",
    salary_period: "08/2026",
    salary_type: "monthly",
    ...identity(8),
    dense: false,
    earnings_components_complete: true,
    rows: [
      { label: "Base monthly salary / שכר יסוד", value: "8,500.00" },
      { label: "Convalescence / הבראה", value: "450.00" },
      { label: "Gross / ברוטו", value: "8,950.00" },
      { label: "Net / נטו", value: "7,580.00" },
    ],
  },
  {
    fixture_id: "ambiguous_number_pdf",
    title: "Ambiguous-number payslip",
    format: "pdf",
    quality: "ambiguous",
    salary_period: "08/2026",
    salary_type: "monthly",
    ...identity(9),
    dense: false,
    earnings_components_complete: true,
    rows: [
      { label: "Base monthly salary - transcribe exactly", value: "85,000" },
      { label: "Gross / ברוטו", value: "8,500" },
      { label: "Net / נטו", value: "7,200" },
      { label: "Reference hours / שעות", value: "182.50" },
    ],
  },
  {
    fixture_id: "contradictory_arithmetic_png",
    title: "Contradictory-arithmetic payslip",
    format: "png",
    quality: "contradictory",
    salary_period: "08/2026",
    salary_type: "monthly",
    ...identity(10),
    dense: false,
    earnings_components_complete: true,
    rows: [
      { label: "Base monthly salary / שכר יסוד", value: "8,500.00" },
      { label: "Travel / נסיעות", value: "500.00" },
      { label: "Gross / ברוטו", value: "12,000.00" },
      { label: "Net / נטו", value: "10,100.00" },
      { label: "Synthetic unknown component / רכיב לא ממופה", value: "750.00" },
    ],
  },
];
