// L5-2 / D2. Units are structured and derived, never relabelled.
//
// On the wire a unit is still a string — `days`, `days_per_month`,
// `calendar_days` — because every stored candidate, template and draft carries
// one, and changing that shape would invalidate all of them for no gain. What
// changes is what the executor DOES with the string. A unit id resolves to a
// dimension, a multiset of base symbols over another, and arithmetic works on
// dimensions:
//
//   days_per_month × months  =  {day / month} + {month}  =  {day}  =  days
//   days ÷ days_per_month    =  {day} − {day / month}    =  {month} =  months
//
// The result is looked up back to its canonical id. If no id names the derived
// dimension, the operation refuses and says which two units it was given. There
// is no conversion table and no relabelling node: `calendar_days` and `days`
// are different symbols and stay different, because a rule that could add a
// calendar day to a working day is a rule that has stopped counting.
//
// Ids the registry does not know are opaque: their dimension is the id itself
// as a single symbol. That is what keeps every existing synthetic fixture
// (`currency.zzz`, `synthetic.point`, `count.hours`) exactly as valid as it was
// — such a unit multiplies with `ratio`, adds to itself, and refuses to combine
// with anything else, which is the behaviour the executor always had.

export type Dimension = Readonly<{ numerator: readonly string[]; denominator: readonly string[] }>;

/** Bijective: every dimension here has exactly one id, and every id one dimension. */
const REGISTRY: Readonly<Record<string, Dimension>> = Object.freeze({
  ratio: { numerator: [], denominator: [] },
  days: { numerator: ["day"], denominator: [] },
  months: { numerator: ["month"], denominator: [] },
  weeks: { numerator: ["week"], denominator: [] },
  hours: { numerator: ["hour"], denominator: [] },
  calendar_days: { numerator: ["calendar_day"], denominator: [] },
  "count.years": { numerator: ["year"], denominator: [] },
  days_per_month: { numerator: ["day"], denominator: ["month"] },
  hours_per_week: { numerator: ["hour"], denominator: ["week"] },
  hours_per_month: { numerator: ["hour"], denominator: ["month"] },
  hours_per_day: { numerator: ["hour"], denominator: ["day"] },
  calendar_days_per_year: { numerator: ["calendar_day"], denominator: ["year"] },
  // L7-2: a count of workdays in a week, for the daily-threshold branch.
  days_per_week: { numerator: ["day"], denominator: ["week"] },
});

const sorted = (symbols: readonly string[]): readonly string[] => Object.freeze([...symbols].sort());

function key(dimension: Dimension): string {
  return `${sorted(dimension.numerator).join("*")}/${sorted(dimension.denominator).join("*")}`;
}

const BY_KEY: ReadonlyMap<string, string> = new Map(Object.entries(REGISTRY).map(([id, dimension]) => [key(dimension), id]));

/** Every base symbol the registry uses. An id that IS one of these is not a unit. */
const BASE_SYMBOLS: ReadonlySet<string> = new Set(Object.values(REGISTRY).flatMap((entry) => [...entry.numerator, ...entry.denominator]));

/**
 * The dimension behind a unit id. Unknown ids are opaque single symbols — with
 * one refusal: an id that spells a base symbol (`day`, `month`, `year`) would
 * alias the registry id built from it, and `day` would quietly equal `days`.
 * A Lane B adversarial pass found exactly that, so it refuses by name.
 */
export function dimensionOf(unit: string): Dimension {
  if (BASE_SYMBOLS.has(unit)) throw new Error(`RULESPEC_UNIT_ID_IS_A_BASE_SYMBOL:${unit}`);
  return REGISTRY[unit] ?? Object.freeze({ numerator: [unit], denominator: [] });
}

/** Cancel symbols that appear on both sides, one for one. */
function reduce(numerator: readonly string[], denominator: readonly string[]): Dimension {
  const remaining = [...denominator];
  const top: string[] = [];
  for (const symbol of numerator) {
    const index = remaining.indexOf(symbol);
    if (index >= 0) remaining.splice(index, 1); else top.push(symbol);
  }
  return Object.freeze({ numerator: sorted(top), denominator: sorted(remaining) });
}

/** The canonical id of a dimension, or null when no id names it. */
export function unitIdOf(dimension: Dimension): string | null {
  const known = BY_KEY.get(key(dimension));
  if (known !== undefined) return known;
  // An opaque symbol on its own is its own id. It cannot be a base symbol,
  // because `dimensionOf` refuses those before they ever become a dimension.
  if (dimension.numerator.length === 1 && dimension.denominator.length === 0 && !BASE_SYMBOLS.has(dimension.numerator[0])) {
    return dimension.numerator[0];
  }
  return null;
}

export type UnitDerivation = Readonly<{ unit: string }> | Readonly<{ refusal: string }>;

/** `left × right`, as a unit id, or a refusal naming both. */
export function productUnit(left: string, right: string): UnitDerivation {
  const a = dimensionOf(left);
  const b = dimensionOf(right);
  const unit = unitIdOf(reduce([...a.numerator, ...b.numerator], [...a.denominator, ...b.denominator]));
  return unit === null ? { refusal: `RULESPEC_UNIT_DERIVED_UNKNOWN:${left}*${right}` } : { unit };
}

/** `left ÷ right`, as a unit id, or a refusal naming both. */
export function quotientUnit(left: string, right: string): UnitDerivation {
  const a = dimensionOf(left);
  const b = dimensionOf(right);
  const unit = unitIdOf(reduce([...a.numerator, ...b.denominator], [...a.denominator, ...b.numerator]));
  return unit === null ? { refusal: `RULESPEC_UNIT_DERIVED_UNKNOWN:${left}/${right}` } : { unit };
}

/** Equal by dimension, not by spelling — though in a bijective registry they coincide. */
export function sameUnit(left: string, right: string): boolean {
  return key(dimensionOf(left)) === key(dimensionOf(right));
}

/** The refusal an operation raises when it needs equal units and does not get them. */
export function unitMismatch(operation: string, left: string, right: string): string {
  return `RULESPEC_UNIT_MISMATCH:${operation}:${left}:${right}`;
}

export const KNOWN_UNIT_IDS: readonly string[] = Object.freeze(Object.keys(REGISTRY));
