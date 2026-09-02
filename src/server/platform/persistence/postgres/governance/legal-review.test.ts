import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  EXPECTED_LEGAL_REVIEW_POLICY_TABLES,
  EXPECTED_PRIVATE_GOVERNANCE_POLICY_TABLES,
} from "../../../../../../scripts/canonical-persistence-v091/foundation/inventory.mts";
import {
  EXPECTED_MIGRATION_CHAIN,
  EXPECTED_MIGRATION_SHA256,
} from "../../../../../../scripts/canonical-persistence-v091/foundation/migrations.mts";
import { legalCitationSchema } from "../../../../../engine/legal-knowledge/contracts.ts";
import { syntheticChunk, syntheticSource } from "../../../../../engine/legal-knowledge/synthetic-fixtures.ts";
import { LEGAL_REVIEW_SCHEMA_VERSION, type LegalReviewPacket } from "../../../../../engine/legal-review/contracts.ts";
import { createLegalReviewPacket } from "../../../../../engine/legal-review/workflow.ts";
import type {
  PostgresClient,
  PostgresQueryResult,
  PostgresStatement,
  PostgresTransactionContext,
} from "../contracts.ts";
import { createDurableGovernanceApplication } from "./application.ts";
import { PostgresLegalReviewRepository } from "./repositories.ts";

const MIGRATION_NAME = "202609010011_durable_legal_review.sql" as const;
const MIGRATION_PATH = path.resolve(process.cwd(), "supabase", "migrations", MIGRATION_NAME);
const SQL = readFileSync(MIGRATION_PATH, "utf8").replaceAll("\r\n", "\n");

const TENANT = "tenant.synthetic.governance";
const NOW = "2040-01-01T00:00:00.000Z";

class RecordingClient implements PostgresClient {
  readonly statements: PostgresStatement[] = [];

  constructor(private readonly handler: (statement: PostgresStatement) => PostgresQueryResult) {}

  async query(statement: PostgresStatement): Promise<PostgresQueryResult> {
    this.statements.push(statement);
    return this.handler(statement);
  }
}

function context(client: PostgresClient): PostgresTransactionContext {
  return Object.freeze({ client, transaction_id: "tx.synthetic.legal-review" });
}

function one(row: Readonly<Record<string, unknown>>): PostgresQueryResult {
  return Object.freeze({ rows: Object.freeze([row]), row_count: 1 });
}

function citation() {
  const source = syntheticSource();
  const chunk = syntheticChunk(source);
  return legalCitationSchema.parse({
    source_id: source.source_id,
    source_version: source.source_version,
    source_version_id: `${source.source_id}@${source.source_version}`,
    parsed_version_id: chunk.parsed_version_id,
    raw_artifact_sha256: chunk.artifact_sha256,
    normalized_text_sha256: chunk.normalized_text_sha256,
    parser_version: chunk.parser_version,
    chunk_id: chunk.chunk_id,
    title: source.title,
    authority: source.authority,
    canonical_url: source.canonical_url,
    section_or_clause: chunk.section_identifier,
    page: chunk.page_from,
    effective_period: source.effective_period,
    effective_date_evidence_locator: "synthetic clause 1",
    review_status: source.status,
    retrieved_at: "2026-08-29T00:00:00Z",
    locator: {
      format: "pdf", page: chunk.page_from, section: chunk.section_identifier, paragraph: null,
      character_from: chunk.character_from, character_to: chunk.character_to,
    },
    supporting_chunk_ids: [chunk.chunk_id],
    excerpt: null,
  });
}

const binding = Object.freeze({
  schema_version: LEGAL_REVIEW_SCHEMA_VERSION,
  source_id: "IL_SYNTHETIC_LAW",
  source_version_id: "IL_SYNTHETIC_LAW@v1",
  manifest_sha256: "c".repeat(64),
  raw_artifact_sha256: "a".repeat(64),
  normalized_text_sha256: "d".repeat(64),
  parser_version: "synthetic-parser-v1",
  normalizer_version: "synthetic-normalizer-v1",
});

const scope = Object.freeze({
  topic: "minimum_wage",
  sectors: Object.freeze(["general"]),
  applicability: "general",
  population_constraints: Object.freeze([]),
  effective_period: Object.freeze({
    effective_from: "2020-01-01", effective_to: null,
    retroactive: false, retroactive_basis: null, applicability_basis: "salary_month",
  }),
  period_certainty: "known",
});

function packet(): LegalReviewPacket {
  return createLegalReviewPacket({ binding, scope, citations: [citation()], created_at: NOW });
}

function action(current: LegalReviewPacket, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: LEGAL_REVIEW_SCHEMA_VERSION,
    action_id: "LRA:0001",
    packet_id: current.packet_id,
    packet_sha256: current.packet_sha256,
    expected_revision: current.revision,
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

function receipt(overrides: Readonly<Record<string, unknown>> = {}) {
  const current = packet();
  return one({
    tenant_id: TENANT,
    workflow_kind: "legal_review",
    aggregate_id: current.packet_id,
    aggregate_version: current.packet_sha256,
    revision: "1",
    state: "pending_review",
    content_sha256: current.packet_sha256,
    audit_event_sha256: "b".repeat(64),
    idempotent_replay: false,
    activation_allowed: false,
    ...overrides,
  });
}

const meta = Object.freeze({ idempotency_key: "idem.legal-review.001", occurred_at: NOW });

// Static reconciliation. This proves the migration text against the same
// canonical rules as the rest of the schema; it is not live PostgreSQL proof.
describe("V0.10.3B legal review migration static reconciliation", () => {
  it("is pinned, additive and last in the canonical chain", () => {
    expect(createHash("sha256").update(SQL, "utf8").digest("hex")).toBe(EXPECTED_MIGRATION_SHA256[MIGRATION_NAME]);
    const index = EXPECTED_MIGRATION_CHAIN.indexOf(MIGRATION_NAME);
    expect(index).toBeGreaterThan(0);
    expect(EXPECTED_MIGRATION_CHAIN[index - 1]).toBe("202609010010_runtime_canonical_helper_acl_repair.sql");
    expect(SQL).toContain("'durable_legal_review'");
    expect(SQL).toContain("'202609010011_durable_legal_review'");
  });

  it("creates exactly the inventoried tables and derives the private governance union", () => {
    const tables = [...SQL.matchAll(/^create table (private\.governance_[a-z0-9_]+) \(/gmu)]
      .map((match) => match[1]).sort();
    expect(tables).toEqual([...EXPECTED_LEGAL_REVIEW_POLICY_TABLES].sort());
    for (const table of EXPECTED_LEGAL_REVIEW_POLICY_TABLES) {
      expect(EXPECTED_PRIVATE_GOVERNANCE_POLICY_TABLES).toContain(table);
    }
    expect(new Set(EXPECTED_PRIVATE_GOVERNANCE_POLICY_TABLES).size)
      .toBe(EXPECTED_PRIVATE_GOVERNANCE_POLICY_TABLES.length);
  });

  it("forces RLS and one owner-verified policy per new table", () => {
    const count = (expression: RegExp) => [...SQL.matchAll(expression)].length;
    expect(count(/^alter table private\.governance_legal_review_[a-z0-9_]+ enable row level security;/gmu)).toBe(2);
    expect(count(/^alter table private\.governance_legal_review_[a-z0-9_]+ force row level security;/gmu)).toBe(2);
    expect(count(/^create policy governance_legal_review_[a-z0-9_]+_verified_tenant on private\./gmu)).toBe(2);
    expect(SQL).toContain("using (tenant_id = private.runtime_verified_tenant())");
    // The superseded service_role policy shape must not be reintroduced.
    expect(SQL).not.toMatch(/to service_role/u);
    expect(SQL).not.toContain("current_setting(");
  });

  it("keeps direct table privileges revoked and grants only the governance owner", () => {
    expect(SQL).toContain("from public, anon, authenticated, service_role;");
    expect(SQL).not.toMatch(/grant\s+(?:select|insert|update|delete|all)\s+on\s+table/iu);
    expect(SQL).not.toMatch(/grant execute .* to (?:public|anon|authenticated|service_role)\b/iu);
    expect([...SQL.matchAll(/^grant execute on function private\.governance_legal_review_[a-z0-9_]+\(/gmu)])
      .toHaveLength(3);
    expect([...SQL.matchAll(/^revoke all on function private\.governance_legal_review_[a-z0-9_]+\(/gmu)])
      .toHaveLength(3);
    expect([...SQL.matchAll(/owner to tivdoc_governance_owner;/gmu)].length).toBeGreaterThanOrEqual(5);
  });

  it("indexes the queue, keeps actions append-only and stays non-operative", () => {
    expect([...SQL.matchAll(/^create index governance_legal_review_[a-z0-9_]+/gmu)]).toHaveLength(4);
    expect(SQL).toContain("create trigger governance_legal_review_actions_immutable");
    expect(SQL).toContain("check (activation_allowed = false)");
    expect(SQL).not.toMatch(/activation_allowed\s*(?:=|,)\s*true\b/iu);
    expect(SQL).toContain("security definer set search_path = ''");
  });

  it("parameterizes every function and never interpolates untrusted text", () => {
    expect([...SQL.matchAll(/^create function private\.governance_legal_review_[a-z0-9_]+\(/gmu)]).toHaveLength(3);
    expect([...SQL.matchAll(/is distinct from private\.runtime_verified_tenant\(\)/gmu)]).toHaveLength(3);
    expect(SQL).not.toMatch(/\bexecute\s+format\s*\(/iu);
    expect(SQL).not.toMatch(/\|\|\s*target_/u);
  });

  it("enforces compare-and-swap, terminal states and role limits in the schema itself", () => {
    expect(SQL).toContain("GOVERNANCE_LEGAL_REVIEW_STALE_REVISION");
    expect(SQL).toContain("GOVERNANCE_LEGAL_REVIEW_IDENTITY_CHANGED");
    expect(SQL).toContain("GOVERNANCE_LEGAL_REVIEW_TERMINAL_STATE");
    expect(SQL).toContain("check (resulting_revision = expected_revision + 1)");
    expect(SQL).toContain("check (actor_role is distinct from 'legal_reviewer_observer')");
    expect(SQL).toContain("check (decision is distinct from 'approve' or actor_role = 'senior_legal_reviewer')");
  });
});

describe("V0.10.3B durable legal review adapter", () => {
  it("enqueues a packet through the canonical parameterized statement", async () => {
    const client = new RecordingClient(() => receipt());
    const repository = new PostgresLegalReviewRepository(context(client), TENANT);
    const current = packet();
    const result = await repository.enqueuePacket({
      packet: current, queue_priority: 10, blocked_reason_codes: [], metadata: meta,
    });
    expect(result.workflow_kind).toBe("legal_review");
    expect(result.activation_allowed).toBe(false);
    const [statement] = client.statements;
    expect(statement?.name).toBe("governance_legal_review_packet_enqueue");
    expect(statement?.text).toContain("private.governance_legal_review_packet_enqueue");
    expect(statement?.text).not.toContain(current.packet_id);
    expect(statement?.values[0]).toBe(TENANT);
    expect(statement?.values[2]).toBe(10);
  });

  it("refuses a packet whose identity does not match its own binding and scope", async () => {
    const client = new RecordingClient(() => { throw new Error("database_must_not_be_called"); });
    const repository = new PostgresLegalReviewRepository(context(client), TENANT);
    const current = packet();
    await expect(repository.enqueuePacket({
      packet: { ...current, packet_sha256: "f".repeat(64) }, queue_priority: 10,
      blocked_reason_codes: [], metadata: meta,
    })).rejects.toMatchObject({ code: "GOVERNANCE_HASH_MISMATCH" });
    expect(client.statements).toHaveLength(0);
  });

  it("rejects an out-of-range queue priority and a non-initial packet before any query", async () => {
    const client = new RecordingClient(() => { throw new Error("database_must_not_be_called"); });
    const repository = new PostgresLegalReviewRepository(context(client), TENANT);
    const current = packet();
    await expect(repository.enqueuePacket({
      packet: current, queue_priority: 1_000, blocked_reason_codes: [], metadata: meta,
    })).rejects.toMatchObject({ code: "GOVERNANCE_INPUT_INVALID" });
    await expect(repository.enqueuePacket({
      packet: { ...current, state: "approved" }, queue_priority: 1, blocked_reason_codes: [], metadata: meta,
    })).rejects.toMatchObject({ code: "GOVERNANCE_INPUT_INVALID" });
    expect(client.statements).toHaveLength(0);
  });

  it("appends an admissible action and carries the domain's next state to SQL", async () => {
    const client = new RecordingClient(() => receipt({ revision: "2", state: "in_review" }));
    const repository = new PostgresLegalReviewRepository(context(client), TENANT);
    const current = packet();
    await repository.appendAction({ packet: current, action: action(current), metadata: meta });
    const [statement] = client.statements;
    expect(statement?.name).toBe("governance_legal_review_action_append");
    expect(statement?.values[2]).toBe("in_review");
    expect(statement?.values[3]).toBeNull();
  });

  it("refuses a stale revision, a terminal packet and an ineligible role without touching SQL", async () => {
    const client = new RecordingClient(() => { throw new Error("database_must_not_be_called"); });
    const repository = new PostgresLegalReviewRepository(context(client), TENANT);
    const current = packet();
    await expect(repository.appendAction({
      packet: current, action: action(current, { expected_revision: 99 }), metadata: meta,
    })).rejects.toMatchObject({ code: "LEGAL_REVIEW_STALE_REVISION" });
    await expect(repository.appendAction({
      packet: { ...current, state: "rejected" }, action: action(current), metadata: meta,
    })).rejects.toMatchObject({ code: "LEGAL_REVIEW_TERMINAL_STATE" });
    await expect(repository.appendAction({
      packet: current, action: action(current, { actor_role: "legal_reviewer_observer" }), metadata: meta,
    })).rejects.toMatchObject({ code: "LEGAL_REVIEW_ROLE_NOT_PERMITTED" });
    expect(client.statements).toHaveLength(0);
  });

  it("blocks an action missing actor identity or signature", async () => {
    const client = new RecordingClient(() => { throw new Error("database_must_not_be_called"); });
    const repository = new PostgresLegalReviewRepository(context(client), TENANT);
    const current = packet();
    await expect(repository.appendAction({
      packet: current,
      action: action(current, { attestation: { actor_id: null, signature_sha256: "e".repeat(64) } }),
      metadata: meta,
    })).rejects.toMatchObject({ code: "LEGAL_REVIEW_HUMAN_ATTESTATION_BLOCKED" });
    expect(client.statements).toHaveLength(0);
  });

  it("treats an identical replay as a conflict rather than a second mutation", async () => {
    const client = new RecordingClient(() => { throw new Error("database_must_not_be_called"); });
    const repository = new PostgresLegalReviewRepository(context(client), TENANT);
    const current = packet();
    const applied = action(current);
    await expect(repository.appendAction({
      packet: current, action: applied, applied_actions: [applied], metadata: meta,
    })).rejects.toMatchObject({ code: "GOVERNANCE_IDEMPOTENT_REPLAY_CONFLICT" });
    expect(client.statements).toHaveLength(0);
  });

  it("requires a supersession target before a packet may be superseded", async () => {
    const client = new RecordingClient(() => { throw new Error("database_must_not_be_called"); });
    const repository = new PostgresLegalReviewRepository(context(client), TENANT);
    const current = packet();
    const inReview = { ...current, state: "in_review" as const, revision: 2 };
    await expect(repository.appendAction({
      packet: inReview,
      action: action(inReview, {
        decision: "supersede", actor_role: "senior_legal_reviewer",
        expected_revision: 2, reason_code: "SUPERSEDED",
      }),
      metadata: meta,
    })).rejects.toMatchObject({ code: "GOVERNANCE_INPUT_INVALID" });
  });

  it("decodes queue rows strictly and rejects a widened or malformed row", async () => {
    const row = {
      ordinal: "0010|2040-01-01T00:00:00.000Z|LRP:a", packet_id: "LRP:a", packet_sha256: "a".repeat(64),
      revision: 1, state: "pending_review", topic: "minimum_wage",
      source_version_id: "IL_SYNTHETIC_LAW@v1", parser_version: "p1", normalizer_version: "n1",
      queue_priority: 10, blocked_reason_codes: [], superseded_by_packet_id: null,
      activation_allowed: false, enqueued_at: NOW, updated_at: NOW,
    };
    const good = new RecordingClient(() => one({ entries: [row] }));
    const rows = await new PostgresLegalReviewRepository(context(good), TENANT).listQueue(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.activation_allowed).toBe(false);

    const widened = new RecordingClient(() => one({ entries: [{ ...row, unexpected: true }] }));
    await expect(new PostgresLegalReviewRepository(context(widened), TENANT).listQueue(10))
      .rejects.toMatchObject({ code: "GOVERNANCE_DECODE_FAILED" });

    const active = new RecordingClient(() => one({ entries: [{ ...row, activation_allowed: true }] }));
    await expect(new PostgresLegalReviewRepository(context(active), TENANT).listQueue(10))
      .rejects.toMatchObject({ code: "GOVERNANCE_DECODE_FAILED" });
  });

  it("bounds the queue listing", async () => {
    const client = new RecordingClient(() => one({ entries: [] }));
    const repository = new PostgresLegalReviewRepository(context(client), TENANT);
    for (const limit of [0, 501]) {
      await expect(repository.listQueue(limit)).rejects.toMatchObject({ code: "GOVERNANCE_INPUT_INVALID" });
    }
    expect(client.statements).toHaveLength(0);
  });
});

describe("V0.10.3B canonical composition binding", () => {
  it("exposes the durable repository with no memory substitute", () => {
    const client = new RecordingClient(() => one({}));
    const application = createDurableGovernanceApplication(context(client), TENANT);
    expect(application.legal_review).toBeInstanceOf(PostgresLegalReviewRepository);
    expect(application.persistence).toBe("postgresql_required");
    expect(application.product_reachable_memory_fallback).toBe(false);
    expect(application.activation_allowed).toBe(false);
  });
});
