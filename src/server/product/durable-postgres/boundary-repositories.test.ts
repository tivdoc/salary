import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { PostgresClient, PostgresQueryResult, PostgresStatement } from "../../platform/persistence/postgres/contracts.ts";
import type { ManagedPostgresClient, PostgresConnectionFactory } from "../../platform/persistence/postgres/runtime/transaction-manager.ts";
import type { PrivateBlobInventoryEntry, PrivateBlobProvider } from "../../platform/storage/private-storage-provider.ts";
import { DURABLE_BOUNDARY_CAPABILITIES } from "./boundary-contracts.ts";
import {
  DurableApprovedReportObjectReader,
  DurableBoundaryError,
  PostgresCaseOwnerRepository,
  PostgresIdentitySessionRepository,
  PostgresIdentitySessionStateReader,
  PostgresPrivacyRequestRepository,
  PostgresPrivateReportObjectRepository,
} from "./boundary-repositories.ts";
import { DURABLE_BOUNDARY_SQL_TEXT, DURABLE_REPORT_IDENTITY_SQL_TEXT, durableBoundaryStatements } from "./boundary-sql.ts";
import {
  CANONICAL_REPORT_IDENTITY_SCHEMA_VERSION,
  canonicalReportDependencySha256,
  canonicalReportModelSha256,
  canonicalReportStorageObjectId,
  canonicalReportStorageObjectVersionId,
  createCanonicalReportIdentity,
  type CanonicalReportIdentity,
  type CanonicalReportIdentitySeed,
} from "./report-identity.ts";

const TENANT = "tenant:synthetic:001";
const CASE = "case:synthetic:001";
const SUBJECT = "subject:synthetic:001";
const SID = "session:synthetic:001";
const JTI = "token:synthetic:001";
const NEXT_JTI = "token:synthetic:002";
const CREATED = "2026-09-01T06:00:00.000Z";
const VALID_AFTER = "2026-09-01T06:00:01.000Z";
const EXPIRES = "2026-09-01T07:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const DEPENDENCY_SHA = canonicalReportDependencySha256({ rule_inputs: [], dependencies: {} });
const MODEL_SHA = canonicalReportModelSha256({
  analysis_result_sha256: HASH_A,
  json_sha256: HASH_A,
  html_sha256: HASH_A,
  manifest_sha256: HASH_A,
});
const REPORT_CORE = Object.freeze({
  tenant_id: TENANT,
  case_id: CASE,
  case_revision: 1,
  analysis_run_id: "analysis:synthetic:001",
  analysis_run_revision: 1,
  rule_input_dependency_sha256: DEPENDENCY_SHA,
  report_model_sha256: MODEL_SHA,
  report_id: "report:synthetic:001",
  report_revision: 1,
  report_sha256: HASH_A,
  pdf_sha256: HASH_B,
});
const OBJECT_ID = canonicalReportStorageObjectVersionId(REPORT_CORE);
const LOCATOR = `objects/${HASH_B.slice(0, 2)}/${OBJECT_ID}`;

describe("durable PostgreSQL product boundaries", () => {
  it("uses only named parameterized private-function statements and declares no memory fallback", () => {
    expect(Object.values(DURABLE_BOUNDARY_SQL_TEXT)).toHaveLength(12);
    for (const text of Object.values(DURABLE_BOUNDARY_SQL_TEXT)) {
      expect(text).toMatch(/^select (?:\* from )?private\.product_/u);
      expect(text).not.toContain("${");
    }
    expect(durableBoundaryStatements.identityRegister([
      SID, SUBJECT, JTI, 0, VALID_AFTER, EXPIRES, null, CREATED,
    ])).toMatchObject({ name: "product_identity_register", values: expect.arrayContaining([SID, SUBJECT]) });
    // The tenant is never an argument: the database resolves it from the
    // installed session context, so no caller can name another tenant.
    for (const text of [DURABLE_BOUNDARY_SQL_TEXT.identityRegister,
      DURABLE_BOUNDARY_SQL_TEXT.identityRotate, DURABLE_BOUNDARY_SQL_TEXT.identityRevoke]) {
      expect(text).not.toContain("$9");
    }
    expect(DURABLE_BOUNDARY_CAPABILITIES.memory_fallback_count).toBe(0);
    expect(DURABLE_BOUNDARY_CAPABILITIES.installed_contract_path).toBe("supabase/migrations/202609010003_durable_product_integrity_hardening.sql");
    expect(DURABLE_REPORT_IDENTITY_SQL_TEXT).toContain("report.revision = state.revision");
    expect(DURABLE_REPORT_IDENTITY_SQL_TEXT).toContain("review.release_state = 'approved'");
    expect(durableBoundaryStatements.reportIdentity([TENANT, CASE, REPORT_CORE.report_id, 1])).toMatchObject({
      name: "product_report_identity_context",
      values: [TENANT, CASE, REPORT_CORE.report_id, 1],
    });
  });

  it("persists session rotation and revocation across fresh reader instances", async () => {
    const store = new SessionStore();
    const repository = new PostgresIdentitySessionRepository(store.client());
    await repository.register({
      tenant_id: TENANT,
      session_id: SID,
      subject: SUBJECT,
      current_token_id: JTI,
      rotation_counter: 0,
      valid_after: VALID_AFTER,
      expires_at: EXPIRES,
      reviewer_organization_id: null,
      created_at: CREATED,
    });

    const first = new PostgresIdentitySessionStateReader(store.factory());
    await expect(first.read(SID)).resolves.toMatchObject({ tenant_id: TENANT, current_token_id: JTI, rotation_counter: 0, status: "active" });

    await repository.rotate({
      session_id: SID,
      next_token_id: NEXT_JTI,
      expected_rotation_counter: 0,
      rotated_at: VALID_AFTER,
    });
    const afterRestart = new PostgresIdentitySessionStateReader(store.factory());
    await expect(afterRestart.read(SID)).resolves.toMatchObject({ current_token_id: NEXT_JTI, rotation_counter: 1, status: "active" });

    await repository.revoke({ session_id: SID, revoked_at: "2026-09-01T06:10:00.000Z" });
    const afterSecondRestart = new PostgresIdentitySessionStateReader(store.factory());
    await expect(afterSecondRestart.read(SID)).resolves.toMatchObject({ status: "revoked" });
    expect(store.acquisitions).toBe(3);
    expect(store.releases).toBe(3);
  });

  it("rejects malformed or widened identity rows", async () => {
    const client = callbackClient(() => result([{ ...sessionStateRow(), unexpected: true }]));
    await expect(new PostgresIdentitySessionRepository(client).read(SID)).rejects.toMatchObject({
      code: "DURABLE_BOUNDARY_ROW_MALFORMED",
    });
  });

  it("binds the exact owner and denies a cross-tenant or cross-owner lookup", async () => {
    const bindClient = callbackClient((query) => {
      expect(query.name).toBe("product_owner_bind");
      const bindingSha = query.values[3];
      return result([ownerRow({ binding_sha256: bindingSha })]);
    });
    const bound = await new PostgresCaseOwnerRepository(bindClient).bind({
      tenant_id: TENANT,
      case_id: CASE,
      subject: SUBJECT,
      created_at: CREATED,
    });
    expect(bound).toMatchObject({ tenant_id: TENANT, case_id: CASE, subject: SUBJECT, status: "active" });

    const denied = new PostgresCaseOwnerRepository(callbackClient((query) => {
      expect(query.values).toEqual(["tenant:synthetic:other", CASE, SUBJECT]);
      return result([]);
    }));
    await expect(denied.requireActive({ tenant_id: "tenant:synthetic:other", case_id: CASE, subject: SUBJECT }))
      .rejects.toMatchObject({ code: "DURABLE_BOUNDARY_OWNER_DENIED" });
  });

  it.each(["PRODUCT_PRIVACY_IDEMPOTENCY_MISMATCH", "PRODUCT_PRIVACY_REVISION_CONFLICT"])(
    "fails closed when PostgreSQL rejects %s",
    async () => {
      const repository = new PostgresPrivacyRequestRepository(callbackClient(() => {
        throw new Error("database rejected durable privacy command");
      }));
      await expect(repository.append(privacyInput({}))).rejects.toMatchObject({
        code: "DURABLE_BOUNDARY_DATABASE_REJECTED",
      });
    },
  );

  it("preserves a revisioned legal-hold conflict as a durable result", async () => {
    const input = privacyInput({ state: "restricted_by_legal_hold", legal_hold_conflict: true });
    const repository = new PostgresPrivacyRequestRepository(callbackClient((query) => result([privacyRow({
      state: input.state,
      legal_hold_conflict: input.legal_hold_conflict,
      command_sha256: query.values[7],
    })])));
    await expect(repository.append(input)).resolves.toMatchObject({
      state: "restricted_by_legal_hold",
      legal_hold_conflict: true,
      revision: 1,
    });
  });

  it("rejects an idempotency replay whose created-at timestamp differs", async () => {
    const repository = new PostgresPrivacyRequestRepository(callbackClient((query) => result([privacyRow({
      command_sha256: query.values[7],
      created_at: "2026-09-01T06:00:01.000Z",
    })])));
    await expect(repository.append(privacyInput({}))).rejects.toMatchObject({
      code: "DURABLE_BOUNDARY_EXACT_BINDING_MISMATCH",
    });
  });

  it("denies an absent or revoked report grant before accessing storage", async () => {
    let reads = 0;
    const repository = new PostgresPrivateReportObjectRepository(reportClient(reportIdentity(1), () => result([])));
    const reader = new DurableApprovedReportObjectReader(repository, blobProvider(async () => {
      reads += 1;
      return Uint8Array.from([1]);
    }));
    await expect(reader.download(reportReadInput())).rejects.toMatchObject({ code: "DURABLE_BOUNDARY_REPORT_DENIED" });
    expect(reads).toBe(0);
  });

  it("returns only exact approved bytes and rejects length/hash corruption", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const artifactSha = sha256(bytes);
    const approvedIdentity = reportIdentity(1, { pdf_sha256: artifactSha });
    const approvedVersion = approvedIdentity.storage_object_version_id;
    const repository = new PostgresPrivateReportObjectRepository(reportClient(approvedIdentity, () => result([approvedObjectRow({
      byte_length: bytes.byteLength,
      artifact_sha256: artifactSha,
      object_version_id: approvedVersion,
      provider_locator: `objects/${artifactSha.slice(0, 2)}/${approvedVersion}`,
    })])));
    const exact = new DurableApprovedReportObjectReader(repository, blobProvider(async () => Uint8Array.from(bytes)));
    const readInput = reportReadInput({
      artifact_sha256: artifactSha,
      canonical_identity: approvedIdentity,
    });
    await expect(exact.download(readInput)).resolves.toMatchObject({ bytes });

    const corrupt = new DurableApprovedReportObjectReader(repository, blobProvider(async () => Uint8Array.from([1, 2, 3, 9])));
    await expect(corrupt.download(readInput)).rejects.toMatchObject({
      code: "DURABLE_BOUNDARY_REPORT_INTEGRITY_FAILURE",
    });

    const short = new DurableApprovedReportObjectReader(repository, blobProvider(async () => Uint8Array.from([1, 2, 3])));
    await expect(short.download(readInput)).rejects.toMatchObject({
      code: "DURABLE_BOUNDARY_REPORT_INTEGRITY_FAILURE",
    });
  });

  it("binds immutable report locator/hash/length metadata and requires explicit approval/revocation", async () => {
    const statements: string[] = [];
    const stagedIdentity = reportIdentity(0);
    const approvedIdentity = reportIdentity(1);
    const repository = new PostgresPrivateReportObjectRepository(reportClient(stagedIdentity, (query) => {
      statements.push(query.name);
      if (query.name === "product_report_bind") return result([reportObjectRow()]);
      return result([{ accepted: true }]);
    }));
    await expect(repository.bind(reportBindInput(stagedIdentity))).resolves.toMatchObject({
      state: "staged",
      grant_epoch: 0,
      provider_locator: LOCATOR,
      artifact_sha256: HASH_B,
    });
    await repository.approve({
      tenant_id: TENANT,
      case_id: CASE,
      object_version_id: OBJECT_ID,
      expected_grant_epoch: 0,
      canonical_identity: stagedIdentity,
    });
    await repository.revoke({
      tenant_id: TENANT,
      case_id: CASE,
      object_version_id: OBJECT_ID,
      expected_grant_epoch: 1,
      revocation_receipt_sha256: HASH_A,
      revoked_at: "2026-09-01T06:20:00.000Z",
      canonical_identity: approvedIdentity,
    });
    expect(statements).toEqual(["product_report_bind", "product_report_approve", "product_report_revoke"]);
  });

  it.each([
    ["case_revision", 2, "CANONICAL_REPORT_IDENTITY_STALE"],
    ["rule_input_dependency_sha256", "c".repeat(64), "CANONICAL_REPORT_DEPENDENCY_MISMATCH"],
    ["report_model_sha256", "d".repeat(64), "CANONICAL_REPORT_MODEL_MISMATCH"],
    ["pdf_sha256", "e".repeat(64), "CANONICAL_REPORT_DIGEST_MISMATCH"],
    ["approval_revision", 2, "CANONICAL_REPORT_APPROVAL_MISMATCH"],
  ] as const)("rejects a database-context %s mismatch before report binding", async (key, value, code) => {
    const expected = reportIdentity(0, { [key]: value });
    const repository = new PostgresPrivateReportObjectRepository(reportClient(reportIdentity(0), () => {
      throw new Error("report bind must not be reached");
    }));
    await expect(repository.bind(reportBindInput(expected))).rejects.toMatchObject({ code });
  });
});

function callbackClient(callback: (query: PostgresStatement) => PostgresQueryResult | Promise<PostgresQueryResult>): PostgresClient {
  return Object.freeze({ query: async (query: PostgresStatement) => callback(query) });
}

function result(rows: readonly Readonly<Record<string, unknown>>[]): PostgresQueryResult {
  return Object.freeze({ rows: Object.freeze(rows), row_count: rows.length });
}

function sessionStateRow(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    tenant_id: TENANT,
    session_id: SID,
    subject: SUBJECT,
    status: "active",
    current_token_id: JTI,
    rotation_counter: "0",
    valid_after_epoch: String(Date.parse(VALID_AFTER) / 1_000),
    expires_at_epoch: String(Date.parse(EXPIRES) / 1_000),
    reviewer_organization_id: null,
    ...overrides,
  });
}

function ownerRow(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    tenant_id: TENANT,
    canonical_case_id: CASE,
    subject: SUBJECT,
    revision: "1",
    status: "active",
    binding_sha256: HASH_A,
    created_at: CREATED,
    revoked_at: null,
    ...overrides,
  });
}

function privacyInput(overrides: Readonly<Record<string, unknown>>): Parameters<PostgresPrivacyRequestRepository["append"]>[0] {
  return {
    request_id: "privacy:synthetic:001",
    tenant_id: TENANT,
    case_id: CASE,
    revision: 1,
    request_kind: "deletion",
    state: "requested",
    idempotency_key: "privacy-idempotency-001",
    legal_hold_conflict: false,
    grant_revocation_receipt_sha256: null,
    created_at: CREATED,
    ...overrides,
  } as Parameters<PostgresPrivacyRequestRepository["append"]>[0];
}

function privacyRow(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    request_id: "privacy:synthetic:001",
    revision: "1",
    tenant_id: TENANT,
    canonical_case_id: CASE,
    request_kind: "deletion",
    state: "requested",
    idempotency_key: "privacy-idempotency-001",
    command_sha256: HASH_A,
    legal_hold_conflict: false,
    grant_revocation_receipt_sha256: null,
    created_at: CREATED,
    ...overrides,
  });
}

function reportBindInput(
  canonicalIdentity: CanonicalReportIdentity = reportIdentity(0),
): Parameters<PostgresPrivateReportObjectRepository["bind"]>[0] {
  return {
    tenant_id: canonicalIdentity.tenant_id,
    case_id: canonicalIdentity.case_id,
    report_id: canonicalIdentity.report_id,
    report_revision: canonicalIdentity.report_revision,
    report_sha256: canonicalIdentity.report_sha256,
    object_version_id: canonicalIdentity.storage_object_version_id,
    provider_locator: `objects/${canonicalIdentity.pdf_sha256.slice(0, 2)}/${canonicalIdentity.storage_object_version_id}`,
    byte_length: 4,
    artifact_sha256: canonicalIdentity.pdf_sha256,
    created_at: CREATED,
    canonical_identity: canonicalIdentity,
  };
}

function reportObjectRow(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    tenant_id: TENANT,
    canonical_case_id: CASE,
    report_id: "report:synthetic:001",
    report_revision: "1",
    report_sha256: HASH_A,
    object_version_id: OBJECT_ID,
    provider_locator: LOCATOR,
    byte_length: "4",
    artifact_sha256: HASH_B,
    state: "staged",
    grant_epoch: "0",
    revocation_receipt_sha256: null,
    revoked_at: null,
    created_at: CREATED,
    ...overrides,
  });
}

function approvedObjectRow(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    object_version_id: OBJECT_ID,
    provider_locator: LOCATOR,
    byte_length: "4",
    artifact_sha256: HASH_B,
    grant_epoch: "1",
    ...overrides,
  });
}

function reportReadInput(overrides: Readonly<Record<string, unknown>> = {}): Parameters<PostgresPrivateReportObjectRepository["approvedRead"]>[0] {
  return {
    tenant_id: TENANT,
    case_id: CASE,
    report_id: "report:synthetic:001",
    report_revision: 1,
    report_sha256: HASH_A,
    artifact_sha256: HASH_B,
    canonical_identity: reportIdentity(1),
    ...overrides,
  } as Parameters<PostgresPrivateReportObjectRepository["approvedRead"]>[0];
}

function reportClient(
  contextIdentity: CanonicalReportIdentity,
  operation: (query: PostgresStatement) => PostgresQueryResult | Promise<PostgresQueryResult>,
): PostgresClient {
  return callbackClient((query) => query.name === "product_report_identity_context"
    ? result([reportIdentityContextRow(contextIdentity)])
    : operation(query));
}

function reportIdentity(
  downloadGrantRevision: number,
  overrides: Readonly<Record<string, unknown>> = {},
): CanonicalReportIdentity {
  const core = {
    ...REPORT_CORE,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => [
      "tenant_id", "case_id", "case_revision", "analysis_run_id", "analysis_run_revision",
      "rule_input_dependency_sha256", "report_model_sha256", "report_id", "report_revision",
      "report_sha256", "pdf_sha256",
    ].includes(key))),
  } as typeof REPORT_CORE;
  const seed = {
    schema_version: CANONICAL_REPORT_IDENTITY_SCHEMA_VERSION,
    ...core,
    owner_binding_revision: 1,
    owner_binding_sha256: HASH_A,
    storage_object_id: canonicalReportStorageObjectId(core),
    storage_object_version_id: canonicalReportStorageObjectVersionId(core),
    approval_task_id: "approval:synthetic:001",
    approval_revision: 1,
    approval_decision_sha256: HASH_A,
    download_grant_revision: downloadGrantRevision,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => [
      "owner_binding_revision", "owner_binding_sha256", "approval_task_id", "approval_revision",
      "approval_decision_sha256", "download_grant_revision",
    ].includes(key))),
  } as CanonicalReportIdentitySeed;
  return createCanonicalReportIdentity(seed);
}

function reportIdentityContextRow(identity: CanonicalReportIdentity): Readonly<Record<string, unknown>> {
  return Object.freeze({
    tenant_id: identity.tenant_id,
    canonical_case_id: identity.case_id,
    case_revision: String(identity.case_revision),
    canonical_analysis_run_id: identity.analysis_run_id,
    analysis_run_revision: String(identity.analysis_run_revision),
    rule_inputs: [],
    dependencies: {},
    report_id: identity.report_id,
    report_revision: String(identity.report_revision),
    analysis_result_sha256: HASH_A,
    json_sha256: HASH_A,
    html_sha256: HASH_A,
    manifest_sha256: HASH_A,
    report_sha256: identity.report_sha256,
    pdf_sha256: identity.pdf_sha256,
    owner_binding_revision: String(identity.owner_binding_revision),
    owner_binding_sha256: identity.owner_binding_sha256,
    approval_task_id: identity.approval_task_id,
    approval_revision: String(identity.approval_revision),
    approval_decision_sha256: identity.approval_decision_sha256,
  });
}

function blobProvider(read: PrivateBlobProvider["readExact"]): PrivateBlobProvider {
  return Object.freeze({
    provider_kind: "hermetic_filesystem" as const,
    managed_platform_verified: false,
    putQuarantined: async () => ({ quarantine_locator: "quarantine/aa/object_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
    promoteQuarantined: async () => ({ active_locator: LOCATOR }),
    readExact: read,
    deleteExact: async () => ({ deleted: false }),
    inventory: async (): Promise<readonly PrivateBlobInventoryEntry[]> => Object.freeze([]),
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

class SessionStore {
  row: Readonly<Record<string, unknown>> | null = null;
  acquisitions = 0;
  releases = 0;

  client(): PostgresClient {
    return callbackClient((query) => this.query(query));
  }

  factory(): PostgresConnectionFactory {
    return Object.freeze({
      acquire: async (): Promise<ManagedPostgresClient> => {
        this.acquisitions += 1;
        return Object.freeze({
          query: async (query: PostgresStatement) => this.query(query),
          release: () => { this.releases += 1; },
        });
      },
    });
  }

  query(query: PostgresStatement): PostgresQueryResult {
    if (query.name === "product_identity_register") {
      this.row = Object.freeze({
        tenant_id: TENANT,
        sid: query.values[0],
        subject: query.values[1],
        current_jti: query.values[2],
        rotation_counter: String(query.values[3]),
        valid_after: query.values[4],
        expires_at: query.values[5],
        revoked_at: null,
        reviewer_org_id: query.values[6],
        session_sha256: HASH_A,
        created_at: query.values[7],
      });
      return result([this.row]);
    }
    if (query.name === "product_identity_read") {
      if (!this.row) return result([]);
      return result([sessionStateRow({
        status: this.row.revoked_at === null ? "active" : "revoked",
        current_token_id: this.row.current_jti,
        rotation_counter: this.row.rotation_counter,
      })]);
    }
    if (query.name === "product_identity_rotate") {
      if (!this.row) return result([{ accepted: false }]);
      this.row = Object.freeze({
        ...this.row,
        current_jti: query.values[1],
        rotation_counter: String(Number(this.row.rotation_counter) + 1),
        valid_after: query.values[3],
      });
      return result([{ accepted: true }]);
    }
    if (query.name === "product_identity_revoke") {
      if (!this.row) return result([{ accepted: false }]);
      this.row = Object.freeze({ ...this.row, revoked_at: query.values[1] });
      return result([{ accepted: true }]);
    }
    throw new DurableBoundaryError("DURABLE_BOUNDARY_DATABASE_REJECTED");
  }
}
