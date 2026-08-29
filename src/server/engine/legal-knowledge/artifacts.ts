import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

export async function storeImmutableLegalArtifact(input: Readonly<{
  root: string;
  sourceId: string;
  sourceVersion: string;
  artifactSha256: string;
  extension: string;
  bytes: Uint8Array;
}>) {
  if (!/^[A-Z0-9][A-Z0-9_-]{2,79}$/u.test(input.sourceId)) throw new Error("invalid_source_id");
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/u.test(input.sourceVersion)) throw new Error("invalid_source_version");
  if (!/^[a-f0-9]{64}$/u.test(input.artifactSha256)) throw new Error("invalid_artifact_hash");
  if (createHash("sha256").update(input.bytes).digest("hex") !== input.artifactSha256) throw new Error("artifact_hash_mismatch");
  if (!/^[a-z0-9]{1,8}$/u.test(input.extension)) throw new Error("invalid_artifact_extension");
  const target = path.resolve(input.root, input.sourceId, input.sourceVersion, `${input.artifactSha256}.${input.extension}`);
  const relative = path.relative(path.resolve(input.root), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("artifact_path_escape");
  const root = path.resolve(input.root);
  const relativeParts = path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean);
  let cursor = root;
  for (const part of relativeParts) {
    cursor = path.join(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error("artifact_symlink_escape");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await mkdir(path.dirname(target), { recursive: true });
  const [realRoot, realParent] = await Promise.all([realpath(root), realpath(path.dirname(target))]);
  const realRelative = path.relative(realRoot, realParent);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error("artifact_symlink_escape");
  try {
    await writeFile(target, input.bytes, { flag: "wx" });
    return { created: true, path: target };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await lstat(target)).isSymbolicLink()) throw new Error("artifact_symlink_escape");
    const existing = await readFile(target);
    if (!existing.equals(Buffer.from(input.bytes))) throw new Error("immutable_artifact_mismatch");
    return { created: false, path: target };
  }
}
