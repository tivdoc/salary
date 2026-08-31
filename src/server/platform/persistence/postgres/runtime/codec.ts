import { CanonicalPostgresError } from "./errors.ts";

const SHA256 = /^[0-9a-f]{64}$/u;

export function rowObject(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) malformed();
  return value as Readonly<Record<string, unknown>>;
}

export function rowString(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) malformed();
  return value;
}

export function rowNullableString(row: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) malformed();
  return value;
}

export function rowSha256(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = rowString(row, key);
  if (!SHA256.test(value)) malformed();
  return value;
}

export function rowNullableSha256(row: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = rowNullableString(row, key);
  if (value !== null && !SHA256.test(value)) malformed();
  return value;
}

export function rowSafeInteger(row: Readonly<Record<string, unknown>>, key: string, minimum = 0): number {
  const value = row[key];
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < minimum) malformed();
  return parsed;
}

export function rowBoolean(row: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") malformed();
  return value;
}

export function rowTimestampMs(row: Readonly<Record<string, unknown>>, key: string): number {
  const value = rowString(row, key);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) malformed();
  return parsed;
}

export function rowJson(row: Readonly<Record<string, unknown>>, key: string): unknown {
  const value = row[key];
  if (value === undefined || value === null) malformed();
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      malformed();
    }
  }
  return structuredClone(value);
}

export function rowStringArray(row: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = row[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) malformed();
  return Object.freeze([...value]) as readonly string[];
}

export function assertEnum<T extends string>(value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) malformed();
  return value as T;
}

export function assertSha256(value: string): void {
  if (!SHA256.test(value)) malformed();
}

function malformed(): never {
  throw new CanonicalPostgresError("POSTGRES_ROW_MALFORMED");
}
