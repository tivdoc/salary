import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";
import { InMemoryCaseAnalysisRepository } from "../../engine/case-analysis/in-memory-repository.ts";
import { InMemoryHashChainAudit } from "../audit/hash-chain.ts";
import { LocalDurableJobQueue } from "../jobs/durable-job-queue.ts";
import { CanonicalPlatformRepository } from "../persistence/canonical-repository.ts";
import { LocalObjectWriteSaga } from "../persistence/object-write-saga.ts";
import { PERSISTENCE_RUNTIME_MODES, type PersistenceRuntimeMode } from "../persistence/runtime-modes.ts";
import { LocalDurablePlatformStore } from "../persistence/transactional-store.ts";
import { LocalPrivateObjectStorage } from "../storage/private-object-storage.ts";

export { PERSISTENCE_RUNTIME_MODES };
export type { PersistenceRuntimeMode };
export type PersistenceExecutionBoundary = "test" | "hermetic_synthetic" | "non_test";

export class PersistenceCompositionError extends Error {
  readonly code:
    | "PERSISTENCE_MODE_REQUIRED"
    | "PERSISTENCE_MODE_INVALID"
    | "MEMORY_TEST_ONLY_OUTSIDE_HERMETIC_EXECUTION"
    | "ISOLATED_POSTGRES_ADAPTER_NOT_IMPLEMENTED"
    | "PERSISTENCE_DISABLED";

  constructor(code: PersistenceCompositionError["code"]) {
    super(code);
    this.name = "PersistenceCompositionError";
    this.code = code;
  }
}

export type MemoryTestPersistenceConfig = Readonly<{
  mode: "memory_test_only";
  execution_boundary: PersistenceExecutionBoundary;
  private_storage_root: string;
  now_ms: () => number;
  authorize_read: (actor: VerifiedActor, versionId: string, scopeRef: string) => boolean;
}>;

export type IsolatedPostgresPersistenceConfig = Readonly<{
  mode: "isolated_postgres";
  execution_boundary: PersistenceExecutionBoundary;
  target_id: string;
}>;

export type DisabledPersistenceConfig = Readonly<{
  mode: "disabled";
  execution_boundary: PersistenceExecutionBoundary;
}>;

export type CanonicalPersistenceConfig =
  | MemoryTestPersistenceConfig
  | IsolatedPostgresPersistenceConfig
  | DisabledPersistenceConfig;

export type MemoryTestPersistenceComposition = Readonly<{
  mode: "memory_test_only";
  durable: false;
  platform_store: LocalDurablePlatformStore;
  canonical_repository: CanonicalPlatformRepository;
  case_analysis_repository: InMemoryCaseAnalysisRepository;
  jobs: LocalDurableJobQueue;
  audit: InMemoryHashChainAudit;
  object_write_saga: LocalObjectWriteSaga;
  private_storage: LocalPrivateObjectStorage;
}>;

export type DisabledPersistenceComposition = Readonly<{
  mode: "disabled";
  durable: false;
  reason: "PERSISTENCE_DISABLED";
}>;

export type CanonicalPersistenceComposition = MemoryTestPersistenceComposition | DisabledPersistenceComposition;

/**
 * The only constructor for canonical platform persistence adapters.
 *
 * There is deliberately no connection-error fallback. Until a PostgreSQL
 * implementation of the existing canonical ports is present, selecting
 * isolated_postgres fails before product services can start.
 */
export function createCanonicalPersistenceComposition(
  config: CanonicalPersistenceConfig,
): CanonicalPersistenceComposition {
  if (config.mode === "disabled") {
    return Object.freeze({ mode: "disabled", durable: false, reason: "PERSISTENCE_DISABLED" });
  }

  if (config.mode === "isolated_postgres") {
    throw new PersistenceCompositionError("ISOLATED_POSTGRES_ADAPTER_NOT_IMPLEMENTED");
  }

  if (config.execution_boundary !== "test" && config.execution_boundary !== "hermetic_synthetic") {
    throw new PersistenceCompositionError("MEMORY_TEST_ONLY_OUTSIDE_HERMETIC_EXECUTION");
  }

  const audit = new InMemoryHashChainAudit();
  const platformStore = new LocalDurablePlatformStore();
  return Object.freeze({
    mode: "memory_test_only",
    durable: false,
    platform_store: platformStore,
    canonical_repository: new CanonicalPlatformRepository(platformStore),
    case_analysis_repository: new InMemoryCaseAnalysisRepository(),
    jobs: new LocalDurableJobQueue(),
    audit,
    object_write_saga: new LocalObjectWriteSaga(),
    private_storage: new LocalPrivateObjectStorage({
      root: config.private_storage_root,
      environment: "generated_local_test_root",
      audit,
      nowMs: config.now_ms,
      authorizeRead: config.authorize_read,
    }),
  });
}

export function requireOperationalPersistence(
  composition: CanonicalPersistenceComposition,
): MemoryTestPersistenceComposition {
  if (composition.mode === "disabled") throw new PersistenceCompositionError("PERSISTENCE_DISABLED");
  return composition;
}

export function parsePersistenceRuntimeMode(value: string | undefined): PersistenceRuntimeMode {
  if (value === undefined || value.trim() === "") {
    throw new PersistenceCompositionError("PERSISTENCE_MODE_REQUIRED");
  }
  if (!(PERSISTENCE_RUNTIME_MODES as readonly string[]).includes(value)) {
    throw new PersistenceCompositionError("PERSISTENCE_MODE_INVALID");
  }
  return value as PersistenceRuntimeMode;
}
