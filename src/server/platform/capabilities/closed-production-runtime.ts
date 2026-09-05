// L8-1 / D2, L9-4 / D3. The runtime a closed deployment installs: the
// projection in which every capability is blocked, through the same creation
// and installation path the local runtimes use — the registry is validated,
// the instance is verified, the one-shot install refuses a second. Nothing
// here reads a flag: the caller (instrumentation.register) decided the
// environment is closed.
//
// "Closed" is two things (L9-4). The engine half — every dispatcher the split
// names engine: legal review, the shadow, operations, the portal, the
// registrar — is BLOCK, and answers the product's one empty 404. The product
// half — every dispatcher `main` serves today — is served as `main` serves
// it: no capability consulted, no limit applied, the route's own code (the
// live site's) deciding. A dispatcher the split does not name is BLOCK.
import { routeHalfOf } from "./route-split.ts";
import { createStableEntrypointRuntime, installStableEntrypointRuntime, type StableEntrypointRuntime } from "./stable-entrypoint-runtime.ts";
import { PRODUCTION_LEGAL_ENGINE_CLOSED, buildClosedProductionCapabilityProjection } from "./system-capabilities.ts";

export const ROUTE_HALF_UNASSIGNED = "ROUTE_HALF_UNASSIGNED" as const;

export function createClosedProductionRuntime(): StableEntrypointRuntime {
  return createStableEntrypointRuntime({
    projection: buildClosedProductionCapabilityProjection(),
    served_as_main: (entrypointId) => routeHalfOf(entrypointId) === "product",
    // The engine half is blocked whether or not it needs a capability (the
    // registrar needs none); a dispatcher the split does not name is blocked
    // as unassigned — nothing defaults into the open half.
    blocked_by_declaration: (entrypointId) => {
      const half = routeHalfOf(entrypointId);
      return half === "product" ? null : half === "engine" ? PRODUCTION_LEGAL_ENGINE_CLOSED : ROUTE_HALF_UNASSIGNED;
    },
  });
}

export function installClosedProductionRuntime(): StableEntrypointRuntime {
  const runtime = createClosedProductionRuntime();
  installStableEntrypointRuntime(runtime);
  return runtime;
}
