// L9-3 / D3. The product half and the engine half of one build, declared
// once, as data.
//
// This repository is the live site and the legal engine. Long run 8 proved a
// production build closed by blocking every capability — and closed the
// business with the engine: the payments routes the five-minute cron hits
// answered the same 404 as the operations panel. "Closed" conflated two
// things with opposite requirements. The product half is everything `main`
// serves today — the public pages, the questionnaire funnel, the case and
// document routes, GA4 measurement, health and the three payments routes —
// and in a production build these answer exactly as `main` answers. The
// engine half — legal review, the shadow, operations, the portal, ground
// truth, anything that reads the reference tenant — answers the empty 404
// under the same build.
//
// Every dispatcher root in the inventory and every route file under src/app
// is assigned here to one half, with a reason in prose. A route added later
// has no entry, and the test fails on it: nothing defaults into the open
// half. A route that exists on `main` must be product (it is what the live
// site serves); a route added on this branch is engine unless it is listed
// here as product with a reason of its own (none is, today).
import { STABLE_PRODUCT_DISPATCHER_ROOTS } from "./stable-entrypoint-runtime.ts";

export type RouteHalf = "product" | "engine";

/** A probe the closure proof sends to a product route: the method, the path, and the status `main` answers with when nothing is configured and nothing is sent (read from main's own handlers; a class like 3xx where the exact code is the framework's). */
export type RouteProbe = Readonly<{ method: "GET" | "POST"; path: string; expected: string }>;

export type RouteAssignment = Readonly<{
  entrypoint_id: string;
  /** The Next.js file under src/app, or null for the registrar (CEP-078), which has no route file. */
  route_file: string | null;
  stable_entry: string;
  half: RouteHalf;
  /** Why this route is on this half. Prose, like the writer inventory's reasons. */
  reason: string;
  /** Product routes only: what the closure proof expects from a production build, per method, with no configuration and no credentials. */
  probes?: readonly RouteProbe[];
  /** UX Run 1: a product route this branch added; main never served it, and the closure proof expects it beside main's own. */
  added_on_branch?: true;
  /** Site S5: a product route main serves that this branch deliberately REWROTE. The "differs only by the guard"
   *  budget does not apply to it — the redesign is the wave's deliverable — but every other rule still does:
   *  it stays on the product half, keeps its guard, and imports nothing from the engine. The reason says why. */
  rewritten_on_branch?: string;
}>;

const MAIN = "Served by `main` (b963844) today";

export const ROUTE_SPLIT: readonly RouteAssignment[] = Object.freeze([
  // --- The product half: what the live site serves. -------------------------
  { entrypoint_id: "CEP-001", route_file: "src/app/page.tsx", stable_entry: "/", half: "product", rewritten_on_branch: "Site S5: the home page rebuilt on design/landing-v5 direction B. Still main's route, still guarded, still importing nothing from the engine; the diff is the redesign itself.", reason: `${MAIN}: the landing page.`, probes: [{ method: "GET", path: "/", expected: "200" }] },
  { entrypoint_id: "CEP-002", route_file: "src/app/check/page.tsx", stable_entry: "/check", half: "product", reason: `${MAIN}: the questionnaire.`, probes: [{ method: "GET", path: "/check", expected: "200" }] },
  { entrypoint_id: "CEP-003", route_file: "src/app/check/upload/page.tsx", stable_entry: "/check/upload", half: "product", reason: `${MAIN}: the upload page; since UX Run 1 / U7 it answers 307 to /check when no case cookie is present, the redirect the review asked for.`, probes: [{ method: "GET", path: "/check/upload", expected: "307" }] },
  { entrypoint_id: "CEP-004", route_file: "src/app/check/payment/page.tsx", stable_entry: "/check/payment", half: "product", reason: `${MAIN}: the payment hand-off page; since UX Run 1 / U7 it answers 307 to /check when no case cookie is present.`, probes: [{ method: "GET", path: "/check/payment", expected: "307" }] },
  { entrypoint_id: "CEP-005", route_file: "src/app/check/received/page.tsx", stable_entry: "/check/received", half: "product", reason: `${MAIN}: the payment confirmation page; since UX Run 1 / U7 it answers 307 to /check when no case cookie is present.`, probes: [{ method: "GET", path: "/check/received", expected: "307" }] },
  { entrypoint_id: "CEP-008", route_file: "src/app/privacy/page.tsx", stable_entry: "/privacy", half: "product", reason: `${MAIN}: the privacy policy.`, probes: [{ method: "GET", path: "/privacy", expected: "200" }] },
  { entrypoint_id: "CEP-009", route_file: "src/app/terms/page.tsx", stable_entry: "/terms", half: "product", reason: `${MAIN}: the terms.`, probes: [{ method: "GET", path: "/terms", expected: "200" }] },
  { entrypoint_id: "CEP-010", route_file: "src/app/robots.ts", stable_entry: "/robots.txt", half: "product", reason: `${MAIN}: robots.txt.`, probes: [{ method: "GET", path: "/robots.txt", expected: "200" }] },
  { entrypoint_id: "CEP-011", route_file: "src/app/sitemap.ts", stable_entry: "/sitemap.xml", half: "product", reason: `${MAIN}: the sitemap.`, probes: [{ method: "GET", path: "/sitemap.xml", expected: "200" }] },
  { entrypoint_id: "CEP-012", route_file: "src/app/opengraph-image.tsx", stable_entry: "/opengraph-image", half: "product", reason: `${MAIN}: the Open Graph image.`, probes: [{ method: "GET", path: "/opengraph-image", expected: "200" }] },
  { entrypoint_id: "CEP-013", route_file: "src/app/api/cases/route.ts", stable_entry: "/api/cases", half: "product", reason: `${MAIN}: creates a case from the questionnaire in the product's own store; it reaches no legal computation.`, probes: [{ method: "POST", path: "/api/cases", expected: "400" }] },
  { entrypoint_id: "CEP-014", route_file: "src/app/api/cases/resume/route.ts", stable_entry: "/api/cases/resume", half: "product", reason: `${MAIN}: resumes a case from its cookie.`, probes: [{ method: "GET", path: "/api/cases/resume", expected: "200" }] },
  { entrypoint_id: "CEP-015", route_file: "src/app/api/cases/status/route.ts", stable_entry: "/api/cases/status", half: "product", reason: `${MAIN}: reads a case's status and payment state.`, probes: [{ method: "GET", path: "/api/cases/status", expected: "401" }] },
  { entrypoint_id: "CEP-016", route_file: "src/app/api/documents/sign/route.ts", stable_entry: "/api/documents/sign", half: "product", reason: `${MAIN}: issues signed upload URLs for the product's private storage.`, probes: [{ method: "POST", path: "/api/documents/sign", expected: "401" }] },
  { entrypoint_id: "CEP-017", route_file: "src/app/api/documents/complete/route.ts", stable_entry: "/api/documents/complete", half: "product", reason: `${MAIN}: records the upload manifest.`, probes: [{ method: "POST", path: "/api/documents/complete", expected: "401" }] },
  { entrypoint_id: "CEP-018", route_file: "src/app/api/funnel/session/route.ts", stable_entry: "/api/funnel/session", half: "product", reason: `${MAIN}: funnel attribution and GA4 measurement.`, probes: [{ method: "POST", path: "/api/funnel/session", expected: "400" }] },
  { entrypoint_id: "CEP-019", route_file: "src/app/api/health/route.ts", stable_entry: "/api/health", half: "product", reason: `${MAIN}: the health route the platform polls.`, probes: [{ method: "GET", path: "/api/health", expected: "200" }] },
  { entrypoint_id: "CEP-022", route_file: "src/app/api/payments/start/route.ts", stable_entry: "/api/payments/start", half: "product", reason: `${MAIN}: starts an Invoice4u checkout.`, probes: [{ method: "POST", path: "/api/payments/start", expected: "401" }] },
  { entrypoint_id: "CEP-023", route_file: "src/app/api/payments/return/route.ts", stable_entry: "/api/payments/return", half: "product", reason: `${MAIN}: the payment return callback.`, probes: [{ method: "GET", path: "/api/payments/return", expected: "3xx" }] },
  { entrypoint_id: "CEP-024", route_file: "src/app/api/payments/reconcile/route.ts", stable_entry: "/api/payments/reconcile", half: "product", reason: `${MAIN}: the bearer-authenticated reconciliation the five-minute cron posts to; without the bearer it answers 401, never 404.`, probes: [{ method: "POST", path: "/api/payments/reconcile", expected: "401" }] },
  // --- UX Run 1 (S1): customer access after payment; product half, served as `main` serves it. ---
  { entrypoint_id: "CEP-096", route_file: "src/app/case/[token]/page.tsx", stable_entry: "/case/[token]", half: "product", reason: "UX Run 1 / D-1.2: the code challenge the sent link opens, and the case view for a verified identity session; it reaches no legal computation.", probes: [{ method: "GET", path: "/case/0000000000000000000000", expected: "200" }], added_on_branch: true },
  { entrypoint_id: "CEP-097", route_file: "src/app/login/page.tsx", stable_entry: "/login", half: "product", reason: "UX Run 1 / D-1.4: phone or email, then a code, then the identity's cases; login and recovery in one route.", probes: [{ method: "GET", path: "/login", expected: "200" }], added_on_branch: true },
  { entrypoint_id: "CEP-098", route_file: "src/app/cases/page.tsx", stable_entry: "/cases", half: "product", reason: "UX Run 1 / D-1.5: the identity's case list, rendered only with more than one case; without a session it sends the visitor to /login.", probes: [{ method: "GET", path: "/cases", expected: "307" }], added_on_branch: true },
  { entrypoint_id: "CEP-099", route_file: "src/app/api/cases/access/request/route.ts", stable_entry: "/api/cases/access/request", half: "product", reason: "UX Run 1 / U2: issues an access code to the channel on file; an empty body is a 400, never a hint about a contact.", probes: [{ method: "POST", path: "/api/cases/access/request", expected: "400" }], added_on_branch: true },
  { entrypoint_id: "CEP-100", route_file: "src/app/api/cases/access/verify/route.ts", stable_entry: "/api/cases/access/verify", half: "product", reason: "UX Run 1 / U2: turns a valid code into a rolling identity session; an empty body is a 400.", probes: [{ method: "POST", path: "/api/cases/access/verify", expected: "400" }], added_on_branch: true },
  { entrypoint_id: "CEP-101", route_file: "src/app/api/cases/access/resend/route.ts", stable_entry: "/api/cases/access/resend", half: "product", reason: "UX Run 1 / U5: re-sends the case link for the funnel cookie's case; without the cookie it answers 401.", probes: [{ method: "POST", path: "/api/cases/access/resend", expected: "401" }], added_on_branch: true },
  // --- The engine half: added on this branch, closed in production. ---------
  { entrypoint_id: "CEP-006", route_file: "src/app/operations/page.tsx", stable_entry: "/operations", half: "engine", reason: "Added on this branch: the operations workspace (legal review, ground truth, the shadow panel)." },
  { entrypoint_id: "CEP-007", route_file: "src/app/portal/page.tsx", stable_entry: "/portal", half: "engine", reason: "Added on this branch: the reviewer portal." },
  { entrypoint_id: "CEP-020", route_file: "src/app/api/operations/[...segments]/route.ts", stable_entry: "/api/operations/*", half: "engine", reason: "Added on this branch: every operations dispatcher, including the shadow summary and the legal-review queue." },
  { entrypoint_id: "CEP-021", route_file: "src/app/api/operations/session/route.ts", stable_entry: "/api/operations/session", half: "engine", reason: "Added on this branch: operations sessions." },
  { entrypoint_id: "CEP-025", route_file: "src/app/api/portal/[[...resource]]/route.ts", stable_entry: "/api/portal/*", half: "engine", reason: "Added on this branch: every portal dispatcher." },
  { entrypoint_id: "CEP-026", route_file: "src/app/api/portal/session/route.ts", stable_entry: "/api/portal/session", half: "engine", reason: "Added on this branch: portal sessions." },
  { entrypoint_id: "CEP-078", route_file: null, stable_entry: "canonical-route-runtime", half: "engine", reason: "Added on this branch: the canonical route registrar the local runtimes install; a deployment installs none." },
]);

/** The Next.js files under src/app that are dispatchers; layouts are not. */
export const ROUTE_FILE_PATTERN = /^src\/app\/.*(?:route\.ts|page\.tsx|opengraph-image\.tsx|robots\.ts|sitemap\.ts)$/u;

const byId = new Map(ROUTE_SPLIT.map((entry) => [entry.entrypoint_id, entry]));

export function routeAssignmentOf(entrypointId: string): RouteAssignment | null {
  return byId.get(entrypointId) ?? null;
}

/** The half a dispatcher is on; null when it is unassigned — which the split test turns into a failure, and the closed runtime into a BLOCK. */
export function routeHalfOf(entrypointId: string): RouteHalf | null {
  return byId.get(entrypointId)?.half ?? null;
}

export function productAssignments(): readonly RouteAssignment[] {
  return ROUTE_SPLIT.filter((entry) => entry.half === "product");
}

export function engineAssignments(): readonly RouteAssignment[] {
  return ROUTE_SPLIT.filter((entry) => entry.half === "engine");
}

/** Every dispatcher root the inventory knows, so a root the split does not name is visible. */
export function unassignedDispatcherRoots(): readonly string[] {
  return STABLE_PRODUCT_DISPATCHER_ROOTS.map((entry) => entry.entrypoint_id).filter((id) => !byId.has(id));
}
