import { describe, expect, it, vi } from "vitest";

import type { VerifiedProductIdentity } from "../auth/identity-session.ts";
import { bindDurableProductActor } from "../auth/identity-session.ts";
import { CANONICAL_POSTGRES_SCHEMA_VERSION } from "../../platform/composition/canonical-postgres.ts";
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

function postgres(verifiedTransaction = vi.fn(async (_input, operation) => operation({}))): DurableProductPostgresRoot {
  return Object.freeze({
    mode: "isolated_postgres" as const,
    durable: true as const,
    target_id: "v0102-session-context-test",
    schema_version: CANONICAL_POSTGRES_SCHEMA_VERSION,
    transaction: vi.fn(),
    verified_transaction: verifiedTransaction,
  }) as unknown as DurableProductPostgresRoot;
}

describe("least-privilege product session context", () => {
  it("passes only durable session coordinates to the web runtime transaction", async () => {
    const transaction = vi.fn(async (_input, operation) => operation(Object.freeze({ marker: true })));
    const root = postgres(transaction);
    const context = createLeastPrivilegeProductSessionContext(root);
    const actor = bindDurableProductActor(identity("customer_owner"));
    await expect(context.transaction({
      actor,
      audience: "portal",
      case_id: "case:synthetic:001",
      correlation_id: "portal:synthetic:001",
    }, async (bundle) => bundle)).resolves.toEqual({ marker: true });
    expect(transaction).toHaveBeenCalledWith(expect.objectContaining({
      runtime_role: "web",
      identity: expect.objectContaining({
        session_id: "session:customer_owner:001",
        token_id: "token:customer_owner:001",
        tenant_id: "tenant:synthetic:001",
        actor_id: "owner:synthetic:001",
      }),
    }), expect.any(Function));
  });

  it("fails closed without a durable binding or reviewer organization", async () => {
    const context = createLeastPrivilegeProductSessionContext(postgres());
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
  });
});
