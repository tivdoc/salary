import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CANONICAL_POSTGRES_SCHEMA_VERSION,
  type CanonicalVerifiedTransactionInput,
  type TransactionScopedPostgresBundle,
} from "../../platform/composition/canonical-postgres.ts";
import {
  createPostgresAnalysisRepositories,
  type PostgresAnalysisRepositories,
} from "../../platform/persistence/postgres/analysis/index.ts";
import type {
  PostgresClient,
  PostgresQueryResult,
  PostgresStatement,
  PostgresTransactionContext,
} from "../../platform/persistence/postgres/contracts.ts";
import {
  intake_factory,
  type PostgresIntakeAdapterBundle,
} from "../../platform/persistence/postgres/intake/index.ts";
import { PostgresIdempotencyRepository } from "../../platform/persistence/postgres/runtime/idempotency.ts";
import { PostgresJobsOutboxAuditRepository } from "../../platform/persistence/postgres/runtime/jobs-outbox-audit.ts";
import { LocalRuntimePrivateBlobProvider } from "../../platform/storage/local-runtime/private-blob-provider.ts";
import { bindDurableProductActor, type VerifiedProductIdentity } from "../auth/identity-session.ts";
import { DurableProductPostgresApplication } from "../durable-postgres/application.ts";
import type { DurableProductPostgresRoot, DurableProductRouteContext } from "../routes/durable-registration.ts";
import { createLeastPrivilegeProductSessionContext } from "../routes/least-privilege-session-context.ts";
import {
  DurableCustomerPortalPostgresApplication,
  createDurableCustomerPortalAdapter,
} from "./durable-postgres-application.ts";

const HASH = "a".repeat(64);
const TENANT_ID = "tenant:portal:001";
const CASE_ID = "case:portal:001";
const OWNER_ID = "owner:portal:001";
const NOW = "2033-05-18T03:33:20.000Z";

describe("durable PostgreSQL customer portal application", () => {
  it("projects the exact case id into every clarification and uses only the verified web transaction", async () => {
    const root = new FocusedPortalPostgresRoot((query) => {
      if (query.name === "product_owner_lookup") return rows(ownerRow());
      if (query.name === "portal_case_state_read") {
        return rows({ revision: "4", lifecycle_state: "awaiting_fact_resolution" });
      }
      if (query.name === "portal_case_history_read") {
        return rows({ revision: "4", lifecycle_state: "awaiting_fact_resolution", occurred_at: NOW });
      }
      if (query.name === "portal_documents_read" || query.name === "portal_reports_read") return rows();
      if (query.name === "portal_clarifications_read") {
        return rows({
          task_id: "confirmation:portal:001",
          case_id: CASE_ID,
          analysis_run_id: "analysis:portal:001",
          target_fact_path: "documents.period",
          question_id: "question:portal:001",
          question_version: "2",
          conversation_id: "conversation:portal:001",
          prompt: "נא לאשר את תקופת המסמכים.",
          answered: false,
        });
      }
      throw new Error(`FOCUSED_QUERY_UNEXPECTED:${query.name}`);
    });
    const application = portalApplication(root);
    const projection = await application.getCaseProjection(ownerActor(), CASE_ID);

    expect(projection.case_id).toBe(CASE_ID);
    expect(projection.clarification_tasks).toHaveLength(1);
    expect(projection.clarification_tasks[0]).toMatchObject({
      case_id: CASE_ID,
      task_id: "confirmation:portal:001",
      status: "open",
      requires_human_review: true,
    });
    expect(projection.clarification_tasks[0]?.task_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(root.unverified_transaction_count).toBe(0);
    expect(root.verified_inputs).toHaveLength(1);
    expect(root.verified_inputs[0]).toMatchObject({
      runtime_role: "web",
      case_id: CASE_ID,
      identity: {
        tenant_id: TENANT_ID,
        actor_id: OWNER_ID,
        session_id: "session:portal:001",
        token_id: "token:portal:001",
        reviewer_organization_id: null,
        rotation_counter: 3,
      },
    });
  });

  it("fails closed before case data reads for a missing session binding or inactive owner", async () => {
    const missingBindingRoot = new FocusedPortalPostgresRoot((query) => {
      throw new Error(`FOCUSED_QUERY_UNEXPECTED:${query.name}`);
    });
    const application = portalApplication(missingBindingRoot);
    const plainActor = productIdentity().actor;
    await expect(application.getCaseProjection(plainActor, CASE_ID))
      .rejects.toThrow("DURABLE_PRODUCT_SESSION_BINDING_REQUIRED");
    expect(missingBindingRoot.queries).toHaveLength(0);
    expect(missingBindingRoot.verified_inputs).toHaveLength(0);

    const inactiveRoot = new FocusedPortalPostgresRoot((query) => {
      if (query.name === "product_owner_lookup") return rows();
      throw new Error(`FOCUSED_QUERY_UNEXPECTED:${query.name}`);
    });
    await expect(portalApplication(inactiveRoot).getCaseProjection(ownerActor(), CASE_ID))
      .rejects.toMatchObject({ code: "PORTAL_NOT_FOUND" });
    expect(inactiveRoot.queries.map((query) => query.name)).toEqual(["product_owner_lookup"]);
  });

  it("hides an approved object when its canonical report identity is no longer current", async () => {
    const root = new FocusedPortalPostgresRoot((query) => {
      if (query.name === "product_owner_lookup") return rows(ownerRow());
      if (query.name === "portal_reports_read") {
        return rows({
          report_id: "report:portal:001",
          report_revision: "4",
          report_sha256: HASH,
          grant_epoch: "1",
        });
      }
      if (query.name === "product_report_identity_context") return rows();
      throw new Error(`FOCUSED_QUERY_UNEXPECTED:${query.name}`);
    });

    await expect(portalApplication(root).listReports(ownerActor(), CASE_ID)).resolves.toEqual([]);
    expect(root.queries.map((query) => query.name)).toEqual([
      "product_owner_lookup",
      "portal_reports_read",
      "product_report_identity_context",
    ]);
  });

  it("rejects a download wrapper whose exact token hash was changed before any PostgreSQL read", async () => {
    const root = new FocusedPortalPostgresRoot((query) => {
      throw new Error(`FOCUSED_QUERY_UNEXPECTED:${query.name}`);
    });
    await expect(portalApplication(root).downloadReport(ownerActor(), Object.freeze({
      grant_id: "encoded.signed-grant",
      case_id: CASE_ID,
      report_id: "report:portal:001",
      artifact_sha256: HASH,
      object_version_id: "object_version:portal:001",
      expires_at: "2033-05-18T03:35:20.000Z",
      grant_sha256: "b".repeat(64),
    }))).rejects.toMatchObject({ code: "PORTAL_NOT_FOUND" });
    expect(root.queries).toHaveLength(0);
    expect(root.verified_inputs).toHaveLength(0);
  });

  it("rejects invalid durable dependencies and exposes no memory or synthetic product fallback", async () => {
    const root = new FocusedPortalPostgresRoot((query) => {
      throw new Error(`FOCUSED_QUERY_UNEXPECTED:${query.name}`);
    });
    const context = portalContext(root);
    expect(() => new DurableCustomerPortalPostgresApplication(context, {
      storage: storage("invalid-key"),
      download_grant_hmac_key: new Uint8Array(31),
    })).toThrow("DURABLE_PORTAL_RUNTIME_DEPENDENCY_INVALID");

    const adapter = createDurableCustomerPortalAdapter(context, dependencies("adapter"));
    expect(adapter).toMatchObject({
      postgres: root,
      product: context.product,
      session_context: context.session_context,
      proof_class: "POSTGRESQL_TRANSACTIONAL_ROUTE_SERVICE",
    });
    const source = await readFile(new URL("./durable-postgres-application.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/InMemory|SyntheticCustomerPortal|memory_test_only_factory/u);
    expect(source).toContain("currentCanonicalIdentity");
    expect(source).toContain("session_context.transaction");
  });
});

type FocusedBundle = TransactionScopedPostgresBundle<PostgresIntakeAdapterBundle, PostgresAnalysisRepositories>;

class FocusedPortalPostgresRoot implements DurableProductPostgresRoot {
  readonly mode = "isolated_postgres" as const;
  readonly durable = true as const;
  readonly target_id = "v0102-durable-portal-focused";
  readonly schema_version = CANONICAL_POSTGRES_SCHEMA_VERSION;
  readonly verified_inputs: CanonicalVerifiedTransactionInput[] = [];
  readonly queries: PostgresStatement[] = [];
  unverified_transaction_count = 0;
  readonly #query: (query: PostgresStatement) => PostgresQueryResult;

  constructor(query: (query: PostgresStatement) => PostgresQueryResult) {
    this.#query = query;
  }

  async transaction<T>(
    tenantId: string,
    caseId: string,
    operation: (bundle: FocusedBundle) => Promise<T>,
  ): Promise<T> {
    this.unverified_transaction_count += 1;
    return operation(this.#bundle(tenantId, caseId));
  }

  async verified_transaction<T>(
    input: CanonicalVerifiedTransactionInput,
    operation: (bundle: FocusedBundle) => Promise<T>,
  ): Promise<T> {
    this.verified_inputs.push(input);
    return operation(this.#bundle(input.identity.tenant_id, input.case_id));
  }

  #bundle(tenantId: string, caseId: string): FocusedBundle {
    const client: PostgresClient = Object.freeze({
      query: async (query: PostgresStatement) => {
        this.queries.push(query);
        return this.#query(query);
      },
    });
    const context: PostgresTransactionContext = Object.freeze({
      client,
      transaction_id: `portal:${caseId}:${this.verified_inputs.length}`,
    });
    return Object.freeze({
      context,
      intake: intake_factory(context, tenantId),
      analysis: createPostgresAnalysisRepositories(context, tenantId),
      runtime: Object.freeze({
        idempotency: new PostgresIdempotencyRepository(),
        jobs_outbox_audit: new PostgresJobsOutboxAuditRepository(context, tenantId, caseId),
      }),
    });
  }
}

function portalApplication(root: DurableProductPostgresRoot): DurableCustomerPortalPostgresApplication {
  return new DurableCustomerPortalPostgresApplication(portalContext(root), dependencies("application"));
}

function portalContext(root: DurableProductPostgresRoot): DurableProductRouteContext {
  return Object.freeze({
    postgres: root,
    product: new DurableProductPostgresApplication(root),
    session_context: createLeastPrivilegeProductSessionContext(root),
  });
}

function dependencies(suffix: string) {
  return Object.freeze({
    storage: storage(suffix),
    download_grant_hmac_key: new Uint8Array(32).fill(7),
    now: () => new Date(NOW),
  });
}

function storage(suffix: string): LocalRuntimePrivateBlobProvider {
  return new LocalRuntimePrivateBlobProvider({
    root: join(tmpdir(), `tivdoc-private-runtime-portal-${suffix}`),
    runtime_class: "ignored_local_private_filesystem",
    publicly_addressable: false,
    managed_platform_verified: false,
  });
}

function ownerActor() {
  return bindDurableProductActor(productIdentity());
}

function productIdentity(): VerifiedProductIdentity {
  return Object.freeze({
    actor: Object.freeze({
      actor_id: OWNER_ID,
      role: "customer_owner" as const,
      tenant_id: TENANT_ID,
      assigned_case_ids: Object.freeze([CASE_ID]),
      verified_server_side: true as const,
      break_glass_reason: null,
      break_glass_expires_at: null,
    }),
    issuer: "issuer:portal:001",
    audience: "portal",
    product_audience: "portal",
    session_id: "session:portal:001",
    token_id: "token:portal:001",
    rotation_counter: 3,
    reviewer_organization_id: null,
    issued_at_epoch: 2_000_000_000,
    expires_at_epoch: 2_000_000_600,
  });
}

function ownerRow() {
  return Object.freeze({
    tenant_id: TENANT_ID,
    canonical_case_id: CASE_ID,
    subject: OWNER_ID,
    revision: "1",
    status: "active",
    binding_sha256: HASH,
    created_at: NOW,
    revoked_at: null,
  });
}

function rows(...items: readonly Readonly<Record<string, unknown>>[]): PostgresQueryResult {
  return Object.freeze({ rows: Object.freeze(items), row_count: items.length });
}
