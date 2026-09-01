import { describe, expect, it } from "vitest";

import type { VerifiedProductIdentity } from "../auth/identity-session.ts";
import { bindDurableProductActor } from "../auth/identity-session.ts";
import {
  CANONICAL_POSTGRES_SCHEMA_VERSION,
  type CanonicalVerifiedTransactionInput,
  type TransactionScopedPostgresBundle,
} from "../../platform/composition/canonical-postgres.ts";
import {
  createPostgresAnalysisRepositories,
  type PostgresAnalysisRepositories,
} from "../../platform/persistence/postgres/analysis/index.ts";
import {
  intake_factory,
  type PostgresIntakeAdapterBundle,
} from "../../platform/persistence/postgres/intake/index.ts";
import type { PostgresTransactionContext } from "../../platform/persistence/postgres/contracts.ts";
import { PostgresIdempotencyRepository } from "../../platform/persistence/postgres/runtime/idempotency.ts";
import { PostgresJobsOutboxAuditRepository } from "../../platform/persistence/postgres/runtime/jobs-outbox-audit.ts";
import type { DurableProductPostgresRoot } from "./durable-registration.ts";
import { createLeastPrivilegeProductSessionContext } from "./least-privilege-session-context.ts";

function identity(role: "customer_owner" | "legal_reviewer"): VerifiedProductIdentity {
  return Object.freeze({
    actor: Object.freeze({
      actor_id: role === "customer_owner" ? "owner:synthetic:001" : "reviewer:synthetic:001",
      role,
      tenant_id: "tenant:synthetic:001",
      assigned_case_ids: Object.freeze(["case:synthetic:001"]),
      verified_server_side: true as const,
      break_glass_reason: null,
      break_glass_expires_at: null,
    }),
    issuer: "https://issuer.test.invalid",
    audience: role === "customer_owner" ? "portal" : "operations",
    product_audience: role === "customer_owner" ? "portal" : "operations",
    session_id: `session:${role}:001`,
    token_id: `token:${role}:001`,
    rotation_counter: 2,
    reviewer_organization_id: role === "customer_owner" ? null : "reviewer-org:synthetic:001",
    issued_at_epoch: 2_000_000_000,
    expires_at_epoch: 2_000_000_600,
  });
}

class FocusedPostgresRoot implements DurableProductPostgresRoot {
  readonly mode = "isolated_postgres" as const;
  readonly durable = true as const;
  readonly target_id = "v0102-session-context-test";
  readonly schema_version = CANONICAL_POSTGRES_SCHEMA_VERSION;
  readonly verified_inputs: CanonicalVerifiedTransactionInput[] = [];

  async transaction<T>(
    tenantId: string,
    caseId: string,
    operation: (bundle: FocusedBundle) => Promise<T>,
  ): Promise<T> {
    return operation(focusedBundle(tenantId, caseId));
  }

  async verified_transaction<T>(
    input: CanonicalVerifiedTransactionInput,
    operation: (bundle: FocusedBundle) => Promise<T>,
  ): Promise<T> {
    this.verified_inputs.push(input);
    return operation(focusedBundle(input.identity.tenant_id, input.case_id));
  }
}

type FocusedBundle = TransactionScopedPostgresBundle<PostgresIntakeAdapterBundle, PostgresAnalysisRepositories>;

describe("least-privilege product session context", () => {
  it("passes only durable session coordinates to the web runtime transaction", async () => {
    const root = new FocusedPostgresRoot();
    const context = createLeastPrivilegeProductSessionContext(root);
    const actor = bindDurableProductActor(identity("customer_owner"));
    await expect(context.transaction({
      actor,
      audience: "portal",
      case_id: "case:synthetic:001",
      correlation_id: "portal:synthetic:001",
    }, async (bundle) => bundle.context.transaction_id)).resolves.toBe("focused:case:synthetic:001");
    expect(root.verified_inputs).toContainEqual(expect.objectContaining({
      runtime_role: "web",
      identity: expect.objectContaining({
        session_id: "session:customer_owner:001",
        token_id: "token:customer_owner:001",
        tenant_id: "tenant:synthetic:001",
        actor_id: "owner:synthetic:001",
      }),
    }));
  });

  it("fails closed without a durable binding or reviewer organization", async () => {
    const root = new FocusedPostgresRoot();
    const context = createLeastPrivilegeProductSessionContext(root);
    const plain = identity("customer_owner").actor;
    await expect(context.transaction({
      actor: plain,
      audience: "portal",
      case_id: "case:synthetic:001",
      correlation_id: "portal:synthetic:001",
    }, async () => null)).rejects.toThrow("DURABLE_PRODUCT_SESSION_BINDING_REQUIRED");

    const reviewer = identity("legal_reviewer");
    const missingOrganization = bindDurableProductActor(Object.freeze({
      ...reviewer,
      reviewer_organization_id: null,
    }));
    await expect(context.transaction({
      actor: missingOrganization,
      audience: "operations",
      case_id: "case:synthetic:001",
      correlation_id: "operations:synthetic:001",
    }, async () => null)).rejects.toThrow("DURABLE_PRODUCT_REVIEWER_ORGANIZATION_REQUIRED");

    const owner = bindDurableProductActor(identity("customer_owner"));
    await expect(context.transaction({
      actor: owner,
      audience: "operations",
      case_id: "case:synthetic:001",
      correlation_id: "operations:synthetic:001",
    }, async () => null)).rejects.toThrow("DURABLE_PRODUCT_SESSION_AUDIENCE_MISMATCH");
    expect(root.verified_inputs).toHaveLength(0);
  });
});

function focusedBundle(tenantId: string, caseId: string): FocusedBundle {
  const context: PostgresTransactionContext = Object.freeze({
    transaction_id: `focused:${caseId}`,
    client: Object.freeze({
      async query() {
        throw new Error("FOCUSED_POSTGRES_QUERY_NOT_EXPECTED");
      },
    }),
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
