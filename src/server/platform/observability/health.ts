export type DependencyHealth = Readonly<{
  dependency: "audit" | "jobs" | "local_backup" | "object_storage" | "persistence";
  available: boolean;
  required_for_readiness: boolean;
}>;

export type CoarseHealth = Readonly<{
  schema_version: "tivdoc-coarse-health-v0.7.0";
  status: "ok" | "degraded" | "unavailable";
}>;

export type CoarseReadiness = Readonly<{
  schema_version: "tivdoc-coarse-readiness-v0.7.0";
  ready: boolean;
  status: "ready" | "not_ready";
}>;

export function coarseHealth(dependencies: readonly DependencyHealth[]): CoarseHealth {
  const available = dependencies.filter((item) => item.available).length;
  const status = dependencies.length === 0 || available === 0 ? "unavailable" : available === dependencies.length ? "ok" : "degraded";
  return Object.freeze({ schema_version: "tivdoc-coarse-health-v0.7.0", status });
}

export function coarseReadiness(dependencies: readonly DependencyHealth[], operationallyEnabled: boolean): CoarseReadiness {
  const ready = operationallyEnabled && dependencies.filter((item) => item.required_for_readiness).every((item) => item.available);
  return Object.freeze({ schema_version: "tivdoc-coarse-readiness-v0.7.0", ready, status: ready ? "ready" : "not_ready" });
}
