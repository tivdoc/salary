import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

type DependencyPin = Readonly<{
  name: string;
  version: string;
  integrity: string;
  files: number;
  bytes: number;
  tree_sha256: string;
}>;

const PINS: readonly DependencyPin[] = Object.freeze([
  { name: "pg", version: "8.23.0", integrity: "sha512-Ip2EQCngowJLGOfCwkFhPXU7/ljlhn6Rxlmy4XYfL2Y+vyRM59+8uR2xqRWKdYmbXmxCFOAmKxBuSUCdF34qLg==", files: 20, bytes: 100044, tree_sha256: "d646057eb7d79aa93f66a004596bd10754eddfb8dda7432bc8dc799c6a30c607" },
  { name: "pg-cloudflare", version: "1.4.0", integrity: "sha512-Vo7z/6rrQYxpNRylp4Tlob2elzbh+N/MOQbxFVWCxS7oEx6jF53GTJFxK2WWpKuBRkmiin4Mt+xofFDjx09R0A==", files: 13, bytes: 23542, tree_sha256: "452e0c040bf24cddcf89ed354117e8515ad2ca7ae41e3f03d6ce1f8416a49632" },
  { name: "pg-connection-string", version: "2.14.0", integrity: "sha512-XwWDGcLRGCXAR8F/AM5bG7Q+A3Wm2s6QeEjlOKZLlH3UYcguiqCWKyWXVag5TLTIjR7oOJUY8kcADaZgWPyLeg==", files: 6, bytes: 16144, tree_sha256: "a3653ffefdd2ec57840b7e7755063e80c4f235f5db7284341bf90ec25d45458d" },
  { name: "pg-int8", version: "1.0.1", integrity: "sha512-WCtabS6t3c8SkpDBUlb1kjOs7l66xsGdKpIPZsg4wR+B3+u9UAum2odSsF9tnvxg80h4ZxLWMy4pRjOsFIqQpw==", files: 4, bytes: 3186, tree_sha256: "c97304d61c60aebd2e56232109de22651f9fa531843e89f17e69f4e309e9b9c6" },
  { name: "pg-pool", version: "3.14.0", integrity: "sha512-gKtPkFdQPU3DksooVLi9LsjZxrsBUZIpa+7aVx+LV5pNh0KzP4Zleud2po+ConrxbuXGBJ6Hfer6hdgpIBpBaw==", files: 5, bytes: 29835, tree_sha256: "7bed63cd11c613f0786956307443e725813ff28e56c44379fbbe674f201e1fae" },
  { name: "pg-protocol", version: "1.16.0", integrity: "sha512-sILXutLVjCLjcDuOmvhX5e2Z4cS5qG/6Bu3VkpFwdf/633ElGLpEh9bgmuI5I4sqKqkifQiGyiCcx1HdtrK7tg==", files: 42, bytes: 200886, tree_sha256: "8443ca59728a93b7320cee5d1e28cb6280accadd82f19dfe0c131c65bc0a1c3d" },
  { name: "pg-types", version: "2.2.0", integrity: "sha512-qTAAlrEsl8s4OiEQY69wDvcMIdQN6wdz5ojQiOy6YRMuynxenON0O5oCpJI6lshc6scgAY8qvJ2On/p+CXY0GA==", files: 13, bytes: 35296, tree_sha256: "19930dbbd9e0a6da931879c20620b2300701f04976e83db75e47a452a6d6d380" },
  { name: "pgpass", version: "1.0.5", integrity: "sha512-FdW9r/jQZhSeohs1Z3sI1yxFQNFvMcnmfuj4WBMUTxOrAyLMaTcE1aAMBiTlbMNaXvBCQuVi0R7hd8udDSP7ug==", files: 4, bytes: 10323, tree_sha256: "ca1a1270959f79d36755aea2c1332848c3b25da441f52a7689a31deb88d00ef8" },
  { name: "postgres-array", version: "2.0.0", integrity: "sha512-VpZrUqU5A69eQyW2c5CA1jtLecCsN2U/bD6VilrFDWq5+5UIEVO7nazS3TEcHf1zuPYO/sqGvUvW62g86RXZuA==", files: 5, bytes: 4903, tree_sha256: "d793d71d3e82795794dc7dc632435fee0b57413d0abc690b434e15fceee3ff3f" },
  { name: "postgres-bytea", version: "1.0.1", integrity: "sha512-5+5HqXnsZPE65IJZSMkZtURARZelel2oXUEO8rH83VS/hxH5vv1uHquPg5wZs8yMAfdv971IU+kcPUczi7NVBQ==", files: 4, bytes: 3095, tree_sha256: "a463f3fcdd93c988cbf80a7aeedbc8e87c8bd01f7322cd0b535cd9a832c25c63" },
  { name: "postgres-date", version: "1.0.7", integrity: "sha512-suDmjLVQg78nMK2UZ454hAG+OAW+HQPZ6n++TNDUX+L0+uUlLywnoxJKDou51Zm+zTCjrCl0Nq6J9C5hP9vK/Q==", files: 4, bytes: 5915, tree_sha256: "46c4fe0a77aa0bd577d4de5c3af69353a76c99f5e097dee3714d264ada46f9b3" },
  { name: "postgres-interval", version: "1.2.0", integrity: "sha512-9ZhXKM/rw350N1ovuWHbGxnGh/SNJ4cnxHiM0rxE4VN41wsg8P8zWn9hv/buK00RP4WvlOyr/RBDiptyxVbkZQ==", files: 5, bytes: 6727, tree_sha256: "db5bd1f96cb54c02c25ad0e79a1c79009290ce9c47bd94e0286ac4c9240c2d8a" },
  { name: "split2", version: "4.2.0", integrity: "sha512-UcjcJOWknrNkF6PLX83qcHM6KHgVKNkV62Y8a5uYDVv9ydGQVwAHMKqHdJje1VTWpljG0WYpCDhrCdAOYH4TWg==", files: 6, bytes: 17419, tree_sha256: "34bd812130b3808f505ad4d75a57d606cccea6dcc5586a89f69cea24361002ca" },
  { name: "xtend", version: "4.0.2", integrity: "sha512-LKYU1iAXJXUgAXn9URjiu+MWhyUXHsvfp7mcuYm9dSUKK0/CjtrUwFAxD82/mCWbtLsGjFIad0wIsod4zrTAEQ==", files: 7, bytes: 6465, tree_sha256: "74690abb546f790cfd84b299be1ba122e6ee8687d78c6db7fd867c5bfb779d78" },
]);

export const CRITICAL_DEPENDENCY_AGGREGATE_SHA256 =
  "972fa0fa7dc31e41e0bc9374f3138d1e05d7daed1e21ba643577d61a1661ea33" as const;
export const CRITICAL_DEPENDENCY_RECEIPT_SYMBOL = Symbol.for("tivdoc.v091.critical-dependency-integrity");

export type CriticalDependencyIntegrityReceipt = Readonly<{
  schema_version: "tivdoc-critical-postgresql-dependency-integrity-v0.9.1";
  package_count: 14;
  packages: readonly DependencyPin[];
  aggregate_sha256: typeof CRITICAL_DEPENDENCY_AGGREGATE_SHA256;
  package_lock_verified: true;
  ignored_runtime_bytes_verified_before_load: true;
  credentials_recorded: 0;
  status: "PASS";
}>;

export async function verifyCriticalPostgresDependencies(
  repositoryRoot: string,
): Promise<CriticalDependencyIntegrityReceipt> {
  const root = await ordinaryDirectory(path.resolve(repositoryRoot), "DEPENDENCY_REPOSITORY_ROOT_UNSAFE");
  const nodeModules = await ordinaryDirectory(path.join(root, "node_modules"), "DEPENDENCY_NODE_MODULES_ROOT_UNSAFE");
  const lockPath = path.join(root, "package-lock.json");
  const lockMetadata = await lstat(lockPath);
  if (!lockMetadata.isFile() || lockMetadata.isSymbolicLink() || lockMetadata.nlink !== 1) {
    throw new Error("DEPENDENCY_PACKAGE_LOCK_UNSAFE");
  }
  const lock = parseRecord(JSON.parse(await readFile(lockPath, "utf8")), "DEPENDENCY_PACKAGE_LOCK_INVALID");
  const packages = parseRecord(lock.packages, "DEPENDENCY_PACKAGE_LOCK_INVALID");
  const verified: DependencyPin[] = [];
  for (const pin of PINS) {
    const lockEntry = parseRecord(packages[`node_modules/${pin.name}`], `DEPENDENCY_LOCK_ENTRY_MISSING:${pin.name}`);
    if (lockEntry.version !== pin.version || lockEntry.integrity !== pin.integrity) {
      throw new Error(`DEPENDENCY_LOCK_ENTRY_MISMATCH:${pin.name}`);
    }
    const packageRoot = await ordinaryDirectory(
      path.join(nodeModules, pin.name),
      `DEPENDENCY_PACKAGE_ROOT_UNSAFE:${pin.name}`,
    );
    if (!packageRoot.toLowerCase().startsWith(`${nodeModules.toLowerCase()}${path.sep}`)) {
      throw new Error(`DEPENDENCY_PACKAGE_PATH_ESCAPE:${pin.name}`);
    }
    const tree = await treeReceipt(packageRoot);
    const packageJson = parseRecord(
      JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")),
      `DEPENDENCY_PACKAGE_JSON_INVALID:${pin.name}`,
    );
    if (packageJson.name !== pin.name || packageJson.version !== pin.version
      || tree.files !== pin.files || tree.bytes !== pin.bytes || tree.tree_sha256 !== pin.tree_sha256) {
      throw new Error(`DEPENDENCY_INSTALLED_TREE_MISMATCH:${pin.name}`);
    }
    verified.push(pin);
  }
  const aggregate = createHash("sha256").update(verified.map((pin) => [
    pin.name, pin.version, pin.integrity, pin.files, pin.bytes, pin.tree_sha256,
  ].join("\0") + "\n").join(""), "utf8").digest("hex");
  if (aggregate !== CRITICAL_DEPENDENCY_AGGREGATE_SHA256) {
    throw new Error("DEPENDENCY_AGGREGATE_MISMATCH");
  }
  return Object.freeze({
    schema_version: "tivdoc-critical-postgresql-dependency-integrity-v0.9.1",
    package_count: 14,
    packages: Object.freeze(verified),
    aggregate_sha256: CRITICAL_DEPENDENCY_AGGREGATE_SHA256,
    package_lock_verified: true,
    ignored_runtime_bytes_verified_before_load: true,
    credentials_recorded: 0,
    status: "PASS",
  });
}

async function treeReceipt(root: string): Promise<Readonly<{ files: number; bytes: number; tree_sha256: string }>> {
  const files: Array<Readonly<{ relative: string; absolute: string; bytes: number }>> = [];
  const walk = async (current: string, relativeParent = ""): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relative = relativeParent ? `${relativeParent}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new Error("DEPENDENCY_REPARSE_POINT_REJECTED");
      const resolved = await realpath(absolute);
      if (!resolved.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)) {
        throw new Error("DEPENDENCY_TREE_PATH_ESCAPE");
      }
      if (metadata.isDirectory()) await walk(absolute, relative);
      else if (metadata.isFile()) {
        if (metadata.nlink !== 1) throw new Error("DEPENDENCY_HARDLINK_REJECTED");
        files.push(Object.freeze({ relative, absolute, bytes: metadata.size }));
      } else throw new Error("DEPENDENCY_SPECIAL_FILE_REJECTED");
    }
  };
  await walk(root);
  const tree = createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    tree.update(file.relative, "utf8");
    tree.update(Buffer.from([0]));
    tree.update(String(file.bytes), "ascii");
    tree.update(Buffer.from([0]));
    tree.update(await sha256File(file.absolute), "ascii");
    tree.update(Buffer.from([10]));
    bytes += file.bytes;
  }
  return Object.freeze({ files: files.length, bytes, tree_sha256: tree.digest("hex") });
}

async function ordinaryDirectory(candidate: string, code: string): Promise<string> {
  const metadata = await lstat(candidate);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(code);
  return await realpath(candidate);
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function parseRecord(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}
