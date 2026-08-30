import { createHash } from "node:crypto";

import {
  KILL_SWITCHES,
  OPERATOR_ACTIONS,
  OPERATOR_REASON_CODES,
  type KillSwitch,
  type OperatorAuditReceipt,
  type OperatorCommand,
  type OperatorPlan,
} from "./contracts";

const OPAQUE = /^[a-z][a-z0-9_-]{7,63}$/;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalCommand(command: OperatorCommand): string {
  return JSON.stringify({
    action: command.action,
    actor_id: command.actor_id,
    correlation_id: command.correlation_id,
    dry_run: command.dry_run,
    idempotency_key: command.idempotency_key,
    reason_code: command.reason_code,
    schema_version: command.schema_version,
    target_ref: command.target_ref,
  });
}

function assertCommand(command: OperatorCommand): void {
  if (command.schema_version !== "tivdoc-operator-command-v0.7.0") throw new Error("OPERATOR_SCHEMA_INVALID");
  if (!(OPERATOR_ACTIONS as readonly string[]).includes(command.action)) throw new Error("OPERATOR_ACTION_INVALID");
  if (!(OPERATOR_REASON_CODES as readonly string[]).includes(command.reason_code)) throw new Error("OPERATOR_REASON_INVALID");
  if (command.dry_run !== true) throw new Error("OPERATOR_MUTATION_NOT_AUTHORIZED");
  if (![command.actor_id, command.idempotency_key, command.correlation_id, command.target_ref].every((value) => OPAQUE.test(value))) {
    throw new Error("OPERATOR_OPAQUE_REFERENCE_INVALID");
  }
}

export class DefaultOffKillSwitches {
  readonly #enabled = new Set<KillSwitch>();
  readonly #mode: "local_verification" | "production";

  constructor(mode: "local_verification" | "production" = "production") {
    this.#mode = mode;
  }

  isEnabled(capability: KillSwitch): boolean {
    if (!(KILL_SWITCHES as readonly string[]).includes(capability)) throw new Error("KILL_SWITCH_UNKNOWN");
    return this.#enabled.has(capability);
  }

  snapshot(): Readonly<Record<KillSwitch, boolean>> {
    return Object.freeze(Object.fromEntries(KILL_SWITCHES.map((item) => [item, this.#enabled.has(item)])) as Record<KillSwitch, boolean>);
  }

  /** Test/local bootstrap only. This object is not backed by environment or production configuration. */
  enableForLocalVerification(capability: KillSwitch): void {
    if (this.#mode !== "local_verification") throw new Error("LOCAL_KILL_SWITCH_OVERRIDE_FORBIDDEN");
    this.#enabled.add(capability);
  }

  disable(capability: KillSwitch): void {
    this.#enabled.delete(capability);
  }
}

export class LocalDryRunOperator {
  readonly #byIdempotency = new Map<string, Readonly<{ commandHash: string; receipt: OperatorAuditReceipt }>>();
  readonly #receipts: OperatorAuditReceipt[] = [];
  readonly #now: () => string;

  constructor(now: () => string) {
    this.#now = now;
  }

  execute(command: OperatorCommand): OperatorPlan {
    assertCommand(command);
    const commandHash = sha256(canonicalCommand(command));
    const existing = this.#byIdempotency.get(command.idempotency_key);
    if (existing) {
      if (existing.commandHash !== commandHash) throw new Error("OPERATOR_IDEMPOTENCY_CONFLICT");
      return Object.freeze({
        action: command.action,
        target_ref: command.target_ref,
        mutation_applied: false,
        idempotent_replay: true,
        required_kill_switch: requiredSwitch(command.action),
        receipt: existing.receipt,
      });
    }

    const previous = this.#receipts.at(-1)?.receipt_sha256 ?? null;
    const core = {
      schema_version: "tivdoc-operator-audit-v0.7.0" as const,
      sequence: this.#receipts.length + 1,
      action: command.action,
      actor_id: command.actor_id,
      reason_code: command.reason_code,
      idempotency_key: command.idempotency_key,
      command_sha256: commandHash,
      previous_sha256: previous,
      outcome: "DRY_RUN_PLANNED" as const,
      occurred_at: this.#now(),
    };
    const receipt = Object.freeze({ ...core, receipt_sha256: sha256(JSON.stringify(core)) });
    this.#receipts.push(receipt);
    this.#byIdempotency.set(command.idempotency_key, Object.freeze({ commandHash, receipt }));
    return Object.freeze({
      action: command.action,
      target_ref: command.target_ref,
      mutation_applied: false,
      idempotent_replay: false,
      required_kill_switch: requiredSwitch(command.action),
      receipt,
    });
  }

  verifyAuditChain(): Readonly<{ valid: boolean; count: number; tail_sha256: string | null }> {
    let previous: string | null = null;
    for (const receipt of this.#receipts) {
      const { receipt_sha256: ignored, ...core } = receipt;
      void ignored;
      if (receipt.previous_sha256 !== previous || sha256(JSON.stringify(core)) !== receipt.receipt_sha256) {
        return Object.freeze({ valid: false, count: this.#receipts.length, tail_sha256: previous });
      }
      previous = receipt.receipt_sha256;
    }
    return Object.freeze({ valid: true, count: this.#receipts.length, tail_sha256: previous });
  }
}

function requiredSwitch(action: OperatorCommand["action"]): KillSwitch | null {
  if (action === "job_replay") return "analysis";
  if (action === "case_hold" || action === "object_quarantine") return "customer_processing";
  return null;
}
