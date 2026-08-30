import { describe, expect, it } from "vitest";

import type { OperatorCommand } from "./contracts";
import { DefaultOffKillSwitches, LocalDryRunOperator } from "./controls";

function command(overrides: Partial<OperatorCommand> = {}): OperatorCommand {
  return {
    schema_version: "tivdoc-operator-command-v0.7.0",
    action: "backup_drill",
    actor_id: "actor_00000001",
    reason_code: "BACKUP_DRILL_SCHEDULED",
    idempotency_key: "idem_00000001",
    correlation_id: "request_00000001",
    dry_run: true,
    target_ref: "fixture_00000001",
    ...overrides,
  };
}

describe("V07-P7-OPERATIONS", () => {
  it("keeps every hazardous capability disabled by default", () => {
    const controls = new DefaultOffKillSwitches("local_verification");
    expect(Object.values(controls.snapshot())).toEqual([false, false, false, false, false]);
    controls.enableForLocalVerification("analysis");
    expect(controls.isEnabled("analysis")).toBe(true);
    controls.disable("analysis");
    expect(controls.isEnabled("analysis")).toBe(false);
    expect(() => new DefaultOffKillSwitches().enableForLocalVerification("analysis")).toThrow("LOCAL_KILL_SWITCH_OVERRIDE_FORBIDDEN");
  });

  it("creates a dry-run-only hash-chained audit receipt", () => {
    const operator = new LocalDryRunOperator(() => "2026-08-30T00:00:00.000Z");
    const result = operator.execute(command());
    expect(result.mutation_applied).toBe(false);
    expect(result.receipt.outcome).toBe("DRY_RUN_PLANNED");
    expect(operator.verifyAuditChain()).toMatchObject({ valid: true, count: 1 });
  });

  it("replays the same command but rejects changed payload under the same key", () => {
    const operator = new LocalDryRunOperator(() => "2026-08-30T00:00:00.000Z");
    operator.execute(command());
    expect(operator.execute(command()).idempotent_replay).toBe(true);
    expect(() => operator.execute(command({ target_ref: "fixture_00000002" }))).toThrow("OPERATOR_IDEMPOTENCY_CONFLICT");
    expect(operator.verifyAuditChain().count).toBe(1);
  });

  it("rejects mutation mode and sensitive/free-form identifiers", () => {
    const operator = new LocalDryRunOperator(() => "2026-08-30T00:00:00.000Z");
    expect(() => operator.execute({ ...command(), dry_run: false } as unknown as OperatorCommand)).toThrow("OPERATOR_MUTATION_NOT_AUTHORIZED");
    expect(() => operator.execute(command({ actor_id: "person@example.test" }))).toThrow("OPERATOR_OPAQUE_REFERENCE_INVALID");
  });
});
