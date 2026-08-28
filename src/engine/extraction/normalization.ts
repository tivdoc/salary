import { moneySchema, type Money } from "../domain/primitives";
import { extractionResultSchema, type ExtractionResult, type RawCandidateField } from "./contracts";
import {
  normalizedCandidateFieldSchema,
  normalizedPayslipExtractionSchema,
  type NormalizedPayslipExtraction,
  type SalaryPeriod,
} from "./payslip";

const hebrewMonths: Readonly<Record<string, number>> = {
  ינואר: 1,
  פברואר: 2,
  מרץ: 3,
  אפריל: 4,
  מאי: 5,
  יוני: 6,
  יולי: 7,
  אוגוסט: 8,
  ספטמבר: 9,
  אוקטובר: 10,
  נובמבר: 11,
  דצמבר: 12,
};

function canonicalDecimal(negative: boolean, whole: string, fraction: string) {
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = fraction.replace(/0+$/, "");
  const magnitude = normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole;
  return negative && magnitude !== "0" ? `-${magnitude}` : magnitude;
}

function decimalParts(raw: string, treatThreeDigitsAsThousands: boolean) {
  let value = raw
    .normalize("NFKC")
    .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
    .replace(/[\s\u00a0]/g, "")
    .trim();
  const parenthesesNegative = /^\(.*\)$/.test(value);
  if (parenthesesNegative) value = value.slice(1, -1);
  const signNegative = value.startsWith("-");
  if (value.startsWith("-") || value.startsWith("+")) value = value.slice(1);
  if (!/^\d[\d.,]*$/.test(value)) return null;

  const separators = [...value].map((character, index) => ({ character, index })).filter(({ character }) => character === "." || character === ",");
  if (separators.length === 0) return { negative: parenthesesNegative || signNegative, whole: value, fraction: "" };

  let decimalIndex = -1;
  if (separators.some(({ character }) => character === ".") && separators.some(({ character }) => character === ",")) {
    decimalIndex = separators.at(-1)?.index ?? -1;
  } else if (separators.length === 1) {
    const separator = separators[0];
    const digitsAfter = value.length - separator.index - 1;
    if (!(treatThreeDigitsAsThousands && digitsAfter === 3 && separator.index >= 1 && separator.index <= 3)) {
      decimalIndex = separator.index;
    }
  } else {
    const groups = value.split(separators[0].character);
    const allThousands = groups.slice(1).every((group) => group.length === 3);
    if (!treatThreeDigitsAsThousands || !allThousands) decimalIndex = separators.at(-1)?.index ?? -1;
  }

  const wholeSource = decimalIndex < 0 ? value : value.slice(0, decimalIndex);
  const fraction = decimalIndex < 0 ? "" : value.slice(decimalIndex + 1);
  const whole = wholeSource.replace(/[.,]/g, "");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) return null;
  return { negative: parenthesesNegative || signNegative, whole, fraction };
}

export function normalizeDecimal(raw: string, treatThreeDigitsAsThousands = false) {
  const cleaned = raw
    .replace(/(?:שעות?|ימים?|hours?|hrs?|days?)/gi, "")
    .trim();
  const parts = decimalParts(cleaned, treatThreeDigitsAsThousands);
  if (!parts) return null;
  return canonicalDecimal(parts.negative, parts.whole, parts.fraction);
}

export function normalizeMoney(raw: string, currency = "ILS"): Money | null {
  const cleaned = raw
    .replace(/₪|nis|ils|ש["״']?ח/gi, "")
    .trim();
  const parts = decimalParts(cleaned, true);
  if (!parts) return null;
  const fractionWithoutTrailingZeros = parts.fraction.replace(/0+$/, "");
  if (fractionWithoutTrailingZeros.length > 2) return null;
  const cents = (parts.fraction + "00").slice(0, 2);
  const absoluteMinorUnits = BigInt(parts.whole) * BigInt(100) + BigInt(cents || "0");
  const signedMinorUnits = parts.negative ? -absoluteMinorUnits : absoluteMinorUnits;
  if (signedMinorUnits > BigInt(Number.MAX_SAFE_INTEGER) || signedMinorUnits < BigInt(Number.MIN_SAFE_INTEGER)) {
    return null;
  }
  return moneySchema.parse({ currency, minor_units: Number(signedMinorUnits) });
}

export function normalizeHours(raw: string) {
  const amount = normalizeDecimal(raw);
  return amount === null ? null : { amount, unit: "hours_per_month" as const };
}

export function normalizePercentage(raw: string) {
  const cleaned = raw.replace(/%/g, "").trim();
  const parts = decimalParts(cleaned, false);
  if (!parts) return null;
  const significantFraction = parts.fraction.replace(/0+$/, "");
  if (significantFraction.length > 2) return null;
  const fraction = (parts.fraction + "00").slice(0, 2);
  const absoluteBasisPoints = BigInt(parts.whole) * BigInt(100) + BigInt(fraction || "0");
  const basisPoints = parts.negative ? -absoluteBasisPoints : absoluteBasisPoints;
  if (basisPoints > BigInt(Number.MAX_SAFE_INTEGER) || basisPoints < BigInt(Number.MIN_SAFE_INTEGER)) return null;
  return { basis_points: Number(basisPoints) };
}

function isoDate(year: number, month: number, day: number) {
  const maximumDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > maximumDay) return null;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

export function normalizeSalaryPeriod(raw: string): SalaryPeriod | null {
  const value = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
  let year: number;
  let month: number;
  const monthYear = value.match(/^(\d{1,2})[/.\-](\d{2}|\d{4})$/);
  const yearMonth = value.match(/^(\d{4})[/.\-](\d{1,2})$/);
  const hebrew = value.match(/^([א-ת]+)\s+(\d{4})$/);
  if (monthYear) {
    month = Number(monthYear[1]);
    year = monthYear[2].length === 2 ? 2000 + Number(monthYear[2]) : Number(monthYear[2]);
  } else if (yearMonth) {
    year = Number(yearMonth[1]);
    month = Number(yearMonth[2]);
  } else if (hebrew && hebrewMonths[hebrew[1]]) {
    month = hebrewMonths[hebrew[1]];
    year = Number(hebrew[2]);
  } else {
    return null;
  }
  const startDate = isoDate(year, month, 1);
  const endDate = isoDate(year, month, new Date(Date.UTC(year, month, 0)).getUTCDate());
  if (!startDate || !endDate) return null;
  return { year, month, start_date: startDate, end_date: endDate };
}

export function normalizeExplicitDate(raw: string) {
  const value = raw.normalize("NFKC").trim();
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const local = value.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (!local || Number(local[1]) <= 12) return null;
  return isoDate(Number(local[3]), Number(local[2]), Number(local[1]));
}

function normalizeSalaryType(raw: string) {
  const value = raw.normalize("NFKC").trim().toLowerCase();
  if (["monthly", "חודשי", "משכורת חודשית"].includes(value)) return "monthly" as const;
  if (["hourly", "שעתי", "שכר שעתי"].includes(value)) return "hourly" as const;
  if (["mixed", "משולב"].includes(value)) return "mixed" as const;
  return null;
}

function normalizeDocumentType(raw: string) {
  const value = raw.normalize("NFKC").trim().toLowerCase();
  if (["payslip", "תלוש", "תלוש שכר"].includes(value)) return "payslip" as const;
  if (["unknown", "לא ידוע"].includes(value)) return "unknown" as const;
  return null;
}

function normalizeBalance(raw: string) {
  const value = raw.normalize("NFKC").toLowerCase();
  const unit = /שעות|hours?|hrs?/.test(value) ? "hours" : /ימים|days?/.test(value) ? "days" : null;
  const amount = normalizeDecimal(value);
  return amount === null || unit === null ? null : { amount, unit };
}

function normalizedValue(candidate: RawCandidateField) {
  switch (candidate.field) {
    case "document_type":
      return normalizeDocumentType(candidate.raw_value);
    case "salary_period":
      return normalizeSalaryPeriod(candidate.raw_value);
    case "employment_start_date":
      return normalizeExplicitDate(candidate.raw_value);
    case "salary_type":
      return normalizeSalaryType(candidate.raw_value);
    case "base_monthly_salary":
    case "hourly_rate":
    case "gross_salary":
    case "net_salary":
    case "travel_amount":
    case "convalescence_amount":
    case "pension_employee_contribution":
    case "pension_employer_contribution":
    case "severance_contribution":
    case "pension_base":
      return normalizeMoney(candidate.raw_value);
    case "regular_hours":
    case "overtime_125_hours":
    case "overtime_150_hours":
      return normalizeHours(candidate.raw_value);
    case "pension_employee_rate":
    case "pension_employer_rate":
    case "severance_rate":
      return normalizePercentage(candidate.raw_value);
    case "vacation_balance":
    case "sick_balance":
      return normalizeBalance(candidate.raw_value);
  }
}

export function normalizePayslipExtraction(input: ExtractionResult): NormalizedPayslipExtraction {
  const extraction = extractionResultSchema.parse(input);
  const fields = extraction.fields.map((candidate) => {
    const value = normalizedValue(candidate);
    const warningFlags = value === null && !candidate.warning_flags.includes("normalization_failed")
      ? [...candidate.warning_flags, "normalization_failed"]
      : candidate.warning_flags;
    return normalizedCandidateFieldSchema.parse({
      ...candidate,
      normalized_value: value,
      warning_flags: warningFlags,
    });
  });
  const additionalComponents = extraction.additional_components.map((component) => {
    const quantity = component.quantity_raw === null ? null : normalizeDecimal(component.quantity_raw);
    const rate = component.rate_raw === null ? null : normalizeMoney(component.rate_raw);
    const amount = component.amount_raw === null ? null : normalizeMoney(component.amount_raw);
    const normalizationWarnings = [
      component.quantity_raw !== null && quantity === null ? "quantity_normalization_failed" : null,
      component.rate_raw !== null && rate === null ? "rate_normalization_failed" : null,
      component.amount_raw !== null && amount === null ? "amount_normalization_failed" : null,
    ].filter((warning): warning is string => warning !== null);
    return {
      ...component,
      quantity,
      rate,
      amount,
      normalization_warnings: normalizationWarnings,
    };
  });
  return normalizedPayslipExtractionSchema.parse({
    ...extraction,
    fields,
    additional_components: additionalComponents,
  });
}
