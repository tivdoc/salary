import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED,
  verifyIsolatedTargetIdentity,
} from "../src/server/engine/persistence-verification/isolated-environment.ts";
import { verifyPersistenceFoundationStatically } from "../src/server/engine/persistence-verification/static-verifier.ts";
import { SyntheticPersistenceStore } from "../src/server/engine/persistence-verification/synthetic-store.ts";
import {
  SYNTHETIC_ACTOR_ALPHA,
  SYNTHETIC_ACTOR_BETA,
  syntheticRecord,
} from "../src/server/engine/persistence-verification/synthetic-fixtures.ts";

const root = process.cwd();
const outputFlagIndex = process.argv.indexOf("--output");
const outputPath = outputFlagIndex >= 0
  ? process.argv[outputFlagIndex + 1]
  : join(root, "output", "parallel-wave-1", "persistence-isolated", "verification.json");
if (!outputPath) throw new Error("--output requires a path");

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), "utf8");
}

function commandAvailable(command: string) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  return spawnSync(locator, [command], { encoding: "utf8", windowsHide: true }).status === 0;
}

function gitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : "unavailable";
}

const repositorySources = [
  "analysis-run-repository.ts",
  "conversation-repository.ts",
  "document-repository.ts",
  "extraction-repository.ts",
  "investigation-repository.ts",
  "repository-error.ts",
]
  .map((file) => read(`src/server/engine/${file}`))
  .join("\n");
const migration = read("supabase/migrations/202608290001_engine_persistence_foundation.sql");
const staticReport = verifyPersistenceFoundationStatically({
  migration,
  repositories: repositorySources,
  safeLogging: read("src/server/engine/safe-logging.ts"),
});

const store = new SyntheticPersistenceStore();
const run = store.insert(SYNTHETIC_ACTOR_ALPHA, syntheticRecord("analysis_run", 1));
const duplicate = store.insert(SYNTHETIC_ACTOR_ALPHA, syntheticRecord("analysis_run", 1));
let tenantIsolation = false;
try {
  store.read(SYNTHETIC_ACTOR_BETA, run.id);
} catch {
  tenantIsolation = true;
}
let rollback = false;
try {
  store.transaction((transaction) => {
    transaction.insert(SYNTHETIC_ACTOR_ALPHA, syntheticRecord("job", 2));
    throw new Error("synthetic_partial_failure");
  });
} catch {
  rollback = store.size() === 1;
}

const tools = {
  docker_cli_available: commandAvailable("docker"),
  supabase_cli_available: commandAvailable("supabase"),
};
const identityGate = verifyIsolatedTargetIdentity(null);
const evidence = {
  schema_version: "persistence-wave1-evidence.v0.3.1",
  status: PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED,
  required_base_commit: "34a4bff98a1ae8771a932916ece4e2a408d7e501",
  observed_git_head: gitHead(),
  environment_fingerprint: {
    redacted: true,
    platform: process.platform,
    architecture: process.arch,
    node_version: process.version,
    docker_cli_available: tools.docker_cli_available,
    supabase_cli_available: tools.supabase_cli_available,
    hostname_included: false,
    username_included: false,
    filesystem_paths_included: false,
    credentials_inspected: false,
  },
  identity_gate: identityGate,
  migration: {
    relative_path: "supabase/migrations/202608290001_engine_persistence_foundation.sql",
    sha256: createHash("sha256").update(migration).digest("hex"),
    applied: false,
    database_semantics_verified: false,
  },
  static_verification: staticReport,
  synthetic_model_probe: {
    method: "deterministic_in_memory_model_not_database_emulation",
    duplicate_idempotent: duplicate === run,
    two_actor_tenant_case_isolation: tenantIsolation,
    partial_failure_rollback: rollback,
  },
  forbidden_actions: {
    external_supabase_accessed: false,
    production_accessed: false,
    shared_preview_accessed: false,
    deployment_performed: false,
    customer_data_used: false,
  },
  gaps: [
    "Docker CLI is unavailable on this host.",
    "Supabase CLI is unavailable on this host.",
    "No verified local or expiring disposable target identity was supplied.",
    "Migration execution, PostgreSQL constraints, indexes, foreign keys, triggers, grants, RLS, rollback, and rebuild remain unverified in a database.",
    "Private Storage deletion and retention orchestration remain outside this verification.",
  ],
};

if (!staticReport.passed || !tenantIsolation || !rollback || duplicate !== run) {
  process.stderr.write("PERSISTENCE_STATIC_VERIFICATION_FAILED\n");
  process.exitCode = 3;
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  if (!existsSync(outputPath)) throw new Error("Evidence output was not created");
  process.stdout.write(`${PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED}\n`);
  process.stdout.write(`evidence=${outputPath}\n`);
  process.exitCode = 2;
}
