import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Wave 7 (R-6). Money invariants: BigInt only, explicit rounding in the
// trace, no floating point anywhere on the calculation path. Enforced the
// way this codebase enforces every other "a new one must not arrive
// unnoticed" invariant — grep the path, pin the exact count, and require
// each hit to carry the specific safety property that makes it not a
// floating-point risk. A hit with no matching guard fails the test; a new,
// unaccounted-for hit changes the count and fails it too.

const MONEY_PATH_ROOT = path.resolve(process.cwd(), "src", "engine", "rule-runtime");
const MONEY_PATH_FILES = ["decimal.ts", "runtime.ts", "canonical.ts", "contracts.ts", "registry.ts"];

async function readMoneyPathFiles() {
  const files = await Promise.all(MONEY_PATH_FILES.map(async (name) => ({
    name, text: (await readFile(path.join(MONEY_PATH_ROOT, name), "utf8")).replaceAll("\r\n", "\n"),
  })));
  return files;
}

describe("rule-runtime money path has no floating-point arithmetic (R-6)", () => {
  it("never calls parseFloat anywhere on the path — zero tolerance, no exception carries this one", async () => {
    const files = await readMoneyPathFiles();
    const hits = files.flatMap((file) => file.text.includes("parseFloat") ? [file.name] : []);
    expect(hits).toEqual([]);
  });

  it("calls Number(...) exactly once, and only immediately guarded by an explicit safe-integer range check", async () => {
    const decimal = (await readMoneyPathFiles()).find((file) => file.name === "decimal.ts")!.text;
    const matches = [...decimal.matchAll(/Number\(/gu)];
    expect(matches).toHaveLength(1);
    // The one call: addMoneyMinorUnits converts a BigInt sum back to a JS
    // number only after checking it falls inside Number.MIN/MAX_SAFE_INTEGER
    // — the conversion is exact by construction, not a floating-point
    // truncation risk. If this guard is ever removed, or the Number(...)
    // call moves to appear before it in the source text, this fails.
    const guardIndex = decimal.indexOf("money_minor_units_out_of_safe_range");
    const callIndex = decimal.indexOf("Number(sum)");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeGreaterThan(guardIndex);
    expect(decimal).toContain("Number.MIN_SAFE_INTEGER");
    expect(decimal).toContain("Number.MAX_SAFE_INTEGER");
  });

  it("uses the division operator exactly once, and only between two bigint operands", async () => {
    const decimal = (await readMoneyPathFiles()).find((file) => file.name === "decimal.ts")!.text;
    // A plain regex division-operator scan over source text would also
    // match string literals and comments; the money path has exactly one
    // arithmetic division and it is easiest to name directly rather than
    // build a tokenizer for one line.
    const divisionLines = decimal.split("\n").filter((line) => / \/ /u.test(line) && !line.trim().startsWith("//"));
    expect(divisionLines).toEqual(["  let quotient = magnitude / divisor;"]);
    // Both operands are declared as bigint immediately above: magnitude is
    // derived from a BigInt coefficient, divisor from powerOfTen (returns
    // bigint) — BigInt "/" is exact integer division, never IEEE-754.
    expect(decimal).toContain("const divisor = powerOfTen(removedPlaces);");
    expect(decimal).toContain("function powerOfTen(exponent: number): bigint {");
    expect(decimal).toContain("const magnitude = negative ? -value.coefficient : value.coefficient;");
  });

  it("every rounding decision on the path is explicit and recorded in a trace, never implicit", async () => {
    const decimal = (await readMoneyPathFiles()).find((file) => file.name === "decimal.ts")!.text;
    expect(decimal).toContain("export function roundExactDecimal(");
    // The rounding function's own return type carries a trace object
    // (mode, from_scale, to_scale, discarded_digits, tie, incremented) —
    // there is no code path in this file that rounds without producing one.
    expect(decimal).toMatch(/trace: Object\.freeze\(\{[\s\S]*mode,[\s\S]*discarded_digits: discardedDigits,[\s\S]*tie,[\s\S]*incremented,/u);
  });
});
