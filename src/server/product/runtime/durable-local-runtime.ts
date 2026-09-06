import path from "node:path";
import "../routes/server-boundary.ts";

import { ConfiguredIdentityVerificationKeyResolver } from "../../platform/auth/configured-verification-key.ts";
import { CryptographicJwtIdentityVerifier } from "../../platform/auth/identity-verification.ts";
import { createStableEntrypointRuntime, STABLE_PRODUCT_DISPATCHER_ROOTS } from "../../platform/capabilities/stable-entrypoint-runtime.ts";
import { startCanonicalApplicationPostgres } from "../../platform/composition/canonical-postgres-application.ts";
import {
  NodePostgresConnectionFactory,
  deriveNodePostgresTargetDescriptor,
  type NodePostgresRemoteDevTarget,
} from "../../platform/persistence/postgres/runtime/node-pg-driver.ts";
import { LocalRuntimePrivateBlobProvider } from "../../platform/storage/local-runtime/private-blob-provider.ts";
import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";
import { PostgresIdentitySessionStateReader } from "../durable-postgres/boundary-repositories.ts";
import {
  createDurablePostgresGlobalDependencyInvalidationService,
  DURABLE_GLOBAL_INVALIDATION_POSTGRES_PROOF,
} from "../dependency-invalidation/postgres-port.ts";
import { DurableCryptographicProductSessionBoundary } from "../auth/durable-session-boundary.ts";
import { installProductSessionBoundary } from "../auth/runtime.ts";
import { createDurableCustomerPortalAdapter } from "../customer-portal/durable-postgres-application.ts";
import { createDurableGovernanceOperationsRouteAdapter } from "../internal-ops/durable-governance/application.ts";
import { LocalFileDurableShadowStateStore } from "../../engine/shadow/durable-store.ts";
import type { ShadowSummarySource } from "../../engine/shadow/summary-projection.ts";
import {
  createDurableInternalOpsLocalRuntimeClass,
  createDurableInternalOpsPostgresAdapter,
} from "../internal-ops/durable-postgres-application.ts";
import {
  createDurableMultiDocumentProductRouteAdapter,
  type DurableMultiDocumentProductApplication,
} from "../multi-document-intake/index.ts";
import { createDurableProductRouteRegistration } from "../routes/durable-registration.ts";
import { createLeastPrivilegeProductSessionContext } from "../routes/least-privilege-session-context.ts";
import {
  installCanonicalProductApplicationComposition,
  installCanonicalProductEntrypointCapabilities,
} from "../routes/runtime.ts";
import { createDurableFreshWorkerLauncher } from "../worker-runtime/durable-worker-launcher.ts";
import {
  DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL,
  buildDurableLocalInternalOpsFlags,
  buildDurableLocalProductCapabilityProjection,
  readDurableLocalProductRuntimeConfig,
} from "./durable-local-config.ts";
import { createDurableSyntheticReportPipeline } from "./durable-synthetic-report-pipeline.ts";

export const DURABLE_LOCAL_PRODUCT_STARTUP_SCHEMA_VERSION =
  "tivdoc-durable-local-product-startup-v0.10.2" as const;

export type DurableLocalProductStartupProof = Readonly<{
  schema_version: typeof DURABLE_LOCAL_PRODUCT_STARTUP_SCHEMA_VERSION;
  status: "READY";
  execution_scope: "local_only";
  persistence: "isolated_postgres";
  postgres_target_id: string;
  runtime_database_roles: readonly ["identity", "web", "operations", "worker"];
  identity_session: "durable_cryptographic_postgresql";
  private_storage: "local_private_immutable_filesystem";
  private_storage_root_binding_sha256: string;
  fresh_worker_process_required: true;
  capability_projection_sha256: string;
  stable_product_dispatchers: 37;
  durable_governance_replacements_wired: 4;
  durable_multi_document_intake_wired: true;
  durable_global_dependency_invalidation_wired: true;
  product_reachable_memory_fallbacks: 0;
  real_legal_activations: 0;
  customer_processing_enabled: false;
  customer_shadow_enabled: false;
  production_delivery_enabled: false;
}>;

type DurableRuntimeGlobal = typeof globalThis & {
  __tivdocDurableLocalProductInitialization?: Promise<DurableLocalProductStartupProof>;
  __tivdocDurableLocalProductProof?: DurableLocalProductStartupProof;
  __tivdocDurableLocalProductClose?: () => Promise<void>;
  __tivdocDurableLocalProductSignalHandlers?: true;
  __tivdocDurableLocalProductWorkflows?: DurableLocalProductWorkflowRegistration;
};

export type DurableLocalProductWorkflowRegistration = Readonly<{
  multi_document_intake: DurableMultiDocumentProductApplication;
  create_dependency_invalidation(
    actor: VerifiedActor,
    correlation_id: string,
  ): ReturnType<typeof createDurablePostgresGlobalDependencyInvalidationService>;
}>;

function runtimeGlobal(): DurableRuntimeGlobal {
  return globalThis as DurableRuntimeGlobal;
}

/**
 * The only ordinary local non-test product composition root. Configuration is
 * validated before any pool is opened, every runtime actor uses a dedicated
 * database role, and global route state is installed only after the complete
 * durable composition has been constructed successfully.
 */

/**
 * L7-8. The offline-shadow summary source: the durable scheduler's file store
 * at the configured root, and the last draft run's summary sidecar beside it.
 * Null when no root is configured, and then the /operations shadow panel is
 * CAPABILITY_ABSENT exactly as before.
 */
function shadowSummarySource(root: string | null): ShadowSummarySource | null {
  if (root === null) return null;
  return Object.freeze({
    store: new LocalFileDurableShadowStateStore({ root, root_kind: "generated_offline_synthetic_state" }),
    summary_path: path.join(path.dirname(root), "draft-shadow-summary-v1.json"),
  });
}

export async function initializeDurableLocalProductRuntime(): Promise<DurableLocalProductStartupProof> {
  const runtime = runtimeGlobal();
  runtime.__tivdocDurableLocalProductInitialization ??= buildDurableLocalProductRuntime();
  return runtime.__tivdocDurableLocalProductInitialization;
}

export function resolveDurableLocalProductStartupProof(): DurableLocalProductStartupProof | null {
  return runtimeGlobal().__tivdocDurableLocalProductProof ?? null;
}

export async function closeDurableLocalProductRuntime(): Promise<void> {
  await runtimeGlobal().__tivdocDurableLocalProductClose?.();
}

export function resolveDurableLocalProductWorkflowRegistration():
DurableLocalProductWorkflowRegistration | null {
  return runtimeGlobal().__tivdocDurableLocalProductWorkflows ?? null;
}

async function buildDurableLocalProductRuntime(): Promise<DurableLocalProductStartupProof> {
  const config = readDurableLocalProductRuntimeConfig();
  const remote = config.remote_dev_target;
  const target = deriveNodePostgresTargetDescriptor(config.connection_urls.web, remote);
  const identityFactory = runtimeFactory(config.connection_urls.identity, "tivdoc_identity_runtime_v0102", 8, remote);
  const webFactory = runtimeFactory(config.connection_urls.web, "tivdoc_web_runtime_v0102", 12, remote);
  const operationsFactory = runtimeFactory(config.connection_urls.operations, "tivdoc_operations_runtime_v0102", 12, remote);
  const factories = Object.freeze([identityFactory, webFactory, operationsFactory] as const);
  let installed = false;

  try {
    const postgres = await startCanonicalApplicationPostgres({
      mode: "isolated_postgres",
      execution_boundary: "non_test",
      target,
      build_identity_sha: config.build_identity_sha,
    }, {
      runtime_connection_factories: Object.freeze({
        web: webFactory,
        operations: operationsFactory,
      }),
    });
    if (postgres.mode !== "isolated_postgres" || postgres.durable !== true) {
      throw new Error("DURABLE_LOCAL_PRODUCT_POSTGRES_STARTUP_FAILED");
    }

    const keyResolver = new ConfiguredIdentityVerificationKeyResolver({
      issuer: config.identity.issuer,
      key_id: config.identity.key_id,
      algorithm: config.identity.algorithm,
      public_key_spki_pem: config.identity.public_key_spki_pem,
      not_before_epoch: config.identity.key_not_before_epoch,
      expires_at_epoch: config.identity.key_expires_at_epoch,
    });
    const identityVerifier = new CryptographicJwtIdentityVerifier({
      config: Object.freeze({
        issuer: config.identity.issuer,
        audiences: Object.freeze(["portal", "operations"]),
        algorithms: Object.freeze([config.identity.algorithm]),
        clock_skew_seconds: config.identity.clock_skew_seconds,
        max_token_lifetime_seconds: config.identity.max_token_lifetime_seconds,
      }),
      keys: keyResolver,
      sessions: new PostgresIdentitySessionStateReader(identityFactory),
    });
    const sessionBoundary = new DurableCryptographicProductSessionBoundary({
      verifier: identityVerifier,
      allowed_origin: config.allowed_origin,
      allow_local_loopback_http: config.allow_loopback_http,
      environment: process.env,
    });
    const storage = new LocalRuntimePrivateBlobProvider({
      root: config.private_storage_root,
      runtime_class: "ignored_local_private_filesystem",
      publicly_addressable: false,
      managed_platform_verified: false,
    });
    const workerLauncher = createDurableFreshWorkerLauncher(config);
    const syntheticReportPipeline = createDurableSyntheticReportPipeline({
      postgres,
      storage,
      worker_launcher: workerLauncher,
      worker_identity: Object.freeze({
        actor_id: config.worker_identity.actor_id,
        tenant_id: config.worker_identity.tenant_id,
      }),
    });
    const sessionContext = createLeastPrivilegeProductSessionContext(postgres);
    const runtimeClass = createDurableInternalOpsLocalRuntimeClass({
      sentinel: DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL,
      config,
    });
    const registration = createDurableProductRouteRegistration({
      session_boundary: sessionBoundary,
      postgres,
      session_context: sessionContext,
      create_portal: (context) => createDurableCustomerPortalAdapter(context, {
        storage,
        download_grant_hmac_key: config.download_grant_hmac_key,
      }),
      create_operations: (context) => {
        const base = createDurableInternalOpsPostgresAdapter({
          context,
          flags: buildDurableLocalInternalOpsFlags(),
          runtime_class: runtimeClass,
          synthetic_report_pipeline: syntheticReportPipeline,
        });
        return createDurableGovernanceOperationsRouteAdapter({ context, base, shadow: shadowSummarySource(config.offline_shadow_state_root) });
      },
    });
    const capabilities = createStableEntrypointRuntime({
      projection: buildDurableLocalProductCapabilityProjection(),
    });
    const multiDocumentIntake = createDurableMultiDocumentProductRouteAdapter(registration.context);
    const workflows: DurableLocalProductWorkflowRegistration = Object.freeze({
      multi_document_intake: multiDocumentIntake.service,
      create_dependency_invalidation: (actor, correlationId) =>
        createDurablePostgresGlobalDependencyInvalidationService({
          session_context: registration.context.session_context,
          actor,
          correlation_id: correlationId,
        }),
    });
    // U0's frozen denominator, at the moment the local runtime installs: 37 Next
    // roots plus the canonical route registrar. It is repeated here rather than
    // read from the ledger on purpose — a startup that trusted the ledger would
    // prove nothing about the ledger.
    if (STABLE_PRODUCT_DISPATCHER_ROOTS.length !== 40
        || syntheticReportPipeline.proof().product_reachable_memory_repositories !== 0
        || multiDocumentIntake.product_proof.product_reachable_memory_fallbacks !== 0
        || multiDocumentIntake.product_proof.legal_conclusions_created !== 0
        || DURABLE_GLOBAL_INVALIDATION_POSTGRES_PROOF.memory_fallbacks !== 0
        || DURABLE_GLOBAL_INVALIDATION_POSTGRES_PROOF.worker_fence_required !== true) {
      throw new Error("DURABLE_LOCAL_PRODUCT_STARTUP_PROOF_INVALID");
    }

    installCanonicalProductEntrypointCapabilities(capabilities);
    installProductSessionBoundary(registration.session_boundary);
    installCanonicalProductApplicationComposition(registration.application_composition);
    runtimeGlobal().__tivdocDurableLocalProductWorkflows = workflows;
    installed = true;

    const storageProof = storage.proof();
    const proof: DurableLocalProductStartupProof = Object.freeze({
      schema_version: DURABLE_LOCAL_PRODUCT_STARTUP_SCHEMA_VERSION,
      status: "READY",
      execution_scope: "local_only",
      persistence: "isolated_postgres",
      postgres_target_id: postgres.target_id,
      runtime_database_roles: Object.freeze(["identity", "web", "operations", "worker"] as const),
      identity_session: "durable_cryptographic_postgresql",
      private_storage: "local_private_immutable_filesystem",
      private_storage_root_binding_sha256: storageProof.root_binding_sha256,
      fresh_worker_process_required: true,
      capability_projection_sha256: capabilities.projection.projection_sha256,
      stable_product_dispatchers: 37,
      durable_governance_replacements_wired: 4,
      durable_multi_document_intake_wired: true,
      durable_global_dependency_invalidation_wired: true,
      product_reachable_memory_fallbacks: 0,
      real_legal_activations: 0,
      customer_processing_enabled: false,
      customer_shadow_enabled: false,
      production_delivery_enabled: false,
    });
    runtimeGlobal().__tivdocDurableLocalProductProof = proof;
    runtimeGlobal().__tivdocDurableLocalProductClose = onceAsync(async () => {
      delete runtimeGlobal().__tivdocDurableLocalProductWorkflows;
      const results = await Promise.allSettled(factories.map((factory) => factory.close()));
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("DURABLE_LOCAL_PRODUCT_SHUTDOWN_FAILED");
      }
    });
    installSignalHandlers();
    return proof;
  } catch (error) {
    if (!installed) await Promise.allSettled(factories.map((factory) => factory.close()));
    throw error;
  }
}

function runtimeFactory(
  connectionUrl: string,
  applicationName: string,
  maxConnections: number,
  remoteDevTarget: NodePostgresRemoteDevTarget | null,
): NodePostgresConnectionFactory {
  return NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: connectionUrl,
    max_connections: maxConnections,
    connection_timeout_ms: 5_000,
    application_name: applicationName,
    remote_dev_target: remoteDevTarget,
  });
}

function onceAsync(operation: () => Promise<void>): () => Promise<void> {
  let promise: Promise<void> | null = null;
  return () => {
    promise ??= operation();
    return promise;
  };
}

function installSignalHandlers(): void {
  const runtime = runtimeGlobal();
  if (runtime.__tivdocDurableLocalProductSignalHandlers) return;
  runtime.__tivdocDurableLocalProductSignalHandlers = true;
  const close = (): void => {
    void closeDurableLocalProductRuntime().catch(() => undefined);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
