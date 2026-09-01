import "./server-boundary.ts";

import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";
import type { ProductAudience } from "../auth/hermetic-session.ts";
import type { ProductSessionBoundary } from "../auth/runtime.ts";
import type { CustomerPortalApplicationPort } from "../customer-portal/repository.ts";
import { DurableProductPostgresApplication } from "../durable-postgres/application.ts";
import type { InternalOpsApplicationPort } from "../internal-ops/application-port.ts";
import {
  CANONICAL_POSTGRES_SCHEMA_VERSION,
  type IsolatedCanonicalPostgresComposition,
  type TransactionScopedPostgresBundle,
} from "../../platform/composition/canonical-postgres.ts";
import type { CanonicalApplicationPostgresComposition } from "../../platform/composition/canonical-postgres-application.ts";
import type { PostgresAnalysisRepositories } from "../../platform/persistence/postgres/analysis/index.ts";
import type { PostgresIntakeAdapterBundle } from "../../platform/persistence/postgres/intake/index.ts";
import type { CanonicalProductApplicationComposition } from "./runtime.ts";

export type DurableProductPostgresRoot = IsolatedCanonicalPostgresComposition<
  PostgresIntakeAdapterBundle,
  PostgresAnalysisRepositories
>;

export interface DurableProductRouteSessionContextPort {
  readonly proof_class: "LEAST_PRIVILEGE_VERIFIED_SESSION_CONTEXT";
  readonly uses_service_role: false;
  readonly bypasses_rls: false;
  readonly postgres: DurableProductPostgresRoot;
  transaction<T>(
    input: Readonly<{
      actor: VerifiedActor;
      audience: ProductAudience;
      case_id: string;
      correlation_id: string;
    }>,
    operation: (
      bundle: TransactionScopedPostgresBundle<PostgresIntakeAdapterBundle, PostgresAnalysisRepositories>,
    ) => Promise<T>,
  ): Promise<T>;
}

export type DurableProductRouteContext = Readonly<{
  postgres: DurableProductPostgresRoot;
  product: DurableProductPostgresApplication;
  session_context: DurableProductRouteSessionContextPort;
}>;

export type DurableProductRouteServiceAdapter<TService> = Readonly<{
  service: TService;
  postgres: DurableProductPostgresRoot;
  product: DurableProductPostgresApplication;
  session_context: DurableProductRouteSessionContextPort;
  proof_class: "POSTGRESQL_TRANSACTIONAL_ROUTE_SERVICE";
}>;

export type DurableProductRouteRegistration = Readonly<{
  session_boundary: ProductSessionBoundary & Readonly<{ proof_class: "DURABLE_CRYPTOGRAPHIC_SESSION" }>;
  application_composition: CanonicalProductApplicationComposition;
  context: DurableProductRouteContext;
}>;

/**
 * Builds a fully validated registration value without mutating global runtime
 * state. The canonical startup root owns the two one-shot install calls.
 */
export function createDurableProductRouteRegistration(input: Readonly<{
  session_boundary: ProductSessionBoundary;
  postgres: CanonicalApplicationPostgresComposition;
  session_context: DurableProductRouteSessionContextPort;
  create_portal(context: DurableProductRouteContext): DurableProductRouteServiceAdapter<CustomerPortalApplicationPort>;
  create_operations(context: DurableProductRouteContext): DurableProductRouteServiceAdapter<InternalOpsApplicationPort>;
}>): DurableProductRouteRegistration {
  if (input.session_boundary.proof_class !== "DURABLE_CRYPTOGRAPHIC_SESSION") {
    throw new Error("DURABLE_PRODUCT_ROUTE_SESSION_REQUIRED");
  }
  if (input.postgres.mode !== "isolated_postgres"
      || input.postgres.durable !== true
      || input.postgres.schema_version !== CANONICAL_POSTGRES_SCHEMA_VERSION) {
    throw new Error("DURABLE_PRODUCT_ROUTE_POSTGRES_REQUIRED");
  }
  if (input.session_context.proof_class !== "LEAST_PRIVILEGE_VERIFIED_SESSION_CONTEXT"
      || input.session_context.uses_service_role !== false
      || input.session_context.bypasses_rls !== false
      || input.session_context.postgres !== input.postgres
      || typeof input.session_context.transaction !== "function") {
    throw new Error("DURABLE_PRODUCT_ROUTE_SESSION_CONTEXT_REQUIRED");
  }

  const product = new DurableProductPostgresApplication(input.postgres);
  const proof = product.proof();
  if (proof.persistence_mode !== "isolated_postgres"
      || proof.durable !== true
      || proof.product_reachable_memory_fallbacks !== 0) {
    throw new Error("DURABLE_PRODUCT_ROUTE_POSTGRES_REQUIRED");
  }
  const context = Object.freeze({
    postgres: input.postgres,
    product,
    session_context: input.session_context,
  });
  const portal = input.create_portal(context);
  const operations = input.create_operations(context);
  assertSameTransactionRoot(portal, context);
  assertSameTransactionRoot(operations, context);
  assertPortalApplication(portal.service);
  assertOperationsApplication(operations.service);

  const applicationComposition: CanonicalProductApplicationComposition = Object.freeze({
    services: Object.freeze({ portal: portal.service, operations: operations.service }),
    persistence: Object.freeze({ mode: "isolated_postgres" as const, durable: true as const }),
    proof_class: "POSTGRESQL_EXECUTION_PROOF" as const,
  });
  return Object.freeze({
    session_boundary: input.session_boundary as DurableProductRouteRegistration["session_boundary"],
    application_composition: applicationComposition,
    context,
  });
}

function assertSameTransactionRoot<TService>(
  adapter: DurableProductRouteServiceAdapter<TService>,
  context: DurableProductRouteContext,
): void {
  if (adapter.proof_class !== "POSTGRESQL_TRANSACTIONAL_ROUTE_SERVICE"
      || adapter.postgres !== context.postgres
      || adapter.product !== context.product
      || adapter.session_context !== context.session_context) {
    throw new Error("DURABLE_PRODUCT_ROUTE_TRANSACTION_ROOT_MISMATCH");
  }
}

function assertPortalApplication(service: CustomerPortalApplicationPort): void {
  const methods: readonly (keyof CustomerPortalApplicationPort)[] = [
    "getCaseProjection",
    "listReports",
    "answerClarification",
    "createPrivacyRequest",
    "createReportAccessGrant",
    "downloadReport",
  ];
  if (!service || methods.some((method) => typeof service[method] !== "function")) {
    throw new Error("DURABLE_PRODUCT_ROUTE_PORTAL_REQUIRED");
  }
}

function assertOperationsApplication(service: InternalOpsApplicationPort): void {
  if (!service || typeof service.read !== "function" || typeof service.mutate !== "function") {
    throw new Error("DURABLE_PRODUCT_ROUTE_OPERATIONS_REQUIRED");
  }
}
