import { describe, expect, it, vi } from "vitest";
import {
  assertNoProhibitedCustomerPath,
  denyRuntimeAction,
  PROHIBITED_RUNTIME_ACTIONS,
  runRuntimeDenialCanaries,
  Wave2RuntimeDenialError,
} from "./runtime-denial.ts";

describe("Wave 2 evidence-audit runtime denial boundary", () => {
  it.each(PROHIBITED_RUNTIME_ACTIONS)("denies %s before any side effect", (action) => {
    const sideEffect = vi.fn();
    expect(() => denyRuntimeAction(action, sideEffect)).toThrow(
      `wave2_evidence_audit_runtime_denied:${action}`,
    );
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it("rejects all prohibited customer path spellings without opening them", () => {
    expect(() => assertNoProhibitedCustomerPath("C:\\safe\\customer-payslip-data-only-v3\\one.pdf"))
      .toThrow(Wave2RuntimeDenialError);
    expect(() => assertNoProhibitedCustomerPath("C:/safe/eval/customer-payslips/redacted/one.pdf"))
      .toThrow("wave2_evidence_audit_runtime_denied:access_customer_path");
  });

  it("reports a zero-side-effect canary matrix", () => {
    expect(runRuntimeDenialCanaries()).toMatchObject({
      passed: true,
      openai_calls: 0,
      external_supabase_connections: 0,
      customer_files_read: 0,
      migrations_executed: 0,
      deploy_actions: 0,
      findings_emitted: 0,
    });
  });
});
