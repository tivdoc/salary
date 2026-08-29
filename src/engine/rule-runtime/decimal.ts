export type RoundingMode = "half_even" | "half_up" | "toward_zero";

export interface ExactDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

export interface DecimalRoundingTrace {
  readonly mode: RoundingMode;
  readonly from_scale: number;
  readonly to_scale: number;
  readonly input: string;
  readonly output: string;
  readonly discarded_digits: string;
  readonly tie: boolean;
  readonly incremented: boolean;
}

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function powerOfTen(exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0) {
    throw new RangeError("decimal_scale_out_of_range");
  }
  return BigInt(10) ** BigInt(exponent);
}

export function parseExactDecimal(value: string): ExactDecimal {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new TypeError("invalid_decimal_string");
  }

  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const magnitude = BigInt(`${whole}${fraction}`);
  return Object.freeze({
    coefficient: negative && magnitude !== BigInt(0) ? -magnitude : magnitude,
    scale: fraction.length,
  });
}

export function formatExactDecimal(value: ExactDecimal): string {
  if (!Number.isSafeInteger(value.scale) || value.scale < 0) {
    throw new RangeError("decimal_scale_out_of_range");
  }

  if (value.coefficient === BigInt(0)) {
    return "0";
  }

  const negative = value.coefficient < BigInt(0);
  let digits = (negative ? -value.coefficient : value.coefficient).toString();
  if (value.scale > 0) {
    digits = digits.padStart(value.scale + 1, "0");
    const split = digits.length - value.scale;
    digits = `${digits.slice(0, split)}.${digits.slice(split)}`;
    digits = digits.replace(/0+$/, "").replace(/\.$/, "");
  }
  return negative ? `-${digits}` : digits;
}

export function addExactDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  return Object.freeze({
    coefficient:
      left.coefficient * powerOfTen(scale - left.scale) +
      right.coefficient * powerOfTen(scale - right.scale),
    scale,
  });
}

export function multiplyExactDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  return Object.freeze({
    coefficient: left.coefficient * right.coefficient,
    scale: left.scale + right.scale,
  });
}

export function roundExactDecimal(
  value: ExactDecimal,
  toScale: number,
  mode: RoundingMode,
): { readonly value: ExactDecimal; readonly trace: DecimalRoundingTrace } {
  if (!Number.isSafeInteger(toScale) || toScale < 0) {
    throw new RangeError("rounding_scale_out_of_range");
  }

  const input = formatExactDecimal(value);
  if (toScale >= value.scale) {
    return Object.freeze({
      value,
      trace: Object.freeze({
        mode,
        from_scale: value.scale,
        to_scale: toScale,
        input,
        output: input,
        discarded_digits: "",
        tie: false,
        incremented: false,
      }),
    });
  }

  const removedPlaces = value.scale - toScale;
  const divisor = powerOfTen(removedPlaces);
  const negative = value.coefficient < BigInt(0);
  const magnitude = negative ? -value.coefficient : value.coefficient;
  let quotient = magnitude / divisor;
  const remainder = magnitude % divisor;
  const doubledRemainder = remainder * BigInt(2);
  const tie = doubledRemainder === divisor;
  const incremented =
    mode === "half_up"
      ? doubledRemainder >= divisor
      : mode === "half_even"
        ? doubledRemainder > divisor ||
          (tie && quotient % BigInt(2) === BigInt(1))
        : false;
  if (incremented) {
    quotient += BigInt(1);
  }

  const rounded = Object.freeze({
    coefficient: negative ? -quotient : quotient,
    scale: toScale,
  });
  const discardedDigits = remainder.toString().padStart(removedPlaces, "0");
  return Object.freeze({
    value: rounded,
    trace: Object.freeze({
      mode,
      from_scale: value.scale,
      to_scale: toScale,
      input,
      output: formatExactDecimal(rounded),
      discarded_digits: discardedDigits,
      tie,
      incremented,
    }),
  });
}

export function addMoneyMinorUnits(
  left: { readonly currency: string; readonly minor_units: number },
  right: { readonly currency: string; readonly minor_units: number },
): { readonly currency: string; readonly minor_units: number } {
  if (!Number.isSafeInteger(left.minor_units) || !Number.isSafeInteger(right.minor_units)) {
    throw new RangeError("money_minor_units_not_safe_integers");
  }
  if (left.currency !== right.currency) {
    throw new TypeError("money_currency_mismatch");
  }
  const sum = BigInt(left.minor_units) + BigInt(right.minor_units);
  if (sum < BigInt(Number.MIN_SAFE_INTEGER) || sum > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("money_minor_units_out_of_safe_range");
  }
  return Object.freeze({ currency: left.currency, minor_units: Number(sum) });
}
