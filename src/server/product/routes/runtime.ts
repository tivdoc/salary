import "./server-boundary.ts";

import type { CustomerPortalService } from "../customer-portal/service.ts";
import { resolveInternalOpsRuntime } from "../internal-ops/runtime.ts";
import type { InternalOpsService } from "../internal-ops/service.ts";

export type CanonicalProductRouteServices = Readonly<{
  portal: CustomerPortalService;
  operations?: InternalOpsService;
}>;

type ProductRouteRuntimeGlobal = typeof globalThis & {
  __tivdocCanonicalProductRouteServices?: CanonicalProductRouteServices;
};

function runtimeGlobal(): ProductRouteRuntimeGlobal {
  return globalThis as ProductRouteRuntimeGlobal;
}

/** Called by the canonical application composition root after repository wiring. */
export function installCanonicalProductRouteServices(services: CanonicalProductRouteServices): void {
  if (runtimeGlobal().__tivdocCanonicalProductRouteServices) throw new Error("canonical_product_route_services_already_installed");
  runtimeGlobal().__tivdocCanonicalProductRouteServices = Object.freeze(services);
}

export function resolveCanonicalPortalService(): CustomerPortalService | null {
  return runtimeGlobal().__tivdocCanonicalProductRouteServices?.portal ?? null;
}

export function resolveCanonicalOperationsService(): InternalOpsService | null {
  return runtimeGlobal().__tivdocCanonicalProductRouteServices?.operations ?? resolveInternalOpsRuntime().service;
}

export function resetCanonicalProductRouteServicesForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("canonical_product_route_services_reset_forbidden");
  delete runtimeGlobal().__tivdocCanonicalProductRouteServices;
}
