import "./server-boundary.ts";

import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";
import type {
  CanonicalVerifiedRuntimeIdentity,
  TransactionScopedPostgresBundle,
} from "../../platform/composition/canonical-postgres.ts";
import type { PostgresAnalysisRepositories } from "../../platform/persistence/postgres/analysis/index.ts";
import type { PostgresIntakeAdapterBundle } from "../../platform/persistence/postgres/intake/index.ts";
import { durableProductIdentityFromActor } from "../auth/identity-session.ts";
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
  const context: DurableProductRouteSessionContextPort = {
    proof_class: "LEAST_PRIVILEGE_VERIFIED_SESSION_CONTEXT" as const,
    uses_service_role: false as const,
    bypasses_rls: false as const,
    postgres,
    async transaction<T>(
      input: Readonly<{
        actor: VerifiedActor;
        audience: ProductAudience;
        case_id: string;
        correlation_id: string;
      }>,
      operation: (
        bundle: TransactionScopedPostgresBundle<PostgresIntakeAdapterBundle, PostgresAnalysisRepositories>,
      ) => Promise<T>,
    ): Promise<T> {
      const identity = verifiedIdentity(input.actor, input.audience);
      return postgres.verified_transaction({
        identity,
        runtime_role: input.audience === "portal" ? "web" : "operations",
        case_id: input.case_id,
        correlation_id: input.correlation_id,
      }, operation);
    },
  };
  return Object.freeze(context);
}

function verifiedIdentity(actor: VerifiedActor, audience: ProductAudience): CanonicalVerifiedRuntimeIdentity {
  const identity = durableProductIdentityFromActor(actor, audience);
  const tenantId = identity.actor.tenant_id;
  if (tenantId === null) throw new Error("DURABLE_PRODUCT_SESSION_BINDING_REQUIRED");
  if (audience === "operations" && identity.reviewer_organization_id === null) {
    throw new Error("DURABLE_PRODUCT_REVIEWER_ORGANIZATION_REQUIRED");
  }
  return Object.freeze({
    session_id: identity.session_id,
    token_id: identity.token_id,
    tenant_id: tenantId,
    actor_id: actor.actor_id,
    reviewer_organization_id: identity.reviewer_organization_id,
    rotation_counter: identity.rotation_counter,
  });
}
