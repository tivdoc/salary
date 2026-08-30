import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const WAVE21_CONTRACT_SHA = "09bc4448265eb7a7dc0044b86ae094b9f53616da";
export const WAVE2_FINAL_SHA = "5ce3eba6ab816cd6a20e101c913f7f1177c7598a";
export const WAVE2_ZIP_SHA256 = "77bd9874cddeae848ad1b7cf376ab3e247bca22b455567f75248cfa3eaea096c";
export const WAVE2_MANIFEST_SHA256 = "9fa62f6848c5bef1e4bfae1654b5e0673bf61589c6ca985d1578a44d95c7c5bf";

export function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

export function stableJson(value: unknown) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export function git(repoRoot: string, args: readonly string[], input?: string, expected = 0) {
  const result = spawnSync("git", [...args], { cwd: repoRoot, input, encoding: "utf8", windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== expected) throw new Error(`git_command_failed:${args.join("_")}:${result.status}:${result.stderr.trim()}`);
  return result.stdout.trim();
}

export function normalized(relative: string) {
  return relative.replaceAll("\\", "/");
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export function allowlistMatch(relative: string, allowlist: readonly string[]) {
  const target = normalized(relative);
  return allowlist.some((entry) => entry.endsWith("/**") ? target.startsWith(entry.slice(0, -3)) : target === entry);
}

export function repoRelative(repoRoot: string, target: string) {
  return normalized(path.relative(repoRoot, target));
}
