import { createHash } from "node:crypto";

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (value instanceof Uint8Array) return { $bytes_hex: Buffer.from(value).toString("hex") };
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalize(child)]),
  );
}

export function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(normalize(value));
  if (encoded === undefined) throw new TypeError("CANONICAL_VALUE_UNDEFINED");
  return encoded;
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function bytesSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function assertSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError("SHA256_INVALID");
}
