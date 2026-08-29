import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const WAVE1_ORIGINAL_BASE = "e978ae5cee4a92f20dcc7db448b275170b8bf724";
export const WAVE1_FINAL_SHA = "bb9a61eae55d49529d7cd633a2c9c2615a8d842e";
export const WAVE2_A_CONTRACT_SHA = "2478e28eb4f31d282dac4b6f8f1fb488fb9b5bca";
export const WAVE1_REVIEW_ZIP_SHA256 = "fe7c5ffe6d3e8cdb3f8bc87e8e6e7268b7df48dfc52e3218c82cc2aef11f980b";

export function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}
export function stableJson(value: unknown) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export function normalizeRelative(value: string) {
  return value.replaceAll("\\", "/");
}

export function requireContained(root: string, candidate: string, code = "path_escape") {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${code}:${normalizeRelative(relative)}`);
  }
  return resolvedCandidate;
}

export function requireSafeRelative(value: string, code = "unsafe_relative_path") {
  const normalized = normalizeRelative(value);
  if (
    !normalized
    || normalized.startsWith("/")
    || /^[A-Za-z]:/u.test(normalized)
    || normalized.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new Error(`${code}:${normalized}`);
  }
  return normalized;
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function writeJsonAtomic(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, stableJson(value), { encoding: "utf8", mode: 0o600 });
  await rm(filePath, { force: true });
  await rename(temporary, filePath);
}

export function parseCliOptions(args: readonly string[]) {
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) throw new Error(`unexpected_argument:${token}`);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      options[token.slice(2)] = next;
      index += 1;
    } else {
      options[token.slice(2)] = true;
    }
  }
  return options;
}

export function requireStringOption(options: Readonly<Record<string, string | boolean>>, name: string) {
  const value = options[name];
  if (typeof value !== "string" || !value) throw new Error(`required_option_missing:${name}`);
  return value;
}
