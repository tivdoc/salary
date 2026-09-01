import { describe, expect, it, vi } from "vitest";

import type { ProductSessionBoundary } from "../auth/runtime.ts";
import type { CustomerPortalApplicationPort } from "../customer-portal/repository.ts";
import type { InternalOpsApplicationPort } from "../internal-ops/application-port.ts";
import { CANONICAL_POSTGRES_SCHEMA_VERSION } from "../../platform/composition/canonical-postgres.ts";
import type { CanonicalApplicationPostgresComposition } from "../../platform/composition/canonical-postgres-application.ts";
import {
  createDurableProductRouteRegistration,
  type DurableProductRouteContext,
  type DurableProductRouteSessionContextPort,
  type DurableProductRouteServiceAdapter,
} from "./durable-registration.ts";
import { resolveCanonicalApplicationProofClass } from "./runtime.ts";

function postgres(): Extract<CanonicalApplicationPostgresComposition, { mode: "isolated_postgres" }> {
  return Object.freeze({
    mode: "isolated_postgres" as const,
    durable: true as const,
    target_id: "v0102-route-registration-test",
    schema_version: CANONICAL_POSTGRES_SCHEMA_VERSION,
    transaction: vi.fn(),
    verified_transaction: vi.fn(),
  });
}

function session(proofClass: ProductSessionBoundary["proof_class"] = "DURABLE_CRYPTOGRAPHIC_SESSION"): ProductSessionBoundary {
  return Object.freeze({ proof_class: proofClass, verify: vi.fn(() => null) });
}

function portal(): CustomerPortalApplicationPort {
  return Object.freeze({
    getCaseProjection: vi.fn(),
    listReports: vi.fn(),
    answerClarification: vi.fn(),
    createPrivacyRequest: vi.fn(),
    createReportAccessGrant: vi.fn(),
    downloadReport: vi.fn(),
  }) as unknown as CustomerPortalApplicationPort;
}

function operations(): InternalOpsApplicationPort {
  return Object.freeze({ read: vi.fn(), mutate: vi.fn() }) as unknown as InternalOpsApplicationPort;
}

function sessionContext(root: ReturnType<typeof postgres>): DurableProductRouteSessionContextPort {
  return Object.freeze({
    proof_class: "LEAST_PRIVILEGE_VERIFIED_SESSION_CONTEXT" as const,
    uses_service_role: false as const,
    bypasses_rls: false as const,
    postgres: root,
    transaction: vi.fn(),
  });
}

function adapter<T>(context: DurableProductRouteContext, service: T): DurableProductRouteServiceAdapter<T> {
  return Object.freeze({
    service,
    postgres: context.postgres,
    product: context.product,
    session_context: context.session_context,
    proof_class: "POSTGRESQL_TRANSACTIONAL_ROUTE_SERVICE" as const,
  });
}

describe("durable canonical product route registration", () => {
  it("constructs both services from the exact same PostgreSQL transaction/revision root without installing globals", () => {
    const root = postgres();
    const durableSession = session();
    const databaseSession = sessionContext(root);
    const portalService = portal();
    const operationsService = operations();
    const contexts: DurableProductRouteContext[] = [];
    const registration = createDurableProductRouteRegistration({
      session_boundary: durableSession,
      postgres: root,
      session_context: databaseSession,
      create_portal(context) {
        contexts.push(context);
        return adapter(context, portalService);
      },
      create_operations(context) {
        contexts.push(context);
        return adapter(context, operationsService);
      },
    });

    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toBe(contexts[1]);
    expect(registration.context.postgres).toBe(root);
    expect(registration.context.product.proof()).toMatchObject({
      persistence_mode: "isolated_postgres",
      durable: true,
      product_reachable_memory_fallbacks: 0,
    });
    expect(registration.application_composition).toMatchObject({
      services: { portal: portalService, operations: operationsService },
      persistence: { mode: "isolated_postgres", durable: true },
      proof_class: "POSTGRESQL_EXECUTION_PROOF",
    });
    expect(registration.session_boundary).toBe(durableSession);
    expect(registration.context.session_context).toBe(databaseSession);
    expect(resolveCanonicalApplicationProofClass()).toBeNull();
  });

  it("rejects non-durable identity, non-PostgreSQL persistence and adapter root substitution", () => {
    const root = postgres();
    const createPortal = (context: DurableProductRouteContext) => adapter(context, portal());
    const createOperations = (context: DurableProductRouteContext) => adapter(context, operations());
    expect(() => createDurableProductRouteRegistration({
      session_boundary: session("HERMETIC_LOOPBACK_TEST_SESSION"),
      postgres: root,
      session_context: sessionContext(root),
      create_portal: createPortal,
      create_operations: createOperations,
    })).toThrow("DURABLE_PRODUCT_ROUTE_SESSION_REQUIRED");
    expect(() => createDurableProductRouteRegistration({
      session_boundary: session(),
      postgres: Object.freeze({ mode: "disabled", durable: false, reason: "PERSISTENCE_DISABLED" }),
      session_context: sessionContext(root),
      create_portal: createPortal,
      create_operations: createOperations,
    })).toThrow("DURABLE_PRODUCT_ROUTE_POSTGRES_REQUIRED");
    expect(() => createDurableProductRouteRegistration({
      session_boundary: session(),
      postgres: root,
      session_context: sessionContext(root),
      create_portal(context) {
        return Object.freeze({ ...adapter(context, portal()), postgres: postgres() });
      },
      create_operations: createOperations,
    })).toThrow("DURABLE_PRODUCT_ROUTE_TRANSACTION_ROOT_MISMATCH");
    expect(() => createDurableProductRouteRegistration({
      session_boundary: session(),
      postgres: root,
      session_context: sessionContext(postgres()),
      create_portal: createPortal,
      create_operations: createOperations,
    })).toThrow("DURABLE_PRODUCT_ROUTE_SESSION_CONTEXT_REQUIRED");
  });

  it("rejects a service-role or RLS-bypassing database session context", () => {
    const root = postgres();
    const broadRole = Object.freeze({
      ...sessionContext(root),
      uses_service_role: true,
    }) as unknown as DurableProductRouteSessionContextPort;
    const bypass = Object.freeze({
      ...sessionContext(root),
      bypasses_rls: true,
    }) as unknown as DurableProductRouteSessionContextPort;
    const createPortal = (context: DurableProductRouteContext) => adapter(context, portal());
    const createOperations = (context: DurableProductRouteContext) => adapter(context, operations());

    for (const unsafeContext of [broadRole, bypass]) {
      expect(() => createDurableProductRouteRegistration({
        session_boundary: session(),
        postgres: root,
        session_context: unsafeContext,
        create_portal: createPortal,
        create_operations: createOperations,
      })).toThrow("DURABLE_PRODUCT_ROUTE_SESSION_CONTEXT_REQUIRED");
    }
  });
});
