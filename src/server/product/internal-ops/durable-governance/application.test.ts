import { readFile } from "node:fs/promises";
import path from "node:path";

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
import {
  DURABLE_GOVERNANCE_WORK_LANES,
  DURABLE_OPERATIONS_TABS,
  type DurableGovernanceCommand,
} from "./contracts.ts";

const NOW = "2026-01-02T03:04:05.000Z";
const CASE_ID = "case.synthetic.001";

class RecordingClient implements PostgresClient {
  readonly statements: PostgresStatement[] = [];

  async query(statement: PostgresStatement): Promise<PostgresQueryResult> {
    this.statements.push(statement);
    if (statement.name === "governance_work_claim") {
      return Object.freeze({ rows: Object.freeze([]), row_count: 0 });
    }
    throw new Error(`unexpected_statement:${statement.name}`);
  }
}

function actor(role: VerifiedActor["role"] = "legal_reviewer"): VerifiedActor {
  return Object.freeze({
    actor_id: `actor.${role}.001`,
    role,
    tenant_id: "tenant.synthetic.001",
    assigned_case_ids: Object.freeze([CASE_ID]),
    verified_server_side: true,
    break_glass_reason: role === "break_glass_admin" ? "synthetic verification only" : null,
    break_glass_expires_at: role === "break_glass_admin" ? "2027-01-02T03:04:05.000Z" : null,
  });
}

function harness(options: Readonly<{ transaction_error?: Error }> = {}) {
  const client = new RecordingClient();
  const postgres = Object.freeze({ marker: "postgres" });
  const product = Object.freeze({ marker: "product" });
  const reads: InternalOpsReadKind[] = [];
  const mutations: unknown[] = [];
  const transactionInputs: unknown[] = [];
  const baseService: InternalOpsApplicationPort = Object.freeze({
    read: async (_actor: VerifiedActor, kind: InternalOpsReadKind) => {
      reads.push(kind);
      return Object.freeze({ schema_version: "synthetic-core", kind }) as never;
    },
    mutate: async (_actor: VerifiedActor, request: unknown) => {
      mutations.push(request);
      return Object.freeze({ synthetic: true }) as never;
    },
  });
  const sessionContext = Object.freeze({
    proof_class: "LEAST_PRIVILEGE_VERIFIED_SESSION_CONTEXT",
    uses_service_role: false,
    bypasses_rls: false,
    postgres,
    transaction: async (input: unknown, operation: (bundle: unknown) => Promise<unknown>) => {
      transactionInputs.push(input);
      if (options.transaction_error) throw options.transaction_error;
      return operation(Object.freeze({
        context: Object.freeze({ client, transaction_id: `transaction.${transactionInputs.length}` }),
        intake: Object.freeze({}),
        analysis: Object.freeze({}),
        runtime: Object.freeze({}),
      }));
    },
  }) as unknown as DurableProductRouteSessionContextPort;
  const context = Object.freeze({
    postgres,
    product,
    session_context: sessionContext,
  }) as unknown as DurableProductRouteContext;
  const base = Object.freeze({
    service: baseService,
    postgres,
    product,
    session_context: sessionContext,
    proof_class: "POSTGRESQL_TRANSACTIONAL_ROUTE_SERVICE",
  }) as unknown as DurableProductRouteServiceAdapter<InternalOpsApplicationPort>;
  const adapter = createDurableGovernanceOperationsRouteAdapter({ context, base, now: () => NOW });
  return { adapter, base, client, context, mutations, reads, transactionInputs };
}

describe("durable governance operations adapter", () => {
  it("is a drop-in stable async operations port while preserving the durable base service", async () => {
    const fixture = harness();
    const reviewer = actor("legal_reviewer");
    await fixture.adapter.service.read(reviewer, "case", CASE_ID);
    await fixture.adapter.service.mutate(reviewer, Object.freeze({ synthetic: true }), "correlation.delegate.001");
    expect(fixture.reads).toEqual(["case"]);
    expect(fixture.mutations).toEqual([{ synthetic: true }]);
    expect(fixture.transactionInputs).toHaveLength(0);
  });

  it("wraps the same verified PostgreSQL route root and advertises all eleven durable tabs", async () => {
    const fixture = harness();
    expect(fixture.adapter.service.proof()).toEqual({
      schema_version: "tivdoc-durable-governance-operations-v0.10.2",
      persistence: "postgresql_required",
      stable_operations_async: true,
      canonical_transaction_contexts: 1,
      product_reachable_memory_fallbacks: 0,
      durable_governance_replacements_wired: 4,
      operations_tabs: DURABLE_OPERATIONS_TABS,
      activation_allowed: false,
    });
    expect(fixture.adapter).toMatchObject({
      postgres: fixture.context.postgres,
      product: fixture.context.product,
      session_context: fixture.context.session_context,
      proof_class: "POSTGRESQL_TRANSACTIONAL_ROUTE_SERVICE",
    });

    const projections = [];
    for (const tab of DURABLE_OPERATIONS_TABS) {
      projections.push(await fixture.adapter.service.readTab({
        actor: actor("break_glass_admin"),
        case_id: CASE_ID,
        correlation_id: `correlation.${tab.toLowerCase()}`,
        tab,
      }));
    }

    expect(projections.map((projection) => projection.tab)).toEqual(DURABLE_OPERATIONS_TABS);
    expect(fixture.reads).toEqual([
      "case", "payment", "documents", "extraction", "facts", "analysis", "report", "audit",
    ]);
    expect(fixture.transactionInputs).toHaveLength(4);
    expect(projections.every((projection) => (
      projection.persistence === "postgresql_required"
      && projection.product_reachable_memory_fallback === false
      && projection.activation_allowed === false
    ))).toBe(true);
    expect(projections.find((projection) => projection.tab === "Overview")).toMatchObject({
      source: "canonical_case_postgres",
      governance_workflow: null,
    });
    expect(projections.find((projection) => projection.tab === "Legal")).toMatchObject({
      source: "durable_governance_postgres",
      governance_workflow: "legal_reconciliation",
    });

    const trust = await fixture.adapter.service.readReviewerTrust({
      actor: actor("break_glass_admin"),
      case_id: CASE_ID,
      correlation_id: "correlation.trust",
      aggregate_references: Object.freeze([]),
    });
    expect(trust).toMatchObject({
      persistence: "postgresql_required",
      governance_workflow: "reviewer_trust",
      product_reachable_memory_fallback: false,
      activation_allowed: false,
    });
    expect(fixture.transactionInputs).toHaveLength(5);
  });

  it("derives the observation-queue workflow, human role, tenant and claimant from the verified actor", async () => {
    const fixture = harness();
    const reviewer = actor("legal_reviewer");
    const result = await fixture.adapter.service.claimPendingWork({
      actor: reviewer,
      case_id: CASE_ID,
      correlation_id: "correlation.claim.001",
      lane: "legal_observation_reconciliation",
      now: NOW,
      lease_seconds: 300,
    });

    expect(result).toEqual({
      schema_version: "tivdoc-durable-governance-operations-v0.10.2",
      lane: "legal_observation_reconciliation",
      claim: null,
      product_reachable_memory_fallback: false,
      activation_allowed: false,
    });
    expect(fixture.client.statements).toHaveLength(1);
    expect(fixture.client.statements[0]).toMatchObject({
      name: "governance_work_claim",
      values: [
        reviewer.tenant_id,
        "legal_reconciliation",
        "legal_observation_reconciliation",
        reviewer.actor_id,
        "human_source_reviewer",
        NOW,
        300,
      ],
    });
  });

  it("keeps GT, observation, parameter and RuleSpec queues separate and rejects cross-role claims before SQL", async () => {
    expect(Object.keys(DURABLE_GOVERNANCE_WORK_LANES)).toEqual([
      "ground_truth_visual_eligibility",
      "ground_truth_annotation",
      "ground_truth_adjudication",
      "ground_truth_lock",
      "legal_observation_reconciliation",
      "parameter_attestation",
      "rulespec_semantics",
      "golden_case_outputs",
    ]);
    expect(DURABLE_GOVERNANCE_WORK_LANES.parameter_attestation).toMatchObject({
      workflow_kind: "parameter_approval",
      actor_role: "parameter_verifier",
      reviewer_role: "human_parameter_reviewer",
    });

    const fixture = harness();
    await expect(fixture.adapter.service.claimPendingWork({
      actor: actor("parameter_verifier"),
      case_id: CASE_ID,
      correlation_id: "correlation.cross.role",
      lane: "legal_observation_reconciliation",
      now: NOW,
      lease_seconds: 300,
    })).rejects.toThrowError("DURABLE_GOVERNANCE_OPERATIONS_FORBIDDEN");
    expect(fixture.transactionInputs).toHaveLength(0);
    expect(fixture.client.statements).toHaveLength(0);
  });

  it("rejects claimant substitution and never enters the database transaction", async () => {
    const fixture = harness();
    const command = Object.freeze({
      action: "work.release",
      lane: "legal_observation_reconciliation",
      input: Object.freeze({
        work_item_id: "work.synthetic.001",
        claimant_id: "actor.other.001",
        fencing_token: 1,
        next_state: "released",
        reason_code: "SYNTHETIC_RELEASE",
        occurred_at: NOW,
        idempotency_key: "idempotency.release.001",
      }),
    }) satisfies DurableGovernanceCommand;
    await expect(fixture.adapter.service.executeGovernance({
      actor: actor("legal_reviewer"),
      case_id: CASE_ID,
      correlation_id: "correlation.release.001",
    }, command)).rejects.toThrowError("DURABLE_GOVERNANCE_REVIEWER_BINDING_MISMATCH");
    expect(fixture.transactionInputs).toHaveLength(0);
  });

  it("fails closed when the verified PostgreSQL transaction is unavailable", async () => {
    const fixture = harness({ transaction_error: new Error("postgres_unavailable") });
    await expect(fixture.adapter.service.readTab({
      actor: actor("legal_reviewer"),
      case_id: CASE_ID,
      correlation_id: "correlation.pg.down",
      tab: "Legal",
    })).rejects.toThrowError("postgres_unavailable");
    expect(fixture.transactionInputs).toHaveLength(1);
    expect(fixture.client.statements).toHaveLength(0);
  });

  it("rejects a different base transaction root and has no process-local repository imports", async () => {
    const fixture = harness();
    const otherRoot = Object.freeze({ ...fixture.base, postgres: Object.freeze({ marker: "other" }) });
    expect(() => createDurableGovernanceOperationsRouteAdapter({
      context: fixture.context,
      base: otherRoot as never,
    })).toThrowError("DURABLE_GOVERNANCE_OPERATIONS_TRANSACTION_ROOT_MISMATCH");

    const directory = path.resolve("src/server/product/internal-ops/durable-governance");
    const source = `${await readFile(path.join(directory, "application.ts"), "utf8")}\n${
      await readFile(path.join(directory, "contracts.ts"), "utf8")
    }`;
    expect(source).not.toMatch(/InMemoryReviewerTrustStore|AppendOnlyLegalOperationsStore|LegalOperationsApplicationService|TrustedGroundTruthWorkflow/u);
    expect(source).not.toMatch(/new\s+Postgres(?:ReviewerTrust|GovernanceWork|GroundTruth|LegalReconciliation|ParameterApproval|RuleSpecApproval)Repository/u);
    expect(source).toContain("createDurableGovernanceApplication(bundle.context, tenantId)");
  });
});
