import path from "node:path";

export const PROHIBITED_RUNTIME_ACTIONS = [
  "construct_openai_client",
  "construct_external_supabase_client",
  "access_customer_path",
  "execute_migration",
  "execute_deploy",
  "emit_finding",
] as const;

export type ProhibitedRuntimeAction = (typeof PROHIBITED_RUNTIME_ACTIONS)[number];

export class Wave2RuntimeDenialError extends Error {
  readonly action: ProhibitedRuntimeAction;

  constructor(action: ProhibitedRuntimeAction) {
    super(`wave2_evidence_audit_runtime_denied:${action}`);
    this.name = "Wave2RuntimeDenialError";
    this.action = action;
  }
}

/**
 * The evidence-audit capability surface is deliberately read-only. Prohibited
 * operations are represented only as canaries and are rejected before a
 * supplied side-effect callback could run.
 */
export function denyRuntimeAction(action: ProhibitedRuntimeAction, sideEffectCanary?: () => unknown): never {
  void sideEffectCanary;
  throw new Wave2RuntimeDenialError(action);
}

export function assertNoProhibitedCustomerPath(candidate: string) {
  const normalized = candidate.replaceAll("\\", "/").toLowerCase();
  const prohibited = [
    "customer-payslip-data-only-v3",
    "/eval/customer-payslips/",
    "/customer-payslips/",
    "/cases/",
  ];
  if (prohibited.some((segment) => normalized.includes(segment))) {
    throw new Wave2RuntimeDenialError("access_customer_path");
  }
  return path.resolve(candidate);
}

export function runRuntimeDenialCanaries() {
  const invocations: Record<ProhibitedRuntimeAction, number> = Object.fromEntries(
    PROHIBITED_RUNTIME_ACTIONS.map((action) => [action, 0]),
  ) as Record<ProhibitedRuntimeAction, number>;
  const results = PROHIBITED_RUNTIME_ACTIONS.map((action) => {
    let denied = false;
    try {
      denyRuntimeAction(action, () => {
        invocations[action] += 1;
      });
    } catch (error) {
      denied = error instanceof Wave2RuntimeDenialError && error.action === action;
    }
    return { action, denied, side_effect_callback_invocations: invocations[action] };
  });
  return {
    schema_version: "tivdoc-wave2-runtime-denial-canaries-v0.4",
    results,
    passed: results.every((result) => result.denied && result.side_effect_callback_invocations === 0),
    openai_calls: 0,
    external_supabase_connections: 0,
    customer_files_read: 0,
    migrations_executed: 0,
    deploy_actions: 0,
    findings_emitted: 0,
  } as const;
}
