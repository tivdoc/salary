import "./server-boundary.ts";

import {
  constants,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

import {
  V07_ROLES,
  type V07Role,
  type VerifiedActor,
} from "../../../engine/wave4/contracts.ts";

export const IDENTITY_JWT_ALGORITHMS = ["RS256", "EdDSA"] as const;
export type IdentityJwtAlgorithm = (typeof IDENTITY_JWT_ALGORITHMS)[number];

export const REVIEWER_ORGANIZATION_ROLES = [
  "extraction_reviewer",
  "fact_reviewer",
  "legal_reviewer",
  "parameter_verifier",
  "report_approver",
] as const satisfies readonly V07Role[];

export type IdentityVerificationKey = Readonly<{
  key_id: string;
  algorithm: IdentityJwtAlgorithm;
  public_key: KeyObject;
  status: "active" | "revoked";
  not_before_epoch: number;
  expires_at_epoch: number;
}>;

/** Resolves only locally configured/provider-synchronized verification keys. */
export interface IdentityVerificationKeyResolver {
  resolve(input: Readonly<{
    issuer: string;
    key_id: string;
    algorithm: IdentityJwtAlgorithm;
  }>): Promise<IdentityVerificationKey | null>;
}

export type IdentitySessionState = Readonly<{
  tenant_id: string;
  session_id: string;
  subject: string;
  status: "active" | "revoked";
  current_token_id: string;
  rotation_counter: number;
  valid_after_epoch: number;
  expires_at_epoch: number;
  reviewer_organization_id: string | null;
}>;

/**
 * Must read the authoritative session record on every verification. Implementations
 * are expected to use durable storage; an absent record is always a denial.
 */
export interface IdentitySessionStateReader {
  read(sessionId: string): Promise<IdentitySessionState | null>;
}

export type IdentityVerificationInput = Readonly<{
  compact_jwt: string;
  expected_audience: string;
}>;

export type VerifiedIdentity = Readonly<{
  actor: VerifiedActor;
  issuer: string;
  audience: string;
  session_id: string;
  token_id: string;
  rotation_counter: number;
  reviewer_organization_id: string | null;
  issued_at_epoch: number;
  expires_at_epoch: number;
}>;

/** The single canonical server identity-verification port. */
export interface IdentityVerificationPort {
  verify(input: IdentityVerificationInput): Promise<VerifiedIdentity | null>;
}

export type JwtIdentityVerificationConfig = Readonly<{
  issuer: string;
  audiences: readonly string[];
  algorithms: readonly IdentityJwtAlgorithm[];
  clock_skew_seconds: number;
  max_token_lifetime_seconds: number;
}>;

type JwtHeader = Readonly<{
  alg: IdentityJwtAlgorithm;
  kid: string;
  typ: "JWT";
}>;

type JwtClaims = Readonly<{
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  sid: string;
  rotation: number;
  role: V07Role;
  tenant_id: string | null;
  assigned_case_ids: readonly string[];
  reviewer_organization_id: string | null;
  break_glass_reason: string | null;
  break_glass_expires_at: number | null;
}>;

const HEADER_KEYS = ["alg", "kid", "typ"] as const;
const CLAIM_KEYS = [
  "assigned_case_ids",
  "aud",
  "break_glass_expires_at",
  "break_glass_reason",
  "exp",
  "iat",
  "iss",
  "jti",
  "nbf",
  "reviewer_organization_id",
  "role",
  "rotation",
  "sid",
  "sub",
  "tenant_id",
] as const;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const MAX_COMPACT_JWT_BYTES = 8_192;
const MAX_HEADER_BYTES = 512;
const MAX_CLAIMS_BYTES = 6_144;
const MAX_SIGNATURE_BYTES = 1_024;
const MAX_ASSIGNMENTS = 1_000;
const MAX_BREAK_GLASS_SECONDS = 15 * 60;

/**
 * Public-key JWT adapter for the canonical port. It deliberately accepts a token,
 * not a Request: HTTP credential extraction belongs to the cookie-only product
 * boundary, so headers and query parameters can never become alternate identities.
 */
export class CryptographicJwtIdentityVerifier implements IdentityVerificationPort {
  readonly #config: JwtIdentityVerificationConfig;
  readonly #audiences: ReadonlySet<string>;
  readonly #algorithms: ReadonlySet<IdentityJwtAlgorithm>;
  readonly #keys: IdentityVerificationKeyResolver;
  readonly #sessions: IdentitySessionStateReader;
  readonly #now: () => number;

  constructor(input: Readonly<{
    config: JwtIdentityVerificationConfig;
    keys: IdentityVerificationKeyResolver;
    sessions: IdentitySessionStateReader;
    now_epoch_seconds?: () => number;
  }>) {
    assertConfiguration(input.config);
    this.#config = Object.freeze({
      ...input.config,
      audiences: Object.freeze([...input.config.audiences]),
      algorithms: Object.freeze([...input.config.algorithms]),
    });
    this.#audiences = new Set(this.#config.audiences);
    this.#algorithms = new Set(this.#config.algorithms);
    this.#keys = input.keys;
    this.#sessions = input.sessions;
    this.#now = input.now_epoch_seconds ?? (() => Math.floor(Date.now() / 1_000));
  }

  async verify(input: IdentityVerificationInput): Promise<VerifiedIdentity | null> {
    if (!this.#audiences.has(input.expected_audience)) return null;
    if (typeof input.compact_jwt !== "string" || Buffer.byteLength(input.compact_jwt, "utf8") > MAX_COMPACT_JWT_BYTES) return null;

    const pieces = input.compact_jwt.split(".");
    if (pieces.length !== 3) return null;
    const [encodedHeader, encodedClaims, encodedSignature] = pieces;
    const headerRecord = parseExactObject(encodedHeader, HEADER_KEYS, MAX_HEADER_BYTES);
    const claimsRecord = parseExactObject(encodedClaims, CLAIM_KEYS, MAX_CLAIMS_BYTES);
    const signature = decodeBase64Url(encodedSignature, MAX_SIGNATURE_BYTES);
    if (!headerRecord || !claimsRecord || !signature) return null;

    const header = parseHeader(headerRecord);
    if (!header || !this.#algorithms.has(header.alg)) return null;

    let key: IdentityVerificationKey | null;
    try {
      key = await this.#keys.resolve({
        issuer: this.#config.issuer,
        key_id: header.kid,
        algorithm: header.alg,
      });
    } catch {
      return null;
    }
    if (!validVerificationKey(key, header)) return null;
    const signingInput = Buffer.from(`${encodedHeader}.${encodedClaims}`, "ascii");
    if (!verifyJwtSignature(header.alg, signingInput, signature, key.public_key)) return null;

    const claims = parseClaims(claimsRecord);
    const now = this.#now();
    if (!claims || !Number.isSafeInteger(now)) return null;
    if (!validTemporalClaims(claims, this.#config, input.expected_audience, now)) return null;
    if (claims.iat < key.not_before_epoch || claims.exp > key.expires_at_epoch) return null;

    let session: IdentitySessionState | null;
    try {
      session = await this.#sessions.read(claims.sid);
    } catch {
      return null;
    }
    if (!sessionMatchesClaims(session, claims, now)) return null;

    const actor = actorFromClaims(claims, now);
    if (!actor) return null;
    return Object.freeze({
      actor,
      issuer: claims.iss,
      audience: claims.aud,
      session_id: claims.sid,
      token_id: claims.jti,
      rotation_counter: claims.rotation,
      reviewer_organization_id: claims.reviewer_organization_id,
      issued_at_epoch: claims.iat,
      expires_at_epoch: claims.exp,
    });
  }
}

function assertConfiguration(config: JwtIdentityVerificationConfig): void {
  if (typeof config.issuer !== "string" || config.issuer.length < 3 || config.issuer.length > 512) throw new Error("IDENTITY_CONFIG_ISSUER_INVALID");
  if (config.audiences.length < 1 || config.audiences.length > 16 || new Set(config.audiences).size !== config.audiences.length || config.audiences.some((value) => typeof value !== "string" || value.length < 3 || value.length > 256)) {
    throw new Error("IDENTITY_CONFIG_AUDIENCES_INVALID");
  }
  if (config.algorithms.length < 1 || config.algorithms.length > IDENTITY_JWT_ALGORITHMS.length || new Set(config.algorithms).size !== config.algorithms.length || config.algorithms.some((value) => !(IDENTITY_JWT_ALGORITHMS as readonly string[]).includes(value))) {
    throw new Error("IDENTITY_CONFIG_ALGORITHMS_INVALID");
  }
  if (!Number.isSafeInteger(config.clock_skew_seconds) || config.clock_skew_seconds < 0 || config.clock_skew_seconds > 60) throw new Error("IDENTITY_CONFIG_CLOCK_SKEW_INVALID");
  if (!Number.isSafeInteger(config.max_token_lifetime_seconds) || config.max_token_lifetime_seconds < 1 || config.max_token_lifetime_seconds > 24 * 60 * 60) throw new Error("IDENTITY_CONFIG_TOKEN_LIFETIME_INVALID");
}

function parseHeader(record: Readonly<Record<string, unknown>>): JwtHeader | null {
  if (record.typ !== "JWT") return null;
  if (record.alg !== "RS256" && record.alg !== "EdDSA") return null;
  if (typeof record.kid !== "string" || !KEY_ID.test(record.kid)) return null;
  return Object.freeze({ alg: record.alg, kid: record.kid, typ: "JWT" });
}

function parseClaims(record: Readonly<Record<string, unknown>>): JwtClaims | null {
  if (typeof record.iss !== "string" || typeof record.aud !== "string") return null;
  if (typeof record.sub !== "string" || !OPAQUE_ID.test(record.sub)) return null;
  if (typeof record.jti !== "string" || !OPAQUE_ID.test(record.jti)) return null;
  if (typeof record.sid !== "string" || !OPAQUE_ID.test(record.sid)) return null;
  if (!Number.isSafeInteger(record.iat) || !Number.isSafeInteger(record.nbf) || !Number.isSafeInteger(record.exp) || !Number.isSafeInteger(record.rotation) || (record.rotation as number) < 0) return null;
  if (typeof record.role !== "string" || !(V07_ROLES as readonly string[]).includes(record.role) || record.role === "anonymous") return null;
  if (record.tenant_id !== null && (typeof record.tenant_id !== "string" || !OPAQUE_ID.test(record.tenant_id))) return null;
  if (!Array.isArray(record.assigned_case_ids) || record.assigned_case_ids.length > MAX_ASSIGNMENTS || record.assigned_case_ids.some((value) => typeof value !== "string" || !OPAQUE_ID.test(value)) || new Set(record.assigned_case_ids).size !== record.assigned_case_ids.length) return null;
  if (record.reviewer_organization_id !== null && (typeof record.reviewer_organization_id !== "string" || !OPAQUE_ID.test(record.reviewer_organization_id))) return null;
  if (record.break_glass_reason !== null && typeof record.break_glass_reason !== "string") return null;
  if (record.break_glass_expires_at !== null && !Number.isSafeInteger(record.break_glass_expires_at)) return null;
  return Object.freeze({
    iss: record.iss,
    aud: record.aud,
    sub: record.sub,
    iat: record.iat as number,
    nbf: record.nbf as number,
    exp: record.exp as number,
    jti: record.jti,
    sid: record.sid,
    rotation: record.rotation as number,
    role: record.role as V07Role,
    tenant_id: record.tenant_id as string | null,
    assigned_case_ids: Object.freeze([...(record.assigned_case_ids as string[])]),
    reviewer_organization_id: record.reviewer_organization_id as string | null,
    break_glass_reason: record.break_glass_reason as string | null,
    break_glass_expires_at: record.break_glass_expires_at as number | null,
  });
}

function validTemporalClaims(claims: JwtClaims, config: JwtIdentityVerificationConfig, expectedAudience: string, now: number): boolean {
  const skew = config.clock_skew_seconds;
  return claims.iss === config.issuer
    && claims.aud === expectedAudience
    && claims.iat <= now + skew
    && claims.nbf <= now + skew
    && claims.exp > now - skew
    && claims.exp > claims.iat
    && claims.exp > claims.nbf
    && claims.exp - claims.iat <= config.max_token_lifetime_seconds;
}

function validVerificationKey(key: IdentityVerificationKey | null, header: JwtHeader): key is IdentityVerificationKey {
  if (!key || key.status !== "active" || key.key_id !== header.kid || key.algorithm !== header.alg) return false;
  if (!Number.isSafeInteger(key.not_before_epoch) || !Number.isSafeInteger(key.expires_at_epoch) || key.expires_at_epoch <= key.not_before_epoch) return false;
  if (key.public_key.type !== "public") return false;
  return header.alg === "RS256"
    ? key.public_key.asymmetricKeyType === "rsa"
    : key.public_key.asymmetricKeyType === "ed25519";
}

function verifyJwtSignature(algorithm: IdentityJwtAlgorithm, signingInput: Buffer, signature: Buffer, publicKey: KeyObject): boolean {
  try {
    return algorithm === "RS256"
      ? verifySignature("RSA-SHA256", signingInput, { key: publicKey, padding: constants.RSA_PKCS1_PADDING }, signature)
      : verifySignature(null, signingInput, publicKey, signature);
  } catch {
    return false;
  }
}

function sessionMatchesClaims(session: IdentitySessionState | null, claims: JwtClaims, now: number): session is IdentitySessionState {
  if (!session || session.status !== "active") return false;
  if (!OPAQUE_ID.test(session.tenant_id) || !OPAQUE_ID.test(session.session_id)
      || !OPAQUE_ID.test(session.subject) || !OPAQUE_ID.test(session.current_token_id)) return false;
  if (!Number.isSafeInteger(session.rotation_counter) || session.rotation_counter < 0 || !Number.isSafeInteger(session.valid_after_epoch) || !Number.isSafeInteger(session.expires_at_epoch)) return false;
  if (session.reviewer_organization_id !== null && !OPAQUE_ID.test(session.reviewer_organization_id)) return false;
  return session.tenant_id === claims.tenant_id
    && session.session_id === claims.sid
    && session.subject === claims.sub
    && session.current_token_id === claims.jti
    && session.rotation_counter === claims.rotation
    && session.reviewer_organization_id === claims.reviewer_organization_id
    && claims.iat >= session.valid_after_epoch
    && claims.exp <= session.expires_at_epoch
    && session.expires_at_epoch > now;
}

function actorFromClaims(claims: JwtClaims, now: number): VerifiedActor | null {
  const reviewerRole = (REVIEWER_ORGANIZATION_ROLES as readonly V07Role[]).includes(claims.role);
  if (reviewerRole) {
    if (claims.reviewer_organization_id === null || claims.tenant_id === null) return null;
  } else if (claims.reviewer_organization_id !== null) {
    return null;
  }

  let breakGlassExpiry: string | null = null;
  if (claims.role === "break_glass_admin") {
    if (!claims.break_glass_reason || !/^[A-Z][A-Z0-9_]{7,63}$/.test(claims.break_glass_reason) || claims.break_glass_expires_at === null) return null;
    if (claims.break_glass_expires_at <= now || claims.break_glass_expires_at > now + MAX_BREAK_GLASS_SECONDS || claims.break_glass_expires_at > claims.exp) return null;
    breakGlassExpiry = new Date(claims.break_glass_expires_at * 1_000).toISOString();
  } else if (claims.break_glass_reason !== null || claims.break_glass_expires_at !== null) {
    return null;
  }

  return Object.freeze({
    actor_id: claims.sub,
    role: claims.role,
    tenant_id: claims.tenant_id,
    assigned_case_ids: Object.freeze([...claims.assigned_case_ids]),
    verified_server_side: true,
    break_glass_reason: claims.break_glass_reason,
    break_glass_expires_at: breakGlassExpiry,
  });
}

function parseExactObject(segment: string, expectedKeys: readonly string[], maxBytes: number): Readonly<Record<string, unknown>> | null {
  const decoded = decodeBase64Url(segment, maxBytes);
  if (!decoded) return null;
  const text = decoded.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(decoded)) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const scannedKeys = topLevelPropertyNames(text);
  if (!scannedKeys || new Set(scannedKeys).size !== scannedKeys.length) return null;
  const actualKeys = Object.keys(value as Record<string, unknown>).sort();
  const requiredKeys = [...expectedKeys].sort();
  if (actualKeys.length !== requiredKeys.length || actualKeys.some((key, index) => key !== requiredKeys[index])) return null;
  return value as Readonly<Record<string, unknown>>;
}

function decodeBase64Url(value: string, maxBytes: number): Buffer | null {
  if (value.length < 1 || value.length > Math.ceil(maxBytes * 4 / 3) + 2 || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    return null;
  }
  return decoded.byteLength <= maxBytes && decoded.toString("base64url") === value ? decoded : null;
}

/** Extracts top-level JSON keys so JSON.parse cannot hide duplicate claims. */
function topLevelPropertyNames(text: string): readonly string[] | null {
  let index = skipWhitespace(text, 0);
  if (text[index] !== "{") return null;
  index = skipWhitespace(text, index + 1);
  if (text[index] === "}") return skipWhitespace(text, index + 1) === text.length ? [] : null;
  const keys: string[] = [];
  while (index < text.length) {
    if (text[index] !== '"') return null;
    const keyEnd = stringEnd(text, index);
    if (keyEnd === null) return null;
    let key: unknown;
    try {
      key = JSON.parse(text.slice(index, keyEnd));
    } catch {
      return null;
    }
    if (typeof key !== "string") return null;
    keys.push(key);
    index = skipWhitespace(text, keyEnd);
    if (text[index] !== ":") return null;
    index = skipWhitespace(text, index + 1);
    const valueEnd = topLevelValueEnd(text, index);
    if (valueEnd === null || valueEnd === index) return null;
    index = skipWhitespace(text, valueEnd);
    if (text[index] === ",") {
      index = skipWhitespace(text, index + 1);
      continue;
    }
    if (text[index] !== "}") return null;
    return skipWhitespace(text, index + 1) === text.length ? keys : null;
  }
  return null;
}

function topLevelValueEnd(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth < 0) return null;
    } else if (character === "}") {
      if (depth === 0) return index;
      depth -= 1;
    } else if (character === "," && depth === 0) return index;
  }
  return null;
}

function stringEnd(text: string, start: number): number | null {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === '"') return index + 1;
  }
  return null;
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return index;
}
