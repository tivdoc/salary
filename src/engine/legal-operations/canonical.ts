import { createHash } from "node:crypto";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, stable(entry)]));
  }
  return value;
}

export function canonicalLegalOperationsJson(value: unknown) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

export function legalOperationsSha256(value: unknown) {
  return createHash("sha256").update(canonicalLegalOperationsJson(value)).digest("hex");
}

export function bytesSha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

export function frozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
