import { createHash } from "node:crypto";
import type { CanonicalHashPort, DeterministicIdPort } from "../wave3/contracts";

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical_json_non_finite_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value instanceof Uint8Array) return canonicalize({ byte_encoding: "hex", value: Buffer.from(value).toString("hex") });
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.some((key) => record[key] === undefined)) throw new TypeError("canonical_json_undefined_value");
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
  }
  throw new TypeError("canonical_json_unsupported_value");
}

export function canonicalJson(value: unknown): string {
  return `${canonicalize(value)}\n`;
}

export class Sha256CanonicalHashPort implements CanonicalHashPort {
  hashCanonical(value: unknown): string {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
  }

  hashBytes(value: Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
  }
}

export class ContentAddressedIdPort implements DeterministicIdPort {
  derive(namespace: string, canonicalInputHash: string): string {
    if (!/^[a-z][a-z0-9._-]{1,39}$/.test(namespace)) throw new TypeError("deterministic_id_namespace_invalid");
    if (!/^[a-f0-9]{64}$/.test(canonicalInputHash)) throw new TypeError("deterministic_id_hash_invalid");
    return `${namespace}:${canonicalInputHash.slice(0, 32)}`;
  }
}

export function immutable<T>(value: T): T {
  if (ArrayBuffer.isView(value)) return value;
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
  }
  return value;
}
