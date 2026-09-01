import { createHash } from "node:crypto";

import { canonicalSha256 } from "../../../engine/rule-runtime/canonical.ts";
import type { IdentitySessionState, IdentitySessionStateReader } from "../../platform/auth/identity-verification.ts";
import type { PostgresClient, PostgresQueryResult } from "../../platform/persistence/postgres/contracts.ts";
import type { PostgresConnectionFactory } from "../../platform/persistence/postgres/runtime/transaction-manager.ts";
import type { PrivateBlobProvider } from "../../platform/storage/private-storage-provider.ts";
import {
  CANONICAL_REPORT_IDENTITY_SCHEMA_VERSION,
  CanonicalReportIdentityError,
  assertCanonicalReportIdentity,
  assertCanonicalReportIdentityMatches,
  canonicalReportDependencySha256,
  canonicalReportModelSha256,
  canonicalReportStorageObjectId,
  canonicalReportStorageObjectVersionId,
  createCanonicalReportIdentity,
  type CanonicalReportIdentity,
} from "./report-identity.ts";
import {
  PRIVACY_REQUEST_KINDS,
  PRIVACY_REQUEST_STATES,
  type ApprovedPrivateReportObject,
  type CaseOwnerRecord,
  type IdentitySessionRecord,
  type IdentitySessionRegistration,
  type PrivateReportObjectRecord,
  type PrivacyRequestKind,
  type PrivacyRequestState,
  type PrivacyRequestVersion,
} from "./boundary-contracts.ts";
import { durableBoundaryStatements } from "./boundary-sql.ts";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ACTIVE_LOCATOR = /^objects\/[a-f0-9]{2}\/object_[a-f0-9]{48}$/u;

export type DurableBoundaryErrorCode =
  | "DURABLE_BOUNDARY_INPUT_INVALID"
  | "DURABLE_BOUNDARY_DATABASE_REJECTED"
  | "DURABLE_BOUNDARY_ROW_MALFORMED"
  | "DURABLE_BOUNDARY_EXACT_BINDING_MISMATCH"
  | "DURABLE_BOUNDARY_OPERATION_REJECTED"
  | "DURABLE_BOUNDARY_OWNER_DENIED"
  | "DURABLE_BOUNDARY_REPORT_DENIED"
  | "DURABLE_BOUNDARY_REPORT_INTEGRITY_FAILURE";

export class DurableBoundaryError extends Error {
  readonly code: DurableBoundaryErrorCode;

  constructor(code: DurableBoundaryErrorCode) {
    super(code);
    this.name = "DurableBoundaryError";
    this.code = code;
  }
}

export class PostgresIdentitySessionRepository {
  readonly #client: PostgresClient;

  constructor(client: PostgresClient) {
    this.#client = client;
  }

  async register(input: IdentitySessionRegistration): Promise<IdentitySessionRecord> {
    assertIdentityRegistration(input);
    const result = await safeQuery(this.#client, durableBoundaryStatements.identityRegister([
      input.tenant_id,
      input.session_id,
      input.subject,
      input.current_token_id,
      input.rotation_counter,
      input.valid_after,
      input.expires_at,
      input.reviewer_organization_id,
      input.created_at,
    ]));
    const record = identityRecord(exactlyOne(result));
    if (record.tenant_id !== input.tenant_id || record.session_id !== input.session_id
      || record.subject !== input.subject || record.current_token_id !== input.current_token_id
      || record.rotation_counter !== input.rotation_counter
      || record.valid_after_epoch !== epoch(input.valid_after)
      || record.expires_at_epoch !== epoch(input.expires_at)
      || record.reviewer_organization_id !== input.reviewer_organization_id
      || record.created_at !== input.created_at || record.status !== "active") {
      mismatch();
    }
    return record;
  }

  async read(sessionId: string): Promise<IdentitySessionState | null> {
    assertOpaque(sessionId);
    const result = await safeQuery(this.#client, durableBoundaryStatements.identityRead(sessionId));
    return optionalOne(result, identitySessionState);
  }

  async rotate(input: Readonly<{
    tenant_id: string;
    session_id: string;
    next_token_id: string;
    expected_rotation_counter: number;
    rotated_at: string;
  }>): Promise<void> {
    assertOpaque(input.tenant_id);
    assertOpaque(input.session_id);
    assertOpaque(input.next_token_id);
    assertCounter(input.expected_rotation_counter);
    assertTimestamp(input.rotated_at);
    await requireAccepted(this.#client, durableBoundaryStatements.identityRotate([
      input.tenant_id,
      input.session_id,
      input.next_token_id,
      input.expected_rotation_counter,
      input.rotated_at,
    ]));
  }

  async revoke(input: Readonly<{ tenant_id: string; session_id: string; revoked_at: string }>): Promise<void> {
    assertOpaque(input.tenant_id);
    assertOpaque(input.session_id);
    assertTimestamp(input.revoked_at);
    await requireAccepted(this.#client, durableBoundaryStatements.identityRevoke([
      input.tenant_id,
      input.session_id,
      input.revoked_at,
    ]));
  }
}

/** Acquires a fresh durable connection for every JWT verification; there is no cache or memory fallback. */
export class PostgresIdentitySessionStateReader implements IdentitySessionStateReader {
  readonly #factory: PostgresConnectionFactory;

  constructor(factory: PostgresConnectionFactory) {
    this.#factory = factory;
  }

  async read(sessionId: string): Promise<IdentitySessionState | null> {
    assertOpaque(sessionId);
    let client;
    try {
      client = await this.#factory.acquire();
      return await new PostgresIdentitySessionRepository(client).read(sessionId);
    } catch (error) {
      if (error instanceof DurableBoundaryError) throw error;
      throw new DurableBoundaryError("DURABLE_BOUNDARY_DATABASE_REJECTED");
    } finally {
      if (client) {
        try {
          await client.release();
        } catch {
          throw new DurableBoundaryError("DURABLE_BOUNDARY_DATABASE_REJECTED");
        }
      }
    }
  }
}

export class PostgresCaseOwnerRepository {
  readonly #client: PostgresClient;

  constructor(client: PostgresClient) {
    this.#client = client;
  }

  async bind(input: Readonly<{ tenant_id: string; case_id: string; subject: string; created_at: string }>): Promise<CaseOwnerRecord> {
    assertOpaque(input.tenant_id);
    assertOpaque(input.case_id);
    assertOpaque(input.subject);
    assertTimestamp(input.created_at);
    const bindingSha256 = canonicalSha256({
      tenant_id: input.tenant_id,
      canonical_case_id: input.case_id,
      subject: input.subject,
      revision: 1,
      status: "active",
      created_at: input.created_at,
    });
    const result = await safeQuery(this.#client, durableBoundaryStatements.ownerBind([
      input.tenant_id, input.case_id, input.subject, bindingSha256, input.created_at,
    ]));
    const record = caseOwnerRecord(exactlyOne(result));
    if (record.tenant_id !== input.tenant_id || record.case_id !== input.case_id
      || record.subject !== input.subject || record.revision !== 1 || record.status !== "active"
      || record.binding_sha256 !== bindingSha256 || record.created_at !== input.created_at
      || record.revoked_at !== null) mismatch();
    return record;
  }

  async lookup(input: Readonly<{ tenant_id: string; case_id: string; subject: string }>): Promise<CaseOwnerRecord | null> {
    assertOpaque(input.tenant_id);
    assertOpaque(input.case_id);
    assertOpaque(input.subject);
    const result = await safeQuery(this.#client, durableBoundaryStatements.ownerLookup([
      input.tenant_id, input.case_id, input.subject,
    ]));
    const record = optionalOne(result, caseOwnerRecord);
    if (record && (record.tenant_id !== input.tenant_id || record.case_id !== input.case_id
      || record.subject !== input.subject || record.status !== "active" || record.revoked_at !== null)) mismatch();
    return record;
  }

  async requireActive(input: Readonly<{ tenant_id: string; case_id: string; subject: string }>): Promise<CaseOwnerRecord> {
    const record = await this.lookup(input);
    if (!record) throw new DurableBoundaryError("DURABLE_BOUNDARY_OWNER_DENIED");
    return record;
  }

  async revoke(input: Readonly<{ tenant_id: string; case_id: string; subject: string; revoked_at: string }>): Promise<void> {
    assertOpaque(input.tenant_id);
    assertOpaque(input.case_id);
    assertOpaque(input.subject);
    assertTimestamp(input.revoked_at);
    await requireAccepted(this.#client, durableBoundaryStatements.ownerRevoke([
      input.tenant_id, input.case_id, input.subject, input.revoked_at,
    ]));
  }
}

export class PostgresPrivacyRequestRepository {
  readonly #client: PostgresClient;

  constructor(client: PostgresClient) {
    this.#client = client;
  }

  async append(input: Readonly<{
    request_id: string;
    tenant_id: string;
    case_id: string;
    revision: number;
    request_kind: PrivacyRequestKind;
    state: PrivacyRequestState;
    idempotency_key: string;
    legal_hold_conflict: boolean;
    grant_revocation_receipt_sha256: string | null;
    created_at: string;
  }>): Promise<PrivacyRequestVersion> {
    assertOpaque(input.request_id);
    assertOpaque(input.tenant_id);
    assertOpaque(input.case_id);
    assertPositiveRevision(input.revision);
    if (!PRIVACY_REQUEST_KINDS.includes(input.request_kind) || !PRIVACY_REQUEST_STATES.includes(input.state)) invalid();
    if (input.idempotency_key.length < 3 || input.idempotency_key.length > 256 || /[\u0000-\u001f\u007f]/u.test(input.idempotency_key)) invalid();
    if (input.legal_hold_conflict !== (input.state === "restricted_by_legal_hold")) invalid();
    assertNullableHash(input.grant_revocation_receipt_sha256);
    assertTimestamp(input.created_at);
    const commandSha256 = canonicalSha256({
      request_id: input.request_id,
      tenant_id: input.tenant_id,
      canonical_case_id: input.case_id,
      revision: input.revision,
      request_kind: input.request_kind,
      state: input.state,
      idempotency_key: input.idempotency_key,
      legal_hold_conflict: input.legal_hold_conflict,
      grant_revocation_receipt_sha256: input.grant_revocation_receipt_sha256,
    });
    const result = await safeQuery(this.#client, durableBoundaryStatements.privacyAppend([
      input.request_id, input.tenant_id, input.case_id, input.revision,
      input.request_kind, input.state, input.idempotency_key, commandSha256,
      input.legal_hold_conflict, input.grant_revocation_receipt_sha256, input.created_at,
    ]));
    const record = privacyRequestVersion(exactlyOne(result));
    if (record.request_id !== input.request_id || record.tenant_id !== input.tenant_id
      || record.case_id !== input.case_id || record.revision !== input.revision
      || record.request_kind !== input.request_kind || record.state !== input.state
      || record.idempotency_key !== input.idempotency_key || record.command_sha256 !== commandSha256
      || record.legal_hold_conflict !== input.legal_hold_conflict
      || record.grant_revocation_receipt_sha256 !== input.grant_revocation_receipt_sha256
      || record.created_at !== input.created_at) mismatch();
    return record;
  }
}

export class PostgresPrivateReportObjectRepository {
  readonly #client: PostgresClient;

  constructor(client: PostgresClient) {
    this.#client = client;
  }

  async currentCanonicalIdentity(input: Readonly<{
    tenant_id: string;
    case_id: string;
    report_id: string;
    report_revision: number;
    download_grant_revision: number;
  }>): Promise<CanonicalReportIdentity | null> {
    assertOpaque(input.tenant_id);
    assertOpaque(input.case_id);
    assertOpaque(input.report_id);
    assertPositiveRevision(input.report_revision);
    assertCounter(input.download_grant_revision);
    const result = await safeQuery(this.#client, durableBoundaryStatements.reportIdentity([
      input.tenant_id,
      input.case_id,
      input.report_id,
      input.report_revision,
    ]));
    if (result.row_count === 0 && result.rows.length === 0) return null;
    return canonicalReportIdentity(exactlyOne(result), input.download_grant_revision);
  }

  async bind(input: Readonly<{
    tenant_id: string;
    case_id: string;
    report_id: string;
    report_revision: number;
    report_sha256: string;
    object_version_id: string;
    provider_locator: string;
    byte_length: number;
    artifact_sha256: string;
    created_at: string;
    canonical_identity: CanonicalReportIdentity;
  }>): Promise<PrivateReportObjectRecord> {
    assertReportBinding(input);
    await this.#requireCanonicalIdentity(input.canonical_identity);
    const result = await safeQuery(this.#client, durableBoundaryStatements.reportBind([
      input.tenant_id, input.case_id, input.report_id, input.report_revision, input.report_sha256,
      input.object_version_id, input.provider_locator, input.byte_length, input.artifact_sha256, input.created_at,
    ]));
    const record = privateReportObject(exactlyOne(result));
    if (record.tenant_id !== input.tenant_id || record.case_id !== input.case_id
      || record.report_id !== input.report_id || record.report_revision !== input.report_revision
      || record.report_sha256 !== input.report_sha256 || record.object_version_id !== input.object_version_id
      || record.provider_locator !== input.provider_locator || record.byte_length !== input.byte_length
      || record.artifact_sha256 !== input.artifact_sha256 || record.created_at !== input.created_at
      || record.state !== "staged" || record.grant_epoch !== 0 || record.revoked_at !== null) mismatch();
    return record;
  }

  async approve(input: Readonly<{
    tenant_id: string;
    case_id: string;
    object_version_id: string;
    expected_grant_epoch: number;
    canonical_identity: CanonicalReportIdentity;
  }>): Promise<void> {
    assertOpaque(input.tenant_id);
    assertOpaque(input.case_id);
    assertOpaque(input.object_version_id);
    assertCounter(input.expected_grant_epoch);
    assertCanonicalReportIdentity(input.canonical_identity);
    if (input.canonical_identity.tenant_id !== input.tenant_id
      || input.canonical_identity.case_id !== input.case_id
      || input.canonical_identity.storage_object_version_id !== input.object_version_id) {
      throw new CanonicalReportIdentityError("CANONICAL_REPORT_STORAGE_MISMATCH");
    }
    if (input.canonical_identity.download_grant_revision !== input.expected_grant_epoch) {
      throw new CanonicalReportIdentityError("CANONICAL_REPORT_GRANT_MISMATCH");
    }
    await this.#requireCanonicalIdentity(input.canonical_identity);
    await requireAccepted(this.#client, durableBoundaryStatements.reportApprove([
      input.tenant_id, input.case_id, input.object_version_id, input.expected_grant_epoch,
    ]));
  }

  async approvedRead(input: Readonly<{
    tenant_id: string;
    case_id: string;
    report_id: string;
    report_revision: number;
    report_sha256: string;
    artifact_sha256: string;
    canonical_identity: CanonicalReportIdentity;
  }>): Promise<ApprovedPrivateReportObject | null> {
    assertOpaque(input.tenant_id);
    assertOpaque(input.case_id);
    assertOpaque(input.report_id);
    assertPositiveRevision(input.report_revision);
    assertHash(input.report_sha256);
    assertHash(input.artifact_sha256);
    assertReportReadIdentity(input);
    try {
      await this.#requireCanonicalIdentity(input.canonical_identity);
    } catch (error) {
      if (error instanceof CanonicalReportIdentityError
        && error.code === "CANONICAL_REPORT_IDENTITY_STALE") return null;
      throw error;
    }
    const result = await safeQuery(this.#client, durableBoundaryStatements.reportApprovedRead([
      input.tenant_id, input.case_id, input.report_id, input.report_revision,
      input.report_sha256, input.artifact_sha256,
    ]));
    const object = optionalOne(result, approvedPrivateReportObject);
    if (object && (object.artifact_sha256 !== input.artifact_sha256
      || object.object_version_id !== input.canonical_identity.storage_object_version_id
      || object.provider_locator !== `objects/${input.artifact_sha256.slice(0, 2)}/${object.object_version_id}`)) mismatch();
    if (object && object.grant_epoch !== input.canonical_identity.download_grant_revision) {
      throw new CanonicalReportIdentityError("CANONICAL_REPORT_GRANT_MISMATCH");
    }
    return object;
  }

  async revoke(input: Readonly<{
    tenant_id: string;
    case_id: string;
    object_version_id: string;
    expected_grant_epoch: number;
    revocation_receipt_sha256: string;
    revoked_at: string;
    canonical_identity: CanonicalReportIdentity;
  }>): Promise<void> {
    assertOpaque(input.tenant_id);
    assertOpaque(input.case_id);
    assertOpaque(input.object_version_id);
    assertCounter(input.expected_grant_epoch);
    assertHash(input.revocation_receipt_sha256);
    assertTimestamp(input.revoked_at);
    assertCanonicalReportIdentity(input.canonical_identity);
    if (input.canonical_identity.tenant_id !== input.tenant_id
      || input.canonical_identity.case_id !== input.case_id
      || input.canonical_identity.storage_object_version_id !== input.object_version_id) {
      throw new CanonicalReportIdentityError("CANONICAL_REPORT_STORAGE_MISMATCH");
    }
    if (input.canonical_identity.download_grant_revision !== input.expected_grant_epoch) {
      throw new CanonicalReportIdentityError("CANONICAL_REPORT_GRANT_MISMATCH");
    }
    await this.#requireCanonicalIdentity(input.canonical_identity);
    await requireAccepted(this.#client, durableBoundaryStatements.reportRevoke([
      input.tenant_id, input.case_id, input.object_version_id, input.expected_grant_epoch,
      input.revocation_receipt_sha256, input.revoked_at,
    ]));
  }

  async #requireCanonicalIdentity(expected: CanonicalReportIdentity): Promise<void> {
    assertCanonicalReportIdentity(expected);
    const actual = await this.currentCanonicalIdentity({
      tenant_id: expected.tenant_id,
      case_id: expected.case_id,
      report_id: expected.report_id,
      report_revision: expected.report_revision,
      download_grant_revision: expected.download_grant_revision,
    });
    if (!actual) {
      throw new CanonicalReportIdentityError("CANONICAL_REPORT_IDENTITY_STALE");
    }
    assertCanonicalReportIdentityMatches(expected, actual);
  }
}

export class DurableApprovedReportObjectReader {
  readonly #repository: PostgresPrivateReportObjectRepository;
  readonly #provider: PrivateBlobProvider;

  constructor(repository: PostgresPrivateReportObjectRepository, provider: PrivateBlobProvider) {
    this.#repository = repository;
    this.#provider = provider;
  }

  async download(input: Parameters<PostgresPrivateReportObjectRepository["approvedRead"]>[0]): Promise<Readonly<{
    object: ApprovedPrivateReportObject;
    bytes: Uint8Array;
  }>> {
    const object = await this.#repository.approvedRead(input);
    if (!object) throw new DurableBoundaryError("DURABLE_BOUNDARY_REPORT_DENIED");
    let bytes: Uint8Array;
    try {
      bytes = await this.#provider.readExact({
        locator: object.provider_locator,
        expected_sha256: object.artifact_sha256,
        expected_length: object.byte_length,
      });
    } catch {
      throw new DurableBoundaryError("DURABLE_BOUNDARY_REPORT_INTEGRITY_FAILURE");
    }
    if (bytes.byteLength !== object.byte_length || sha256(bytes) !== object.artifact_sha256) {
      throw new DurableBoundaryError("DURABLE_BOUNDARY_REPORT_INTEGRITY_FAILURE");
    }
    return Object.freeze({ object, bytes: Uint8Array.from(bytes) });
  }
}

async function safeQuery(client: PostgresClient, query: Parameters<PostgresClient["query"]>[0]): Promise<PostgresQueryResult> {
  try {
    return await client.query(query);
  } catch (error) {
    if (error instanceof DurableBoundaryError) throw error;
    throw new DurableBoundaryError("DURABLE_BOUNDARY_DATABASE_REJECTED");
  }
}

async function requireAccepted(client: PostgresClient, query: Parameters<PostgresClient["query"]>[0]): Promise<void> {
  const row = exactlyOne(await safeQuery(client, query));
  exactKeys(row, ["accepted"]);
  if (row.accepted !== true) throw new DurableBoundaryError("DURABLE_BOUNDARY_OPERATION_REJECTED");
}

function exactlyOne(result: PostgresQueryResult): Readonly<Record<string, unknown>> {
  if (result.row_count !== 1 || result.rows.length !== 1) malformed();
  return result.rows[0];
}

function optionalOne<T>(result: PostgresQueryResult, decode: (row: Readonly<Record<string, unknown>>) => T): T | null {
  if (result.row_count === 0 && result.rows.length === 0) return null;
  return decode(exactlyOne(result));
}

function identitySessionState(row: Readonly<Record<string, unknown>>): IdentitySessionState {
  exactKeys(row, ["tenant_id", "session_id", "subject", "status", "current_token_id", "rotation_counter", "valid_after_epoch", "expires_at_epoch", "reviewer_organization_id"]);
  const state = Object.freeze({
    tenant_id: opaque(row, "tenant_id"),
    session_id: opaque(row, "session_id"),
    subject: opaque(row, "subject"),
    status: enumValue(row, "status", ["active", "revoked"] as const),
    current_token_id: opaque(row, "current_token_id"),
    rotation_counter: safeInteger(row, "rotation_counter", 0),
    valid_after_epoch: safeInteger(row, "valid_after_epoch", 0),
    expires_at_epoch: safeInteger(row, "expires_at_epoch", 1),
    reviewer_organization_id: nullableOpaque(row, "reviewer_organization_id"),
  });
  if (state.expires_at_epoch <= state.valid_after_epoch) malformed();
  return state;
}

function identityRecord(row: Readonly<Record<string, unknown>>): IdentitySessionRecord {
  exactKeys(row, ["tenant_id", "sid", "subject", "current_jti", "rotation_counter", "valid_after", "expires_at", "revoked_at", "reviewer_org_id", "session_sha256", "created_at"]);
  const validAfter = timestamp(row, "valid_after");
  const expiresAt = timestamp(row, "expires_at");
  const revokedAt = nullableTimestamp(row, "revoked_at");
  return Object.freeze({
    tenant_id: opaque(row, "tenant_id"),
    session_id: opaque(row, "sid"),
    subject: opaque(row, "subject"),
    status: revokedAt === null ? "active" : "revoked",
    current_token_id: opaque(row, "current_jti"),
    rotation_counter: safeInteger(row, "rotation_counter", 0),
    valid_after_epoch: epoch(validAfter),
    expires_at_epoch: epoch(expiresAt),
    reviewer_organization_id: nullableOpaque(row, "reviewer_org_id"),
    session_sha256: hash(row, "session_sha256"),
    created_at: timestamp(row, "created_at"),
    revoked_at: revokedAt,
  });
}

function caseOwnerRecord(row: Readonly<Record<string, unknown>>): CaseOwnerRecord {
  exactKeys(row, ["tenant_id", "canonical_case_id", "subject", "revision", "status", "binding_sha256", "created_at", "revoked_at"]);
  const status = enumValue(row, "status", ["active", "revoked"] as const);
  const revokedAt = nullableTimestamp(row, "revoked_at");
  if ((status === "revoked") !== (revokedAt !== null)) malformed();
  return Object.freeze({
    tenant_id: opaque(row, "tenant_id"),
    case_id: opaque(row, "canonical_case_id"),
    subject: opaque(row, "subject"),
    revision: safeInteger(row, "revision", 1),
    status,
    binding_sha256: hash(row, "binding_sha256"),
    created_at: timestamp(row, "created_at"),
    revoked_at: revokedAt,
  });
}

function privacyRequestVersion(row: Readonly<Record<string, unknown>>): PrivacyRequestVersion {
  exactKeys(row, ["request_id", "revision", "tenant_id", "canonical_case_id", "request_kind", "state", "idempotency_key", "command_sha256", "legal_hold_conflict", "grant_revocation_receipt_sha256", "created_at"]);
  const state = enumValue(row, "state", PRIVACY_REQUEST_STATES);
  const legalHold = booleanValue(row, "legal_hold_conflict");
  if (legalHold !== (state === "restricted_by_legal_hold")) malformed();
  return Object.freeze({
    request_id: opaque(row, "request_id"),
    revision: safeInteger(row, "revision", 1),
    tenant_id: opaque(row, "tenant_id"),
    case_id: opaque(row, "canonical_case_id"),
    request_kind: enumValue(row, "request_kind", PRIVACY_REQUEST_KINDS),
    state,
    idempotency_key: boundedString(row, "idempotency_key", 3, 256),
    command_sha256: hash(row, "command_sha256"),
    legal_hold_conflict: legalHold,
    grant_revocation_receipt_sha256: nullableHash(row, "grant_revocation_receipt_sha256"),
    created_at: timestamp(row, "created_at"),
  });
}

function privateReportObject(row: Readonly<Record<string, unknown>>): PrivateReportObjectRecord {
  exactKeys(row, ["tenant_id", "canonical_case_id", "report_id", "report_revision", "report_sha256", "object_version_id", "provider_locator", "byte_length", "artifact_sha256", "state", "grant_epoch", "revocation_receipt_sha256", "revoked_at", "created_at"]);
  const state = enumValue(row, "state", ["staged", "approved", "revoked"] as const);
  const revokedAt = nullableTimestamp(row, "revoked_at");
  const receipt = nullableHash(row, "revocation_receipt_sha256");
  if ((state === "revoked") !== (revokedAt !== null) || (state === "revoked") !== (receipt !== null)) malformed();
  return Object.freeze({
    tenant_id: opaque(row, "tenant_id"),
    case_id: opaque(row, "canonical_case_id"),
    report_id: opaque(row, "report_id"),
    report_revision: safeInteger(row, "report_revision", 1),
    report_sha256: hash(row, "report_sha256"),
    object_version_id: opaque(row, "object_version_id"),
    provider_locator: activeLocator(row, "provider_locator"),
    byte_length: safeInteger(row, "byte_length", 1, 52_428_800),
    artifact_sha256: hash(row, "artifact_sha256"),
    state,
    grant_epoch: safeInteger(row, "grant_epoch", 0),
    revocation_receipt_sha256: receipt,
    revoked_at: revokedAt,
    created_at: timestamp(row, "created_at"),
  });
}

function approvedPrivateReportObject(row: Readonly<Record<string, unknown>>): ApprovedPrivateReportObject {
  exactKeys(row, ["object_version_id", "provider_locator", "byte_length", "artifact_sha256", "grant_epoch"]);
  return Object.freeze({
    object_version_id: opaque(row, "object_version_id"),
    provider_locator: activeLocator(row, "provider_locator"),
    byte_length: safeInteger(row, "byte_length", 1, 52_428_800),
    artifact_sha256: hash(row, "artifact_sha256"),
    grant_epoch: safeInteger(row, "grant_epoch", 1),
  });
}

function assertIdentityRegistration(input: IdentitySessionRegistration): void {
  assertOpaque(input.tenant_id);
  assertOpaque(input.session_id);
  assertOpaque(input.subject);
  assertOpaque(input.current_token_id);
  assertCounter(input.rotation_counter);
  assertTimestamp(input.valid_after);
  assertTimestamp(input.expires_at);
  assertNullableOpaque(input.reviewer_organization_id);
  assertTimestamp(input.created_at);
  if (Date.parse(input.expires_at) <= Date.parse(input.valid_after)) invalid();
}

function assertReportBinding(input: Readonly<{ tenant_id: string; case_id: string; report_id: string; report_revision: number; report_sha256: string; object_version_id: string; provider_locator: string; byte_length: number; artifact_sha256: string; created_at: string; canonical_identity: CanonicalReportIdentity }>): void {
  assertOpaque(input.tenant_id);
  assertOpaque(input.case_id);
  assertOpaque(input.report_id);
  assertPositiveRevision(input.report_revision);
  assertHash(input.report_sha256);
  assertOpaque(input.object_version_id);
  if (!ACTIVE_LOCATOR.test(input.provider_locator)) invalid();
  if (!Number.isSafeInteger(input.byte_length) || input.byte_length < 1 || input.byte_length > 52_428_800) invalid();
  assertHash(input.artifact_sha256);
  assertTimestamp(input.created_at);
  assertCanonicalReportIdentity(input.canonical_identity);
  if (input.canonical_identity.tenant_id !== input.tenant_id
    || input.canonical_identity.case_id !== input.case_id
    || input.canonical_identity.report_id !== input.report_id
    || input.canonical_identity.report_revision !== input.report_revision
    || input.canonical_identity.report_sha256 !== input.report_sha256
    || input.canonical_identity.pdf_sha256 !== input.artifact_sha256) {
    throw new CanonicalReportIdentityError("CANONICAL_REPORT_DIGEST_MISMATCH");
  }
  if (input.canonical_identity.storage_object_version_id !== input.object_version_id
    || input.provider_locator !== `objects/${input.artifact_sha256.slice(0, 2)}/${input.object_version_id}`) {
    throw new CanonicalReportIdentityError("CANONICAL_REPORT_STORAGE_MISMATCH");
  }
  if (input.canonical_identity.download_grant_revision !== 0) {
    throw new CanonicalReportIdentityError("CANONICAL_REPORT_GRANT_MISMATCH");
  }
}

function assertReportReadIdentity(input: Readonly<{
  tenant_id: string;
  case_id: string;
  report_id: string;
  report_revision: number;
  report_sha256: string;
  artifact_sha256: string;
  canonical_identity: CanonicalReportIdentity;
}>): void {
  assertCanonicalReportIdentity(input.canonical_identity);
  if (input.canonical_identity.tenant_id !== input.tenant_id
    || input.canonical_identity.case_id !== input.case_id
    || input.canonical_identity.report_id !== input.report_id
    || input.canonical_identity.report_revision !== input.report_revision
    || input.canonical_identity.report_sha256 !== input.report_sha256
    || input.canonical_identity.pdf_sha256 !== input.artifact_sha256) {
    throw new CanonicalReportIdentityError("CANONICAL_REPORT_DIGEST_MISMATCH");
  }
  if (input.canonical_identity.download_grant_revision < 1) {
    throw new CanonicalReportIdentityError("CANONICAL_REPORT_GRANT_MISMATCH");
  }
}

function canonicalReportIdentity(
  row: Readonly<Record<string, unknown>>,
  downloadGrantRevision: number,
): CanonicalReportIdentity {
  exactKeys(row, [
    "tenant_id", "canonical_case_id", "case_revision", "canonical_analysis_run_id",
    "analysis_run_revision", "rule_inputs", "dependencies", "report_id", "report_revision",
    "analysis_result_sha256", "json_sha256", "html_sha256", "manifest_sha256",
    "report_sha256", "pdf_sha256", "owner_binding_revision", "owner_binding_sha256",
    "approval_task_id", "approval_revision", "approval_decision_sha256",
  ]);
  const core = Object.freeze({
    tenant_id: opaque(row, "tenant_id"),
    case_id: opaque(row, "canonical_case_id"),
    case_revision: safeInteger(row, "case_revision", 1),
    analysis_run_id: opaque(row, "canonical_analysis_run_id"),
    analysis_run_revision: safeInteger(row, "analysis_run_revision", 1),
    rule_input_dependency_sha256: canonicalReportDependencySha256({
      rule_inputs: arrayValue(row, "rule_inputs"),
      dependencies: recordValue(row, "dependencies"),
    }),
    report_model_sha256: canonicalReportModelSha256({
      analysis_result_sha256: hash(row, "analysis_result_sha256"),
      json_sha256: hash(row, "json_sha256"),
      html_sha256: hash(row, "html_sha256"),
      manifest_sha256: hash(row, "manifest_sha256"),
    }),
    report_id: opaque(row, "report_id"),
    report_revision: safeInteger(row, "report_revision", 1),
    report_sha256: hash(row, "report_sha256"),
    pdf_sha256: hash(row, "pdf_sha256"),
  });
  return createCanonicalReportIdentity(Object.freeze({
    schema_version: CANONICAL_REPORT_IDENTITY_SCHEMA_VERSION,
    ...core,
    owner_binding_revision: safeInteger(row, "owner_binding_revision", 1),
    owner_binding_sha256: hash(row, "owner_binding_sha256"),
    storage_object_id: canonicalReportStorageObjectId(core),
    storage_object_version_id: canonicalReportStorageObjectVersionId(core),
    approval_task_id: opaque(row, "approval_task_id"),
    approval_revision: safeInteger(row, "approval_revision", 1),
    approval_decision_sha256: hash(row, "approval_decision_sha256"),
    download_grant_revision: downloadGrantRevision,
  }));
}

function exactKeys(row: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  const actual = Object.keys(row).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) malformed();
}

function boundedString(row: Readonly<Record<string, unknown>>, key: string, minimum: number, maximum: number): string {
  const value = row[key];
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) malformed();
  return value;
}

function opaque(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = boundedString(row, key, 3, 256);
  if (!OPAQUE_ID.test(value)) malformed();
  return value;
}

function nullableOpaque(row: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) malformed();
  return value;
}

function hash(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !SHA256.test(value)) malformed();
  return value;
}

function nullableHash(row: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string" || !SHA256.test(value)) malformed();
  return value;
}

function arrayValue(row: Readonly<Record<string, unknown>>, key: string): readonly unknown[] {
  const value = row[key];
  if (!Array.isArray(value)) malformed();
  return value;
}

function recordValue(row: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> {
  const value = row[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) malformed();
  return value as Readonly<Record<string, unknown>>;
}

function safeInteger(row: Readonly<Record<string, unknown>>, key: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = row[key];
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) malformed();
  return parsed;
}

function booleanValue(row: Readonly<Record<string, unknown>>, key: string): boolean {
  if (typeof row[key] !== "boolean") malformed();
  return row[key] as boolean;
}

function enumValue<T extends string>(row: Readonly<Record<string, unknown>>, key: string, allowed: readonly T[]): T {
  const value = row[key];
  if (typeof value !== "string" || !allowed.includes(value as T)) malformed();
  return value as T;
}

function timestamp(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") malformed();
  assertTimestamp(value);
  return value;
}

function nullableTimestamp(row: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") malformed();
  assertTimestamp(value);
  return value;
}

function activeLocator(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !ACTIVE_LOCATOR.test(value)) malformed();
  return value;
}

function assertOpaque(value: string): void {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) invalid();
}

function assertNullableOpaque(value: string | null): void {
  if (value !== null) assertOpaque(value);
}

function assertHash(value: string): void {
  if (!SHA256.test(value)) invalid();
}

function assertNullableHash(value: string | null): void {
  if (value !== null) assertHash(value);
}

function assertCounter(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
}

function assertPositiveRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) invalid();
}

function assertTimestamp(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) invalid();
}

function epoch(value: string): number {
  return Math.floor(Date.parse(value) / 1_000);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function invalid(): never {
  throw new DurableBoundaryError("DURABLE_BOUNDARY_INPUT_INVALID");
}

function malformed(): never {
  throw new DurableBoundaryError("DURABLE_BOUNDARY_ROW_MALFORMED");
}

function mismatch(): never {
  throw new DurableBoundaryError("DURABLE_BOUNDARY_EXACT_BINDING_MISMATCH");
}
