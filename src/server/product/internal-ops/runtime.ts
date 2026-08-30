import "./server-boundary.ts";

import { readInternalOpsFlags } from "./flags.ts";
import { InternalOpsService } from "./service.ts";
import type { InternalOpsPorts } from "./ports.ts";

let installedPorts: InternalOpsPorts | null = null;

/** Integration seam for the P1/P2 platform adapters; installation is one-shot. */
export function installInternalOpsPorts(ports: InternalOpsPorts): void {
  if (installedPorts !== null) throw new Error("internal_ops_ports_already_installed");
  installedPorts = Object.freeze(ports);
}

export function resolveInternalOpsRuntime(): Readonly<{
  flags: ReturnType<typeof readInternalOpsFlags>;
  service: InternalOpsService | null;
}> {
  const flags = readInternalOpsFlags();
  return Object.freeze({
    flags,
    service: installedPorts ? new InternalOpsService({ ports: installedPorts, flags }) : null,
  });
}

export function resetInternalOpsPortsForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("internal_ops_test_reset_forbidden");
  installedPorts = null;
}
