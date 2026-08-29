import { createHash } from "node:crypto";

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical_json_requires_finite_numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("canonical_json_unsupported_value");
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    if (!Object.isFrozen(value)) {
      Object.freeze(value);
    }
  }
  return value;
}
