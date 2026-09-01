import {
  constants,
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

export const DURABLE_BROWSER_RECEIPT_SCHEMA =
  "tivdoc-full-local-system-marathon-durable-browser-e2e-v0.10.2" as const;
export const DURABLE_BROWSER_RUNTIME_SENTINEL =
  "TIVDOC_DURABLE_LOCAL_PRODUCT_V0102" as const;
export const DURABLE_BROWSER_IDENTITY_COOKIE =
  "__Host-tivdoc_identity" as const;
export const DURABLE_BROWSER_CSRF_COOKIE = "tivdoc_csrf" as const;

const RUN_ID = /^[a-f0-9]{12,32}$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/u;
const HASH = /^[a-f0-9]{64}$/u;

export type DurableBrowserFixtureIds = Readonly<{
  tenant_id: string;
  case_id: string;
  internal_case_id: string;
  fact_id: string;
  legal_reviewer: DurableBrowserIdentityFixture;
  report_approver: DurableBrowserIdentityFixture;
  owner: DurableBrowserIdentityFixture;
  cross_owner: DurableBrowserIdentityFixture;
  worker: DurableBrowserIdentityFixture;
}>;

export type DurableBrowserIdentityFixture = Readonly<{
  actor_id: string;
  role:
    | "legal_reviewer"
    | "report_approver"
    | "customer_owner"
    | "scoped_background_worker";
  audience: "operations" | "portal" | null;
  session_id: string;
  token_id: string;
  reviewer_organization_id: string | null;
}>;

export type DurableBrowserKeyMaterial = Readonly<{
  key_id: string;
  private_key: KeyObject;
  public_key_spki_pem: string;
}>;

export type DurableBrowserJwtClaims = Readonly<{
  assigned_case_ids: readonly string[];
  aud: "operations" | "portal";
  break_glass_expires_at: null;
  break_glass_reason: null;
  exp: number;
  iat: number;
  iss: string;
  jti: string;
  nbf: number;
  reviewer_organization_id: string | null;
  role: DurableBrowserIdentityFixture["role"];
  rotation: 1;
  sid: string;
  sub: string;
  tenant_id: string;
}>;

export type BrowserStorageState = Readonly<{
  cookies: readonly Readonly<{
    name: string;
    value: string;
    domain: "127.0.0.1";
    path: "/";
    expires: number;
    httpOnly: boolean;
    secure: true;
    sameSite: "Strict";
  }>[];
  origins: readonly [];
}>;

export function durableBrowserFixtureIds(runId: string): DurableBrowserFixtureIds {
  if (!RUN_ID.test(runId)) throw new Error("DURABLE_BROWSER_RUN_ID_INVALID");
  const identity = (
    name: "legal" | "approver" | "owner" | "cross-owner" | "worker",
    role: DurableBrowserIdentityFixture["role"],
    audience: DurableBrowserIdentityFixture["audience"],
    reviewerOrganizationId: string | null,
  ): DurableBrowserIdentityFixture => Object.freeze({
    actor_id: `${name}:synthetic:${runId}`,
    role,
    audience,
    session_id: `session:synthetic:${name}:${runId}`,
    token_id: `token:synthetic:${name}:${runId}`,
    reviewer_organization_id: reviewerOrganizationId,
  });
  const tenantId = `tenant:synthetic:${runId}`;
  const caseId = deterministicUuid(`canonical-case:${runId}`);
  return Object.freeze({
    tenant_id: tenantId,
    case_id: caseId,
    internal_case_id: deterministicUuid(`case:${runId}`),
    fact_id: `fact:synthetic:${runId}`,
    legal_reviewer: identity(
      "legal",
      "legal_reviewer",
      "operations",
      `reviewer-org:synthetic:legal:${runId}`,
    ),
    report_approver: identity(
      "approver",
      "report_approver",
      "operations",
      `reviewer-org:synthetic:approval:${runId}`,
    ),
    owner: identity("owner", "customer_owner", "portal", null),
    cross_owner: identity("cross-owner", "customer_owner", "portal", null),
    worker: identity("worker", "scoped_background_worker", null, null),
  });
}

export function generateDurableBrowserKeyMaterial(runId: string): DurableBrowserKeyMaterial {
  if (!RUN_ID.test(runId)) throw new Error("DURABLE_BROWSER_RUN_ID_INVALID");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
  const exported = publicKey.export({ format: "pem", type: "spki" });
  if (typeof exported !== "string") throw new Error("DURABLE_BROWSER_PUBLIC_KEY_INVALID");
  return Object.freeze({
    key_id: `synthetic-key-${runId}`,
    private_key: privateKey,
    public_key_spki_pem: exported,
  });
}

export function durableBrowserJwtClaims(input: Readonly<{
  fixture: DurableBrowserIdentityFixture;
  tenant_id: string;
  case_id: string;
  issuer: string;
  issued_at_epoch: number;
  expires_at_epoch: number;
}>): DurableBrowserJwtClaims {
  const { fixture } = input;
  if (fixture.audience === null || !OPAQUE.test(input.tenant_id)
      || !OPAQUE.test(input.case_id) || !OPAQUE.test(fixture.actor_id)
      || !OPAQUE.test(fixture.session_id) || !OPAQUE.test(fixture.token_id)
      || !Number.isSafeInteger(input.issued_at_epoch)
      || !Number.isSafeInteger(input.expires_at_epoch)
      || input.expires_at_epoch <= input.issued_at_epoch
      || input.expires_at_epoch - input.issued_at_epoch > 3_600) {
    throw new Error("DURABLE_BROWSER_IDENTITY_FIXTURE_INVALID");
  }
  if (fixture.role === "legal_reviewer" || fixture.role === "report_approver") {
    if (!fixture.reviewer_organization_id || !OPAQUE.test(fixture.reviewer_organization_id)) {
      throw new Error("DURABLE_BROWSER_REVIEWER_ORGANIZATION_INVALID");
    }
  } else if (fixture.reviewer_organization_id !== null) {
    throw new Error("DURABLE_BROWSER_REVIEWER_ORGANIZATION_INVALID");
  }
  return Object.freeze({
    assigned_case_ids: Object.freeze([input.case_id]),
    aud: fixture.audience,
    break_glass_expires_at: null,
    break_glass_reason: null,
    exp: input.expires_at_epoch,
    iat: input.issued_at_epoch,
    iss: input.issuer,
    jti: fixture.token_id,
    nbf: input.issued_at_epoch - 1,
    reviewer_organization_id: fixture.reviewer_organization_id,
    role: fixture.role,
    rotation: 1,
    sid: fixture.session_id,
    sub: fixture.actor_id,
    tenant_id: input.tenant_id,
  });
}

export function signDurableBrowserJwt(
  claims: DurableBrowserJwtClaims,
  keyId: string,
  privateKey: KeyObject,
): string {
  const encodedHeader = base64url(JSON.stringify({ alg: "RS256", kid: keyId, typ: "JWT" }));
  const encodedClaims = base64url(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput, "ascii")
    .end()
    .sign({ key: privateKey, padding: constants.RSA_PKCS1_PADDING })
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

export function durableBrowserStorageState(input: Readonly<{
  compact_jwt: string;
  csrf_token: string;
  expires_at_epoch: number;
}>): BrowserStorageState {
  if (input.compact_jwt.split(".").length !== 3
      || !/^[A-Za-z0-9_-]{32,86}$/u.test(input.csrf_token)
      || !Number.isSafeInteger(input.expires_at_epoch)) {
    throw new Error("DURABLE_BROWSER_STORAGE_STATE_INVALID");
  }
  return Object.freeze({
    cookies: Object.freeze([
      Object.freeze({
        name: DURABLE_BROWSER_IDENTITY_COOKIE,
        value: input.compact_jwt,
        domain: "127.0.0.1" as const,
        path: "/" as const,
        expires: input.expires_at_epoch,
        httpOnly: true,
        secure: true as const,
        sameSite: "Strict" as const,
      }),
      Object.freeze({
        name: DURABLE_BROWSER_CSRF_COOKIE,
        value: input.csrf_token,
        domain: "127.0.0.1" as const,
        path: "/" as const,
        expires: input.expires_at_epoch,
        httpOnly: false,
        secure: true as const,
        sameSite: "Strict" as const,
      }),
    ]),
    origins: Object.freeze([]),
  });
}

export function durableBrowserRuntimeEnvironment(input: Readonly<{
  system_environment: Readonly<Record<string, string | undefined>>;
  build_identity_sha: string;
  allowed_origin: string;
  issuer: string;
  key_id: string;
  public_key_spki_pem: string;
  key_not_before_epoch: number;
  key_expires_at_epoch: number;
  identity_postgres_url: string;
  web_postgres_url: string;
  operations_postgres_url: string;
  worker_postgres_url: string;
  private_storage_root: string;
  download_grant_hmac_key_base64url: string;
  worker: DurableBrowserIdentityFixture;
  tenant_id: string;
}>): NodeJS.ProcessEnv {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(input.build_identity_sha)
      || input.worker.role !== "scoped_background_worker"
      || input.worker.audience !== null
      || !OPAQUE.test(input.tenant_id)) {
    throw new Error("DURABLE_BROWSER_RUNTIME_CONFIGURATION_INVALID");
  }
  const system: NodeJS.ProcessEnv = {};
  for (const key of ["SYSTEMROOT", "TEMP", "TMP", "WINDIR", "PATH"] as const) {
    const value = input.system_environment[key];
    if (value) system[key] = value;
  }
  return Object.freeze({
    ...system,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    TIVDOC_PRODUCT_BROWSER_RUNTIME_ENABLED: "0",
    TIVDOC_DURABLE_PRODUCT_RUNTIME_ENABLED: "1",
    TIVDOC_DURABLE_PRODUCT_RUNTIME_SENTINEL: DURABLE_BROWSER_RUNTIME_SENTINEL,
    TIVDOC_RUNTIME_TARGET: "local_only",
    TIVDOC_PRODUCT_PERSISTENCE_MODE: "isolated_postgres",
    TIVDOC_DURABLE_IDENTITY_ENABLED: "1",
    TIVDOC_PRIVATE_STORAGE_ENABLED: "1",
    TIVDOC_PORTAL_UI_ENABLED: "1",
    TIVDOC_PORTAL_API_ENABLED: "1",
    TIVDOC_OPERATIONS_UI_ENABLED: "1",
    TIVDOC_OPERATIONS_API_ENABLED: "1",
    TIVDOC_CUSTOMER_PROCESSING_ENABLED: "0",
    TIVDOC_CUSTOMER_SHADOW_AUTHORIZED: "0",
    TIVDOC_PRODUCTION_DELIVERY_ENABLED: "0",
    TIVDOC_OPENAI_LIVE_TESTS: "0",
    TIVDOC_RUNTIME_BUILD_IDENTITY_SHA: input.build_identity_sha,
    TIVDOC_LOCAL_PRODUCT_ALLOWED_ORIGIN: input.allowed_origin,
    TIVDOC_IDENTITY_ISSUER: input.issuer,
    TIVDOC_IDENTITY_KEY_ID: input.key_id,
    TIVDOC_IDENTITY_ALGORITHM: "RS256",
    TIVDOC_IDENTITY_PUBLIC_KEY_SPKI_PEM: input.public_key_spki_pem,
    TIVDOC_IDENTITY_KEY_NOT_BEFORE_EPOCH: String(input.key_not_before_epoch),
    TIVDOC_IDENTITY_KEY_EXPIRES_AT_EPOCH: String(input.key_expires_at_epoch),
    TIVDOC_IDENTITY_CLOCK_SKEW_SECONDS: "5",
    TIVDOC_IDENTITY_MAX_TOKEN_LIFETIME_SECONDS: "3600",
    TIVDOC_IDENTITY_POSTGRES_URL: input.identity_postgres_url,
    TIVDOC_WEB_POSTGRES_URL: input.web_postgres_url,
    TIVDOC_OPERATIONS_POSTGRES_URL: input.operations_postgres_url,
    TIVDOC_WORKER_POSTGRES_URL: input.worker_postgres_url,
    TIVDOC_PRIVATE_STORAGE_ROOT: input.private_storage_root,
    TIVDOC_DOWNLOAD_GRANT_HMAC_KEY_BASE64URL: input.download_grant_hmac_key_base64url,
    TIVDOC_WORKER_ACTOR_ID: input.worker.actor_id,
    TIVDOC_WORKER_TENANT_ID: input.tenant_id,
    TIVDOC_WORKER_SESSION_ID: input.worker.session_id,
    TIVDOC_WORKER_TOKEN_ID: input.worker.token_id,
    TIVDOC_WORKER_ROTATION_COUNTER: "1",
  });
}

export function durableBrowserCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export function durableBrowserHmacKey(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertSha256(value: unknown, code: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(code);
  return value;
}

function deterministicUuid(value: string): string {
  const hex = sha256(value).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
