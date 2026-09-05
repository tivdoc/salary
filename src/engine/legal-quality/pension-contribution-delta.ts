// L11-5 / D3.7 (run 11). A difference in the pension WAGE CAP is not a
// difference in money paid.
//
// The sensitivity report's pension-cap decision separates two figures for the
// cap (13,566 under §1 of the National Insurance Law, 13,769 under §2), and
// its table stated the difference between them — 203.00 — as the row's
// "difference". A reader took that for the sum at stake. It is not: the cap is
// a base, and what the cap changes is the contributions computed on it, at
// the contribution rates — 6% employee, 6.5% employer, 6% severance under the
// 2016 order's 2017 rates, 18.5% in all. The lawyer-approved opinion asks
// that the contribution delta be shown (203 × 18.5% ≈ 37.6) and the base
// delta shown separately, so that neither is mistaken for the other.
//
// Exact rational arithmetic on minor units, rounded half-up once at the end.
// The rates are inputs: nothing here knows a percentage.
export type ContributionRate = Readonly<{ numerator: string; denominator: string }>;

export type ContributionDelta = Readonly<{
  base_delta_minor_units: string;
  rate_sum: Readonly<{ numerator: string; denominator: string }>;
  contribution_delta_minor_units: string;
  rounding: "half_up";
  components: readonly Readonly<{ share: string; rate: ContributionRate; delta_minor_units: string }>[];
}>;

const digits = /^-?(?:0|[1-9]\d*)$/u;

function gcd(a: bigint, b: bigint): bigint {
  let x = a < BigInt(0) ? -a : a;
  let y = b < BigInt(0) ? -b : b;
  while (y !== BigInt(0)) [x, y] = [y, x % y];
  return x;
}

/** Half-up division of two integers to an integer, exact. */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= BigInt(0)) throw new Error("CONTRIBUTION_DELTA_DENOMINATOR_INVALID");
  const negative = numerator < BigInt(0);
  const magnitude = negative ? -numerator : numerator;
  const quotient = magnitude / denominator;
  const remainder = magnitude % denominator;
  const rounded = remainder * BigInt(2) >= denominator ? quotient + BigInt(1) : quotient;
  return negative ? -rounded : rounded;
}

export function contributionDelta(input: Readonly<{
  base_delta_minor_units: string;
  shares: readonly Readonly<{ share: string; rate: ContributionRate }>[];
}>): ContributionDelta {
  if (!digits.test(input.base_delta_minor_units)) throw new Error("CONTRIBUTION_DELTA_BASE_INVALID");
  if (input.shares.length === 0) throw new Error("CONTRIBUTION_DELTA_NO_SHARES");
  const base = BigInt(input.base_delta_minor_units);
  let sumNumerator = BigInt(0);
  let sumDenominator = BigInt(1);
  const components = input.shares.map((entry) => {
    if (!digits.test(entry.rate.numerator) || !/^[1-9]\d*$/u.test(entry.rate.denominator)) throw new Error(`CONTRIBUTION_DELTA_RATE_INVALID:${entry.share}`);
    const numerator = BigInt(entry.rate.numerator);
    const denominator = BigInt(entry.rate.denominator);
    sumNumerator = sumNumerator * denominator + numerator * sumDenominator;
    sumDenominator *= denominator;
    return { share: entry.share, rate: entry.rate, delta_minor_units: divideHalfUp(base * numerator, denominator).toString() };
  });
  const divisor = gcd(sumNumerator, sumDenominator) || BigInt(1);
  const rateSum = { numerator: (sumNumerator / divisor).toString(), denominator: (sumDenominator / divisor).toString() };
  return Object.freeze({
    base_delta_minor_units: input.base_delta_minor_units,
    rate_sum: rateSum,
    contribution_delta_minor_units: divideHalfUp(base * BigInt(rateSum.numerator), BigInt(rateSum.denominator)).toString(),
    rounding: "half_up",
    components: Object.freeze(components),
  });
}
