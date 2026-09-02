import { describe, expect, it } from "vitest";

import type { VerifiedActor } from "../../../../engine/wave4/contracts.ts";
import { legalCitationSchema } from "../../../../engine/legal-knowledge/contracts.ts";
import { syntheticChunk, syntheticSource } from "../../../../engine/legal-knowledge/synthetic-fixtures.ts";
import { LEGAL_REVIEW_SCHEMA_VERSION } from "../../../../engine/legal-review/contracts.ts";
import { createLegalReviewPacket } from "../../../../engine/legal-review/workflow.ts";
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

const NOW = "2026-01-02T03:04:05.000Z";
const CORRELATION = "correlation.legal-review.001";

function citation() {
  const source = syntheticSource();
  const chunk = syntheticChunk(source);
  return legalCitationSchema.parse({
    source_id: source.source_id, source_version: source.source_version,
    source_version_id: `${source.source_id}@${source.source_version}`,
    parsed_version_id: chunk.parsed_version_id, raw_artifact_sha256: chunk.artifact_sha256,
    normalized_text_sha256: chunk.normalized_text_sha256, parser_version: chunk.parser_version,
    chunk_id: chunk.chunk_id, title: source.title, authority: source.authority,
    canonical_url: source.canonical_url, section_or_clause: chunk.section_identifier,
    page: chunk.page_from, effective_period: source.effective_period,
    effective_date_evidence_locator: "synthetic clause 1", review_status: source.status,
    retrieved_at: "2026-08-29T00:00:00Z",
    locator: {
      format: "pdf", page: chunk.page_from, section: chunk.section_identifier, paragraph: null,
      character_from: chunk.character_from, character_to: chunk.character_to,
    },
    supporting_chunk_ids: [chunk.chunk_id], excerpt: null,
  });
}

const packet = createLegalReviewPacket({
  binding: {
    schema_version: LEGAL_REVIEW_SCHEMA_VERSION,
    source_id: "IL_SYNTHETIC_LAW", source_version_id: "IL_SYNTHETIC_LAW@v1",
    manifest_sha256: "c".repeat(64), raw_artifact_sha256: "a".repeat(64),
    normalized_text_sha256: "d".repeat(64),
    parser_version: "synthetic-parser-v1", normalizer_version: "synthetic-normalizer-v1",
  },
  scope: {
    topic: "minimum_wage", sectors: ["general"], applicability: "general",
    population_constraints: [],
    effective_period: {
      effective_from: "2020-01-01", effective_to: null,
      retroactive: false, retroactive_basis: null, applicability_basis: "salary_month",
    },
    period_certainty: "known",
  },
  citations: [citation()],
  created_at: NOW,
});

function action(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: LEGAL_REVIEW_SCHEMA_VERSION,
    action_id: "LRA:ops:0001",
    packet_id: packet.packet_id,
    packet_sha256: packet.packet_sha256,
    expected_revision: packet.revision,
    decision: "claim",
    actor_role: "legal_reviewer",
    attestation: { actor_id: "reviewer:1", signature_sha256: "e".repeat(64) },
    reason_code: "REVIEW_STARTED",
    reason: "Beginning review.",
    cited_chunk_ids: [],
    occurred_at: NOW,
    ...overrides,
  } as never;
}

const QUEUE_ROW = Object.freeze({
  ordinal: "0010|2026-01-02T03:04:05.000Z|LRP:a",
  packet_id: packet.packet_id, packet_sha256: packet.packet_sha256,
  revision: 1, state: "pending_review", topic: "minimum_wage",
  source_version_id: "IL_SYNTHETIC_LAW@v1", parser_version: "synthetic-parser-v1",
  normalizer_version: "synthetic-normalizer-v1", queue_priority: 10,
  blocked_reason_codes: [], superseded_by_packet_id: null, activation_allowed: false,
  enqueued_at: NOW, updated_at: NOW,
});

function actor(role: VerifiedActor["role"] = "legal_reviewer", overrides: Record<string, unknown> = {}): VerifiedActor {
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

  async query(statement: PostgresStatement): Promise<PostgresQueryResult> {
    this.statements.push(statement);
    if (statement.name === "governance_legal_review_queue_list") {
      return Object.freeze({ rows: Object.freeze([{ entries: [QUEUE_ROW] }]), row_count: 1 });
    }
    if (statement.name === "governance_legal_review_action_append") {
      return Object.freeze({
        rows: Object.freeze([{
          tenant_id: "tenant.synthetic.001", workflow_kind: "legal_review",
          aggregate_id: packet.packet_id, aggregate_version: packet.packet_sha256,
          revision: "2", state: "in_review", content_sha256: "a".repeat(64),
          audit_event_sha256: "b".repeat(64), idempotent_replay: false, activation_allowed: false,
        }]),
        row_count: 1,
      });
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

describe("V0.10.4 nested legal review operations workspace", () => {
  it("lists the durable queue through the canonical transaction", async () => {
    const fixture = harness();
    const projection = await fixture.adapter.service.readLegalReviewQueue({
      actor: actor("legal_reviewer"), correlation_id: CORRELATION, limit: 25,
    });
    expect(projection.persistence).toBe("postgresql_required");
    expect(projection.governance_workflow).toBe("legal_review");
    expect(projection.product_reachable_memory_fallback).toBe(false);
    expect(projection.activation_allowed).toBe(false);
    expect(projection.entries).toHaveLength(1);
    expect(projection.entries[0]?.activation_allowed).toBe(false);
    expect(fixture.client.statements[0]?.name).toBe("governance_legal_review_queue_list");
    expect(fixture.transactionInputs).toHaveLength(1);
  });

  it("submits a reviewer action through the durable adapter only", async () => {
    const fixture = harness();
    const result = await fixture.adapter.service.submitLegalReviewAction({
      actor: actor("legal_reviewer"), correlation_id: CORRELATION,
      packet, action: action(), idempotency_key: "idem.ops.001", occurred_at: NOW,
    });
    expect(result.receipt.workflow_kind).toBe("legal_review");
    expect(result.receipt.activation_allowed).toBe(false);
    expect(fixture.client.statements[0]?.name).toBe("governance_legal_review_action_append");
  });

  it("permits an auditor to read but never to act", async () => {
    const fixture = harness();
    await expect(fixture.adapter.service.readLegalReviewQueue({
      actor: actor("auditor"), correlation_id: CORRELATION, limit: 5,
    })).resolves.toBeDefined();
    await expect(fixture.adapter.service.submitLegalReviewAction({
      actor: actor("auditor"), correlation_id: CORRELATION,
      packet, action: action(), idempotency_key: "idem.ops.002", occurred_at: NOW,
    })).rejects.toThrow(/FORBIDDEN/u);
  });

  it("fails closed for a role outside the legal review workspace", async () => {
    const fixture = harness();
    for (const role of ["intake_operator", "extraction_reviewer", "scoped_background_worker"] as const) {
      await expect(fixture.adapter.service.readLegalReviewQueue({
        actor: actor(role), correlation_id: CORRELATION, limit: 5,
      })).rejects.toThrow(/FORBIDDEN/u);
    }
    expect(fixture.client.statements).toHaveLength(0);
  });

  it("fails closed for an unverified actor, a missing tenant and a malformed correlation id", async () => {
    const fixture = harness();
    await expect(fixture.adapter.service.readLegalReviewQueue({
      actor: actor("legal_reviewer", { verified_server_side: false }), correlation_id: CORRELATION, limit: 5,
    })).rejects.toThrow(/FORBIDDEN/u);
    await expect(fixture.adapter.service.readLegalReviewQueue({
      actor: actor("legal_reviewer", { tenant_id: null }), correlation_id: CORRELATION, limit: 5,
    })).rejects.toThrow(/FORBIDDEN/u);
    await expect(fixture.adapter.service.readLegalReviewQueue({
      actor: actor("legal_reviewer"), correlation_id: "!!", limit: 5,
    })).rejects.toThrow(/FORBIDDEN/u);
    expect(fixture.client.statements).toHaveLength(0);
  });

  it("rejects a stale revision and a divergent replay before reaching the database", async () => {
    const fixture = harness();
    await expect(fixture.adapter.service.submitLegalReviewAction({
      actor: actor("legal_reviewer"), correlation_id: CORRELATION,
      packet, action: action({ expected_revision: 99 }),
      idempotency_key: "idem.ops.003", occurred_at: NOW,
    })).rejects.toMatchObject({ code: "LEGAL_REVIEW_STALE_REVISION" });

    const applied = action();
    await expect(fixture.adapter.service.submitLegalReviewAction({
      actor: actor("legal_reviewer"), correlation_id: CORRELATION,
      packet, action: { ...(applied as object), reason: "different" } as never,
      applied_actions: [applied], idempotency_key: "idem.ops.004", occurred_at: NOW,
    })).rejects.toMatchObject({ code: "LEGAL_REVIEW_ACTION_CONFLICT" });
    expect(fixture.client.statements).toHaveLength(0);
  });

  it("rejects a malformed action and an unattested action", async () => {
    const fixture = harness();
    await expect(fixture.adapter.service.submitLegalReviewAction({
      actor: actor("legal_reviewer"), correlation_id: CORRELATION,
      packet, action: { not: "an action" } as never,
      idempotency_key: "idem.ops.005", occurred_at: NOW,
    })).rejects.toMatchObject({ code: "LEGAL_REVIEW_ACTION_INVALID" });
    await expect(fixture.adapter.service.submitLegalReviewAction({
      actor: actor("legal_reviewer"), correlation_id: CORRELATION,
      packet, action: action({ attestation: { actor_id: null, signature_sha256: null } }),
      idempotency_key: "idem.ops.006", occurred_at: NOW,
    })).rejects.toMatchObject({ code: "LEGAL_REVIEW_HUMAN_ATTESTATION_BLOCKED" });
    expect(fixture.client.statements).toHaveLength(0);
  });

  it("keeps the established operations tab contract untouched", () => {
    const fixture = harness();
    expect(fixture.adapter.service.proof().operations_tabs).toHaveLength(11);
  });
});
