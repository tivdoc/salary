// L8-1 / D2. The runtime a closed deployment installs: the projection in which
// every capability is blocked, through the same creation and installation
// path the local runtimes use — the registry is validated, the instance is
// verified, the one-shot install refuses a second. Nothing here reads a flag:
// the caller (instrumentation.register) decided the environment is closed.
import { createStableEntrypointRuntime, installStableEntrypointRuntime, type StableEntrypointRuntime } from "./stable-entrypoint-runtime.ts";
import { buildClosedProductionCapabilityProjection } from "./system-capabilities.ts";

export function createClosedProductionRuntime(): StableEntrypointRuntime {
  return createStableEntrypointRuntime({ projection: buildClosedProductionCapabilityProjection() });
}

export function installClosedProductionRuntime(): StableEntrypointRuntime {
  const runtime = createClosedProductionRuntime();
  installStableEntrypointRuntime(runtime);
  return runtime;
}
