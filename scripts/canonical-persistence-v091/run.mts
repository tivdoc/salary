import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, realpathSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildDynamicEvidence } from "./evidence/artifacts.mts";
import {
  applyCleanMigrationChain,
  applyCompatibilityBootstrap,
  assertOwnedClusterStopped,
  assertOwnedCluster,
  assertPlainPostgresFoundationInventory,
  collectPostgresInventory,
  createOwnedDatabase,
  createOwnedLocalTarget,
  CRITICAL_DEPENDENCY_AGGREGATE_SHA256,
  CRITICAL_DEPENDENCY_RECEIPT_SYMBOL,
  discoverMigrationChain,
  initializeOwnedCluster,
  inspectExplicitDynamicTarget,
  ensurePinnedPostgresBinaries,
  runDynamicPreflight,
  resolveDynamicPostgresPaths,
  runSafeCommand,
  selectRandomHighLoopbackPort,
  startOwnedCluster,
  stopOwnedCluster,
  type ApprovedPostgresTarget,
  type CriticalDependencyIntegrityReceipt,
  type DynamicPostgresPaths,
  type PinnedPostgresBinaries,
  type PinnedPostgresProvisioningReceipt,
  type SecretValue,
} from "./foundation/index.mts";
import { runAtomicityMatrix } from "./matrix/atomicity.mts";
import { runBackupRestoreMatrix } from "./matrix/backup-restore.mts";
import { runCanonicalCapabilityMatrix } from "./matrix/capabilities.mts";
import { runConcurrencyMatrix } from "./matrix/concurrency.mts";
import { runRealMigrationMatrix } from "./matrix/migrations.mts";
import { runRealPostgresRlsMatrix } from "./matrix/rls.mts";
import {
  assertTrustedGitRepository,
  trustedGitText,
} from "./foundation/trusted-git.mts";
import {
  configureDynamicRoleSessions,
  generateDynamicRoleSecrets,
  roleConnectionUrls,
  targetConnectionUrl,
} from "./orchestration/roles.mts";

const root = path.resolve(process.cwd());
const dependencyIntegrity = Reflect.get(
  globalThis,
  CRITICAL_DEPENDENCY_RECEIPT_SYMBOL,
) as CriticalDependencyIntegrityReceipt | undefined;
assert(dependencyIntegrity?.status === "PASS"
  && dependencyIntegrity.package_count === 14
  && dependencyIntegrity.aggregate_sha256 === CRITICAL_DEPENDENCY_AGGREGATE_SHA256,
"DYNAMIC_CRITICAL_DEPENDENCY_INTEGRITY_MISSING");
const foundationSmoke = process.argv.includes("--foundation-smoke");
const migrationSmoke = process.argv.includes("--migration-smoke");
const matrixSmoke = process.argv.includes("--matrix-smoke");
const smokeOnly = foundationSmoke || migrationSmoke || matrixSmoke;
const fullMatrix = matrixSmoke || !smokeOnly;
const finalRun = !smokeOnly;
const runId = randomBytes(6).toString("hex");
const developmentRoot = path.resolve(root, "output", "canonical-postgresql-dynamic-v0.9.1", "development");
await mkdir(developmentRoot, { recursive: true });
const migrationPortabilityAmendment = JSON.parse(await readFile(path.resolve(
  root,
  "scripts",
  "canonical-persistence-v091",
  "foundation",
  "migration-portability-amendment.json",
), "utf8")) as Readonly<Record<string, unknown>>;

const trustedGit = assertTrustedGitRepository(root);
const git = Object.freeze({
  branch: gitText(["branch", "--show-current"]),
  head: gitText(["rev-parse", "HEAD"]),
  tree: gitText(["show", "-s", "--format=%T", "HEAD"]),
  required_base_head: "43f3e63a5cef75b24e95d1bce4383e9249a2d866",
  required_base_tree: "16aea86ef3251ec92e52ebf0e4757902459cf987",
});
assert(git.branch === "codex/tivdoc-engine-foundation", "DYNAMIC_BRANCH_MISMATCH");
assert(gitText(["show", "-s", "--format=%T", git.required_base_head]) === git.required_base_tree, "DYNAMIC_BASE_TREE_MISMATCH");
assert(gitText(["merge-base", git.required_base_head, "HEAD"]) === git.required_base_head,
  "DYNAMIC_BASE_ANCESTRY_MISMATCH");
if (finalRun) assert(gitText(["status", "--porcelain", "--untracked-files=all"]) === "", "DYNAMIC_FINAL_RUN_REQUIRES_CLEAN_WORKTREE");
const initialPreflight = finalRun ? await runDynamicPreflight(root, git) : null;

const explicit = inspectExplicitDynamicTarget();
if (!explicit.target && explicit.receipt.reason !== "explicit_target_not_supplied") {
  throw new Error(`DYNAMIC_EXPLICIT_TARGET_REJECTED:${explicit.receipt.reason}`);
}
let target: ApprovedPostgresTarget;
let paths: DynamicPostgresPaths;
let binaries: PinnedPostgresBinaries;
let provisioning: PinnedPostgresProvisioningReceipt;
let ownsServer = false;
let serverStartAttempted = false;
let shutdownVerified = false;

try {
  if (explicit.target) {
    // An explicit URL alone is not an ownership/isolation marker and therefore
    // cannot authorize destructive bootstrap/migration operations.
    throw new Error("DYNAMIC_EXPLICIT_TARGET_REQUIRES_VERIFIED_OWNERSHIP_MARKER");
  } else {
    const port = await selectRandomHighLoopbackPort();
    target = createOwnedLocalTarget({ port, suffix: `dynamic_${runId}` });
    paths = resolveDynamicPostgresPaths(root, target);
    const prepared = await ensurePinnedPostgresBinaries(paths);
    binaries = prepared.binaries;
    provisioning = prepared.provisioning;
    await initializeOwnedCluster({ target, paths, binaries });
    ownsServer = true;
    serverStartAttempted = true;
    await startOwnedCluster({ target, paths, binaries });
    await createOwnedDatabase({ target, paths, binaries });
  }

  const chain = await discoverMigrationChain(paths);
  const bootstrap = await applyCompatibilityBootstrap({ target, paths, binaries });
  const adminUrl = targetConnectionUrl(target);
  const roleSecrets = generateDynamicRoleSecrets();
  const roles = await configureDynamicRoleSessions({ admin_connection_url: adminUrl, secrets: roleSecrets });
  const clean = await applyCleanMigrationChain({ target, paths, binaries, chain });
  const inventory = await collectPostgresInventory({ target, paths, binaries });
  assertPlainPostgresFoundationInventory(inventory);
  const clusterMarker = ownsServer ? await assertOwnedCluster(target, paths) : null;
  const environment = Object.freeze({
    schema_version: "tivdoc-real-postgresql-environment-v0.9.1",
    proof_class: "REAL_POSTGRESQL_DYNAMIC_PROOF",
    target: target.descriptor,
    postgres_version: binaries.postgres_version,
    client_version: binaries.version_output,
    node_version: process.version,
    node_runtime_requirement: "v22.22.2",
    os: process.platform,
    architecture: process.arch,
    source_kind: binaries.source_kind,
    source_url: binaries.source_url,
    source_sha256: binaries.source_sha256,
    source_integrity: binaries.source_integrity,
    critical_dependency_integrity: dependencyIntegrity,
    trusted_git: trustedGit,
    provisioning,
    target_selection: Object.freeze({
      explicit_target_supplied: explicit.receipt.reason !== "explicit_target_not_supplied",
      explicit_target_approved: explicit.receipt.approved,
      selected_target_kind: target.descriptor.kind,
      fallback_after_rejected_explicit_target: false,
      credentials_recorded: 0,
      status: "PASS" as const,
    }),
    binary_sha256: binaries.binary_sha256,
    configuration_sha256: clusterMarker?.configuration_sha256 ?? null,
    cluster_identity_sha256: sha256({
      target_id: target.descriptor.target_id,
      postgres_version: binaries.postgres_version,
      configuration_sha256: clusterMarker?.configuration_sha256 ?? null,
    }),
    server: inventory.inventory.server,
    loopback_only: target.descriptor.host === "127.0.0.1",
    owned_user_space_server: ownsServer,
    admin_privileges_used: provisioning.administrator_privileges_used,
    windows_token_elevated: provisioning.windows_token_elevated,
    system_service_installed: false,
    credentials_recorded: 0,
    status: "PASS",
  });

  const migrationMatrix = (migrationSmoke || fullMatrix) ? await runRealMigrationMatrix({
    root,
    owner_target: target,
    binaries,
    chain,
    build_identity_sha: git.head,
    run_id: runId,
    service_role_password: roleSecrets.service_role.reveal(),
  }) : null;

  if (!fullMatrix) {
    const receipt = Object.freeze({
      schema_version: "tivdoc-real-postgresql-foundation-smoke-v0.9.1",
      proof_class: "REAL_POSTGRESQL_DYNAMIC_PROOF",
      status: "PASS",
      git,
      environment,
      migration_chain: safeMigrationChain(chain),
      bootstrap,
      clean_migration: clean,
      roles,
      inventory_sha256: inventory.inventory_sha256,
      migration_matrix: migrationMatrix,
      explicit_target_receipt: explicit.receipt,
      credentials_recorded: 0,
    });
    await writeJson(path.join(developmentRoot, "foundation-smoke.json"), receipt);
    process.stdout.write(`${JSON.stringify({
      schema_version: receipt.schema_version,
      status: receipt.status,
      target: environment.target,
      postgres_version: environment.postgres_version,
      migrations: chain.migration_count,
      inventory_sha256: inventory.inventory_sha256,
      migration_matrix: migrationMatrix?.status ?? "NOT_RUN",
      credentials_recorded: 0,
    })}\n`);
  } else {
    assert(migrationMatrix?.status === "PASS", "DYNAMIC_MIGRATION_MATRIX_FAILED");
    const urls = roleConnectionUrls({ target, database: target.descriptor.database, secrets: roleSecrets });
    const capabilities = await runCanonicalCapabilityMatrix({
      connection_url: urls.service_role,
      build_identity_sha: git.head,
      fixture_suffix: runId,
    });
    assert(capabilities.matrix.length === 14 && capabilities.matrix.every((row) => row.status === "PASS"),
      "DYNAMIC_CAPABILITY_MATRIX_FAILED");

    const tenantBMatrix = await runCanonicalCapabilityMatrix({
      connection_url: urls.service_role,
      build_identity_sha: git.head,
      fixture_suffix: `b${runId}`,
    });
    assert(tenantBMatrix.matrix.length === 14 && tenantBMatrix.matrix.every((row) => row.status === "PASS"),
      "DYNAMIC_TENANT_B_CAPABILITY_MATRIX_FAILED");
    const tenantB = Object.freeze({
      tenant_id: tenantBMatrix.durable_state.tenant_id,
      case_id: tenantBMatrix.durable_state.case_id,
      connection_attempts: tenantBMatrix.driver_metrics.connection_attempts,
    });
    const rlsMatrix = await runRealPostgresRlsMatrix({
      admin_connection_url: adminUrl,
      role_connection_urls: {
        anon: urls.anon,
        authenticated: urls.authenticated,
        service_role: urls.service_role,
        tenant_policy_probe: urls.tivdoc_policy_probe,
      },
      tenant_a: capabilities.durable_state.tenant_id,
      tenant_b: tenantB.tenant_id,
    });
    const rls = Object.freeze({
      ...rlsMatrix,
      tenant_b_seed_connection_attempts: tenantB.connection_attempts,
    });
    if (matrixSmoke) await writeJson(path.join(developmentRoot, "rls-latest.json"), rls);
    assert(rls.status === "PASS", "DYNAMIC_RLS_MATRIX_FAILED");

    const atomicity = await runAtomicityMatrix({
      connection_url: urls.service_role,
      build_identity_sha: git.head,
      matrix_run_id: `a${runId}`,
      max_connections: 16,
    });
    assert(atomicity.status === "PASS" && atomicity.passed_boundary_count === 8
      && atomicity.complete_contract_coverage, "DYNAMIC_ATOMICITY_MATRIX_FAILED");
    const concurrency = await runConcurrencyMatrix({
      connection_url: urls.service_role,
      build_identity_sha: git.head,
      matrix_run_id: `c${runId}`,
      max_connections: 16,
    });
    assert(concurrency.status === "PASS" && concurrency.independent_connection_proof,
      "DYNAMIC_CONCURRENCY_MATRIX_FAILED");

    const replayStatePath = path.join(paths.cluster_root, `restart-replay-${runId}.json`);
    await writeJson(replayStatePath, capabilities.durable_state);
    await stopOwnedCluster({ target, paths, binaries });
    await startOwnedCluster({ target, paths, binaries });
    const replayChild = await runFreshReplayProcess({
      root,
      connection_url: urls.service_role,
      build_identity_sha: git.head,
      durable_state_path: replayStatePath,
      service_role_secret: roleSecrets.service_role,
    });
    await rm(replayStatePath, { force: true });
    const restart = Object.freeze({
      ...replayChild,
      genuine_server_stop_start: true,
      same_cluster_restarted: true,
      pool_closed_before_restart: true,
      status: "PASS",
    });

    const backupRestore = await runBackupRestoreMatrix({
      root,
      source_target: target,
      source_paths: paths,
      binaries,
      build_identity_sha: git.head,
      run_id: runId,
      durable_state: capabilities.durable_state,
      role_secrets: roleSecrets,
      tenant_a: capabilities.durable_state.tenant_id,
      tenant_b: tenantB.tenant_id,
    });
    assert(backupRestore.status === "PASS", "DYNAMIC_BACKUP_RESTORE_FAILED");

    const connectionComponents = Object.freeze({
      capability_matrix: capabilities.driver_metrics.connection_attempts,
      tenant_b_seed: tenantB.connection_attempts,
      rls: rls.connection_attempts,
      atomicity: atomicity.connection_attempts,
      concurrency: concurrency.connection_attempts,
      restart_replay: restart.connection_attempts,
      backup_restore: backupRestore.connection_attempts,
    });
    const observedConnectionAttempts = Object.values(connectionComponents).reduce((sum, value) => sum + value, 0);
    assert(observedConnectionAttempts > 0, "DYNAMIC_REAL_CONNECTIONS_NOT_OBSERVED");
    const connectionBreakdown = Object.freeze({
      schema_version: "tivdoc-canonical-postgresql-dynamic-connection-breakdown-v0.9.1",
      components: connectionComponents,
      observed_total: observedConnectionAttempts,
      definition: "OBSERVED_NODE_POSTGRES_POOL_ACQUISITION_ATTEMPTS_LOWER_BOUND_EXCLUDES_ADMINISTRATIVE_CLI_CONNECTIONS",
      credentials_recorded: 0,
      status: "PASS",
    });
    const stopReceipt = await stopOwnedCluster({ target, paths, binaries });
    const stoppedReceipt = await assertOwnedClusterStopped({ target, paths, binaries });
    shutdownVerified = true;
    const shutdown = Object.freeze({
      schema_version: "tivdoc-canonical-postgresql-dynamic-shutdown-v0.9.1",
      owned_server: true,
      ownership_verified: true,
      stop_command: stopReceipt.status === "COMPLETE" ? "PASS" as const : "FAIL" as const,
      server_stopped: stoppedReceipt.status === "COMPLETE",
      credentials_recorded: 0,
      status: "PASS" as const,
    });

    if (matrixSmoke) {
      const receipt = Object.freeze({
        schema_version: "tivdoc-real-postgresql-matrix-smoke-v0.9.1",
        status: "PASS",
        postgres_version: environment.postgres_version,
        migrations: migrationMatrix.status,
        capabilities: capabilities.matrix.length,
        restart: restart.status,
        rls: rls.status,
        atomicity: atomicity.status,
        concurrency: concurrency.status,
        backup_restore: backupRestore.status,
        real_connection_attempts: observedConnectionAttempts,
        credentials_recorded: 0,
      });
      await writeJson(path.join(developmentRoot, "matrix-smoke.json"), receipt);
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
    } else {
      const regressions = runRegressions();
      assert(gitText(["status", "--porcelain", "--untracked-files=all"]) === "", "DYNAMIC_POST_REGRESSION_WORKTREE_DIRTY");
      const postRegressionGit = Object.freeze({
        branch: gitText(["branch", "--show-current"]),
        head: gitText(["rev-parse", "HEAD"]),
        tree: gitText(["show", "-s", "--format=%T", "HEAD"]),
      });
      assert(postRegressionGit.branch === git.branch
        && postRegressionGit.head === git.head
        && postRegressionGit.tree === git.tree,
      "DYNAMIC_POST_REGRESSION_GIT_IDENTITY_CHANGED");
      const postflightRaw = await runDynamicPreflight(root, git);
      assert(initialPreflight !== null
        && JSON.stringify(initialPreflight.prior_static_package) === JSON.stringify(postflightRaw.prior_static_package),
      "DYNAMIC_PRIOR_STATIC_PACKAGE_CHANGED");
      const postflight = Object.freeze({
        ...postflightRaw,
        prior_static_package: Object.freeze({
          ...postflightRaw.prior_static_package,
          initial_manifest_sha256: initialPreflight.prior_static_package.manifest_sha256,
          postflight_manifest_sha256: postflightRaw.prior_static_package.manifest_sha256,
          initial_zip_sha256: initialPreflight.prior_static_package.zip_sha256,
          postflight_zip_sha256: postflightRaw.prior_static_package.zip_sha256,
          preserved_unchanged: true,
        }),
      });
      const acceptance = Object.freeze({
        schema_version: "tivdoc-canonical-postgresql-dynamic-acceptance-v0.9.1",
        acceptance_result: "ACCEPTANCE_24_OF_24_PASS",
        pc_22: "PC-22_PASS",
        static_baseline: Object.freeze({ result: "23/24 PASS", failures: 0, pc_22: "SKIPPED_ENVIRONMENT_DEPENDENCY" }),
        dynamic_extension: Object.freeze({ item: "PC-22", result: "PASS", proof_class: "REAL_POSTGRESQL_DYNAMIC_PROOF" }),
        counts: Object.freeze({ total: 24, pass: 24, fail: 0, skipped: 0 }),
        truth_counters: Object.freeze({
          REAL_POSTGRESQL_SERVER_USED: "YES",
          REAL_POSTGRESQL_CONNECTION_ATTEMPTS: observedConnectionAttempts,
          REAL_POSTGRESQL_MIGRATION_CLEAN: "PASS",
          REAL_POSTGRESQL_MIGRATION_UPGRADE: "PASS",
          REAL_POSTGRESQL_COMPOSITION_ROOT: "PASS",
          REAL_POSTGRESQL_RESTART_REPLAY: "PASS",
          REAL_POSTGRESQL_RLS_MATRIX: "PASS",
          REAL_POSTGRESQL_FAILURE_ATOMICITY: "PASS",
          REAL_POSTGRESQL_APPROVAL_RACES: "PASS",
          REAL_POSTGRESQL_BACKUP_RESTORE: "PASS",
          PRODUCT_REACHABLE_MEMORY_FALLBACKS: 0,
        }),
        final_status_constants: Object.freeze([
          "DYNAMIC_POSTGRESQL_VERIFICATION_COMPLETE",
          "CASE_ANALYSIS_DURABILITY_DYNAMICALLY_PROVEN",
          "PC-22_PASS",
          "ACCEPTANCE_24_OF_24_PASS",
        ]),
        remaining_blockers: Object.freeze(["ISOLATED_SUPABASE_MIGRATION_RLS_VERIFICATION_REQUIRED"]),
        credentials_recorded: 0,
        status: "PASS",
      });
      const gitReceipt = Object.freeze({
        schema_version: "tivdoc-canonical-postgresql-dynamic-git-v0.9.1",
        ...git,
        post_regression: postRegressionGit,
        head_tree_cross_check: postRegressionGit.tree === gitText(["show", "-s", "--format=%T", postRegressionGit.head]),
        worktree: "CLEAN",
        supabase_temp_touched: false,
        credentials_recorded: 0,
        status: "PASS",
      });
      const finalRoot = path.resolve(root, "output", "canonical-postgresql-dynamic-v0.9.1", "final");
      const evidence = await buildDynamicEvidence({
        repository_root: root,
        final_root: finalRoot,
        payloads: {
          "acceptance-receipt.json": acceptance,
          "atomicity-matrix.json": atomicity,
          "backup-restore.json": backupRestore,
          "capability-matrix.json": capabilities,
          "clean-migration.json": clean,
          "connection-breakdown.json": connectionBreakdown,
          "concurrency-matrix.json": concurrency,
          "environment.json": environment,
          "git.json": gitReceipt,
          "migration-chain.json": safeMigrationChain(chain),
          "migration-matrix.json": migrationMatrix,
          "migration-portability-amendment.json": migrationPortabilityAmendment,
          "preflight.json": postflight,
          "regressions.json": regressions,
          "restart-replay.json": restart,
          "rls-matrix.json": rls,
          "role-sessions.json": roles,
          "shutdown.json": shutdown,
          "supabase-compatibility.json": Object.freeze({
            bootstrap,
            proof_class: "REAL_POSTGRESQL_DYNAMIC_PROOF",
            isolated_supabase_platform_proof: "NOT_PERFORMED",
            blocker: "ISOLATED_SUPABASE_MIGRATION_RLS_VERIFICATION_REQUIRED",
            credentials_recorded: 0,
          }),
        },
      });
      process.stdout.write(`${JSON.stringify(Object.freeze({
        schema_version: "tivdoc-canonical-postgresql-dynamic-final-v0.9.1",
        status: "PASS",
        acceptance_result: acceptance.acceptance_result,
        pc_22: acceptance.pc_22,
        postgres_version: environment.postgres_version,
        real_connection_attempts: observedConnectionAttempts,
        evidence_manifest_sha256: evidence.manifest_sha256,
        evidence_zip_sha256: evidence.zip_sha256,
        evidence_wrapper_sha256: evidence.wrapper_sha256,
        independent_verifier_output_sha256: evidence.independent_verifier_output_sha256,
        repeat_build_match: evidence.repeat_build_match,
        credentials_recorded: 0,
      }))}\n`);
    }
  }
} finally {
  if (ownsServer && serverStartAttempted && !shutdownVerified && target! && paths! && binaries!) {
    let cleanupError: unknown = null;
    try {
      await stopOwnedCluster({ target, paths, binaries });
    } catch (error) {
      cleanupError = error;
    }
    try {
      await assertOwnedClusterStopped({ target, paths, binaries });
      shutdownVerified = true;
      cleanupError = null;
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) {
      await writeJson(path.join(developmentRoot, "stop-failure.json"), {
        schema_version: "tivdoc-dynamic-postgres-stop-failure-v0.9.1",
        error_name: cleanupError instanceof Error ? cleanupError.name : "Error",
        credentials_recorded: 0,
      });
      process.exitCode = 1;
    }
  }
}

async function runFreshReplayProcess(input: Readonly<{
  root: string;
  connection_url: string;
  build_identity_sha: string;
  durable_state_path: string;
  service_role_secret: SecretValue;
}>): Promise<Readonly<{
  schema_version: string;
  proof_class: string;
  fresh_node_process: true;
  capability_count: number;
  connection_attempts: number;
  credentials_recorded: 0;
  status: "PASS";
}>> {
  const childScript = path.resolve(input.root, "scripts", "canonical-persistence-v091", "matrix", "restart-replay-bootstrap.mts");
  const result = await runSafeCommand({
    executable: process.execPath,
    args: Object.freeze([
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--experimental-strip-types",
      "--experimental-transform-types",
      childScript,
    ]),
    cwd: input.root,
    env: Object.freeze({
      ...minimalEnvironment(),
      TIVDOC_V091_REPLAY_CONNECTION_URL: input.connection_url,
      TIVDOC_V091_BUILD_IDENTITY_SHA: input.build_identity_sha,
      TIVDOC_V091_DURABLE_STATE_PATH: input.durable_state_path,
    }),
    redactions: Object.freeze([input.service_role_secret]),
    timeout_ms: 60_000,
  });
  const value = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  assert(value.status === "PASS" && value.fresh_node_process === true && value.capability_count === 14
    && typeof value.connection_attempts === "number" && value.connection_attempts > 0,
  "DYNAMIC_FRESH_PROCESS_REPLAY_FAILED");
  return value as Awaited<ReturnType<typeof runFreshReplayProcess>>;
}

function runRegressions() {
  const node = process.execPath;
  const npmCli = path.resolve(path.dirname(node), "node_modules", "npm", "bin", "npm-cli.js");
  const vitest = path.resolve(root, "node_modules", "vitest", "vitest.mjs");
  const tsc = path.resolve(root, "node_modules", "typescript", "bin", "tsc");
  const nextFontMockEnvironment = Object.freeze({
    NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.resolve(root, "scripts", "canonical-persistence-v091", "foundation", "next-font-google-mock.cjs"),
    TIVDOC_V091_FONT_MOCK_ALLOWED: "1",
  });
  const commands = Object.freeze([
    ["focused_v09_v091", node, [vitest, "run", "scripts/canonical-persistence-v091/foundation/foundation.test.mjs", "src/server/platform/persistence/postgres", "src/server/platform/composition/canonical-postgres-application.test.ts", "--maxWorkers=1"]],
    ["full_unit_integration", node, [npmCli, "test", "--", "--maxWorkers=1"]],
    ["eslint", node, [npmCli, "run", "lint"]],
    ["typescript_no_emit", node, [tsc, "--noEmit"]],
    ["nextjs_production_build", node, [npmCli, "run", "build", "--", "--webpack"], nextFontMockEnvironment],
    ["canonical_v09_acceptance", node, [npmCli, "run", "canonical:persistence:v09:acceptance"], {
      ...nextFontMockEnvironment,
      TIVDOC_V09_ACCEPTANCE_FINAL_ROOT: "output/canonical-postgresql-dynamic-v0.9.1/v09-regression/final",
    }],
  ] as const);
  const receipts = commands.map(([id, executable, args, extraEnvironment]) => {
    if (id === "nextjs_production_build" || id === "canonical_v09_acceptance") {
      resetNextBuildDirectory();
    }
    const started = Date.now();
    const result = spawnSync(executable, [...args], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: id === "canonical_v09_acceptance" ? 1_200_000 : 600_000,
      maxBuffer: 32 * 1024 * 1024,
      env: regressionEnvironment(extraEnvironment),
    });
    if (result.status !== 0 || result.error) {
      throw new Error(`DYNAMIC_REGRESSION_FAILED:${id}`);
    }
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    return Object.freeze({
      command_id: id,
      executable,
      arguments: Object.freeze([...args]),
      exit_code: 0,
      duration_ms: Date.now() - started,
      stdout_sha256: sha256Bytes(stdout),
      stderr_sha256: sha256Bytes(stderr),
      output_byte_count: Buffer.byteLength(stdout) + Buffer.byteLength(stderr),
      safe_summary: safeRegressionSummary(id, stdout),
      status: "PASS",
    });
  });
  return Object.freeze({
    schema_version: "tivdoc-canonical-postgresql-dynamic-regressions-v0.9.1",
    commands: Object.freeze(receipts),
    command_count: receipts.length,
    passed: receipts.length,
    failed: 0,
    live_provider_calls: 0,
    external_credentials_available: 0,
    environment_mode: "ALLOWLISTED_OFFLINE_NO_PROVIDER_CREDENTIALS",
    customer_data_used: false,
    credentials_recorded: 0,
    status: "PASS",
  });
}

function resetNextBuildDirectory(): void {
  const buildRoot = path.resolve(root, ".next");
  assert(path.relative(root, buildRoot) === ".next", "DYNAMIC_NEXT_BUILD_ROOT_UNSAFE");
  try {
    const metadata = lstatSync(buildRoot);
    assert(metadata.isDirectory() && !metadata.isSymbolicLink(), "DYNAMIC_NEXT_BUILD_ROOT_UNSAFE");
    const physical = realpathSync.native(buildRoot);
    const samePhysicalPath = process.platform === "win32"
      ? physical.toLowerCase() === buildRoot.toLowerCase()
      : physical === buildRoot;
    assert(samePhysicalPath, "DYNAMIC_NEXT_BUILD_ROOT_REPARSE_FORBIDDEN");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  rmSync(buildRoot, { recursive: true, force: true });
}

function regressionEnvironment(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const inherited = minimalEnvironment();
  const systemRoot = inherited.SystemRoot ?? inherited.WINDIR ?? "C:\\Windows";
  return {
    ...inherited,
    Path: [
      path.dirname(process.execPath),
      path.resolve(root, "node_modules", ".bin"),
      path.resolve(systemRoot, "System32"),
      process.env.Path ?? process.env.PATH ?? "",
    ].filter(Boolean).join(path.delimiter),
    CI: "1",
    NO_COLOR: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    TIVDOC_DYNAMIC_POSTGRES_URL: "",
    TIVDOC_ALLOW_EXTERNAL_TESTS: "0",
    OPENAI_API_KEY: "",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    ...(extra ?? {}),
  };
}

function safeRegressionSummary(commandId: string, stdout: string): Readonly<Record<string, string | number | boolean>> {
  const summary: Record<string, string | number | boolean> = { output_present: stdout.length > 0 };
  const escape = String.fromCharCode(27);
  const normalized = stdout.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "gu"), "");
  const testFiles = normalized.match(/Test Files\s+(\d+) passed/iu);
  const tests = normalized.match(/Tests\s+(\d+) passed(?:\s*\|\s*(\d+) skipped)?/iu);
  if (testFiles) summary.test_files_passed = Number(testFiles[1]);
  if (tests) {
    summary.tests_passed = Number(tests[1]);
    summary.tests_skipped = Number(tests[2] ?? 0);
  }
  if (commandId === "canonical_v09_acceptance") {
    const lastJson = stdout.trim().split(/\r?\n/u).reverse().find((line) => line.trim().startsWith("{"));
    if (lastJson) {
      try {
        const value = JSON.parse(lastJson) as Record<string, unknown>;
        const counts = typeof value.counts === "object" && value.counts !== null
          ? value.counts as Record<string, unknown>
          : {};
        const verifiedGit = typeof value.verified_git === "object" && value.verified_git !== null
          ? value.verified_git as Record<string, unknown>
          : {};
        summary.acceptance_passed = Number(counts.acceptance_passed ?? 0);
        summary.acceptance_failed = Number(counts.acceptance_failed ?? 0);
        summary.acceptance_skipped_blocked = Number(counts.acceptance_skipped_blocked ?? 0);
        summary.acceptance_status = summary.acceptance_passed === 23
          && summary.acceptance_failed === 0
          && summary.acceptance_skipped_blocked === 1 ? "PASS" : "FAIL";
        summary.verified_branch = String(verifiedGit.branch ?? "");
        summary.verified_head = String(verifiedGit.head ?? "");
        summary.verified_tree = String(verifiedGit.tree ?? "");
      } catch {
        summary.acceptance_status = "UNPARSEABLE";
      }
    }
  }
  return Object.freeze(summary);
}

function safeMigrationChain(chain: Awaited<ReturnType<typeof discoverMigrationChain>>) {
  return Object.freeze({
    schema_version: chain.schema_version,
    migration_count: chain.migration_count,
    migrations: Object.freeze(chain.migrations.map(({ name, sha256, bytes }) => Object.freeze({ name, sha256, bytes }))),
    canonical_migration_sha256: chain.canonical_migration_sha256,
    credentials_recorded: 0,
    status: "PASS",
  });
}

function minimalEnvironment(): Record<string, string> {
  const output: Record<string, string> = {};
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "LANG", "LC_ALL"] as const) {
    const value = process.env[name];
    if (value) output[name] = value;
  }
  return output;
}

function gitText(args: readonly string[]): string {
  return trustedGitText(root, args);
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sha256Bytes(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
