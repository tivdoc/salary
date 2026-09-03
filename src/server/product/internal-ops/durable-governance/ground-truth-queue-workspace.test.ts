import { describe, expect, it } from "vitest";

import type { VerifiedActor } from "../../../../engine/wave4/contracts.ts";
import type {
  PostgresClient,
  PostgresQueryResult,
  PostgresStatement,
} from "../../../platform/persistence/postgres/contracts.ts";
import type {
  DurableProductRouteContext,
  DurableProductRouteServiceAdapter,
  DurableProductRouteSessionContextPort,
} from "../../routes/durable-registration.ts";
import type { InternalOpsApplicationPort } from "../application-port.ts";
import type { InternalOpsReadKind } from "../service.ts";
import { createDurableGovernanceOperationsRouteAdapter } from "./application.ts";

// Wave 5 (G-12). The nested Ground Truth queue panel, at the application
// layer: every refusal the legal-review workspace has, plus the two that are
// this panel's own — a payload in an entry is a decode failure, and the read
// is bounded before any statement runs.

const NOW = "2026-01-02T03:04:05.000Z";
const CORRELATION = "correlation.ground-truth.001";

const ENTRY = Object.freeze({
  ordinal: "2026-01-02T03:04:05+00|gt.visual.CUSTOMER_EVAL_001",
  work_item_id: "gt.visual.CUSTOMER_EVAL_001",
  workflow_kind: "ground_truth",
  aggregate_id: "CUSTOMER_EVAL_001",
  aggregate_version: "1",
  work_kind: "ground_truth_visual_eligibility",
  required_role: "human_ground_truth_eligibility_reviewer",
  document_sha256: "7".repeat(64),
  object_version_id: "customer-payslip-data-only-v3:CUSTOMER_EVAL_001",
  input_sha256: "8".repeat(64),
  state: "pending",
  claimant_id: null,
  fencing_token: 0,
  lease_expires_at: null,
  created_at: NOW,
  updated_at: NOW,
});

function actor(role: VerifiedActor["role"] = "extraction_reviewer", overrides: Record<string, unknown> = {}): VerifiedActor {
  return Object.freeze({
    actor_id: `actor.${role}.001`,
    role,
    tenant_id: "tenant.synthetic.001",
    assigned_case_ids: Object.freeze([]),
    verified_server_side: true,
    break_glass_reason: role === "break_glass_admin" ? "synthetic verification only" : null,
    break_glass_expires_at: role === "break_glass_admin" ? "2027-01-02T03:04:05.000Z" : null,
    ...overrides,
  }) as VerifiedActor;
}

class RecordingClient implements PostgresClient {
  readonly statements: PostgresStatement[] = [];
  entries: readonly unknown[] = [ENTRY];

  async query(statement: PostgresStatement): Promise<PostgresQueryResult> {
    this.statements.push(statement);
    if (statement.name === "governance_work_queue_list") {
      return Object.freeze({ rows: Object.freeze([{ entries: this.entries }]), row_count: 1 });
    }
    throw new Error(`unexpected_statement:${statement.name}`);
  }
}

function harness() {
  const client = new RecordingClient();
  const postgres = Object.freeze({ marker: "postgres" });
  const product = Object.freeze({ marker: "product" });
  const transactionInputs: unknown[] = [];
  const baseService: InternalOpsApplicationPort = Object.freeze({
    read: async (_actor: VerifiedActor, kind: InternalOpsReadKind) =>
      Object.freeze({ schema_version: "synthetic-core", kind }) as never,
    mutate: async () => Object.freeze({ synthetic: true }) as never,
  });
  const sessionContext = Object.freeze({
    proof_class: "LEAST_PRIVILEGE_VERIFIED_SESSION_CONTEXT",
    uses_service_role: false,
    bypasses_rls: false,
    postgres,
    transaction: async (input: unknown, operation: (bundle: unknown) => Promise<unknown>) => {
      transactionInputs.push(input);
      return operation(Object.freeze({
        context: Object.freeze({ client, transaction_id: `transaction.${transactionInputs.length}` }),
        intake: Object.freeze({}), analysis: Object.freeze({}), runtime: Object.freeze({}),
      }));
    },
  }) as unknown as DurableProductRouteSessionContextPort;
  const context = Object.freeze({
    postgres, product, session_context: sessionContext,
  }) as unknown as DurableProductRouteContext;
  const base = Object.freeze({
    service: baseService, postgres, product,
    session_context: sessionContext, proof_class: "POSTGRESQL_TRANSACTIONAL_ROUTE_SERVICE",
  }) as unknown as DurableProductRouteServiceAdapter<InternalOpsApplicationPort>;
  const adapter = createDurableGovernanceOperationsRouteAdapter({ context, base, now: () => NOW });
  return { adapter, client, transactionInputs };
}

describe("Wave 5 nested ground truth queue panel", () => {
  it("lists the durable queue through the canonical transaction, identity only", async () => {
    const fixture = harness();
    const projection = await fixture.adapter.service.readGroundTruthQueue({
      actor: actor(), correlation_id: CORRELATION, limit: 25,
    });
    expect(projection.governance_workflow).toBe("ground_truth");
    expect(projection.persistence).toBe("postgresql_required");
    expect(projection.content_included).toBe(false);
    expect(projection.activation_allowed).toBe(false);
    expect(projection.product_reachable_memory_fallback).toBe(false);
    expect(projection.entries).toEqual([ENTRY]);
    expect(fixture.client.statements).toHaveLength(1);
    expect(fixture.client.statements[0]?.name).toBe("governance_work_queue_list");
    expect(fixture.client.statements[0]?.values).toEqual(["tenant.synthetic.001", "ground_truth", 25]);
    expect(fixture.transactionInputs).toEqual([{
      actor: actor(), audience: "operations", case_id: null, correlation_id: CORRELATION,
    }]);
  });

  it("admits every reader role the panel declares, and refuses every other", async () => {
    for (const role of ["extraction_reviewer", "legal_reviewer", "report_approver", "auditor", "break_glass_admin"] as const) {
      const fixture = harness();
      await expect(fixture.adapter.service.readGroundTruthQueue({
        actor: actor(role), correlation_id: CORRELATION, limit: 5,
      })).resolves.toBeDefined();
    }
    for (const role of ["anonymous", "customer_owner", "intake_operator", "fact_reviewer", "parameter_verifier", "scoped_background_worker"] as const) {
      const fixture = harness();
      await expect(fixture.adapter.service.readGroundTruthQueue({
        actor: actor(role), correlation_id: CORRELATION, limit: 5,
      })).rejects.toThrow(/FORBIDDEN/u);
      expect(fixture.client.statements).toHaveLength(0);
    }
  });

  it("fails closed for an unverified actor, a missing tenant and a malformed correlation id", async () => {
    const fixture = harness();
    await expect(fixture.adapter.service.readGroundTruthQueue({
      actor: actor("extraction_reviewer", { verified_server_side: false }), correlation_id: CORRELATION, limit: 5,
    })).rejects.toThrow(/FORBIDDEN/u);
    await expect(fixture.adapter.service.readGroundTruthQueue({
      actor: actor("extraction_reviewer", { tenant_id: null }), correlation_id: CORRELATION, limit: 5,
    })).rejects.toThrow(/FORBIDDEN/u);
    await expect(fixture.adapter.service.readGroundTruthQueue({
      actor: actor("extraction_reviewer"), correlation_id: "!!", limit: 5,
    })).rejects.toThrow(/FORBIDDEN/u);
    expect(fixture.client.statements).toHaveLength(0);
  });

  it("bounds the read before any statement runs", async () => {
    const fixture = harness();
    for (const limit of [0, 501, 2.5, Number.NaN]) {
      await expect(fixture.adapter.service.readGroundTruthQueue({
        actor: actor(), correlation_id: CORRELATION, limit,
      })).rejects.toThrow(/GOVERNANCE_INPUT_INVALID/u);
    }
    expect(fixture.client.statements).toHaveLength(0);
  });

  it("treats a payload in an entry as a decode failure, never as content", async () => {
    const fixture = harness();
    fixture.client.entries = [{ ...ENTRY, payload_json: { synthetic: true } }];
    await expect(fixture.adapter.service.readGroundTruthQueue({
      actor: actor(), correlation_id: CORRELATION, limit: 5,
    })).rejects.toThrow(/GOVERNANCE_DECODE_FAILED/u);
  });
});
