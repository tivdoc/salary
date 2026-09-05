import "../../production-refusal.mjs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { verifyCanonicalPersistenceWiringStatically } from "../../../src/server/platform/persistence/wiring-verifier.ts";

const repoRoot = path.resolve(".");
const [platformMigration, canonicalMigration, postgresRoot, applicationRoot, isolatedEnvironment, productReachableSources] = await Promise.all([
  read("supabase/migrations/202608310001_engine_platform_persistence.sql"),
  read("supabase/migrations/202608310002_canonical_postgresql_composition.sql"),
  read("src/server/platform/composition/canonical-postgres.ts"),
  read("src/server/platform/composition/canonical-postgres-application.ts"),
  read("src/server/platform/persistence/isolated-environment.ts"),
  collectProductReachableSources(),
]);
const receipt = verifyCanonicalPersistenceWiringStatically({
  platform_migration: `${platformMigration}\n${canonicalMigration}`,
  composition_root: `${postgresRoot}\n${applicationRoot}`,
  isolated_environment: isolatedEnvironment,
  product_reachable_sources: productReachableSources,
});

process.stdout.write(`${JSON.stringify(receipt)}\n`);
process.exitCode = receipt.passed ? 0 : 1;

async function read(file: string): Promise<string> {
  return readFile(path.join(repoRoot, file), "utf8");
}

async function collectProductReachableSources(): Promise<readonly Readonly<{ path: string; source: string }>[]> {
  const roots = [
    "src/app",
    "src/server/product/internal-ops",
    "src/server/product/customer-portal",
  ];
  const files = (await Promise.all(roots.map((root) => walk(path.join(repoRoot, root)))))
    .flat()
    .filter((file) => /\.(?:ts|tsx)$/.test(file))
    .filter((file) => !/\.(?:test|spec)\.[^.]+$/.test(file))
    .filter((file) => !/[\\/](?:test-fixtures|fixtures)[\\/]/.test(file))
    .filter((file) => !/[\\/]test-fixtures\.[^.]+$/.test(file));
  return Promise.all(files.map(async (file) => Object.freeze({
    path: path.relative(repoRoot, file).replaceAll("\\", "/"),
    source: await readFile(file, "utf8"),
  })));
}

async function walk(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : Promise.resolve([target]);
  }));
  return nested.flat();
}
