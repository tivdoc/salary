import "./server-boundary.ts";

import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";
import type { CanonicalVerifiedRuntimeIdentity } from "../../platform/composition/canonical-postgres.ts";
import { durableProductActorSession } from "../auth/identity-session.ts";
import type { ProductAudience } from "../auth/hermetic-session.ts";
import type {
  DurableProductPostgresRoot,
  DurableProductRouteSessionContextPort,
} from "./durable-registration.ts";

/**
 * The stable HTTP bridge into the role-specific PostgreSQL pools. Tenant,
 * actor and role are re-derived by `private.runtime_context_install`; the
 * signed actor values here are comparison constraints, never database GUCs.
 */
export function createLeastPrivilegeProductSessionContext(
  postgres: DurableProductPostgresRoot,
): DurableProductRouteSessionContextPort {
  return Object.freeze({
    proof_class: "LEAST_PRIVILEGE_VERIFIED_SESSION_CONTEXT" as const,
    uses_service_role: false as const,
    bypasses_rls: false as const,
    postgres,
    transaction: async <T>(
      input: Readonly<{
        actor: VerifiedActor;
        audience: ProductAudience;
        case_id: string;
        correlation_id: string;
      }>,
      operation: Parameters<DurableProductRouteSessionContextPort["transaction"]>[1],
    ): Promise<T> => {
      const identity = verifiedIdentity(input.actor, input.audience);
      return postgres.verified_transaction({
        identity,
        runtime_role: input.audience === "portal" ? "web" : "operations",
        case_id: input.case_id,
        correlation_id: input.correlation_id,
      }, operation) as Promise<T>;
    },
  });
}

function verifiedIdentity(actor: VerifiedActor, audience: ProductAudience): CanonicalVerifiedRuntimeIdentity {
  const session = durableProductActorSession(actor);
  if (!session || actor.tenant_id === null) throw new Error("DURABLE_PRODUCT_SESSION_BINDING_REQUIRED");
  if ((audience === "portal" && actor.role !== "customer_owner")
      || (audience === "operations" && (actor.role === "anonymous" || actor.role === "customer_owner"))) {
    throw new Error("DURABLE_PRODUCT_SESSION_AUDIENCE_MISMATCH");
  }
  if (audience === "operations" && session.reviewer_organization_id === null) {
    throw new Error("DURABLE_PRODUCT_REVIEWER_ORGANIZATION_REQUIRED");
  }
  return Object.freeze({
    session_id: session.session_id,
    token_id: session.token_id,
    tenant_id: actor.tenant_id,
    actor_id: actor.actor_id,
    reviewer_organization_id: session.reviewer_organization_id,
    rotation_counter: session.rotation_counter,
  });
}
