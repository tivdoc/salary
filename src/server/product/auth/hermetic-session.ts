import "./server-boundary.ts";

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { internalOpsActorSchema } from "../internal-ops/contracts.ts";

export const PRODUCT_SESSION_COOKIE = "tivdoc_hermetic_session" as const;
export const PRODUCT_CSRF_HEADER = "x-tivdoc-csrf" as const;

export type ProductAudience = "portal" | "operations";
export type AuthenticatedProductActor = ReturnType<typeof internalOpsActorSchema.parse>;

type Environment = Readonly<Record<string, string | undefined>>;
type SessionClaims = Readonly<{
  version: 1;
  mode: "local_hermetic";
  audience: ProductAudience;
  actor: AuthenticatedProductActor;
  csrf_token: string;
  session_id: string;
  issued_at_epoch: number;
  expires_at_epoch: number;
}>;

export type VerifiedProductSession = Readonly<{
  actor: AuthenticatedProductActor;
  audience: ProductAudience;
  csrf_token: string;
  expires_at_epoch: number;
}>;

export type IssuedProductSession = Readonly<{
  cookie: string;
  csrf_token: string;
  expires_at_epoch: number;
}>;

const IDENTITY_SPOOF_HEADERS = Object.freeze([
  "authorization",
  "x-user-id",
  "x-role",
  "x-owner-id",
  "x-tivdoc-actor-id",
  "x-tivdoc-role",
  "x-tivdoc-owner-id",
]);
const IDENTITY_QUERY_KEYS = Object.freeze(["actor", "actor_id", "owner", "owner_id", "role", "tenant", "tenant_id"]);
const MAX_SESSION_SECONDS = 15 * 60;

type TicketRecord = Readonly<{
  audience: ProductAudience;
  actor: AuthenticatedProductActor;
}>;

export class HermeticSessionManager {
  readonly #environment: Environment;
  readonly #nodeEnv: string | undefined;
  readonly #vercelEnv: string | undefined;
  readonly #now: () => number;
  readonly #activeSessionPrincipals = new Map<string, string>();
  readonly #currentSessionByPrincipal = new Map<string, string>();

  constructor(input: Readonly<{
    environment?: Environment;
    nodeEnv?: string;
    vercelEnv?: string;
    now?: () => number;
  }> = {}) {
    this.#environment = input.environment ?? process.env;
    this.#nodeEnv = input.nodeEnv ?? process.env.NODE_ENV;
    this.#vercelEnv = input.vercelEnv ?? process.env.VERCEL_ENV;
    this.#now = input.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  issue(request: Request, audience: ProductAudience, ticket: string): IssuedProductSession | null {
    const configuration = this.#configurationFor(request);
    if (!configuration || hasIdentitySpoof(request)) return null;
    const record = configuration.tickets.get(ticket);
    if (!record || record.audience !== audience || !roleAllowedForAudience(record.actor.role, audience)) return null;
    const issuedAt = this.#now();
    const expiresAt = issuedAt + configuration.maxSessionSeconds;
    const claims: SessionClaims = Object.freeze({
      version: 1,
      mode: "local_hermetic",
      audience,
      actor: record.actor,
      csrf_token: randomBytes(32).toString("base64url"),
      session_id: randomUUID(),
      issued_at_epoch: issuedAt,
      expires_at_epoch: expiresAt,
    });
    const token = signClaims(claims, configuration.secret);
    const principal = sessionPrincipal(claims.actor.actor_id, claims.audience);
    const previousSessionId = this.#currentSessionByPrincipal.get(principal);
    if (previousSessionId) this.#activeSessionPrincipals.delete(previousSessionId);
    this.#activeSessionPrincipals.set(claims.session_id, principal);
    this.#currentSessionByPrincipal.set(principal, claims.session_id);
    return Object.freeze({
      cookie: serializeCookie(token, expiresAt - issuedAt, new URL(request.url).protocol === "https:"),
      csrf_token: claims.csrf_token,
      expires_at_epoch: expiresAt,
    });
  }

  verify(request: Request, audience: ProductAudience, requireCsrf: boolean): VerifiedProductSession | null {
    const configuration = this.#configurationFor(request);
    if (!configuration || hasIdentitySpoof(request)) return null;
    const token = singleCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE);
    if (!token) return null;
    const claims = verifyClaims(token, configuration.secret);
    if (!claims || claims.audience !== audience || claims.mode !== "local_hermetic") return null;
    const principal = sessionPrincipal(claims.actor.actor_id, claims.audience);
    if (this.#activeSessionPrincipals.get(claims.session_id) !== principal || this.#currentSessionByPrincipal.get(principal) !== claims.session_id) return null;
    const now = this.#now();
    if (claims.issued_at_epoch > now + 5 || claims.expires_at_epoch <= now || claims.expires_at_epoch - claims.issued_at_epoch > configuration.maxSessionSeconds) return null;
    if (!roleAllowedForAudience(claims.actor.role, audience)) return null;
    if (requireCsrf && !validCsrf(request, claims.csrf_token)) return null;
    return Object.freeze({
      actor: claims.actor,
      audience: claims.audience,
      csrf_token: claims.csrf_token,
      expires_at_epoch: claims.expires_at_epoch,
    });
  }

  revoke(request: Request, audience: ProductAudience): string | null {
    const configuration = this.#configurationFor(request);
    if (!configuration || hasIdentitySpoof(request)) return null;
    const token = singleCookie(request.headers.get("cookie"), PRODUCT_SESSION_COOKIE);
    if (!token) return null;
    const claims = verifyClaims(token, configuration.secret);
    if (!claims || claims.audience !== audience || !validCsrf(request, claims.csrf_token)) return null;
    const now = this.#now();
    const principal = sessionPrincipal(claims.actor.actor_id, claims.audience);
    if (claims.expires_at_epoch <= now || this.#activeSessionPrincipals.get(claims.session_id) !== principal || this.#currentSessionByPrincipal.get(principal) !== claims.session_id) return null;
    this.#activeSessionPrincipals.delete(claims.session_id);
    this.#currentSessionByPrincipal.delete(principal);
    return expireCookie(new URL(request.url).protocol === "https:");
  }

  #configurationFor(request: Request): Readonly<{ secret: string; tickets: ReadonlyMap<string, TicketRecord>; maxSessionSeconds: number }> | null {
    if (!isLoopbackUrl(request.url)) return null;
    // Both the real process and the injectable test seam must be test. A caller
    // cannot turn this hermetic fixture into a development/preview provider.
    if (process.env.NODE_ENV !== "test" || process.env.VERCEL_ENV === "production" || process.env.VERCEL_ENV === "preview" || this.#nodeEnv !== "test" || this.#vercelEnv === "production" || this.#vercelEnv === "preview") return null;
    if (!enabled(this.#environment.TIVDOC_HERMETIC_MODE)) return null;
    const secret = this.#environment.TIVDOC_PRODUCT_SESSION_SECRET;
    if (!secret || Buffer.byteLength(secret, "utf8") < 32) return null;
    const tickets = parseTickets(this.#environment.TIVDOC_PRODUCT_HERMETIC_TICKETS_JSON);
    const maxSessionSeconds = parseSessionSeconds(this.#environment.TIVDOC_PRODUCT_SESSION_MAX_AGE_SECONDS);
    return tickets && maxSessionSeconds !== null ? Object.freeze({ secret, tickets, maxSessionSeconds }) : null;
  }
}

type HermeticRuntimeGlobal = typeof globalThis & {
  __tivdocProductHermeticSessionManager?: HermeticSessionManager;
};

export function runtimeHermeticSessionManager(): HermeticSessionManager {
  const runtimeGlobal = globalThis as HermeticRuntimeGlobal;
  runtimeGlobal.__tivdocProductHermeticSessionManager ??= new HermeticSessionManager();
  return runtimeGlobal.__tivdocProductHermeticSessionManager;
}

export function resetRuntimeHermeticSessionManagerForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("auth_runtime_reset_forbidden");
  delete (globalThis as HermeticRuntimeGlobal).__tivdocProductHermeticSessionManager;
}

function parseTickets(raw: string | undefined): ReadonlyMap<string, TicketRecord> | null {
  if (!raw || raw.length > 32_768) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 20) return null;
  const tickets = new Map<string, TicketRecord>();
  for (const [ticket, candidate] of entries) {
    if (!/^[A-Za-z0-9:_-]{16,160}$/.test(ticket) || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const object = candidate as Record<string, unknown>;
    if (Object.keys(object).sort().join(",") !== "actor,audience") return null;
    if (object.audience !== "portal" && object.audience !== "operations") return null;
    const actor = internalOpsActorSchema.safeParse(object.actor);
    if (!actor.success || !roleAllowedForAudience(actor.data.role, object.audience)) return null;
    tickets.set(ticket, Object.freeze({ audience: object.audience, actor: Object.freeze(actor.data) }));
  }
  return tickets;
}

function signClaims(claims: SessionClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyClaims(token: string, secret: string): SessionClaims | null {
  const pieces = token.split(".");
  if (pieces.length !== 2 || pieces.some((piece) => !/^[A-Za-z0-9_-]+$/.test(piece))) return null;
  const expected = createHmac("sha256", secret).update(pieces[0]).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(pieces[1], "base64url");
  } catch {
    return null;
  }
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(pieces[0], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const exactKeys = ["actor", "audience", "csrf_token", "expires_at_epoch", "issued_at_epoch", "mode", "session_id", "version"];
  if (Object.keys(candidate).sort().join(",") !== exactKeys.sort().join(",")) return null;
  if (candidate.version !== 1 || candidate.mode !== "local_hermetic") return null;
  if (candidate.audience !== "portal" && candidate.audience !== "operations") return null;
  if (typeof candidate.csrf_token !== "string" || !/^[A-Za-z0-9_-]{32,64}$/.test(candidate.csrf_token)) return null;
  if (typeof candidate.session_id !== "string" || !/^[0-9a-f-]{36}$/.test(candidate.session_id)) return null;
  if (!Number.isSafeInteger(candidate.issued_at_epoch) || !Number.isSafeInteger(candidate.expires_at_epoch)) return null;
  const actor = internalOpsActorSchema.safeParse(candidate.actor);
  if (!actor.success) return null;
  return Object.freeze({
    version: 1,
    mode: "local_hermetic",
    audience: candidate.audience,
    actor: Object.freeze(actor.data),
    csrf_token: candidate.csrf_token,
    session_id: candidate.session_id,
    issued_at_epoch: candidate.issued_at_epoch as number,
    expires_at_epoch: candidate.expires_at_epoch as number,
  });
}

function singleCookie(raw: string | null, name: string): string | null {
  if (!raw || raw.length > 8_192) return null;
  const matches = raw.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_.-]{40,4096}$/.test(value) ? value : null;
}

function validCsrf(request: Request, expected: string): boolean {
  const supplied = request.headers.get(PRODUCT_CSRF_HEADER);
  if (!supplied || supplied.length !== expected.length) return false;
  const left = Buffer.from(supplied, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.byteLength !== right.byteLength || !timingSafeEqual(left, right)) return false;
  const origin = request.headers.get("origin");
  if (!origin || !sameHermeticOrigin(origin, request.url, request.headers.get("host"))) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite === null || fetchSite === "same-origin";
}

function hasIdentitySpoof(request: Request): boolean {
  if (IDENTITY_SPOOF_HEADERS.some((header) => request.headers.has(header))) return true;
  const url = new URL(request.url);
  return IDENTITY_QUERY_KEYS.some((key) => url.searchParams.has(key));
}

function roleAllowedForAudience(role: string, audience: ProductAudience): boolean {
  if (audience === "portal") return role === "customer_owner";
  return role !== "anonymous" && role !== "customer_owner";
}

function sessionPrincipal(actorId: string, audience: ProductAudience): string {
  return `${audience}:${actorId}`;
}

function isLoopbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:")
    && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1");
}

function enabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function sameHermeticOrigin(supplied: string, requestUrl: string, host: string | null): boolean {
  let suppliedUrl: URL;
  let request: URL;
  try {
    suppliedUrl = new URL(supplied);
    request = new URL(requestUrl);
  } catch {
    return false;
  }
  if (!loopbackHostname(suppliedUrl.hostname) || !loopbackHostname(request.hostname)) return false;
  if (host === null) return suppliedUrl.origin === request.origin;
  if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)) return false;
  let hostOrigin: URL;
  try {
    hostOrigin = new URL(`${request.protocol}//${host}`);
  } catch {
    return false;
  }
  return loopbackHostname(hostOrigin.hostname) && suppliedUrl.origin === hostOrigin.origin;
}

function loopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function parseSessionSeconds(value: string | undefined): number | null {
  if (value === undefined) return MAX_SESSION_SECONDS;
  if (!/^\d{1,3}$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= MAX_SESSION_SECONDS ? seconds : null;
}

function serializeCookie(token: string, maxAge: number, secure: boolean): string {
  return `${PRODUCT_SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function expireCookie(secure: boolean): string {
  return `${PRODUCT_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}
