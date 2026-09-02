// Wave 2 (§3.10, B3). What the `/operations` journey can and cannot invalidate,
// stated once, with the reason, so nothing claims wiring it does not have.
//
// The rule this encodes: a service with no caller is `implemented_uncalled`,
// never `implemented`, and a path with nothing to invalidate is
// `not_applicable_at_current_scope` — never quietly counted as closed. Neither
// disposition is allowed to be asserted; each carries the evidence that decides
// it, so a change to the code changes the disposition rather than leaving a
// stale claim behind.

export const JOURNEY_INVALIDATION_DISPOSITION_SCHEMA =
  "tivdoc-journey-invalidation-disposition-wave2" as const;

export type InvalidationDisposition =
  | "wired"
  | "not_applicable_at_current_scope"
  | "implemented_uncalled";

export type JourneyMutationPath = Readonly<{
  /** The mutation the journey can actually perform. */
  path: string;
  anchor: string;
  disposition: InvalidationDisposition;
  /** Why, in terms a reader can check against the code. */
  reason: string;
}>;

/**
 * Every mutation the `/operations` journey reaches.
 *
 * The journey is: synthetic reviewer session -> queue -> topics -> action. Only
 * the action mutates anything, and what it mutates is a review packet.
 *
 * A review packet has no case. `private.governance_legal_review_packets` has no
 * `case_id` column at all, while `public.engine_global_dependency_state` — the
 * table every invalidation writes — is keyed by `(tenant_id,
 * canonical_case_id)`. There is therefore no dependency row a packet action
 * could invalidate, and no run, report, approval or grant derives from a packet
 * while `activation_allowed` is constrained to `false`.
 *
 * That is a scope fact, not a gap in the wiring: inventing a case id to give the
 * invalidation something to write would be fabricating the dependency it claims
 * to track.
 */
export const JOURNEY_MUTATION_PATHS: readonly JourneyMutationPath[] = Object.freeze([
  Object.freeze({
    path: "POST /api/operations/legal-review/actions",
    anchor: "src/server/product/routes/operations-http.ts",
    disposition: "not_applicable_at_current_scope" as const,
    reason: "A review packet carries no case id, and the dependency state is keyed by "
      + "(tenant_id, canonical_case_id). No run, report, approval or grant depends on a "
      + "packet while activation_allowed is constrained to false, so there is nothing to "
      + "invalidate.",
  }),
  Object.freeze({
    path: "GET /api/operations/legal-review/queue",
    anchor: "src/server/product/routes/operations-http.ts",
    disposition: "not_applicable_at_current_scope" as const,
    reason: "A read. It mutates nothing and therefore invalidates nothing.",
  }),
  Object.freeze({
    path: "GET /api/operations/legal-review/topics",
    anchor: "src/server/product/routes/operations-http.ts",
    disposition: "not_applicable_at_current_scope" as const,
    reason: "A read. It mutates nothing and therefore invalidates nothing.",
  }),
]);

/**
 * Services a contract, ledger or report claims while nothing calls them.
 *
 * Recorded rather than quietly wired: a caller invented to satisfy a claim
 * would make the claim true and the system no better. Each entry names where
 * the claim lives so the owner can decide between wiring it and deleting it.
 */
export const IMPLEMENTED_UNCALLED_SERVICES: readonly Readonly<{
  symbol: string;
  anchor: string;
  claimed_by: string | null;
}>[] = Object.freeze([
  Object.freeze({
    symbol: "create_dependency_invalidation",
    anchor: "src/server/product/runtime/durable-local-runtime.ts:213",
    claimed_by: "reachable only through resolveDurableLocalProductWorkflowRegistration, itself uncalled",
  }),
  Object.freeze({
    symbol: "resolveDurableLocalProductWorkflowRegistration",
    anchor: "src/server/product/runtime/durable-local-runtime.ts:112",
    claimed_by: "output/wave1/agents/b38/findings.md",
  }),
  Object.freeze({
    symbol: "withCurrentAuthorization",
    anchor: "src/server/product/dependency-invalidation/global-invalidation.ts",
    claimed_by: "the only enforcement behind stale_execution_blocked and its siblings",
  }),
  Object.freeze({
    symbol: "installInternalOpsPorts",
    anchor: "src/server/product/internal-ops/runtime.ts:10",
    claimed_by: "canonical-entrypoints.v0.10.0.json CEP-080 dependency; docs/overnight-v0.7-p5.md",
  }),
  Object.freeze({
    symbol: "resolveInternalOpsRuntime",
    anchor: "src/server/product/internal-ops/runtime.ts:15",
    claimed_by: "CEP-080, transitively",
  }),
  Object.freeze({
    symbol: "installCanonicalProductRouteServices",
    anchor: "src/server/product/routes/runtime.ts:46",
    claimed_by: "output/product-integration-v0.8.0 ui-service-trace.json composition_root",
  }),
  Object.freeze({
    symbol: "createPortalApi",
    anchor: "src/server/product/customer-portal/api.ts:16",
    claimed_by: "docs/overnight-v0.7-p6.md",
  }),
  Object.freeze({
    symbol: "resolveDurableLocalProductStartupProof",
    anchor: "src/server/product/runtime/durable-local-runtime.ts:104",
    claimed_by: null,
  }),
]);
