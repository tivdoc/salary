import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { canonicalSha256, canonicalStringify } from "../../../engine/rule-runtime/canonical.ts";
import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";
import type { DurableJob } from "../../platform/jobs/durable-job-queue.ts";
import {
  CANONICAL_POSTGRES_SCHEMA_VERSION,
  type CanonicalPostgresRuntimeRole,
  type CanonicalVerifiedRuntimeIdentity,
  type TransactionScopedPostgresBundle,
} from "../../platform/composition/canonical-postgres.ts";
import type { CanonicalApplicationPostgresComposition } from "../../platform/composition/canonical-postgres-application.ts";
import { PlatformPersistenceError } from "../../platform/persistence/contracts.ts";
import {
  statement,
  type PostgresClient,
  type PostgresParameter,
  type PostgresQueryResult,
} from "../../platform/persistence/postgres/contracts.ts";
import { LocalRuntimePrivateBlobProvider } from "../../platform/storage/local-runtime/private-blob-provider.ts";
import type { VerifiedProductIdentity } from "../auth/identity-session.ts";
import {
  DurableApprovedReportObjectReader,
  PostgresPrivateReportObjectRepository,
} from "./boundary-repositories.ts";
import type {
  FreshWorkerExecutionInput,
  FreshWorkerExecutionPort,
  FreshWorkerRunResult,
} from "./fresh-worker-protocol.ts";
import {
  assertCanonicalReportIdentity,
  assertCanonicalReportIdentityMatches,
  withCanonicalReportGrantRevision,
  type CanonicalReportIdentity,
} from "./report-identity.ts";
import { decodeDurableReportArtifacts } from "./report-artifacts.ts";

export const DURABLE_RUNTIME_PRODUCT_SCHEMA_VERSION =
  "tivdoc-runtime-product-lane-v0.10.2" as const;
export const DURABLE_RUNTIME_JOB_KIND = "runtime_product_report_storage" as const;
export const DURABLE_RUNTIME_EFFECT_KIND = "runtime_product_report_stored" as const;
export const DURABLE_DOWNLOAD_GRANT_SCHEMA_VERSION =
  "tivdoc-runtime-download-grant-v0.10.2" as const;

export type DurableRuntimeDatabasePrincipal =
  | "tivdoc_web_runtime"
  | "tivdoc_operations_runtime"
  | "tivdoc_worker_runtime";

export type DurableRuntimeTransactionBundle = Pick<
  TransactionScopedPostgresBundle<unknown, unknown>,
  "context" | "runtime"
>;

export type DurableRuntimeIsolatedPostgresCompositionPort = Readonly<{
  mode: "isolated_postgres";
  durable: true;
  target_id: string;
  schema_version: typeof CANONICAL_POSTGRES_SCHEMA_VERSION;
  verified_transaction<T>(
    input: Readonly<{
      identity: CanonicalVerifiedRuntimeIdentity;
      runtime_role: CanonicalPostgresRuntimeRole;
      case_id: string;
      correlation_id: string;
    }>,
    operation: (bundle: DurableRuntimeTransactionBundle) => Promise<T>,
  ): Promise<T>;
}>;

export type DurableRuntimePostgresCompositionPort =
  | DurableRuntimeIsolatedPostgresCompositionPort
  | Readonly<{ mode: "disabled"; durable: false; reason: "PERSISTENCE_DISABLED" }>;

/**
 * Request/worker-scoped seam supplied by the canonical root after it has
 * verified a durable session. Tenant, actor and database role are immutable
 * properties of the seam; an HTTP payload cannot choose them.
 */
export interface DurableRuntimePostgresContextPort {
  readonly proof_class: "DURABLE_VERIFIED_RUNTIME_CONTEXT";
  readonly uses_service_role: false;
  readonly bypasses_rls: false;
  readonly database_principal: DurableRuntimeDatabasePrincipal;
  readonly tenant_id: string;
  readonly actor_id: string;
  readonly session_revision: number;
  readonly session_binding_sha256: string;
  readonly postgres: DurableRuntimePostgresCompositionPort;
  transaction<T>(
    input: Readonly<{ case_id: string; correlation_id: string }>,
    operation: (bundle: DurableRuntimeTransactionBundle) => Promise<T>,
  ): Promise<T>;
}

export function createDurableRuntimeProductIdentityContext(input: Readonly<{
  postgres: CanonicalApplicationPostgresComposition;
  identity: VerifiedProductIdentity;
}>): DurableRuntimePostgresContextPort {
  if (input.postgres.mode !== "isolated_postgres") {
    throw new Error("RUNTIME_PRODUCT_POSTGRES_REQUIRED");
  }
  assertVerifiedProductIdentityForRuntimeContext(input.identity);
  const runtimeRole = input.identity.product_audience === "portal" ? "web" : "operations";
  return createVerifiedRuntimeContext({
    postgres: input.postgres,
    runtime_role: runtimeRole,
    identity: {
      session_id: input.identity.session_id,
      token_id: input.identity.token_id,
      tenant_id: requireTenant(input.identity.actor.tenant_id),
      actor_id: input.identity.actor.actor_id,
      reviewer_organization_id: input.identity.reviewer_organization_id,
      rotation_counter: input.identity.rotation_counter,
    },
    session_binding_sha256: verifiedSessionBindingSha256(input.identity),
  });
}

export function createDurableRuntimeWorkerContext(input: Readonly<{
  postgres: DurableRuntimeIsolatedPostgresCompositionPort;
  identity: CanonicalVerifiedRuntimeIdentity;
}>): DurableRuntimePostgresContextPort {
  return createVerifiedRuntimeContext({
    postgres: input.postgres,
    runtime_role: "worker",
    identity: input.identity,
    session_binding_sha256: canonicalSha256({
      schema_version: "tivdoc-durable-worker-session-binding-v0.10.2",
      ...input.identity,
    }),
  });
}

function createVerifiedRuntimeContext(input: Readonly<{
  postgres: DurableRuntimeIsolatedPostgresCompositionPort;
  runtime_role: CanonicalPostgresRuntimeRole;
  identity: CanonicalVerifiedRuntimeIdentity;
  session_binding_sha256: string;
}>): DurableRuntimePostgresContextPort {
  const postgres = input.postgres;
  if (postgres.mode !== "isolated_postgres" || postgres.durable !== true
      || postgres.schema_version !== CANONICAL_POSTGRES_SCHEMA_VERSION) {
    throw new Error("RUNTIME_PRODUCT_POSTGRES_REQUIRED");
  }
  const identity = Object.freeze({ ...input.identity });
  assertOpaque(identity.session_id, "RUNTIME_PRODUCT_VERIFIED_CONTEXT_REQUIRED");
  assertOpaque(identity.token_id, "RUNTIME_PRODUCT_VERIFIED_CONTEXT_REQUIRED");
  assertOpaque(identity.tenant_id, "RUNTIME_PRODUCT_VERIFIED_CONTEXT_REQUIRED");
  assertOpaque(identity.actor_id, "RUNTIME_PRODUCT_VERIFIED_CONTEXT_REQUIRED");
  if (identity.reviewer_organization_id !== null) {
    assertOpaque(identity.reviewer_organization_id, "RUNTIME_PRODUCT_VERIFIED_CONTEXT_REQUIRED");
  }
  if (!Number.isSafeInteger(identity.rotation_counter) || identity.rotation_counter < 0) {
    throw new Error("RUNTIME_PRODUCT_VERIFIED_CONTEXT_REQUIRED");
  }
  assertHash(input.session_binding_sha256, "RUNTIME_PRODUCT_VERIFIED_CONTEXT_REQUIRED");
  const databasePrincipal = databasePrincipalForRuntimeRole(input.runtime_role);

  return Object.freeze({
    proof_class: "DURABLE_VERIFIED_RUNTIME_CONTEXT" as const,
    uses_service_role: false as const,
    bypasses_rls: false as const,
    database_principal: databasePrincipal,
    tenant_id: identity.tenant_id,
    actor_id: identity.actor_id,
    session_revision: identity.rotation_counter,
    session_binding_sha256: input.session_binding_sha256,
    postgres,
    transaction: <T>(
      transactionInput: Readonly<{ case_id: string; correlation_id: string }>,
      operation: (bundle: DurableRuntimeTransactionBundle) => Promise<T>,
    ): Promise<T> => {
      assertOpaque(transactionInput.case_id, "RUNTIME_PRODUCT_VERIFIED_CONTEXT_MISMATCH");
      assertCorrelation(transactionInput.correlation_id, "RUNTIME_PRODUCT_VERIFIED_CONTEXT_MISMATCH");
      return postgres.verified_transaction({
        identity,
        runtime_role: input.runtime_role,
        case_id: transactionInput.case_id,
        correlation_id: transactionInput.correlation_id,
      }, operation);
    },
  });
}

function databasePrincipalForRuntimeRole(
  runtimeRole: CanonicalPostgresRuntimeRole,
): DurableRuntimeDatabasePrincipal {
  if (runtimeRole === "web") return "tivdoc_web_runtime";
  if (runtimeRole === "operations") return "tivdoc_operations_runtime";
  return "tivdoc_worker_runtime";
}

function assertVerifiedProductIdentityForRuntimeContext(identity: VerifiedProductIdentity): void {
  const role = identity.actor.role;
  const audienceMatches = identity.audience === identity.product_audience;
  const roleMatches = identity.product_audience === "portal"
    ? role === "customer_owner"
    : role !== "anonymous" && role !== "customer_owner" && role !== "scoped_background_worker";
  if (!audienceMatches || !roleMatches || identity.actor.verified_server_side !== true) {
    throw new Error("RUNTIME_PRODUCT_VERIFIED_CONTEXT_REQUIRED");
  }
}

function requireTenant(value: string | null): string {
  if (value === null) throw new Error("RUNTIME_PRODUCT_VERIFIED_CONTEXT_REQUIRED");
  return value;
}

/** This contract is consumed by the orchestrator's role/context installer. */
export const DURABLE_RUNTIME_POSTGRES_CONTEXT_REQUIREMENTS = Object.freeze({
  schema_version: "tivdoc-runtime-postgres-context-v0.10.2",
  transaction_local_settings: Object.freeze([
    "tivdoc.tenant_id",
    "tivdoc.actor_id",
    "tivdoc.identity_sid",
    "tivdoc.identity_jti",
    "tivdoc.runtime_role",
    "tivdoc.correlation_id",
    "tivdoc.reviewer_organization_id",
  ] as const),
  runtime_roles: Object.freeze({
    web: "tivdoc_web_runtime",
    operations: "tivdoc_operations_runtime",
    worker: "tivdoc_worker_runtime",
  } as const),
  runtime_context_values: Object.freeze({
    web: "web",
    operations: "operations",
    worker: "worker",
  } as const),
  context_installer: "private.runtime_context_install(text,text,text)" as const,
  context_authority: "authoritative_current_durable_identity_session" as const,
  forbidden_identities: Object.freeze([
    "service_role",
    "tivdoc_governance_owner",
    "table_owner",
    "superuser",
    "bypassrls",
  ] as const),
  transaction_local_context_required: true,
  pool_reuse_context_reset_required: true,
  direct_table_owner_execution_forbidden: true,
  bypassrls_forbidden: true,
} as const);

const SHA256 = /^[a-f0-9]{64}$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/u;
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,95}$/u;
const JOB_ENVELOPE_KEYS = Object.freeze([
  "schema_version",
  "analysis_mode",
  "legal_rules_activated",
  "timeline",
  "pipeline",
  "storage",
] as const);
const TIMELINE_KEYS = Object.freeze([
  "correlation_id", "tenant_id", "case_id", "case_revision",
  "owner_binding_revision", "owner_binding_sha256", "actor_id",
  "session_binding_sha256", "session_revision", "analysis_run_id",
  "report_id", "report_revision", "report_sha256", "pdf_sha256",
] as const);
const PIPELINE_KEYS = Object.freeze([
  "job_id", "outbox_id", "logical_effect_id", "idempotency_key",
  "logical_effect_sha256",
] as const);
const PIPELINE_INPUT_KEYS = Object.freeze([
  "job_id", "outbox_id", "logical_effect_id", "idempotency_key",
] as const);
const STORAGE_KEYS = Object.freeze([
  "provider_class", "managed_platform_verified", "staging_object_key",
  "quarantine_locator", "locator_sha256",
] as const);

export type DurableRuntimeTimelineBinding = Readonly<{
  correlation_id: string;
  tenant_id: string;
  case_id: string;
  case_revision: number;
  owner_binding_revision: number;
  owner_binding_sha256: string;
  actor_id: string;
  session_binding_sha256: string;
  session_revision: number;
  analysis_run_id: string;
  report_id: string;
  report_revision: number;
  report_sha256: string;
  pdf_sha256: string;
}>;

export type DurableRuntimePipeline = Readonly<{
  job_id: string;
  outbox_id: string;
  logical_effect_id: string;
  idempotency_key: string;
}>;

export type DurableRuntimeReportJobEnvelope = Readonly<{
  schema_version: typeof DURABLE_RUNTIME_PRODUCT_SCHEMA_VERSION;
  analysis_mode: "synthetic_seven_topic_only";
  legal_rules_activated: 0;
  timeline: DurableRuntimeTimelineBinding;
  pipeline: DurableRuntimePipeline & Readonly<{
    logical_effect_sha256: string;
  }>;
  storage: Readonly<{
    provider_class: "local_private_immutable_filesystem";
    managed_platform_verified: false;
    staging_object_key: string;
    quarantine_locator: string;
    locator_sha256: string;
  }>;
}>;

export type DurableRuntimeTimelineEvent = Readonly<{
  event_kind:
    | "ui"
    | "http"
    | "identity_session"
    | "canonical_root"
    | "postgres_transaction"
    | "job_outbox"
    | "fresh_worker"
    | "private_storage"
    | "exact_approval"
    | "authenticated_download"
    | "audit";
  correlation_id: string;
  tenant_id: string;
  case_id: string;
  case_revision: number;
  owner_binding_revision: number;
  owner_binding_sha256: string;
  report_revision: number;
  report_sha256: string;
  event_revision: number;
  actor_id: string;
  session_or_process_sha256: string;
  relevant_sha256: string;
  occurred_at: string | null;
  state: string;
}>;

export type DurableRuntimeTimeline = Readonly<{
  schema_version: typeof DURABLE_RUNTIME_PRODUCT_SCHEMA_VERSION;
  binding: DurableRuntimeTimelineBinding;
  binding_sha256: string;
  events: readonly DurableRuntimeTimelineEvent[];
  complete_through: DurableRuntimeTimelineEvent["event_kind"];
  managed_storage_verified: false;
}>;

export type DurableRuntimeBoundaryEventKind = Extract<
  DurableRuntimeTimelineEvent["event_kind"],
  "ui" | "http" | "identity_session" | "canonical_root" | "postgres_transaction"
>;

export type DurableDownloadGrant = Readonly<{
  token: string;
  expires_at_epoch: number;
  grant_sha256: string;
}>;

type DownloadGrantPayload = Readonly<{
  schema_version: typeof DURABLE_DOWNLOAD_GRANT_SCHEMA_VERSION;
  grant_id: string;
  correlation_id: string;
  tenant_id: string;
  case_id: string;
  actor_id: string;
  session_binding_sha256: string;
  session_revision: number;
  report_identity_sha256: string;
  object_version_id: string;
  grant_epoch: number;
  issued_at_epoch: number;
  expires_at_epoch: number;
}>;

const CURRENT_REPORT = `
select report.artifacts_payload, state.revision::text as case_revision
from public.engine_report_versions report
join public.engine_case_state state
  on state.tenant_id = report.tenant_id and state.case_id = report.case_id
where report.tenant_id = $1
  and report.canonical_case_id = $2
  and report.report_id = $3
  and report.revision = $4
  and report.report_sha256 = $5
  and report.pdf_sha256 = $6
  and report.canonical_analysis_run_id = $7
  and state.revision = $8
  and state.lifecycle_state not in ('release_hold', 'cancelled')
  and report.tenant_id = nullif(current_setting('tivdoc.tenant_id', true), '')
limit 1`;

const CURRENT_OWNER = `
select revision::text, binding_sha256
from public.product_case_owners
where tenant_id = $1 and canonical_case_id = $2 and subject = $3
  and status = 'active' and revoked_at is null
  and tenant_id = nullif(current_setting('tivdoc.tenant_id', true), '')
  and subject = nullif(current_setting('tivdoc.actor_id', true), '')
limit 1`;

const JOB_READ = `
select job_id, tenant_id, canonical_case_id as case_id, job_kind, idempotency_key,
       payload, payload_sha256, pinned_version_sha256s, state, revision::text,
       attempt_count::text, max_attempts::text,
       (extract(epoch from available_at) * 1000)::bigint::text as available_at_ms,
       lease_owner, (extract(epoch from lease_expires_at) * 1000)::bigint::text as lease_expires_at_ms,
       fencing_token::text, cancellation_requested, terminal_effect_sha256, replayed_from_job_id
from public.engine_durable_jobs
where tenant_id = $1 and canonical_case_id = $2 and job_id = $3 and job_kind = $4
limit 1`;

const JOB_BY_CORRELATION = `
select job_id, tenant_id, canonical_case_id as case_id, job_kind, idempotency_key,
       payload, payload_sha256, pinned_version_sha256s, state, revision::text,
       attempt_count::text, max_attempts::text,
       (extract(epoch from available_at) * 1000)::bigint::text as available_at_ms,
       lease_owner, (extract(epoch from lease_expires_at) * 1000)::bigint::text as lease_expires_at_ms,
       fencing_token::text, cancellation_requested, terminal_effect_sha256, replayed_from_job_id
from public.engine_durable_jobs
where tenant_id = $1 and canonical_case_id = $2 and job_kind = $3
  and payload -> 'timeline' ->> 'correlation_id' = $4
limit 1`;

const NEXT_JOB_FOR_CLAIM = `
select job_id
from public.engine_durable_jobs
where tenant_id = $1 and attempt_count < max_attempts and (
  (state in ('queued', 'retry_wait') and available_at <= to_timestamp($2 / 1000.0))
  or (state in ('leased', 'running') and lease_expires_at <= to_timestamp($2 / 1000.0))
)
order by available_at, job_id
for update skip locked
limit 1`;

const OUTBOX_READ = `
select outbox_id, logical_effect_id, effect_kind, payload_sha256, state,
       fencing_token::text, published_at
from public.engine_outbox_events
where tenant_id = $1 and canonical_case_id = $2 and outbox_id = $3
  and logical_effect_id = $4
limit 1`;

const NEXT_OUTBOX_FOR_CLAIM = `
select outbox_id
from public.engine_outbox_events
where tenant_id = $1 and (
  state = 'pending' or (state = 'leased' and lease_expires_at <= to_timestamp($2 / 1000.0))
)
order by created_at, outbox_id
for update skip locked
limit 1`;

const EFFECT_READ = `
select logical_effect_sha256, committed_at
from public.engine_logical_effect_receipts
where tenant_id = $1 and logical_effect_id = $2 and outbox_id = $3
limit 1`;

const AUDIT_READ = `
select case_sequence::text, actor_id, action, resource_id, resource_revision::text,
       resource_sha256, reason_code, event_sha256, occurred_at
from public.engine_platform_audit_events
where tenant_id = $1 and canonical_case_id = $2 and resource_id like $3 || ':%'
order by case_sequence`;

const AUDIT_EXACT = `
select case_sequence::text, event_sha256, occurred_at
from public.engine_platform_audit_events
where tenant_id = $1 and canonical_case_id = $2 and actor_id = $3
  and action = $4 and resource_id = $5 and resource_revision = $6
  and resource_sha256 = $7
limit 1`;

const OBJECT_TIMELINE = `
select object_version_id, provider_locator, byte_length::text, artifact_sha256,
       state, grant_epoch::text, created_at, revoked_at
from public.product_private_report_objects
where tenant_id = $1 and canonical_case_id = $2 and report_id = $3
  and report_revision = $4 and report_sha256 = $5
limit 1`;

const OBJECT_APPROVAL_LOCK = `
select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended($1 || ':' || $2, 0)
)`;

const RUNTIME_CONTEXT_VERIFY = `
select session_user as database_principal, current_user as effective_principal,
       current_setting('tivdoc.tenant_id', true) as tenant_id,
       current_setting('tivdoc.actor_id', true) as actor_id,
       current_setting('tivdoc.identity_sid', true) as identity_sid,
       current_setting('tivdoc.identity_jti', true) as identity_jti,
       current_setting('tivdoc.runtime_role', true) as runtime_role,
       current_setting('tivdoc.correlation_id', true) as correlation_id,
       current_setting('tivdoc.reviewer_organization_id', true) as reviewer_organization_id,
       role.rolsuper as is_superuser, role.rolbypassrls as bypasses_rls,
       exists (
         select 1 from pg_catalog.pg_roles forbidden
         where forbidden.rolname in ('service_role', 'tivdoc_governance_owner')
           and pg_catalog.pg_has_role(role.oid, forbidden.oid, 'member')
       ) as has_forbidden_membership,
       exists (
         select 1 from pg_catalog.pg_class object
         join pg_catalog.pg_namespace namespace on namespace.oid = object.relnamespace
         where namespace.nspname in ('public', 'private')
           and object.relname in (
             'engine_durable_jobs', 'engine_outbox_events',
             'engine_logical_effect_receipts', 'engine_platform_audit_events',
             'engine_report_versions', 'engine_review_task_versions',
             'product_private_report_objects'
           ) and object.relowner = role.oid
       ) as owns_runtime_object
from pg_catalog.pg_roles role
where role.rolname = session_user`;

export function createDurableRuntimeReportJobEnvelope(input: Readonly<{
  timeline: DurableRuntimeTimelineBinding;
  pipeline: DurableRuntimePipeline;
}>): DurableRuntimeReportJobEnvelope {
  exactKeys(input.timeline, TIMELINE_KEYS);
  exactKeys(input.pipeline, PIPELINE_INPUT_KEYS);
  const timeline = Object.freeze({ ...input.timeline });
  const pipeline = Object.freeze({ ...input.pipeline });
  assertTimelineBinding(timeline);
  assertPipeline(pipeline);
  const stagingObjectKey = `object_${canonicalSha256({
    schema_version: "tivdoc-runtime-staging-object-v0.10.2",
    correlation_id: timeline.correlation_id,
    tenant_id: timeline.tenant_id,
    case_id: timeline.case_id,
    report_id: timeline.report_id,
    report_revision: timeline.report_revision,
    report_sha256: timeline.report_sha256,
    pdf_sha256: timeline.pdf_sha256,
  }).slice(0, 48)}`;
  const quarantineLocator = `quarantine/${timeline.pdf_sha256.slice(0, 2)}/${stagingObjectKey}`;
  const locatorSha256 = canonicalSha256({ locator: quarantineLocator });
  const logicalEffectSha256 = canonicalSha256({
    schema_version: "tivdoc-runtime-report-storage-effect-v0.10.2",
    binding_sha256: canonicalSha256(timeline),
    report_sha256: timeline.report_sha256,
    pdf_sha256: timeline.pdf_sha256,
    storage_locator_sha256: locatorSha256,
  });
  return Object.freeze({
    schema_version: DURABLE_RUNTIME_PRODUCT_SCHEMA_VERSION,
    analysis_mode: "synthetic_seven_topic_only",
    legal_rules_activated: 0,
    timeline,
    pipeline: Object.freeze({ ...pipeline, logical_effect_sha256: logicalEffectSha256 }),
    storage: Object.freeze({
      provider_class: "local_private_immutable_filesystem",
      managed_platform_verified: false,
      staging_object_key: stagingObjectKey,
      quarantine_locator: quarantineLocator,
      locator_sha256: locatorSha256,
    }),
  });
}

export function createDurableRuntimeProductRegistrar(input: Readonly<{
  context: DurableRuntimePostgresContextPort;
  storage: LocalRuntimePrivateBlobProvider;
  download_grant_hmac_key?: Uint8Array;
}>): DurableRuntimeProductRegistrar {
  return new DurableRuntimeProductRegistrar(input);
}

export class DurableRuntimeProductRegistrar implements FreshWorkerExecutionPort {
  readonly #application: DurableRuntimeIsolatedPostgresCompositionPort;
  readonly #context: DurableRuntimePostgresContextPort;
  readonly #storage: LocalRuntimePrivateBlobProvider;
  readonly #grants: DownloadGrantCodec | null;

  constructor(input: Readonly<{
    context: DurableRuntimePostgresContextPort;
    storage: LocalRuntimePrivateBlobProvider;
    download_grant_hmac_key?: Uint8Array;
  }>) {
    if (input.context.proof_class !== "DURABLE_VERIFIED_RUNTIME_CONTEXT"
      || input.context.uses_service_role !== false
      || input.context.bypasses_rls !== false
      || !isDatabasePrincipal(input.context.database_principal)
      || !OPAQUE.test(input.context.tenant_id)
      || !OPAQUE.test(input.context.actor_id)
      || !Number.isSafeInteger(input.context.session_revision)
      || input.context.session_revision < 0
      || !SHA256.test(input.context.session_binding_sha256)
      || typeof input.context.transaction !== "function") {
      throw new Error("RUNTIME_PRODUCT_VERIFIED_CONTEXT_REQUIRED");
    }
    const application = input.context.postgres;
    if (application.mode === "disabled") {
      throw new Error(application.reason);
    }
    if (!application.durable || application.schema_version !== CANONICAL_POSTGRES_SCHEMA_VERSION) {
      throw new Error("RUNTIME_PRODUCT_POSTGRES_REQUIRED");
    }
    if (input.storage.managed_platform_verified !== false
      || input.storage.proof().provider_kind !== "local_private_immutable_filesystem") {
      throw new Error("RUNTIME_PRODUCT_LOCAL_PRIVATE_STORAGE_REQUIRED");
    }
    this.#application = application;
    this.#context = input.context;
    this.#storage = input.storage;
    if (input.context.database_principal === "tivdoc_web_runtime") {
      if (!input.download_grant_hmac_key) throw new Error("RUNTIME_PRODUCT_DOWNLOAD_GRANT_KEY_INVALID");
      this.#grants = new DownloadGrantCodec(input.download_grant_hmac_key);
    } else {
      if (input.download_grant_hmac_key !== undefined) {
        throw new Error("RUNTIME_PRODUCT_DOWNLOAD_GRANT_KEY_SCOPE_INVALID");
      }
      this.#grants = null;
    }
  }

  proof() {
    return Object.freeze({
      schema_version: DURABLE_RUNTIME_PRODUCT_SCHEMA_VERSION,
      persistence_mode: "isolated_postgres" as const,
      postgres_target_id: this.#application.target_id,
      product_reachable_memory_fallbacks: 0 as const,
      recording_driver_reachable: false as const,
      private_storage: this.#storage.proof(),
      managed_storage_verified: false as const,
      database_principal: this.#context.database_principal,
      uses_service_role: false as const,
      bypasses_rls: false as const,
      verified_session_revision: this.#context.session_revision,
      postgres_context_requirements: DURABLE_RUNTIME_POSTGRES_CONTEXT_REQUIREMENTS,
    });
  }

  async recordBoundaryEvent(input: Readonly<{
    identity: VerifiedProductIdentity;
    binding: DurableRuntimeTimelineBinding;
    event_kind: DurableRuntimeBoundaryEventKind;
    relevant_sha256: string;
    occurred_at: string;
  }>): Promise<Readonly<{
    event_kind: DurableRuntimeBoundaryEventKind;
    audit_event_sha256: string;
    idempotent_replay: boolean;
  }>> {
    assertTimelineBinding(input.binding);
    assertRuntimeBoundaryIdentity(input.identity, input.binding);
    this.#assertBoundIdentityContext(input.identity);
    assertHash(input.relevant_sha256, "RUNTIME_PRODUCT_TIMELINE_INVALID");
    assertTimestamp(input.occurred_at);
    const principal = input.identity.product_audience === "portal"
      ? "tivdoc_web_runtime"
      : "tivdoc_operations_runtime";
    const sessionBindingSha256 = verifiedSessionBindingSha256(input.identity);
    return this.#transaction(principal, input.binding, input.identity.actor.actor_id, async (bundle) => {
      const resourceSha256 = timelineEventSha256(input.binding, input.event_kind, {
        relevant_sha256: input.relevant_sha256,
      }, {
        actor_id: input.identity.actor.actor_id,
        session_or_process_sha256: sessionBindingSha256,
        session_revision: input.identity.rotation_counter,
      });
      const audit = await appendAuditOnce(bundle.context.client, bundle.runtime.jobs_outbox_audit, {
        binding: input.binding,
        actor_id: input.identity.actor.actor_id,
        action: boundaryAuditAction(input.event_kind),
        resource_id: timelineResourceId(input.binding.correlation_id, `boundary-${input.event_kind}`),
        resource_revision: input.event_kind === "identity_session"
          ? input.identity.rotation_counter + 1
          : input.binding.case_revision,
        resource_sha256: resourceSha256,
        session_or_process_sha256: sessionBindingSha256,
        occurred_at: input.occurred_at,
      });
      return Object.freeze({
        event_kind: input.event_kind,
        audit_event_sha256: audit.event_sha256,
        idempotent_replay: audit.idempotent_replay,
      });
    });
  }

  async enqueue(input: Readonly<{
    envelope: DurableRuntimeReportJobEnvelope;
    actor: VerifiedActor;
    available_at_ms: number;
    max_attempts: number;
    occurred_at: string;
  }>): Promise<Readonly<{
    job_id: string;
    job_revision: number;
    payload_sha256: string;
    idempotent_replay: boolean;
    audit_event_sha256: string;
  }>> {
    assertEnvelope(input.envelope);
    assertActor(input.actor, input.envelope.timeline, ["intake_operator", "scoped_background_worker"]);
    if (this.#context.session_revision !== input.envelope.timeline.session_revision
      || this.#context.session_binding_sha256 !== input.envelope.timeline.session_binding_sha256) {
      throw new Error("RUNTIME_PRODUCT_VERIFIED_CONTEXT_MISMATCH");
    }
    assertTimestamp(input.occurred_at);
    if (!Number.isSafeInteger(input.available_at_ms) || input.available_at_ms < 1
      || !Number.isSafeInteger(input.max_attempts) || input.max_attempts < 2 || input.max_attempts > 8) {
      throw new Error("RUNTIME_PRODUCT_JOB_ARGUMENT_INVALID");
    }
    const envelope = input.envelope;
    const payloadSha256 = canonicalSha256(envelope);
    const principal = input.actor.role === "scoped_background_worker"
      ? "tivdoc_worker_runtime"
      : "tivdoc_operations_runtime";
    return this.#transaction(principal, envelope.timeline, input.actor.actor_id, async (bundle) => {
      await readCurrentReport(bundle.context.client, envelope.timeline);
      const job = await bundle.runtime.jobs_outbox_audit.enqueue({
        job_id: envelope.pipeline.job_id,
        tenant_id: envelope.timeline.tenant_id,
        case_id: envelope.timeline.case_id,
        job_kind: DURABLE_RUNTIME_JOB_KIND,
        idempotency_key: envelope.pipeline.idempotency_key,
        payload_sha256: payloadSha256,
        payload: envelope,
        pinned_version_sha256s: Object.freeze([
          envelope.timeline.owner_binding_sha256,
          envelope.timeline.session_binding_sha256,
          envelope.timeline.report_sha256,
          envelope.timeline.pdf_sha256,
        ]),
        max_attempts: input.max_attempts,
        available_at_ms: input.available_at_ms,
      });
      await enqueueOutboxOnce(bundle.context.client, bundle.runtime.jobs_outbox_audit, envelope, payloadSha256, input.occurred_at);
      const auditResourceSha256 = timelineEventSha256(envelope.timeline, "job_outbox", {
        payload_sha256: payloadSha256,
        storage_locator_sha256: envelope.storage.locator_sha256,
      });
      const audit = await appendAuditOnce(bundle.context.client, bundle.runtime.jobs_outbox_audit, {
        binding: envelope.timeline,
        actor_id: input.actor.actor_id,
        action: "RUNTIME_PRODUCT_JOB_OUTBOX_ENQUEUED",
        resource_id: timelineResourceId(envelope.timeline.correlation_id, "job-outbox"),
        resource_revision: envelope.timeline.case_revision,
        resource_sha256: auditResourceSha256,
        session_or_process_sha256: envelope.timeline.session_binding_sha256,
        occurred_at: input.occurred_at,
      });
      return Object.freeze({
        job_id: job.job_id,
        job_revision: job.revision,
        payload_sha256: payloadSha256,
        idempotent_replay: audit.idempotent_replay,
        audit_event_sha256: audit.event_sha256,
      });
    });
  }

  async process(input: FreshWorkerExecutionInput): Promise<FreshWorkerRunResult> {
    assertFreshExecutionInput(input);
    const claimed = await this.#claimAndStart(input);
    if (claimed.replay) return claimed.replay;
    const { job, envelope } = claimed;
    let storageLocatorSha256 = envelope.storage.locator_sha256;
    try {
      const report = await this.#transaction("tivdoc_worker_runtime", envelope.timeline, input.worker_id, (bundle) =>
        readCurrentReport(bundle.context.client, envelope.timeline));
      const staged = await this.#storage.putQuarantined({
        object_key: envelope.storage.staging_object_key,
        expected_sha256: envelope.timeline.pdf_sha256,
        expected_length: report.pdf.byteLength,
        bytes: report.pdf,
      });
      if (staged.quarantine_locator !== envelope.storage.quarantine_locator) {
        throw new Error("RUNTIME_PRODUCT_STORAGE_LOCATOR_MISMATCH");
      }
      storageLocatorSha256 = canonicalSha256({ locator: staged.quarantine_locator });
      if (storageLocatorSha256 !== envelope.storage.locator_sha256) {
        throw new Error("RUNTIME_PRODUCT_STORAGE_LOCATOR_MISMATCH");
      }
      const workerProcessSha256 = canonicalSha256({
        schema_version: "tivdoc-fresh-worker-process-binding-v0.10.2",
        worker_id: input.worker_id,
        parent_process_id: input.parent_process_id,
        process_id: input.process_id,
        boot_nonce_sha256: input.boot_nonce_sha256,
        fencing_token: job.fencing_token,
      });
      return await this.#complete({
        input,
        job,
        envelope,
        storage_locator_sha256: storageLocatorSha256,
        worker_process_sha256: workerProcessSha256,
      });
    } catch {
      return this.#retry({ input, job, envelope, storage_locator_sha256: storageLocatorSha256 });
    }
  }

  async finalizeApprovedReport(input: Readonly<{
    identity: VerifiedProductIdentity;
    envelope: DurableRuntimeReportJobEnvelope;
    occurred_at: string;
  }>): Promise<Readonly<{
    canonical_identity: CanonicalReportIdentity;
    storage_locator_sha256: string;
    audit_event_sha256: string;
    idempotent_replay: boolean;
  }>> {
    assertEnvelope(input.envelope);
    assertVerifiedIdentity(input.identity, input.envelope.timeline, ["report_approver"]);
    this.#assertBoundIdentityContext(input.identity);
    assertTimestamp(input.occurred_at);
    const binding = input.envelope.timeline;
    const identityAtStaging = await this.#currentIdentity(
      binding,
      0,
      "tivdoc_operations_runtime",
      input.identity.actor.actor_id,
      binding.correlation_id,
    );
    const identityAtGrant = withCanonicalReportGrantRevision(identityAtStaging, 1);
    const existing = await this.#transaction(
      "tivdoc_operations_runtime", binding, input.identity.actor.actor_id, async (bundle) =>
      new PostgresPrivateReportObjectRepository(bundle.context.client)
        .approvedRead(reportReadInput(identityAtGrant)));
    if (existing) {
      await this.#storage.readExact({
        locator: existing.provider_locator,
        expected_sha256: existing.artifact_sha256,
        expected_length: existing.byte_length,
      });
      const storageLocatorSha256 = canonicalSha256({ locator: existing.provider_locator });
      const audit = await this.#transaction(
        "tivdoc_operations_runtime", binding, input.identity.actor.actor_id, (bundle) =>
        appendApprovalAudit(bundle.context.client, bundle.runtime.jobs_outbox_audit, {
          binding,
          identity: input.identity,
          report_identity: identityAtGrant,
          storage_locator_sha256: storageLocatorSha256,
          occurred_at: input.occurred_at,
        }));
      return Object.freeze({
        canonical_identity: identityAtGrant,
        storage_locator_sha256: storageLocatorSha256,
        audit_event_sha256: audit.event_sha256,
        idempotent_replay: true,
      });
    }
    const staged = await this.#storage.readExact({
      locator: input.envelope.storage.quarantine_locator,
      expected_sha256: binding.pdf_sha256,
      expected_length: await this.#reportByteLength(
        binding,
        "tivdoc_operations_runtime",
        input.identity.actor.actor_id,
        binding.correlation_id,
      ),
    });
    const promoted = await this.#storage.promoteQuarantined({
      quarantine_locator: input.envelope.storage.quarantine_locator,
      object_key: identityAtStaging.storage_object_version_id,
      expected_sha256: binding.pdf_sha256,
      expected_length: staged.byteLength,
    });
    const storageLocatorSha256 = canonicalSha256({ locator: promoted.active_locator });
    return this.#transaction(
      "tivdoc_operations_runtime", binding, input.identity.actor.actor_id, async (bundle) => {
      await bundle.context.client.query(statement(
        "runtime_product_object_approval_lock",
        OBJECT_APPROVAL_LOCK,
        [binding.tenant_id, identityAtStaging.storage_object_version_id],
      ));
      const repository = new PostgresPrivateReportObjectRepository(bundle.context.client);
      const existing = await repository.approvedRead(reportReadInput(identityAtGrant));
      let idempotentReplay = existing !== null;
      if (!existing) {
        await repository.bind({
          tenant_id: binding.tenant_id,
          case_id: binding.case_id,
          report_id: binding.report_id,
          report_revision: binding.report_revision,
          report_sha256: binding.report_sha256,
          object_version_id: identityAtStaging.storage_object_version_id,
          provider_locator: promoted.active_locator,
          byte_length: staged.byteLength,
          artifact_sha256: binding.pdf_sha256,
          created_at: input.occurred_at,
          canonical_identity: identityAtStaging,
        });
        await repository.approve({
          tenant_id: binding.tenant_id,
          case_id: binding.case_id,
          object_version_id: identityAtStaging.storage_object_version_id,
          expected_grant_epoch: 0,
          canonical_identity: identityAtStaging,
        });
        const approved = await repository.approvedRead(reportReadInput(identityAtGrant));
        if (!approved) throw new Error("RUNTIME_PRODUCT_OBJECT_APPROVAL_FAILED");
        idempotentReplay = false;
      }
      const audit = await appendApprovalAudit(bundle.context.client, bundle.runtime.jobs_outbox_audit, {
        binding,
        identity: input.identity,
        report_identity: identityAtGrant,
        storage_locator_sha256: storageLocatorSha256,
        occurred_at: input.occurred_at,
      });
      return Object.freeze({
        canonical_identity: identityAtGrant,
        storage_locator_sha256: storageLocatorSha256,
        audit_event_sha256: audit.event_sha256,
        idempotent_replay: idempotentReplay,
      });
    });
  }

  async issueDownloadGrant(input: Readonly<{
    identity: VerifiedProductIdentity;
    report_identity: CanonicalReportIdentity;
    correlation_id: string;
    now_epoch: number;
    ttl_seconds: number;
  }>): Promise<DurableDownloadGrant> {
    assertCanonicalReportIdentity(input.report_identity);
    assertPortalIdentity(input.identity, input.report_identity.tenant_id, input.report_identity.case_id);
    this.#assertBoundIdentityContext(input.identity);
    const sessionBindingSha256 = verifiedSessionBindingSha256(input.identity);
    const current = await this.#currentIdentity(
      identityBinding(input.report_identity),
      input.report_identity.download_grant_revision,
      "tivdoc_web_runtime",
      input.identity.actor.actor_id,
      input.correlation_id,
    );
    assertCanonicalReportIdentityMatches(input.report_identity, current);
    await this.#transaction(
      "tivdoc_web_runtime",
      { tenant_id: current.tenant_id, case_id: current.case_id, correlation_id: input.correlation_id },
      input.identity.actor.actor_id,
      async (bundle) => {
      await requireCurrentOwner(bundle.context.client, current, input.identity.actor.actor_id);
      const repository = new PostgresPrivateReportObjectRepository(bundle.context.client);
      if (!await repository.approvedRead(reportReadInput(current))) {
        throw new Error("RUNTIME_PRODUCT_DOWNLOAD_NOT_FOUND");
      }
    });
    return this.#downloadGrantCodec().issue({
      identity: input.identity,
      report_identity: current,
      correlation_id: input.correlation_id,
      session_binding_sha256: sessionBindingSha256,
      now_epoch: input.now_epoch,
      ttl_seconds: input.ttl_seconds,
    });
  }

  async download(input: Readonly<{
    identity: VerifiedProductIdentity;
    report_identity: CanonicalReportIdentity;
    grant_token: string;
    now_epoch: number;
    occurred_at: string;
  }>): Promise<Readonly<{
    bytes: Uint8Array;
    content_type: "application/pdf";
    receipt_sha256: string;
    audit_event_sha256: string;
  }>> {
    assertCanonicalReportIdentity(input.report_identity);
    assertPortalIdentity(input.identity, input.report_identity.tenant_id, input.report_identity.case_id);
    this.#assertBoundIdentityContext(input.identity);
    assertTimestamp(input.occurred_at);
    const grant = this.#downloadGrantCodec().verify({
      token: input.grant_token,
      identity: input.identity,
      report_identity: input.report_identity,
      now_epoch: input.now_epoch,
    });
    return this.#transaction(
      "tivdoc_web_runtime",
      {
        tenant_id: input.report_identity.tenant_id,
        case_id: input.report_identity.case_id,
        correlation_id: grant.correlation_id,
      },
      input.identity.actor.actor_id,
      async (bundle) => {
      const repository = new PostgresPrivateReportObjectRepository(bundle.context.client);
      const current = await repository.currentCanonicalIdentity({
        tenant_id: input.report_identity.tenant_id,
        case_id: input.report_identity.case_id,
        report_id: input.report_identity.report_id,
        report_revision: input.report_identity.report_revision,
        download_grant_revision: grant.grant_epoch,
      });
      if (!current) throw new Error("RUNTIME_PRODUCT_DOWNLOAD_NOT_FOUND");
      assertCanonicalReportIdentityMatches(input.report_identity, current);
      await requireCurrentOwner(bundle.context.client, current, input.identity.actor.actor_id);
      const downloaded = await new DurableApprovedReportObjectReader(repository, this.#storage)
        .download(reportReadInput(current));
      const bytesSha256 = byteSha256(downloaded.bytes);
      if (bytesSha256 !== current.pdf_sha256) throw new Error("RUNTIME_PRODUCT_EXACT_BYTES_MISMATCH");
      const receiptSha256 = canonicalSha256({
        schema_version: "tivdoc-authenticated-download-receipt-v0.10.2",
        correlation_id: grant.correlation_id,
        actor_id: input.identity.actor.actor_id,
        session_binding_sha256: grant.session_binding_sha256,
        report_identity_sha256: current.identity_sha256,
        grant_epoch: grant.grant_epoch,
        bytes_sha256: bytesSha256,
      });
      const audit = await appendAuditOnce(bundle.context.client, bundle.runtime.jobs_outbox_audit, {
        binding: identityTimelineBinding(current, input.identity, grant.correlation_id),
        actor_id: input.identity.actor.actor_id,
        action: "RUNTIME_PRODUCT_AUTHENTICATED_DOWNLOAD",
        resource_id: timelineResourceId(grant.correlation_id, "download"),
        resource_revision: current.download_grant_revision,
        resource_sha256: receiptSha256,
        session_or_process_sha256: verifiedSessionBindingSha256(input.identity),
        occurred_at: input.occurred_at,
      });
      return Object.freeze({
        bytes: Uint8Array.from(downloaded.bytes),
        content_type: "application/pdf" as const,
        receipt_sha256: receiptSha256,
        audit_event_sha256: audit.event_sha256,
      });
    });
  }

  async revokeDownloadGrant(input: Readonly<{
    identity: VerifiedProductIdentity;
    report_identity: CanonicalReportIdentity;
    reason_code: string;
    revoked_at: string;
  }>): Promise<Readonly<{ revocation_receipt_sha256: string; audit_event_sha256: string }>> {
    assertCanonicalReportIdentity(input.report_identity);
    assertVerifiedIdentity(input.identity, identityBinding(input.report_identity), ["report_approver", "intake_operator"]);
    this.#assertBoundIdentityContext(input.identity);
    assertTimestamp(input.revoked_at);
    if (!OPAQUE.test(input.reason_code)) throw new Error("RUNTIME_PRODUCT_REVOCATION_REASON_INVALID");
    const receiptSha256 = canonicalSha256({
      schema_version: "tivdoc-runtime-report-grant-revocation-v0.10.2",
      report_identity_sha256: input.report_identity.identity_sha256,
      grant_epoch: input.report_identity.download_grant_revision,
      actor_id: input.identity.actor.actor_id,
      reason_code: input.reason_code,
      revoked_at: input.revoked_at,
    });
    const revocationCorrelationId = `revoke-${canonicalSha256({
      report_identity_sha256: input.report_identity.identity_sha256,
      grant_epoch: input.report_identity.download_grant_revision,
    }).slice(0, 48)}`;
    return this.#transaction(
      "tivdoc_operations_runtime",
      {
        tenant_id: input.report_identity.tenant_id,
        case_id: input.report_identity.case_id,
        correlation_id: revocationCorrelationId,
      },
      input.identity.actor.actor_id,
      async (bundle) => {
      const repository = new PostgresPrivateReportObjectRepository(bundle.context.client);
      const current = await repository.currentCanonicalIdentity({
        tenant_id: input.report_identity.tenant_id,
        case_id: input.report_identity.case_id,
        report_id: input.report_identity.report_id,
        report_revision: input.report_identity.report_revision,
        download_grant_revision: input.report_identity.download_grant_revision,
      });
      if (!current) throw new Error("RUNTIME_PRODUCT_REPORT_STALE");
      assertCanonicalReportIdentityMatches(input.report_identity, current);
      await repository.revoke({
        tenant_id: current.tenant_id,
        case_id: current.case_id,
        object_version_id: current.storage_object_version_id,
        expected_grant_epoch: current.download_grant_revision,
        revocation_receipt_sha256: receiptSha256,
        revoked_at: input.revoked_at,
        canonical_identity: current,
      });
      const audit = await appendAuditOnce(bundle.context.client, bundle.runtime.jobs_outbox_audit, {
        binding: identityTimelineBinding(current, input.identity, revocationCorrelationId),
        actor_id: input.identity.actor.actor_id,
        action: "RUNTIME_PRODUCT_DOWNLOAD_GRANT_REVOKED",
        resource_id: timelineResourceId(revocationCorrelationId, "revoke"),
        resource_revision: current.download_grant_revision,
        resource_sha256: receiptSha256,
        session_or_process_sha256: verifiedSessionBindingSha256(input.identity),
        occurred_at: input.revoked_at,
      });
      return Object.freeze({
        revocation_receipt_sha256: receiptSha256,
        audit_event_sha256: audit.event_sha256,
      });
    });
  }

  async timeline(binding: DurableRuntimeTimelineBinding): Promise<DurableRuntimeTimeline> {
    assertTimelineBinding(binding);
    if (this.#context.session_revision !== binding.session_revision
      || this.#context.session_binding_sha256 !== binding.session_binding_sha256) {
      throw new Error("RUNTIME_PRODUCT_VERIFIED_CONTEXT_MISMATCH");
    }
    return this.#transaction(
      "tivdoc_operations_runtime", binding, binding.actor_id, async (bundle) => {
      const job = await readJobByCorrelation(bundle.context.client, binding);
      const envelope = decodeEnvelope(job.payload);
      if (canonicalSha256(envelope.timeline) !== canonicalSha256(binding)) {
        throw new Error("RUNTIME_PRODUCT_TIMELINE_BINDING_MISMATCH");
      }
      const auditRows = await bundle.context.client.query(statement(
        "runtime_timeline_audit_read",
        AUDIT_READ,
        [binding.tenant_id, binding.case_id, binding.correlation_id],
      ));
      const outboxRows = await bundle.context.client.query(statement(
        "runtime_timeline_outbox_read",
        OUTBOX_READ,
        [binding.tenant_id, binding.case_id, envelope.pipeline.outbox_id, envelope.pipeline.logical_effect_id],
      ));
      const effectRows = await bundle.context.client.query(statement(
        "runtime_timeline_effect_read",
        EFFECT_READ,
        [binding.tenant_id, envelope.pipeline.logical_effect_id, envelope.pipeline.outbox_id],
      ));
      const objectRows = await bundle.context.client.query(statement(
        "runtime_timeline_object_read",
        OBJECT_TIMELINE,
        [binding.tenant_id, binding.case_id, binding.report_id, binding.report_revision, binding.report_sha256],
      ));
      const events = timelineEvents(binding, job, auditRows, outboxRows, effectRows, objectRows);
      return Object.freeze({
        schema_version: DURABLE_RUNTIME_PRODUCT_SCHEMA_VERSION,
        binding,
        binding_sha256: canonicalSha256(binding),
        events,
        complete_through: events.at(-1)?.event_kind ?? "ui",
        managed_storage_verified: false,
      });
    });
  }

  async #claimAndStart(input: FreshWorkerExecutionInput): Promise<Readonly<{
    replay: FreshWorkerRunResult | null;
    job: DurableJob;
    envelope: DurableRuntimeReportJobEnvelope;
  }>> {
    return this.#transaction(
      "tivdoc_worker_runtime",
      { tenant_id: input.tenant_id, case_id: input.case_id, correlation_id: input.correlation_id },
      input.worker_id,
      async (bundle) => {
      const prior = await readJob(bundle.context.client, input.tenant_id, input.case_id, input.job_id);
      const envelope = decodeEnvelope(prior.payload);
      if (envelope.timeline.correlation_id !== input.correlation_id) {
        throw new Error("RUNTIME_PRODUCT_WORKER_CORRELATION_MISMATCH");
      }
      if (prior.payload_sha256 !== canonicalSha256(envelope)) throw new Error("RUNTIME_PRODUCT_JOB_PAYLOAD_MISMATCH");
      if (prior.state === "succeeded") {
        if (prior.terminal_effect_sha256 !== envelope.pipeline.logical_effect_sha256) {
          throw new Error("RUNTIME_PRODUCT_JOB_EFFECT_MISMATCH");
        }
        return Object.freeze({
          replay: resultFromJob(prior, envelope, canonicalSha256({
            schema_version: "tivdoc-fresh-worker-process-binding-v0.10.2",
            worker_id: input.worker_id,
            parent_process_id: input.parent_process_id,
            process_id: input.process_id,
            boot_nonce_sha256: input.boot_nonce_sha256,
            fencing_token: prior.fencing_token,
          }), null, "IDEMPOTENT_REPLAY"),
          job: prior,
          envelope,
        });
      }
      await requireNextClaimTarget(
        bundle.context.client,
        "runtime_product_next_job_claim",
        NEXT_JOB_FOR_CLAIM,
        [input.tenant_id, input.now_ms],
        "job_id",
        input.job_id,
      );
      const jobs = await bundle.runtime.jobs_outbox_audit.claim(input.worker_id, input.now_ms, input.lease_ms, 1);
      const claimed = jobs.find((candidate) => candidate.job_id === input.job_id
        && candidate.case_id === input.case_id && candidate.job_kind === DURABLE_RUNTIME_JOB_KIND);
      if (!claimed) throw new Error("RUNTIME_PRODUCT_JOB_NOT_CLAIMED");
      const running = await bundle.runtime.jobs_outbox_audit.start(
        claimed.job_id,
        input.worker_id,
        claimed.fencing_token,
        input.now_ms + 1,
      );
      return Object.freeze({ replay: null, job: running, envelope });
    });
  }

  async #complete(input: Readonly<{
    input: FreshWorkerExecutionInput;
    job: DurableJob;
    envelope: DurableRuntimeReportJobEnvelope;
    storage_locator_sha256: string;
    worker_process_sha256: string;
  }>): Promise<FreshWorkerRunResult> {
    return this.#transaction(
      "tivdoc_worker_runtime",
      input.envelope.timeline,
      input.input.worker_id,
      async (bundle) => {
      const running = await bundle.runtime.jobs_outbox_audit.heartbeat(
        input.job.job_id,
        input.input.worker_id,
        input.job.fencing_token,
        input.input.now_ms + 2,
        input.input.lease_ms,
      );
      const outbox = await readOutbox(bundle.context.client, input.envelope);
      if (outbox.state === "published") {
        await requireExactEffect(bundle.context.client, input.envelope);
      } else {
        await requireNextClaimTarget(
          bundle.context.client,
          "runtime_product_next_outbox_claim",
          NEXT_OUTBOX_FOR_CLAIM,
          [input.envelope.timeline.tenant_id, input.input.now_ms + 3],
          "outbox_id",
          input.envelope.pipeline.outbox_id,
        );
        const claimedOutbox = await bundle.runtime.jobs_outbox_audit.claimOutbox(
          input.input.worker_id,
          input.input.now_ms + 3,
          input.input.lease_ms,
        );
        if (!claimedOutbox || claimedOutbox.outbox_id !== input.envelope.pipeline.outbox_id
          || claimedOutbox.logical_effect_id !== input.envelope.pipeline.logical_effect_id) {
          throw new Error("RUNTIME_PRODUCT_OUTBOX_NOT_CLAIMED");
        }
        await bundle.runtime.jobs_outbox_audit.publishOutbox({
          outbox_id: claimedOutbox.outbox_id,
          worker_id: input.input.worker_id,
          fencing_token: claimedOutbox.fencing_token,
          now_ms: input.input.now_ms + 4,
          logical_effect_sha256: input.envelope.pipeline.logical_effect_sha256,
        });
      }
      const succeeded = await bundle.runtime.jobs_outbox_audit.succeed(
        running.job_id,
        input.input.worker_id,
        running.fencing_token,
        input.input.now_ms + 5,
        input.envelope.pipeline.logical_effect_sha256,
      );
      const auditResourceSha256 = timelineEventSha256(input.envelope.timeline, "fresh_worker", {
        worker_process_sha256: input.worker_process_sha256,
        storage_locator_sha256: input.storage_locator_sha256,
        logical_effect_sha256: input.envelope.pipeline.logical_effect_sha256,
        fencing_token: succeeded.fencing_token,
      }, {
        actor_id: input.input.worker_id,
        session_or_process_sha256: input.worker_process_sha256,
        session_revision: 0,
      });
      const audit = await appendAuditOnce(bundle.context.client, bundle.runtime.jobs_outbox_audit, {
        binding: input.envelope.timeline,
        actor_id: input.input.worker_id,
        action: "RUNTIME_PRODUCT_FRESH_WORKER_STORED",
        resource_id: timelineResourceId(input.envelope.timeline.correlation_id, "worker"),
        resource_revision: succeeded.revision,
        resource_sha256: auditResourceSha256,
        session_or_process_sha256: input.worker_process_sha256,
        occurred_at: new Date(input.input.now_ms + 6).toISOString(),
      });
      return resultFromJob(succeeded, input.envelope, input.worker_process_sha256,
        audit.event_sha256, "SUCCEEDED");
    });
  }

  async #retry(input: Readonly<{
    input: FreshWorkerExecutionInput;
    job: DurableJob;
    envelope: DurableRuntimeReportJobEnvelope;
    storage_locator_sha256: string;
  }>): Promise<FreshWorkerRunResult> {
    return this.#transaction(
      "tivdoc_worker_runtime",
      input.envelope.timeline,
      input.input.worker_id,
      async (bundle) => {
      const failed = await bundle.runtime.jobs_outbox_audit.fail(
        input.job.job_id,
        input.input.worker_id,
        input.job.fencing_token,
        input.input.now_ms + 2,
        input.input.retry_delay_ms,
      );
      const processSha256 = canonicalSha256({
        schema_version: "tivdoc-fresh-worker-process-binding-v0.10.2",
        worker_id: input.input.worker_id,
        parent_process_id: input.input.parent_process_id,
        process_id: input.input.process_id,
        boot_nonce_sha256: input.input.boot_nonce_sha256,
        fencing_token: input.job.fencing_token,
      });
      return resultFromJob(
        failed,
        input.envelope,
        processSha256,
        null,
        failed.state === "dead_letter" ? "DEAD_LETTER" : "RETRY_WAIT",
        input.storage_locator_sha256,
      );
    });
  }

  async #currentIdentity(binding: Pick<DurableRuntimeTimelineBinding,
    "tenant_id" | "case_id" | "report_id" | "report_revision"
  >, grantRevision: number, principal: DurableRuntimeDatabasePrincipal, actorId: string,
  correlationId: string): Promise<CanonicalReportIdentity> {
    return this.#transaction(
      principal,
      { tenant_id: binding.tenant_id, case_id: binding.case_id, correlation_id: correlationId },
      actorId,
      async (bundle) => {
      const identity = await new PostgresPrivateReportObjectRepository(bundle.context.client)
        .currentCanonicalIdentity({
          tenant_id: binding.tenant_id,
          case_id: binding.case_id,
          report_id: binding.report_id,
          report_revision: binding.report_revision,
          download_grant_revision: grantRevision,
        });
      if (!identity) throw new Error("RUNTIME_PRODUCT_REPORT_STALE");
      return identity;
    });
  }

  async #reportByteLength(
    binding: DurableRuntimeTimelineBinding,
    principal: DurableRuntimeDatabasePrincipal,
    actorId: string,
    correlationId: string,
  ): Promise<number> {
    const report = await this.#transaction(
      principal,
      { tenant_id: binding.tenant_id, case_id: binding.case_id, correlation_id: correlationId },
      actorId,
      (bundle) =>
      readCurrentReport(bundle.context.client, binding));
    return report.pdf.byteLength;
  }

  async #transaction<T>(
    principal: DurableRuntimeDatabasePrincipal,
    binding: Readonly<{ tenant_id: string; case_id: string; correlation_id: string }>,
    actorId: string,
    operation: (bundle: DurableRuntimeTransactionBundle) => Promise<T>,
  ): Promise<T> {
    if (this.#context.database_principal !== principal
      || this.#context.tenant_id !== binding.tenant_id
      || this.#context.actor_id !== actorId) {
      throw new Error("RUNTIME_PRODUCT_VERIFIED_CONTEXT_MISMATCH");
    }
    assertOpaque(binding.case_id, "RUNTIME_PRODUCT_VERIFIED_CONTEXT_MISMATCH");
    assertCorrelation(binding.correlation_id, "RUNTIME_PRODUCT_VERIFIED_CONTEXT_MISMATCH");
    return this.#context.transaction({
      case_id: binding.case_id,
      correlation_id: binding.correlation_id,
    }, async (bundle) => {
      await assertRuntimePostgresContext(bundle.context.client, {
        database_principal: principal,
        tenant_id: binding.tenant_id,
        actor_id: actorId,
        correlation_id: binding.correlation_id,
      });
      return operation(bundle);
    });
  }

  #downloadGrantCodec(): DownloadGrantCodec {
    if (!this.#grants || this.#context.database_principal !== "tivdoc_web_runtime") {
      throw new Error("RUNTIME_PRODUCT_VERIFIED_CONTEXT_MISMATCH");
    }
    return this.#grants;
  }

  #assertBoundIdentityContext(identity: VerifiedProductIdentity): void {
    if (this.#context.session_revision !== identity.rotation_counter
      || this.#context.session_binding_sha256 !== verifiedSessionBindingSha256(identity)) {
      throw new Error("RUNTIME_PRODUCT_VERIFIED_CONTEXT_MISMATCH");
    }
  }
}

class DownloadGrantCodec {
  readonly #key: Uint8Array;

  constructor(key: Uint8Array) {
    if (!(key instanceof Uint8Array) || key.byteLength < 32 || key.byteLength > 128) {
      throw new Error("RUNTIME_PRODUCT_DOWNLOAD_GRANT_KEY_INVALID");
    }
    this.#key = Uint8Array.from(key);
  }

  issue(input: Readonly<{
    identity: VerifiedProductIdentity;
    report_identity: CanonicalReportIdentity;
    correlation_id: string;
    session_binding_sha256: string;
    now_epoch: number;
    ttl_seconds: number;
  }>): DurableDownloadGrant {
    assertCorrelation(input.correlation_id, "RUNTIME_PRODUCT_CORRELATION_INVALID");
    if (!Number.isSafeInteger(input.now_epoch) || !Number.isSafeInteger(input.ttl_seconds)
      || input.ttl_seconds < 1 || input.ttl_seconds > 300) {
      throw new Error("RUNTIME_PRODUCT_DOWNLOAD_GRANT_TTL_INVALID");
    }
    const expiresAt = input.now_epoch + input.ttl_seconds;
    if (expiresAt > input.identity.expires_at_epoch) throw new Error("RUNTIME_PRODUCT_DOWNLOAD_GRANT_TTL_INVALID");
    const grantId = `grant_${canonicalSha256({
      correlation_id: input.correlation_id,
      report_identity_sha256: input.report_identity.identity_sha256,
      actor_id: input.identity.actor.actor_id,
      session_binding_sha256: input.session_binding_sha256,
      issued_at_epoch: input.now_epoch,
      expires_at_epoch: expiresAt,
    }).slice(0, 48)}`;
    const payload: DownloadGrantPayload = Object.freeze({
      schema_version: DURABLE_DOWNLOAD_GRANT_SCHEMA_VERSION,
      grant_id: grantId,
      correlation_id: input.correlation_id,
      tenant_id: input.report_identity.tenant_id,
      case_id: input.report_identity.case_id,
      actor_id: input.identity.actor.actor_id,
      session_binding_sha256: input.session_binding_sha256,
      session_revision: input.identity.rotation_counter,
      report_identity_sha256: input.report_identity.identity_sha256,
      object_version_id: input.report_identity.storage_object_version_id,
      grant_epoch: input.report_identity.download_grant_revision,
      issued_at_epoch: input.now_epoch,
      expires_at_epoch: expiresAt,
    });
    const encoded = Buffer.from(canonicalStringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.#key).update(encoded).digest("base64url");
    const token = `${encoded}.${signature}`;
    return Object.freeze({
      token,
      expires_at_epoch: expiresAt,
      grant_sha256: byteSha256(Buffer.from(token, "utf8")),
    });
  }

  verify(input: Readonly<{
    token: string;
    identity: VerifiedProductIdentity;
    report_identity: CanonicalReportIdentity;
    now_epoch: number;
  }>): DownloadGrantPayload {
    if (input.token.length < 64 || input.token.length > 4_096 || input.token.split(".").length !== 2) {
      throw new Error("RUNTIME_PRODUCT_DOWNLOAD_NOT_FOUND");
    }
    const [encoded, signature] = input.token.split(".");
    if (!encoded || !signature || !/^[A-Za-z0-9_-]+$/u.test(encoded) || !/^[A-Za-z0-9_-]{43}$/u.test(signature)) {
      throw new Error("RUNTIME_PRODUCT_DOWNLOAD_NOT_FOUND");
    }
    const expected = createHmac("sha256", this.#key).update(encoded).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      throw new Error("RUNTIME_PRODUCT_DOWNLOAD_NOT_FOUND");
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw new Error("RUNTIME_PRODUCT_DOWNLOAD_NOT_FOUND");
    }
    const payload = decodeGrantPayload(value);
    if (!Number.isSafeInteger(input.now_epoch) || input.now_epoch < payload.issued_at_epoch
      || input.now_epoch >= payload.expires_at_epoch
      || payload.expires_at_epoch - payload.issued_at_epoch > 300
      || payload.tenant_id !== input.report_identity.tenant_id
      || payload.case_id !== input.report_identity.case_id
      || payload.actor_id !== input.identity.actor.actor_id
      || payload.session_binding_sha256 !== verifiedSessionBindingSha256(input.identity)
      || payload.session_revision !== input.identity.rotation_counter
      || payload.report_identity_sha256 !== input.report_identity.identity_sha256
      || payload.object_version_id !== input.report_identity.storage_object_version_id
      || payload.grant_epoch !== input.report_identity.download_grant_revision) {
      throw new Error("RUNTIME_PRODUCT_DOWNLOAD_NOT_FOUND");
    }
    return payload;
  }
}

async function assertRuntimePostgresContext(
  client: PostgresClient,
  expected: Readonly<{
    database_principal: DurableRuntimeDatabasePrincipal;
    tenant_id: string;
    actor_id: string;
    correlation_id: string;
  }>,
): Promise<void> {
  const row = exactlyOne(await client.query(statement(
    "runtime_product_context_verify",
    RUNTIME_CONTEXT_VERIFY,
    [],
  )), "RUNTIME_PRODUCT_VERIFIED_CONTEXT_REQUIRED");
  const expectedRuntimeRole = runtimeContextValue(expected.database_principal);
  const reviewerOrganization = stringValue(row.reviewer_organization_id);
  if (stringValue(row.database_principal) !== expected.database_principal
    || stringValue(row.effective_principal) !== expected.database_principal
    || stringValue(row.tenant_id) !== expected.tenant_id
    || stringValue(row.actor_id) !== expected.actor_id
    || stringValue(row.runtime_role) !== expectedRuntimeRole
    || stringValue(row.correlation_id) !== expected.correlation_id
    || !OPAQUE.test(stringValue(row.identity_sid))
    || !OPAQUE.test(stringValue(row.identity_jti))
    || (expected.database_principal === "tivdoc_operations_runtime"
      && !OPAQUE.test(reviewerOrganization))
    || booleanValue(row.is_superuser)
    || booleanValue(row.bypasses_rls)
    || booleanValue(row.has_forbidden_membership)
    || booleanValue(row.owns_runtime_object)) {
    throw new Error("RUNTIME_PRODUCT_VERIFIED_CONTEXT_REQUIRED");
  }
}

function runtimeContextValue(principal: DurableRuntimeDatabasePrincipal): "web" | "operations" | "worker" {
  if (principal === "tivdoc_web_runtime") return "web";
  if (principal === "tivdoc_operations_runtime") return "operations";
  return "worker";
}

function isDatabasePrincipal(value: unknown): value is DurableRuntimeDatabasePrincipal {
  return value === "tivdoc_web_runtime"
    || value === "tivdoc_operations_runtime"
    || value === "tivdoc_worker_runtime";
}

async function readCurrentReport(client: PostgresClient, binding: DurableRuntimeTimelineBinding) {
  const result = await client.query(statement("runtime_product_current_report", CURRENT_REPORT, [
    binding.tenant_id,
    binding.case_id,
    binding.report_id,
    binding.report_revision,
    binding.report_sha256,
    binding.pdf_sha256,
    binding.analysis_run_id,
    binding.case_revision,
  ]));
  const row = exactlyOne(result, "RUNTIME_PRODUCT_REPORT_STALE");
  if (positiveInteger(row.case_revision) !== binding.case_revision) throw new Error("RUNTIME_PRODUCT_REPORT_STALE");
  const report = decodeDurableReportArtifacts(row.artifacts_payload);
  if (report.report_id !== binding.report_id
    || report.report_revision !== binding.report_revision
    || report.report_sha256 !== binding.report_sha256
    || report.pdf_sha256 !== binding.pdf_sha256
    || byteSha256(report.pdf) !== binding.pdf_sha256) {
    throw new Error("RUNTIME_PRODUCT_EXACT_BYTES_MISMATCH");
  }
  return report;
}

async function requireCurrentOwner(
  client: PostgresClient,
  identity: CanonicalReportIdentity,
  actorId: string,
): Promise<void> {
  const row = exactlyOne(await client.query(statement(
    "runtime_product_current_owner",
    CURRENT_OWNER,
    [identity.tenant_id, identity.case_id, actorId],
  )), "RUNTIME_PRODUCT_DOWNLOAD_NOT_FOUND");
  if (positiveInteger(row.revision) !== identity.owner_binding_revision
    || hashValue(row.binding_sha256) !== identity.owner_binding_sha256) {
    throw new Error("RUNTIME_PRODUCT_DOWNLOAD_NOT_FOUND");
  }
}

async function readJob(client: PostgresClient, tenantId: string, caseId: string, jobId: string): Promise<DurableJob> {
  const row = exactlyOne(await client.query(statement("runtime_product_job_read", JOB_READ, [
    tenantId,
    caseId,
    jobId,
    DURABLE_RUNTIME_JOB_KIND,
  ])), "RUNTIME_PRODUCT_JOB_NOT_FOUND");
  return decodeJobRow(row);
}

async function requireNextClaimTarget(
  client: PostgresClient,
  name: string,
  text: string,
  values: readonly PostgresParameter[],
  idColumn: "job_id" | "outbox_id",
  expectedId: string,
): Promise<void> {
  const result = await client.query(statement(name, text, values));
  const row = exactlyOne(result, "RUNTIME_PRODUCT_CLAIM_ORDER_BLOCKED");
  if (stringValue(row[idColumn]) !== expectedId) {
    throw new Error("RUNTIME_PRODUCT_CLAIM_ORDER_BLOCKED");
  }
}

async function readJobByCorrelation(
  client: PostgresClient,
  binding: DurableRuntimeTimelineBinding,
): Promise<DurableJob> {
  const row = exactlyOne(await client.query(statement(
    "runtime_product_job_correlation_read",
    JOB_BY_CORRELATION,
    [binding.tenant_id, binding.case_id, DURABLE_RUNTIME_JOB_KIND, binding.correlation_id],
  )), "RUNTIME_PRODUCT_TIMELINE_NOT_FOUND");
  return decodeJobRow(row);
}

function decodeJobRow(row: Readonly<Record<string, unknown>>): DurableJob {
  return Object.freeze({
    job_id: stringValue(row.job_id),
    tenant_id: stringValue(row.tenant_id),
    case_id: nullableString(row.case_id),
    job_kind: stringValue(row.job_kind),
    idempotency_key: stringValue(row.idempotency_key),
    payload: row.payload,
    payload_sha256: hashValue(row.payload_sha256),
    pinned_version_sha256s: stringArray(row.pinned_version_sha256s),
    state: jobState(row.state),
    revision: positiveInteger(row.revision),
    attempt_count: nonNegativeInteger(row.attempt_count),
    max_attempts: positiveInteger(row.max_attempts),
    available_at_ms: nonNegativeInteger(row.available_at_ms),
    lease_owner: nullableString(row.lease_owner),
    lease_expires_at_ms: nullableInteger(row.lease_expires_at_ms),
    fencing_token: nonNegativeInteger(row.fencing_token),
    cancellation_requested: booleanValue(row.cancellation_requested),
    terminal_effect_sha256: nullableHash(row.terminal_effect_sha256),
    replayed_from_job_id: nullableString(row.replayed_from_job_id),
  });
}

async function readOutbox(client: PostgresClient, envelope: DurableRuntimeReportJobEnvelope) {
  const row = exactlyOne(await client.query(statement("runtime_product_outbox_read", OUTBOX_READ, [
    envelope.timeline.tenant_id,
    envelope.timeline.case_id,
    envelope.pipeline.outbox_id,
    envelope.pipeline.logical_effect_id,
  ])), "RUNTIME_PRODUCT_OUTBOX_NOT_FOUND");
  if (stringValue(row.effect_kind) !== DURABLE_RUNTIME_EFFECT_KIND
    || hashValue(row.payload_sha256) !== canonicalSha256(envelope)) {
    throw new Error("RUNTIME_PRODUCT_OUTBOX_MISMATCH");
  }
  const state = outboxState(row.state);
  return Object.freeze({
    state,
    fencing_token: nonNegativeInteger(row.fencing_token),
    published_at: nullableString(row.published_at),
  });
}

async function requireExactEffect(client: PostgresClient, envelope: DurableRuntimeReportJobEnvelope): Promise<void> {
  const row = exactlyOne(await client.query(statement("runtime_product_effect_read", EFFECT_READ, [
    envelope.timeline.tenant_id,
    envelope.pipeline.logical_effect_id,
    envelope.pipeline.outbox_id,
  ])), "RUNTIME_PRODUCT_EFFECT_NOT_FOUND");
  if (hashValue(row.logical_effect_sha256) !== envelope.pipeline.logical_effect_sha256) {
    throw new Error("RUNTIME_PRODUCT_JOB_EFFECT_MISMATCH");
  }
}

async function enqueueOutboxOnce(
  client: PostgresClient,
  repository: Parameters<typeof appendAuditOnce>[1],
  envelope: DurableRuntimeReportJobEnvelope,
  payloadSha256: string,
  createdAt: string,
): Promise<void> {
  const existing = await client.query(statement("runtime_product_outbox_existing", OUTBOX_READ, [
    envelope.timeline.tenant_id,
    envelope.timeline.case_id,
    envelope.pipeline.outbox_id,
    envelope.pipeline.logical_effect_id,
  ]));
  if (existing.row_count === 1 && existing.rows.length === 1) {
    const row = existing.rows[0];
    if (hashValue(row.payload_sha256) !== payloadSha256
      || stringValue(row.effect_kind) !== DURABLE_RUNTIME_EFFECT_KIND) {
      throw new PlatformPersistenceError("IDEMPOTENCY_KEY_COMMAND_MISMATCH");
    }
    return;
  }
  if (existing.row_count !== 0 || existing.rows.length !== 0) throw new Error("RUNTIME_PRODUCT_OUTBOX_MISMATCH");
  await repository.enqueueOutbox({
    outbox_id: envelope.pipeline.outbox_id,
    tenant_id: envelope.timeline.tenant_id,
    case_id: envelope.timeline.case_id,
    logical_effect_id: envelope.pipeline.logical_effect_id,
    effect_kind: DURABLE_RUNTIME_EFFECT_KIND,
    payload_sha256: payloadSha256,
    payload: envelope,
    created_at: createdAt,
  });
}

async function appendAuditOnce(
  client: PostgresClient,
  repository: Readonly<{
    append(input: Readonly<{
      actor_id: string;
      action: string;
      resource_id: string;
      resource_revision: number;
      resource_sha256: string;
      reason: string;
      occurred_at: string;
    }>): Promise<Readonly<{ sequence: number; previous_sha256: string | null; event_sha256: string }>>;
    enqueueOutbox(input: Readonly<{
      outbox_id: string;
      tenant_id: string;
      case_id: string | null;
      logical_effect_id: string;
      effect_kind: string;
      payload_sha256: string;
      payload: unknown;
      created_at: string;
    }>): Promise<void>;
  }>,
  input: Readonly<{
    binding: Pick<DurableRuntimeTimelineBinding, "tenant_id" | "case_id">;
    actor_id: string;
    action: string;
    resource_id: string;
    resource_revision: number;
    resource_sha256: string;
    session_or_process_sha256: string;
    occurred_at: string;
  }>,
) {
  assertHash(input.session_or_process_sha256, "RUNTIME_PRODUCT_TIMELINE_INVALID");
  const existing = await client.query(statement("runtime_product_audit_exact", AUDIT_EXACT, [
    input.binding.tenant_id,
    input.binding.case_id,
    input.actor_id,
    input.action,
    input.resource_id,
    input.resource_revision,
    input.resource_sha256,
  ]));
  if (existing.row_count === 1 && existing.rows[0]) {
    return Object.freeze({
      sequence: positiveInteger(existing.rows[0].case_sequence),
      previous_sha256: null,
      event_sha256: hashValue(existing.rows[0].event_sha256),
      idempotent_replay: true,
    });
  }
  if (existing.row_count !== 0 || existing.rows.length !== 0) throw new Error("RUNTIME_PRODUCT_AUDIT_MISMATCH");
  const appended = await repository.append({
    actor_id: input.actor_id,
    action: input.action,
    resource_id: input.resource_id,
    resource_revision: input.resource_revision,
    resource_sha256: input.resource_sha256,
    reason: `TIVDOC_TIMELINE:${input.session_or_process_sha256}`,
    occurred_at: input.occurred_at,
  });
  return Object.freeze({ ...appended, idempotent_replay: false });
}

async function appendApprovalAudit(
  client: PostgresClient,
  repository: Parameters<typeof appendAuditOnce>[1],
  input: Readonly<{
    binding: DurableRuntimeTimelineBinding;
    identity: VerifiedProductIdentity;
    report_identity: CanonicalReportIdentity;
    storage_locator_sha256: string;
    occurred_at: string;
  }>,
) {
  const auditSha256 = timelineEventSha256(input.binding, "exact_approval", {
    canonical_identity_sha256: input.report_identity.identity_sha256,
    storage_locator_sha256: input.storage_locator_sha256,
  }, {
    actor_id: input.identity.actor.actor_id,
    session_or_process_sha256: verifiedSessionBindingSha256(input.identity),
    session_revision: input.identity.rotation_counter,
  });
  return appendAuditOnce(client, repository, {
    binding: input.binding,
    actor_id: input.identity.actor.actor_id,
    action: "RUNTIME_PRODUCT_EXACT_REPORT_GRANTED",
    resource_id: timelineResourceId(input.binding.correlation_id, "approval"),
    resource_revision: input.report_identity.approval_revision,
    resource_sha256: auditSha256,
    session_or_process_sha256: verifiedSessionBindingSha256(input.identity),
    occurred_at: input.occurred_at,
  });
}

function decodeEnvelope(value: unknown): DurableRuntimeReportJobEnvelope {
  if (!isRecord(value)) invalidEnvelope();
  exactKeys(value, JOB_ENVELOPE_KEYS);
  if (!isRecord(value.timeline) || !isRecord(value.pipeline) || !isRecord(value.storage)) invalidEnvelope();
  exactKeys(value.timeline, TIMELINE_KEYS);
  exactKeys(value.pipeline, PIPELINE_KEYS);
  exactKeys(value.storage, STORAGE_KEYS);
  const timeline = Object.freeze({
    correlation_id: exactString(value.timeline.correlation_id),
    tenant_id: exactString(value.timeline.tenant_id),
    case_id: exactString(value.timeline.case_id),
    case_revision: exactNumber(value.timeline.case_revision),
    owner_binding_revision: exactNumber(value.timeline.owner_binding_revision),
    owner_binding_sha256: exactString(value.timeline.owner_binding_sha256),
    actor_id: exactString(value.timeline.actor_id),
    session_binding_sha256: exactString(value.timeline.session_binding_sha256),
    session_revision: exactNumber(value.timeline.session_revision),
    analysis_run_id: exactString(value.timeline.analysis_run_id),
    report_id: exactString(value.timeline.report_id),
    report_revision: exactNumber(value.timeline.report_revision),
    report_sha256: exactString(value.timeline.report_sha256),
    pdf_sha256: exactString(value.timeline.pdf_sha256),
  });
  const pipeline = Object.freeze({
    job_id: exactString(value.pipeline.job_id),
    outbox_id: exactString(value.pipeline.outbox_id),
    logical_effect_id: exactString(value.pipeline.logical_effect_id),
    idempotency_key: exactString(value.pipeline.idempotency_key),
    logical_effect_sha256: exactString(value.pipeline.logical_effect_sha256),
  });
  const storage = Object.freeze({
    provider_class: exactString(value.storage.provider_class),
    managed_platform_verified: value.storage.managed_platform_verified,
    staging_object_key: exactString(value.storage.staging_object_key),
    quarantine_locator: exactString(value.storage.quarantine_locator),
    locator_sha256: exactString(value.storage.locator_sha256),
  });
  if (value.schema_version !== DURABLE_RUNTIME_PRODUCT_SCHEMA_VERSION
    || value.analysis_mode !== "synthetic_seven_topic_only"
    || value.legal_rules_activated !== 0
    || value.storage.provider_class !== "local_private_immutable_filesystem"
    || value.storage.managed_platform_verified !== false) invalidEnvelope();
  const envelope: DurableRuntimeReportJobEnvelope = Object.freeze({
    schema_version: DURABLE_RUNTIME_PRODUCT_SCHEMA_VERSION,
    analysis_mode: "synthetic_seven_topic_only",
    legal_rules_activated: 0,
    timeline,
    pipeline,
    storage: Object.freeze({
      provider_class: "local_private_immutable_filesystem",
      managed_platform_verified: false,
      staging_object_key: storage.staging_object_key,
      quarantine_locator: storage.quarantine_locator,
      locator_sha256: storage.locator_sha256,
    }),
  });
  assertEnvelope(envelope);
  return envelope;
}

function assertEnvelope(envelope: DurableRuntimeReportJobEnvelope): void {
  exactKeys(envelope, JOB_ENVELOPE_KEYS);
  exactKeys(envelope.timeline, TIMELINE_KEYS);
  exactKeys(envelope.pipeline, PIPELINE_KEYS);
  exactKeys(envelope.storage, STORAGE_KEYS);
  if (envelope.schema_version !== DURABLE_RUNTIME_PRODUCT_SCHEMA_VERSION
    || envelope.analysis_mode !== "synthetic_seven_topic_only"
    || envelope.legal_rules_activated !== 0
    || envelope.storage.provider_class !== "local_private_immutable_filesystem"
    || envelope.storage.managed_platform_verified !== false) invalidEnvelope();
  assertTimelineBinding(envelope.timeline);
  assertPipeline(envelope.pipeline);
  assertHash(envelope.pipeline.logical_effect_sha256, "RUNTIME_PRODUCT_EFFECT_INVALID");
  if (!/^object_[a-f0-9]{48}$/u.test(envelope.storage.staging_object_key)
    || envelope.storage.quarantine_locator
      !== `quarantine/${envelope.timeline.pdf_sha256.slice(0, 2)}/${envelope.storage.staging_object_key}`
    || envelope.storage.locator_sha256
      !== canonicalSha256({ locator: envelope.storage.quarantine_locator })) invalidEnvelope();
  const rebuilt = createDurableRuntimeReportJobEnvelope({
    timeline: envelope.timeline,
    pipeline: {
      job_id: envelope.pipeline.job_id,
      outbox_id: envelope.pipeline.outbox_id,
      logical_effect_id: envelope.pipeline.logical_effect_id,
      idempotency_key: envelope.pipeline.idempotency_key,
    },
  });
  if (rebuilt.pipeline.logical_effect_sha256 !== envelope.pipeline.logical_effect_sha256
    || rebuilt.storage.staging_object_key !== envelope.storage.staging_object_key) invalidEnvelope();
}

function assertTimelineBinding(binding: DurableRuntimeTimelineBinding): void {
  if (!CORRELATION.test(binding.correlation_id)) throw new Error("RUNTIME_PRODUCT_TIMELINE_INVALID");
  for (const value of [
    binding.tenant_id,
    binding.case_id,
    binding.actor_id,
    binding.analysis_run_id,
    binding.report_id,
  ]) assertOpaque(value, "RUNTIME_PRODUCT_TIMELINE_INVALID");
  for (const value of [binding.case_revision, binding.owner_binding_revision, binding.session_revision, binding.report_revision]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("RUNTIME_PRODUCT_TIMELINE_INVALID");
  }
  for (const value of [
    binding.owner_binding_sha256,
    binding.session_binding_sha256,
    binding.report_sha256,
    binding.pdf_sha256,
  ]) assertHash(value, "RUNTIME_PRODUCT_TIMELINE_INVALID");
}

function assertPipeline(pipeline: DurableRuntimePipeline): void {
  for (const value of [pipeline.job_id, pipeline.outbox_id, pipeline.logical_effect_id, pipeline.idempotency_key]) {
    assertOpaque(value, "RUNTIME_PRODUCT_PIPELINE_INVALID");
  }
}

function assertFreshExecutionInput(input: FreshWorkerExecutionInput): void {
  for (const value of [input.worker_id, input.tenant_id, input.case_id, input.correlation_id, input.job_id]) {
    assertOpaque(value, "RUNTIME_PRODUCT_WORKER_INPUT_INVALID");
  }
  assertHash(input.boot_nonce_sha256, "RUNTIME_PRODUCT_WORKER_INPUT_INVALID");
  for (const value of [input.parent_process_id, input.process_id, input.now_ms, input.lease_ms, input.retry_delay_ms]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("RUNTIME_PRODUCT_WORKER_INPUT_INVALID");
  }
  if (input.parent_process_id === input.process_id || input.lease_ms < 1_000 || input.lease_ms > 300_000) {
    throw new Error("RUNTIME_PRODUCT_WORKER_INPUT_INVALID");
  }
}

function assertActor(actor: VerifiedActor, binding: DurableRuntimeTimelineBinding, roles: readonly VerifiedActor["role"][]): void {
  if (actor.verified_server_side !== true || actor.tenant_id !== binding.tenant_id
    || !actor.assigned_case_ids.includes(binding.case_id) || !roles.includes(actor.role)
    || actor.actor_id !== binding.actor_id) throw new Error("RUNTIME_PRODUCT_FORBIDDEN");
}

function assertVerifiedIdentity(
  identity: VerifiedProductIdentity,
  binding: Pick<DurableRuntimeTimelineBinding, "tenant_id" | "case_id">,
  roles: readonly VerifiedActor["role"][],
): void {
  if (identity.actor.verified_server_side !== true || identity.actor.tenant_id !== binding.tenant_id
    || !identity.actor.assigned_case_ids.includes(binding.case_id) || !roles.includes(identity.actor.role)) {
    throw new Error("RUNTIME_PRODUCT_FORBIDDEN");
  }
}

function assertPortalIdentity(identity: VerifiedProductIdentity, tenantId: string, caseId: string): void {
  if (identity.product_audience !== "portal" || identity.actor.role !== "customer_owner"
    || identity.actor.verified_server_side !== true || identity.actor.tenant_id !== tenantId
    || !identity.actor.assigned_case_ids.includes(caseId)) throw new Error("RUNTIME_PRODUCT_DOWNLOAD_NOT_FOUND");
}

function assertRuntimeBoundaryIdentity(
  identity: VerifiedProductIdentity,
  binding: DurableRuntimeTimelineBinding,
): void {
  if (identity.product_audience === "portal") {
    assertPortalIdentity(identity, binding.tenant_id, binding.case_id);
    return;
  }
  if (identity.product_audience !== "operations"
    || identity.actor.verified_server_side !== true
    || identity.actor.tenant_id !== binding.tenant_id
    || !identity.actor.assigned_case_ids.includes(binding.case_id)
    || identity.actor.role === "anonymous"
    || identity.actor.role === "customer_owner"
    || identity.actor.role === "scoped_background_worker") {
    throw new Error("RUNTIME_PRODUCT_FORBIDDEN");
  }
}

function boundaryAuditAction(kind: DurableRuntimeBoundaryEventKind): string {
  if (kind === "ui") return "RUNTIME_PRODUCT_BOUNDARY_UI";
  if (kind === "http") return "RUNTIME_PRODUCT_BOUNDARY_HTTP";
  if (kind === "identity_session") return "RUNTIME_PRODUCT_BOUNDARY_IDENTITY_SESSION";
  if (kind === "canonical_root") return "RUNTIME_PRODUCT_BOUNDARY_CANONICAL_ROOT";
  return "RUNTIME_PRODUCT_BOUNDARY_POSTGRES_TRANSACTION";
}

function auditEventKind(action: string): DurableRuntimeTimelineEvent["event_kind"] {
  if (action === "RUNTIME_PRODUCT_BOUNDARY_UI") return "ui";
  if (action === "RUNTIME_PRODUCT_BOUNDARY_HTTP") return "http";
  if (action === "RUNTIME_PRODUCT_BOUNDARY_IDENTITY_SESSION") return "identity_session";
  if (action === "RUNTIME_PRODUCT_BOUNDARY_CANONICAL_ROOT") return "canonical_root";
  if (action === "RUNTIME_PRODUCT_BOUNDARY_POSTGRES_TRANSACTION") return "postgres_transaction";
  if (action === "RUNTIME_PRODUCT_JOB_OUTBOX_ENQUEUED") return "job_outbox";
  if (action === "RUNTIME_PRODUCT_FRESH_WORKER_STORED") return "fresh_worker";
  if (action === "RUNTIME_PRODUCT_EXACT_REPORT_GRANTED") return "exact_approval";
  if (action === "RUNTIME_PRODUCT_AUTHENTICATED_DOWNLOAD") return "authenticated_download";
  return "audit";
}

function verifiedSessionBindingSha256(identity: VerifiedProductIdentity): string {
  return canonicalSha256({
    schema_version: "tivdoc-verified-session-binding-v0.10.2",
    issuer: identity.issuer,
    audience: identity.audience,
    session_id: identity.session_id,
    token_id: identity.token_id,
    rotation_counter: identity.rotation_counter,
    actor_id: identity.actor.actor_id,
    tenant_id: identity.actor.tenant_id,
  });
}

function identityBinding(identity: CanonicalReportIdentity): Pick<DurableRuntimeTimelineBinding,
  "tenant_id" | "case_id" | "report_id" | "report_revision"
> {
  return Object.freeze({
    tenant_id: identity.tenant_id,
    case_id: identity.case_id,
    report_id: identity.report_id,
    report_revision: identity.report_revision,
  });
}

function identityTimelineBinding(
  identity: CanonicalReportIdentity,
  productIdentity: VerifiedProductIdentity,
  correlationId: string,
): DurableRuntimeTimelineBinding {
  return Object.freeze({
    correlation_id: correlationId,
    tenant_id: identity.tenant_id,
    case_id: identity.case_id,
    case_revision: identity.case_revision,
    owner_binding_revision: identity.owner_binding_revision,
    owner_binding_sha256: identity.owner_binding_sha256,
    actor_id: productIdentity.actor.actor_id,
    session_binding_sha256: verifiedSessionBindingSha256(productIdentity),
    session_revision: productIdentity.rotation_counter,
    analysis_run_id: identity.analysis_run_id,
    report_id: identity.report_id,
    report_revision: identity.report_revision,
    report_sha256: identity.report_sha256,
    pdf_sha256: identity.pdf_sha256,
  });
}

function reportReadInput(identity: CanonicalReportIdentity) {
  return Object.freeze({
    tenant_id: identity.tenant_id,
    case_id: identity.case_id,
    report_id: identity.report_id,
    report_revision: identity.report_revision,
    report_sha256: identity.report_sha256,
    artifact_sha256: identity.pdf_sha256,
    canonical_identity: identity,
  });
}

function resultFromJob(
  job: DurableJob,
  envelope: DurableRuntimeReportJobEnvelope,
  workerProcessSha256: string,
  auditEventSha256: string | null,
  state: FreshWorkerRunResult["state"],
  storageLocatorSha256 = envelope.storage.locator_sha256,
): FreshWorkerRunResult {
  return Object.freeze({
    state,
    job_revision: job.revision,
    fencing_token: job.fencing_token,
    attempt_count: Math.max(job.attempt_count, 1),
    report_sha256: envelope.timeline.report_sha256,
    artifact_sha256: envelope.timeline.pdf_sha256,
    logical_effect_sha256: envelope.pipeline.logical_effect_sha256,
    storage_locator_sha256: storageLocatorSha256,
    worker_process_sha256: workerProcessSha256,
    audit_event_sha256: auditEventSha256,
  });
}

function timelineEventSha256(
  binding: DurableRuntimeTimelineBinding,
  eventKind: string,
  relevant: Readonly<Record<string, unknown>>,
  eventBinding: Readonly<{
    actor_id: string;
    session_or_process_sha256: string;
    session_revision: number;
  }> = Object.freeze({
    actor_id: binding.actor_id,
    session_or_process_sha256: binding.session_binding_sha256,
    session_revision: binding.session_revision,
  }),
): string {
  assertOpaque(eventBinding.actor_id, "RUNTIME_PRODUCT_TIMELINE_INVALID");
  assertHash(eventBinding.session_or_process_sha256, "RUNTIME_PRODUCT_TIMELINE_INVALID");
  if (!Number.isSafeInteger(eventBinding.session_revision) || eventBinding.session_revision < 0) {
    throw new Error("RUNTIME_PRODUCT_TIMELINE_INVALID");
  }
  return canonicalSha256({
    schema_version: "tivdoc-runtime-timeline-event-v0.10.2",
    event_kind: eventKind,
    correlation_id: binding.correlation_id,
    tenant_id: binding.tenant_id,
    case_id: binding.case_id,
    case_revision: binding.case_revision,
    owner_binding_revision: binding.owner_binding_revision,
    owner_binding_sha256: binding.owner_binding_sha256,
    actor_id: eventBinding.actor_id,
    session_or_process_sha256: eventBinding.session_or_process_sha256,
    session_revision: eventBinding.session_revision,
    report_sha256: binding.report_sha256,
    pdf_sha256: binding.pdf_sha256,
    relevant,
  });
}

function timelineResourceId(correlationId: string, suffix: string): string {
  const value = `${correlationId}:${suffix}`;
  assertOpaque(value, "RUNTIME_PRODUCT_CORRELATION_INVALID");
  return value;
}

function decodeGrantPayload(value: unknown): DownloadGrantPayload {
  if (!isRecord(value)) throw new Error("RUNTIME_PRODUCT_DOWNLOAD_NOT_FOUND");
  exactKeys(value, [
    "schema_version", "grant_id", "correlation_id", "tenant_id", "case_id", "actor_id",
    "session_binding_sha256", "session_revision", "report_identity_sha256",
    "object_version_id", "grant_epoch", "issued_at_epoch", "expires_at_epoch",
  ]);
  if (value.schema_version !== DURABLE_DOWNLOAD_GRANT_SCHEMA_VERSION) {
    throw new Error("RUNTIME_PRODUCT_DOWNLOAD_NOT_FOUND");
  }
  const payload: DownloadGrantPayload = Object.freeze({
    schema_version: DURABLE_DOWNLOAD_GRANT_SCHEMA_VERSION,
    grant_id: exactString(value.grant_id),
    correlation_id: exactString(value.correlation_id),
    tenant_id: exactString(value.tenant_id),
    case_id: exactString(value.case_id),
    actor_id: exactString(value.actor_id),
    session_binding_sha256: exactString(value.session_binding_sha256),
    session_revision: exactNumber(value.session_revision),
    report_identity_sha256: exactString(value.report_identity_sha256),
    object_version_id: exactString(value.object_version_id),
    grant_epoch: exactNumber(value.grant_epoch),
    issued_at_epoch: exactNumber(value.issued_at_epoch),
    expires_at_epoch: exactNumber(value.expires_at_epoch),
  });
  for (const item of [payload.grant_id, payload.correlation_id, payload.tenant_id, payload.case_id,
    payload.actor_id, payload.object_version_id]) {
    if (!OPAQUE.test(item)) throw new Error("RUNTIME_PRODUCT_DOWNLOAD_NOT_FOUND");
  }
  for (const hash of [payload.session_binding_sha256, payload.report_identity_sha256]) {
    if (!SHA256.test(hash)) throw new Error("RUNTIME_PRODUCT_DOWNLOAD_NOT_FOUND");
  }
  return payload;
}

function timelineEvents(
  binding: DurableRuntimeTimelineBinding,
  job: DurableJob,
  auditRows: PostgresQueryResult,
  outboxRows: PostgresQueryResult,
  effectRows: PostgresQueryResult,
  objectRows: PostgresQueryResult,
): readonly DurableRuntimeTimelineEvent[] {
  const events: DurableRuntimeTimelineEvent[] = [];
  for (const row of auditRows.rows) {
    const action = stringValue(row.action);
    const eventKind = auditEventKind(action);
    const event = boundTimelineEvent(binding, {
      event_kind: eventKind,
      event_revision: positiveInteger(row.resource_revision),
      actor_id: stringValue(row.actor_id),
      session_or_process_sha256: timelineReasonSha256(row.reason_code),
      relevant_sha256: hashValue(row.resource_sha256),
      occurred_at: nullableString(row.occurred_at),
      state: action,
    });
    events.push(event);
    if (eventKind === "authenticated_download") {
      events.push(boundTimelineEvent(binding, {
        event_kind: "audit",
        event_revision: event.event_revision,
        actor_id: event.actor_id,
        session_or_process_sha256: event.session_or_process_sha256,
        relevant_sha256: hashValue(row.event_sha256),
        occurred_at: event.occurred_at,
        state: "audit_chain_bound",
      }));
    }
  }
  const outbox = outboxRows.row_count === 1 && outboxRows.rows[0] ? outboxRows.rows[0] : null;
  const effect = effectRows.row_count === 1 && effectRows.rows[0] ? effectRows.rows[0] : null;
  events.push(boundTimelineEvent(binding, {
    event_kind: "job_outbox",
    event_revision: job.revision,
    actor_id: job.lease_owner ?? binding.actor_id,
    session_or_process_sha256: binding.session_binding_sha256,
    relevant_sha256: job.terminal_effect_sha256 ?? job.payload_sha256,
    occurred_at: effect ? nullableString(effect.committed_at) : null,
    state: outbox ? `${job.state}:${stringValue(outbox.state)}` : job.state,
  }));
  if (objectRows.row_count === 1 && objectRows.rows[0]) {
    const object = objectRows.rows[0];
    const workerEvent = events.find((event) => event.event_kind === "fresh_worker");
    const locator = stringValue(object.provider_locator);
    if (locator.includes("://") || locator.includes("..")) throw new Error("RUNTIME_PRODUCT_TIMELINE_STORAGE_INVALID");
    events.push(boundTimelineEvent(binding, {
      event_kind: "private_storage",
      event_revision: nonNegativeInteger(object.grant_epoch),
      actor_id: workerEvent?.actor_id ?? job.lease_owner ?? "tivdoc_worker_runtime",
      session_or_process_sha256: workerEvent?.session_or_process_sha256
        ?? job.terminal_effect_sha256
        ?? binding.session_binding_sha256,
      relevant_sha256: canonicalSha256({
        object_version_id: stringValue(object.object_version_id),
        provider_locator_sha256: canonicalSha256({ locator }),
        byte_length: positiveInteger(object.byte_length),
        artifact_sha256: hashValue(object.artifact_sha256),
        state: stringValue(object.state),
      }),
      occurred_at: nullableString(object.created_at),
      state: stringValue(object.state),
    }));
  }
  if (effect) {
    const workerEvent = events.find((event) => event.event_kind === "fresh_worker");
    events.push(boundTimelineEvent(binding, {
      event_kind: "job_outbox",
      event_revision: job.revision,
      actor_id: workerEvent?.actor_id ?? job.lease_owner ?? "tivdoc_worker_runtime",
      session_or_process_sha256: workerEvent?.session_or_process_sha256
        ?? job.terminal_effect_sha256
        ?? binding.session_binding_sha256,
      relevant_sha256: hashValue(effect.logical_effect_sha256),
      occurred_at: nullableString(effect.committed_at),
      state: "logical_effect_committed",
    }));
  }
  const order: Readonly<Record<DurableRuntimeTimelineEvent["event_kind"], number>> = Object.freeze({
    ui: 0,
    http: 1,
    identity_session: 2,
    canonical_root: 3,
    postgres_transaction: 4,
    job_outbox: 5,
    fresh_worker: 6,
    private_storage: 7,
    exact_approval: 8,
    authenticated_download: 9,
    audit: 10,
  });
  return Object.freeze(events.sort((left, right) => order[left.event_kind] - order[right.event_kind]
    || left.event_revision - right.event_revision));
}

function boundTimelineEvent(
  binding: DurableRuntimeTimelineBinding,
  event: Omit<DurableRuntimeTimelineEvent,
    "correlation_id" | "tenant_id" | "case_id" | "case_revision"
    | "owner_binding_revision" | "owner_binding_sha256" | "report_revision" | "report_sha256"
  >,
): DurableRuntimeTimelineEvent {
  return Object.freeze({
    correlation_id: binding.correlation_id,
    tenant_id: binding.tenant_id,
    case_id: binding.case_id,
    case_revision: binding.case_revision,
    owner_binding_revision: binding.owner_binding_revision,
    owner_binding_sha256: binding.owner_binding_sha256,
    report_revision: binding.report_revision,
    report_sha256: binding.report_sha256,
    ...event,
  });
}

function exactlyOne(result: PostgresQueryResult, code: string): Readonly<Record<string, unknown>> {
  if (result.row_count !== 1 || result.rows.length !== 1 || !result.rows[0]) throw new Error(code);
  return result.rows[0];
}

function exactKeys(value: object, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalidEnvelope();
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") invalidEnvelope();
  return value;
}

function exactString(value: unknown): string {
  return stringValue(value);
}

function exactNumber(value: unknown): number {
  if (typeof value !== "number") invalidEnvelope();
  return value;
}

function positiveInteger(value: unknown): number {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || typeof parsed !== "number" || parsed < 1) invalidEnvelope();
  return parsed;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || typeof parsed !== "number" || parsed < 0) invalidEnvelope();
  return parsed;
}

function nullableInteger(value: unknown): number | null {
  return value === null ? null : nonNegativeInteger(value);
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") invalidEnvelope();
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return stringValue(value);
}

function hashValue(value: unknown): string {
  const hash = stringValue(value);
  if (!SHA256.test(hash)) invalidEnvelope();
  return hash;
}

function timelineReasonSha256(value: unknown): string {
  const reason = stringValue(value);
  const prefix = "TIVDOC_TIMELINE:";
  if (!reason.startsWith(prefix)) invalidEnvelope();
  return hashValue(reason.slice(prefix.length));
}

function nullableHash(value: unknown): string | null {
  return value === null ? null : hashValue(value);
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) invalidEnvelope();
  return Object.freeze([...value]);
}

function jobState(value: unknown): DurableJob["state"] {
  const state = stringValue(value);
  if (state === "queued" || state === "leased" || state === "running"
    || state === "succeeded" || state === "retry_wait" || state === "cancelled"
    || state === "dead_letter") return state;
  invalidEnvelope();
}

function outboxState(value: unknown): "pending" | "leased" | "published" {
  const state = stringValue(value);
  if (state === "pending" || state === "leased" || state === "published") return state;
  throw new Error("RUNTIME_PRODUCT_OUTBOX_MISMATCH");
}

function assertHash(value: string, code: string): void {
  if (!SHA256.test(value)) throw new Error(code);
}

function assertOpaque(value: string, code: string): void {
  if (!OPAQUE.test(value)) throw new Error(code);
}

function assertCorrelation(value: string, code: string): void {
  if (!CORRELATION.test(value)) throw new Error(code);
}

function assertTimestamp(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || Number.isNaN(Date.parse(value))) throw new Error("RUNTIME_PRODUCT_TIMESTAMP_INVALID");
}

function byteSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidEnvelope(): never {
  throw new Error("RUNTIME_PRODUCT_JOB_ENVELOPE_INVALID");
}
