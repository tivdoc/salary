// L11-4 / D3.4 (run 11). The convalescence day rate, keyed by convalescence
// year, with knowledge time.
//
// The lawyer-approved opinion (5.9.2026) settled the period question the
// 2026 order left open: the rate is set per CONVALESCENCE YEAR — the twelve
// months from 1 July to 30 June, named for the year in which they end — and
// the 451.50 of the 2026 order is the rate for convalescence year 2026,
// 1.7.2025 to 30.6.2026. The order was published on 18.8.2026, after most
// of that year's payments were made, and applies to all of it: the rate has a
// VALID time (the convalescence year) and a KNOWLEDGE time (the publication),
// and a payment made at the old rate before the publication is a shortfall
// the employer must make up, tagged as a retroactive update rather than an
// ordinary gap.
//
// What is not known is not guessed. Convalescence year 2027 (from 1.7.2026)
// has no published rate: a computation for it refuses with
// `rate_not_published` — not 418, not 451.50 by default. Years before the
// table's first row are outside it; the 2023 order's 418 is registered as
// its own parameter version, and how the 2024 and 2025 freeze laws count a
// "year" is the opinion's open item V10 for the lawyer, so no row is written
// for them here.
//
// Which convalescence year a PAYMENT covers is, by the opinion's default, the
// year of the payslip: the summer payments of June to September Y pay for
// convalescence year Y (which ended on 30 June Y), and a January-to-May
// payment is a partial or final payment for the same year. A payslip that
// states another year would override this; that input does not exist yet.
export const CONVALESCENCE_RATE_TABLE_SCHEMA = "tivdoc-convalescence-rate-table-v1" as const;
export const RATE_NOT_PUBLISHED = "rate_not_published" as const;
export const RATE_NOT_IN_TABLE = "rate_not_in_table" as const;
export const HAVRAA_YEAR_BRANCH = "havraa_year" as const;

export type HavraaRateRow = Readonly<{
  havraa_year: number;
  rate_minor_units: number;
  valid_from: string;
  valid_to: string;
  known_at: string;
  retroactive: boolean;
  parameter_version_id: string;
  source: string;
}>;

export const HAVRAA_RATE_TABLE: readonly HavraaRateRow[] = Object.freeze([
  {
    havraa_year: 2026,
    rate_minor_units: 45_150,
    valid_from: "2025-07-01",
    valid_to: "2026-06-30",
    known_at: "2026-08-18",
    retroactive: true,
    parameter_version_id: "il.convalescence.daily_rate@2026.3.0",
    source: "IL_CONVALESCENCE_EXTENSION_ORDER_2026@discovery-v0.2 (gazette 14863, page 9134), published 18.8.2026 per the lawyer-approved opinion of 5.9.2026; the gazette number and date of publication are the opinion's open item V8",
  },
]);

const iso = /^\d{4}-\d{2}-\d{2}$/u;

/** The convalescence year an ENTITLEMENT date falls in: 1.7.Y−1 … 30.6.Y → Y. */
export function havraaYearOf(isoDate: string): number {
  if (!iso.test(isoDate)) throw new Error(`CONVALESCENCE_DATE_MALFORMED:${isoDate}`);
  const year = Number.parseInt(isoDate.slice(0, 4), 10);
  const month = Number.parseInt(isoDate.slice(5, 7), 10);
  return month >= 7 ? year + 1 : year;
}

/** The convalescence year a PAYMENT in this payslip month covers, by the opinion's default: the year of the payslip. */
export function havraaYearPaidFor(paymentPeriodStart: string): number {
  if (!iso.test(paymentPeriodStart)) throw new Error(`CONVALESCENCE_DATE_MALFORMED:${paymentPeriodStart}`);
  return Number.parseInt(paymentPeriodStart.slice(0, 4), 10);
}

export type HavraaRateLookup =
  | Readonly<{ status: "known"; havraa_year: number; row: HavraaRateRow }>
  | Readonly<{ status: "unknown"; havraa_year: number; refusal: typeof RATE_NOT_PUBLISHED; note: string }>
  | Readonly<{ status: "outside_table"; havraa_year: number; refusal: typeof RATE_NOT_IN_TABLE; note: string }>;

export function havraaRateFor(havraaYear: number): HavraaRateLookup {
  const row = HAVRAA_RATE_TABLE.find((entry) => entry.havraa_year === havraaYear);
  if (row) return { status: "known", havraa_year: havraaYear, row };
  const latest = Math.max(...HAVRAA_RATE_TABLE.map((entry) => entry.havraa_year));
  if (havraaYear > latest) {
    return {
      status: "unknown", havraa_year: havraaYear, refusal: RATE_NOT_PUBLISHED,
      note: `no rate is published for convalescence year ${havraaYear} (from 1.7.${havraaYear - 1}); neither 418 nor 451.50 is assumed`,
    };
  }
  return {
    status: "outside_table", havraa_year: havraaYear, refusal: RATE_NOT_IN_TABLE,
    note: `convalescence year ${havraaYear} precedes the table's first row; the 2023 order's 418 is registered as il.convalescence.daily_rate@2023.1.0 and how the 2024/2025 freeze laws count a year is the opinion's open item V10`,
  };
}

/** The shadow's guard for the havraa_year branch: a refusal code, or null when the month's rate is known. */
export function havraaBranchGuard(input: Readonly<{ branch: string | null; period: Readonly<{ start: string; end: string }> | null }>): string | null {
  // The snapshot a caller may pass beside the period is not needed here.
  if (input.branch !== HAVRAA_YEAR_BRANCH || input.period === null) return null;
  const lookup = havraaRateFor(havraaYearPaidFor(input.period.start));
  return lookup.status === "known" ? null : lookup.refusal;
}

/** The tag a shortfall carries when the payment was made before the rate was known. */
export function retroactiveTag(paymentPeriodStart: string, row: HavraaRateRow): string | null {
  if (!iso.test(paymentPeriodStart)) throw new Error(`CONVALESCENCE_DATE_MALFORMED:${paymentPeriodStart}`);
  return row.retroactive && paymentPeriodStart < row.known_at ? `retroactive_update_${row.known_at}` : null;
}

export type ConvalescencePaymentClass =
  | Readonly<{ status: "computed"; havraa_year: number; rate_minor_units: number; paid_per_day_minor_units: number; delta_per_day_minor_units: number; tag: string | null; parameter_version_id: string }>
  | Readonly<{ status: "refused"; havraa_year: number; refusal: typeof RATE_NOT_PUBLISHED | typeof RATE_NOT_IN_TABLE; note: string }>;

/** One day's shortfall against the published rate for the year the payment covers; exact integer arithmetic. */
export function classifyConvalescencePayment(input: Readonly<{ paid_per_day_minor_units: number; payment_period_start: string; havraa_year?: number }>): ConvalescencePaymentClass {
  const year = input.havraa_year ?? havraaYearPaidFor(input.payment_period_start);
  const lookup = havraaRateFor(year);
  if (lookup.status !== "known") return { status: "refused", havraa_year: year, refusal: lookup.refusal, note: lookup.note };
  return {
    status: "computed",
    havraa_year: year,
    rate_minor_units: lookup.row.rate_minor_units,
    paid_per_day_minor_units: input.paid_per_day_minor_units,
    delta_per_day_minor_units: lookup.row.rate_minor_units - input.paid_per_day_minor_units,
    tag: retroactiveTag(input.payment_period_start, lookup.row),
    parameter_version_id: lookup.row.parameter_version_id,
  };
}
