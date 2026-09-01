import "./server-boundary.ts";

import { resolveProductSessionBoundary } from "../auth/runtime.ts";
import type { CustomerPortalService } from "../customer-portal/service.ts";
import { resolveInternalOpsRuntime } from "../internal-ops/runtime.ts";
import type { InternalOpsService } from "../internal-ops/service.ts";

export type CanonicalProductRouteServices = Readonly<{
  portal: CustomerPortalService;
  operations?: InternalOpsService;
}>;

/** Structural view keeps route imports version-neutral while the root owns concrete adapters. */
export type CanonicalApplicationPersistence = Readonly<{
  mode: "memory_test_only" | "isolated_postgres" | "disabled";
  durable: boolean;
}>;

export type CanonicalProductApplicationComposition = Readonly<{
  services: CanonicalProductRouteServices;
  persistence: CanonicalApplicationPersistence | null;
  proof_class: "POSTGRESQL_EXECUTION_PROOF" | "STATIC_OR_RECORDING_DRIVER_PROOF" | "HERMETIC_MEMORY_TEST_ONLY";
}>;

type ProductRouteRuntimeGlobal = typeof globalThis & {
  __tivdocCanonicalProductRouteServices?: CanonicalProductRouteServices;
  __tivdocCanonicalProductApplicationComposition?: CanonicalProductApplicationComposition;
};

function runtimeGlobal(): ProductRouteRuntimeGlobal {
  return globalThis as ProductRouteRuntimeGlobal;
}

/** Called by the canonical application composition root after repository wiring. */
export function installCanonicalProductRouteServices(services: CanonicalProductRouteServices): void {
  installCanonicalProductApplicationComposition({ services, persistence: null, proof_class: "HERMETIC_MEMORY_TEST_ONLY" });
}

/** Installs the route services together with the application persistence root as one unit. */
export function installCanonicalProductApplicationComposition(composition: CanonicalProductApplicationComposition): void {
  if (runtimeGlobal().__tivdocCanonicalProductApplicationComposition || runtimeGlobal().__tivdocCanonicalProductRouteServices) {
    throw new Error("canonical_product_application_composition_already_installed");
  }
  const sessionBoundary = resolveProductSessionBoundary();
  if (!sessionBoundary) throw new Error("CANONICAL_PRODUCT_SESSION_BOUNDARY_REQUIRED");
  if (composition.proof_class === "POSTGRESQL_EXECUTION_PROOF") {
    if (sessionBoundary.proof_class !== "DURABLE_CRYPTOGRAPHIC_SESSION"
        || composition.persistence?.mode !== "isolated_postgres" || composition.persistence.durable !== true) {
      throw new Error("CANONICAL_PRODUCT_DURABLE_COMPOSITION_INVALID");
    }
  } else if (sessionBoundary.proof_class !== "HERMETIC_LOOPBACK_TEST_SESSION") {
    throw new Error("CANONICAL_PRODUCT_HERMETIC_COMPOSITION_INVALID");
  }
  const services = Object.freeze(composition.services);
  runtimeGlobal().__tivdocCanonicalProductRouteServices = services;
  runtimeGlobal().__tivdocCanonicalProductApplicationComposition = Object.freeze({ ...composition, services });
}

export function resolveCanonicalPortalService(): CustomerPortalService | null {
  return runtimeGlobal().__tivdocCanonicalProductRouteServices?.portal ?? null;
}

export function resolveCanonicalOperationsService(): InternalOpsService | null {
  return runtimeGlobal().__tivdocCanonicalProductRouteServices?.operations ?? resolveInternalOpsRuntime().service;
}

export function resolveCanonicalApplicationPersistence(): CanonicalApplicationPersistence | null {
  return runtimeGlobal().__tivdocCanonicalProductApplicationComposition?.persistence ?? null;
}

export function resolveCanonicalApplicationProofClass(): CanonicalProductApplicationComposition["proof_class"] | null {
  return runtimeGlobal().__tivdocCanonicalProductApplicationComposition?.proof_class ?? null;
}

export function resetCanonicalProductRouteServicesForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("canonical_product_route_services_reset_forbidden");
  delete runtimeGlobal().__tivdocCanonicalProductRouteServices;
  delete runtimeGlobal().__tivdocCanonicalProductApplicationComposition;
}
