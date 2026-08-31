import { isAbsolute, relative, resolve } from "node:path";

import type { ApprovedPostgresTarget } from "./safety.mts";

export type DynamicPostgresPaths = Readonly<{
  repository_root: string;
  tools_root: string;
  distribution_root: string;
  binaries_root: string;
  runtime_root: string;
  cluster_root: string;
  data_root: string;
  log_root: string;
  server_log: string;
  owner_marker: string;
  backup_root: string;
  bootstrap_sql: string;
  migrations_root: string;
}>;

export function resolveDynamicPostgresPaths(
  repositoryRoot: string,
  target: ApprovedPostgresTarget,
): DynamicPostgresPaths {
  const root = resolve(repositoryRoot);
  if (!isAbsolute(root)) throw new TypeError("REPOSITORY_ROOT_NOT_ABSOLUTE");
  const toolsRoot = contained(root, resolve(root, ".tools", "postgresql"));
  const distributionRoot = contained(toolsRoot, resolve(toolsRoot, "17.11-2-official-zip"));
  const runtimeRoot = contained(root, resolve(root, ".tmp", "postgresql-dynamic-v0.9.1"));
  const clusterRoot = contained(runtimeRoot, resolve(runtimeRoot, target.descriptor.target_id));
  return Object.freeze({
    repository_root: root,
    tools_root: toolsRoot,
    distribution_root: distributionRoot,
    binaries_root: contained(distributionRoot, resolve(distributionRoot, "bin")),
    runtime_root: runtimeRoot,
    cluster_root: clusterRoot,
    data_root: contained(clusterRoot, resolve(clusterRoot, "data")),
    log_root: contained(clusterRoot, resolve(clusterRoot, "logs")),
    server_log: contained(clusterRoot, resolve(clusterRoot, "logs", "postgresql.log")),
    owner_marker: contained(clusterRoot, resolve(clusterRoot, "owner-marker.json")),
    backup_root: contained(clusterRoot, resolve(clusterRoot, "backups")),
    bootstrap_sql: contained(root, resolve(
      root,
      "scripts",
      "canonical-persistence-v091",
      "sql",
      "plain-postgres-supabase-compat.sql",
    )),
    migrations_root: contained(root, resolve(root, "supabase", "migrations")),
  });
}

export function contained(parent: string, candidate: string): string {
  const resolvedParent = resolve(parent);
  const resolvedCandidate = resolve(candidate);
  const segment = relative(resolvedParent, resolvedCandidate);
  if (segment === "" || (!segment.startsWith("..") && !isAbsolute(segment))) return resolvedCandidate;
  throw new Error("PATH_ESCAPES_APPROVED_ROOT");
}
