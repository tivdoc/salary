import "../routes/server-boundary.ts";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { factPathSchema, type FactPath } from "../../../engine/facts/fact-paths.ts";
import { canonicalSha256 } from "../../../engine/rule-runtime/canonical.ts";
import type { CaseLifecycleState } from "../../../engine/wave3/contracts.ts";
import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";
import { statement, type PostgresTransactionContext } from "../../platform/persistence/postgres/contracts.ts";
import { PostgresIntakeError } from "../../platform/persistence/postgres/intake/errors.ts";
import { PostgresCaseLifecycleRepository } from "../../platform/persistence/postgres/intake/repositories.ts";
import {
  PostgresCaseOwnerRepository,
  PostgresPrivacyRequestRepository,
  PostgresPrivateReportObjectRepository,
} from "../durable-postgres/boundary-repositories.ts";
import {
  createDurableRuntimeProductIdentityContext,
  createDurableRuntimeProductRegistrar,
} from "../durable-postgres/runtime-product-lane.ts";
import type { CanonicalReportIdentity } from "../durable-postgres/report-identity.ts";
import { durableProductIdentityFromActor } from "../auth/identity-session.ts";
import type { LocalRuntimePrivateBlobProvider } from "../../platform/storage/local-runtime/private-blob-provider.ts";
import type { DurableProductRouteContext, DurableProductRouteServiceAdapter } from "../routes/durable-registration.ts";
import {
  PORTAL_SCHEMA_VERSION,
  STATUS_LABELS_HE,
  PortalError,
  customerSafeStatus,
  type CustomerClarificationTask,
  type CustomerReportProjection,
  type PortalCaseProjection,
  type PrivacyRequestRevision,
  type ReportAccessGrant,
} from "./contracts.ts";
import type {
  CustomerPortalApplicationPort,
  PortalAnswerInput,
  PortalPrivacyInput,
  ReportDownload,
} from "./repository.ts";

const BLOCKED_TOPICS = Object.freeze([
  "minimum_wage", "working_time", "pension", "travel", "convalescence", "vacation", "sick_leave",
].map((topic) => `legal_topic_not_ready:${topic}`));
const LIFECYCLE_STATES = Object.freeze([
  "awaiting_payment", "awaiting_documents", "awaiting_extraction_review", "awaiting_fact_resolution",
  "ready_for_legal_evaluation", "awaiting_legal_review", "awaiting_report_approval", "report_ready",
  "release_hold", "delivered", "cancelled",
] satisfies readonly CaseLifecycleState[]);
const JSON_VALUE = z.json();

export type DurableCustomerPortalDependencies = Readonly<{
  storage: LocalRuntimePrivateBlobProvider;
  download_grant_hmac_key: Uint8Array;
  now?: () => Date;
}>;

/** Stable portal adapter. Every read and mutation re-enters the verified web-role transaction. */
export class DurableCustomerPortalPostgresApplication implements CustomerPortalApplicationPort {
  readonly #context: DurableProductRouteContext;
  readonly #storage: LocalRuntimePrivateBlobProvider;
  readonly #grantKey: Uint8Array;
  readonly #now: () => Date;

  constructor(context: DurableProductRouteContext, dependencies: DurableCustomerPortalDependencies) {
    const productProof = context.product.proof();
    if (context.postgres.mode !== "isolated_postgres"
        || context.postgres.durable !== true
        || context.session_context.proof_class !== "LEAST_PRIVILEGE_VERIFIED_SESSION_CONTEXT"
        || context.session_context.uses_service_role !== false
        || context.session_context.bypasses_rls !== false
        || context.session_context.postgres !== context.postgres
        || productProof.persistence_mode !== "isolated_postgres"
        || productProof.durable !== true
        || productProof.product_reachable_memory_fallbacks !== 0
        || dependencies.storage.proof().provider_kind !== "local_private_immutable_filesystem"
        || dependencies.storage.managed_platform_verified !== false
        || !(dependencies.download_grant_hmac_key instanceof Uint8Array)
        || dependencies.download_grant_hmac_key.byteLength < 32
        || dependencies.download_grant_hmac_key.byteLength > 128
        || (dependencies.now !== undefined && typeof dependencies.now !== "function")) {
      throw new Error("DURABLE_PORTAL_RUNTIME_DEPENDENCY_INVALID");
    }
    this.#context = context;
    this.#storage = dependencies.storage;
    this.#grantKey = Uint8Array.from(dependencies.download_grant_hmac_key);
    this.#now = dependencies.now ?? (() => new Date());
  }

  async getCaseProjection(actor: VerifiedActor, caseId: string): Promise<PortalCaseProjection> {
    return this.#withActor(actor, caseId, async (context, tenantId) => {
      await requireOwner(context, tenantId, caseId, actor.actor_id);
      const state = await readState(context, tenantId, caseId);
      const history = await readHistory(context, tenantId, caseId);
      const documents = await readDocuments(context, tenantId, caseId);
      const clarifications = await readClarifications(context, tenantId, caseId);
      const reports = await readReports(context, tenantId, caseId);
      const status = customerSafeStatus(
        state.lifecycle_state,
        clarifications.some((task) => task.status === "open"),
        BLOCKED_TOPICS.length,
        reports.length > 0,
      );
      const unsigned = Object.freeze({
        schema_version: PORTAL_SCHEMA_VERSION,
        case_id: caseId,
        revision: state.revision,
        status,
        status_label_he: STATUS_LABELS_HE[status],
        status_timeline: Object.freeze(history.map((event) => {
          const itemStatus = customerSafeStatus(event.lifecycle_state, false, 0);
          return Object.freeze({
            revision: event.revision,
            status: itemStatus,
            status_label_he: STATUS_LABELS_HE[itemStatus],
            occurred_at: event.occurred_at,
          });
        })),
        blocker_codes: BLOCKED_TOPICS,
        document_references: documents,
        clarification_tasks: clarifications,
        reports,
        retention: Object.freeze({
          retention_class: "local_synthetic_product_proof",
          legal_hold: false,
          deletion_status: "not_requested" as const,
        }),
      });
      return Object.freeze({ ...unsigned, projection_sha256: canonicalSha256(unsigned) });
    });
  }

  async listReports(actor: VerifiedActor, caseId: string): Promise<readonly CustomerReportProjection[]> {
    return this.#withActor(actor, caseId, async (context, tenantId) => {
      await requireOwner(context, tenantId, caseId, actor.actor_id);
      return readReports(context, tenantId, caseId);
    });
  }

  async answerClarification(
    actor: VerifiedActor,
    input: PortalAnswerInput & Readonly<{ expected_revision: number }>,
  ): Promise<Readonly<{ candidate: ReturnType<typeof declaredCandidate>; idempotent_replay: boolean }>> {
    const tenantId = requireTenant(actor);
    const occurredAt = this.#occurredAt();
    const answer = jsonValue(input.value);
    const command = Object.freeze({
      action: "portal_clarification_answer",
      tenant_id: tenantId,
      case_id: input.case_id,
      task_id: input.task_id,
      question_version: input.question_version,
      value: answer,
      explicit_confirmation: input.explicit_confirmation,
      consent_version: input.consent_version,
      terms_version: input.terms_version,
    });
    const commandSha256 = canonicalSha256(command);
    const receipt = await portalMutation(() => this.#context.session_context.transaction({
      actor,
      audience: "portal",
      case_id: input.case_id,
      correlation_id: correlation("portal-answer"),
    }, async (bundle) => {
      await requireOwner(bundle.context, tenantId, input.case_id, actor.actor_id);
      const task = await readClarification(bundle.context, tenantId, input.case_id, input.task_id);
      if (!task || task.question_version !== input.question_version) throw new PortalError("PORTAL_NOT_FOUND");
      return bundle.runtime.idempotency.execute(bundle.context, {
        tenant_id: tenantId,
        case_id: input.case_id,
        actor_id: actor.actor_id,
        scope: "portal_clarification_answer",
        idempotency_key: input.idempotency_key,
        expected_case_revision: input.expected_revision,
        command_sha256: commandSha256,
        command,
        occurred_at: occurredAt,
        writes: Object.freeze([]),
        invalidates: Object.freeze([]),
        outbox: Object.freeze([]),
      }, async () => {
        const state = await requireExpectedState(bundle.context, bundle.intake.case_lifecycle, tenantId,
          input.case_id, input.expected_revision);
        const answerSha256 = canonicalSha256({ command_sha256: commandSha256, value: answer });
        const conversationId = task.conversation_id;
        const messageId = `message:${answerSha256.slice(0, 48)}`;
        await bundle.intake.conversations.appendMessage(bundle.context, {
          tenant_id: tenantId,
          case_id: input.case_id,
          message_id: messageId,
          conversation_id: conversationId,
          analysis_run_id: task.analysis_run_id,
          role: "customer",
          agent: null,
          question_id: task.question_id,
          question_version: task.question_version,
          selected_option_ids: [],
          free_text_answer: typeof answer === "string" ? answer : null,
          content: typeof answer === "string" ? answer : JSON.stringify(answer),
          model_provider: null,
          model_identifier: null,
          prompt_version: null,
          idempotency_key: `message.${input.idempotency_key}`,
          created_at: occurredAt,
        });
        await bundle.analysis.traceFindings.persistConfirmation({
          confirmation_id: `confirmation:${answerSha256.slice(0, 48)}`,
          case_id: input.case_id,
          source_analysis_run_id: task.analysis_run_id,
          target_fact_path: task.fact_path,
          question_id: task.question_id,
          question_version: task.question_version,
          proposed_value: null,
          answer,
          status: "confirmed",
          source_message_id: messageId,
          idempotency_key: `confirmation.${input.idempotency_key}`,
          created_at: occurredAt,
          answered_at: occurredAt,
        });
        const next = await advanceRevision(bundle.context, bundle.intake.case_lifecycle, {
          tenant_id: tenantId,
          case_id: input.case_id,
          expected_revision: input.expected_revision,
          lifecycle_state: state.lifecycle_state,
          command_sha256: commandSha256,
          event_kind: "portal.clarification.answered",
          occurred_at: occurredAt,
        });
        const audit = await bundle.runtime.jobs_outbox_audit.append({
          actor_id: actor.actor_id,
          action: "PORTAL_CLARIFICATION_ANSWERED",
          resource_id: input.task_id,
          resource_revision: next.revision,
          resource_sha256: answerSha256,
          reason: "DECLARED_FACT_REQUIRES_HUMAN_REVIEW",
          occurred_at: occurredAt,
        });
        return Object.freeze({
          tenant_id: tenantId,
          case_id: input.case_id,
          case_revision: next.revision,
          command_sha256: commandSha256,
          audit_event_sha256: audit.event_sha256,
          outbox_ids: Object.freeze([]),
          idempotent_replay: false,
        });
      });
    }));
    return Object.freeze({
      candidate: declaredCandidate(Object.freeze({ ...input, value: answer }), receipt.case_revision, commandSha256),
      idempotent_replay: receipt.idempotent_replay,
    });
  }

  async createPrivacyRequest(
    actor: VerifiedActor,
    input: PortalPrivacyInput & Readonly<{ expected_revision: number }>,
  ): Promise<Readonly<{ request: PrivacyRequestRevision; idempotent_replay: boolean }>> {
    const tenantId = requireTenant(actor);
    const occurredAt = this.#occurredAt();
    const requestId = `privacy:${canonicalSha256({ tenant_id: tenantId, key: input.idempotency_key }).slice(0, 48)}`;
    const durableKind = input.request_kind === "data_export" ? "export" : input.request_kind;
    const command = Object.freeze({ action: "portal_privacy_request", tenant_id: tenantId, ...input, request_id: requestId });
    const commandSha256 = canonicalSha256(command);
    const outcome = await portalMutation(() => this.#context.session_context.transaction({
      actor,
      audience: "portal",
      case_id: input.case_id,
      correlation_id: correlation("portal-privacy"),
    }, async (bundle) => {
      await requireOwner(bundle.context, tenantId, input.case_id, actor.actor_id);
      const receipt = await bundle.runtime.idempotency.execute(bundle.context, {
        tenant_id: tenantId,
        case_id: input.case_id,
        actor_id: actor.actor_id,
        scope: "portal_privacy_request",
        idempotency_key: input.idempotency_key,
        expected_case_revision: input.expected_revision,
        command_sha256: commandSha256,
        command,
        occurred_at: occurredAt,
        writes: Object.freeze([]),
        invalidates: Object.freeze([]),
        outbox: Object.freeze([]),
      }, async () => {
        const state = await requireExpectedState(bundle.context, bundle.intake.case_lifecycle, tenantId,
          input.case_id, input.expected_revision);
        const stored = await new PostgresPrivacyRequestRepository(bundle.context.client).append({
          request_id: requestId,
          tenant_id: tenantId,
          case_id: input.case_id,
          revision: 1,
          request_kind: durableKind,
          state: "requested",
          idempotency_key: input.idempotency_key,
          legal_hold_conflict: false,
          grant_revocation_receipt_sha256: null,
          created_at: occurredAt,
        });
        const next = await advanceRevision(bundle.context, bundle.intake.case_lifecycle, {
          tenant_id: tenantId,
          case_id: input.case_id,
          expected_revision: input.expected_revision,
          lifecycle_state: state.lifecycle_state,
          command_sha256: commandSha256,
          event_kind: "portal.privacy.requested",
          occurred_at: occurredAt,
        });
        const audit = await bundle.runtime.jobs_outbox_audit.append({
          actor_id: actor.actor_id,
          action: "PORTAL_PRIVACY_REQUESTED",
          resource_id: stored.request_id,
          resource_revision: next.revision,
          resource_sha256: stored.command_sha256,
          reason: "PRIVACY_REQUEST_REQUIRES_AUTHORIZED_OPERATIONS",
          occurred_at: occurredAt,
        });
        return Object.freeze({ tenant_id: tenantId, case_id: input.case_id, case_revision: next.revision,
          command_sha256: commandSha256, audit_event_sha256: audit.event_sha256,
          outbox_ids: Object.freeze([]), idempotent_replay: false });
      });
      const stored = await readPrivacyRequest(bundle.context, {
        tenant_id: tenantId,
        case_id: input.case_id,
        request_id: requestId,
        idempotency_key: input.idempotency_key,
        request_kind: durableKind,
      });
      return Object.freeze({ receipt, stored });
    }));
    const request = Object.freeze({
      request_id: requestId,
      case_id: input.case_id,
      request_kind: input.request_kind,
      revision: outcome.stored.revision,
      status: outcome.stored.status,
      idempotency_key: input.idempotency_key,
      command_sha256: commandSha256,
      receipt_sha256: canonicalSha256({
        request_id: requestId,
        revision: outcome.stored.revision,
        status: outcome.stored.status,
        command_sha256: commandSha256,
        stored_command_sha256: outcome.stored.command_sha256,
      }),
      created_at: outcome.stored.created_at,
    });
    return Object.freeze({ request, idempotent_replay: outcome.receipt.idempotent_replay });
  }

  async createReportAccessGrant(
    actor: VerifiedActor,
    caseId: string,
    reportId: string,
    expectedRevision: number,
  ): Promise<ReportAccessGrant> {
    const identity = durableProductIdentityFromActor(actor, "portal");
    const tenantId = requireTenant(actor);
    const reportIdentity = await this.#context.session_context.transaction({
      actor,
      audience: "portal",
      case_id: caseId,
      correlation_id: correlation("portal-grant-read"),
    }, async (bundle) => {
      await requireOwner(bundle.context, tenantId, caseId, actor.actor_id);
      const state = await readState(bundle.context, tenantId, caseId);
      if (state.revision !== expectedRevision) throw new PortalError("PORTAL_REVISION_CONFLICT");
      return requireReportIdentity(bundle.context, tenantId, caseId, reportId);
    });
    const runtime = createDurableRuntimeProductIdentityContext({ postgres: this.#context.postgres, identity });
    const registrar = createDurableRuntimeProductRegistrar({ context: runtime, storage: this.#storage,
      download_grant_hmac_key: this.#grantKey });
    const now = this.#nowDate();
    const issued = await concealDownloadFailure(() => registrar.issueDownloadGrant({
        identity,
        report_identity: reportIdentity,
        correlation_id: correlation("portal-download"),
        now_epoch: Math.floor(now.getTime() / 1_000),
        ttl_seconds: 120,
      }));
    return Object.freeze({
      grant_id: issued.token,
      case_id: caseId,
      report_id: reportId,
      artifact_sha256: reportIdentity.pdf_sha256,
      object_version_id: reportIdentity.storage_object_version_id,
      expires_at: new Date(issued.expires_at_epoch * 1_000).toISOString(),
      grant_sha256: issued.grant_sha256,
    });
  }

  async downloadReport(actor: VerifiedActor, grant: ReportAccessGrant): Promise<ReportDownload> {
    if (byteSha256(Buffer.from(grant.grant_id, "utf8")) !== grant.grant_sha256) {
      throw new PortalError("PORTAL_NOT_FOUND");
    }
    const identity = durableProductIdentityFromActor(actor, "portal");
    const tenantId = requireTenant(actor);
    const reportIdentity = await this.#context.session_context.transaction({
      actor,
      audience: "portal",
      case_id: grant.case_id,
      correlation_id: correlation("portal-download-read"),
    }, async (bundle) => {
      await requireOwner(bundle.context, tenantId, grant.case_id, actor.actor_id);
      const current = await requireReportIdentity(bundle.context, tenantId, grant.case_id, grant.report_id,
        grant.object_version_id);
      if (current.pdf_sha256 !== grant.artifact_sha256) throw new PortalError("PORTAL_NOT_FOUND");
      return current;
    });
    const runtime = createDurableRuntimeProductIdentityContext({ postgres: this.#context.postgres, identity });
    const registrar = createDurableRuntimeProductRegistrar({ context: runtime, storage: this.#storage,
      download_grant_hmac_key: this.#grantKey });
    const now = this.#nowDate();
    const downloaded = await concealDownloadFailure(() => registrar.download({
        identity,
        report_identity: reportIdentity,
        grant_token: grant.grant_id,
        now_epoch: Math.floor(now.getTime() / 1_000),
        occurred_at: now.toISOString(),
      }));
    return Object.freeze({
      bytes: downloaded.bytes,
      artifact_sha256: grant.artifact_sha256,
      object_version_id: grant.object_version_id,
      content_type: "application/pdf",
      filename: "tivdoc-report.pdf",
    });
  }

  async #withActor<T>(
    actor: VerifiedActor,
    caseId: string,
    operation: (context: PostgresTransactionContext, tenantId: string) => Promise<T>,
  ): Promise<T> {
    const tenantId = requireTenant(actor);
    return this.#context.session_context.transaction({
      actor,
      audience: "portal",
      case_id: caseId,
      correlation_id: correlation("portal-read"),
    }, (bundle) =>
      operation(bundle.context, tenantId));
  }

  #occurredAt(): string {
    return this.#nowDate().toISOString();
  }

  #nowDate(): Date {
    const value = this.#now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error("DURABLE_PORTAL_CLOCK_INVALID");
    }
    return value;
  }
}

export function createDurableCustomerPortalAdapter(
  context: DurableProductRouteContext,
  dependencies: DurableCustomerPortalDependencies,
): DurableProductRouteServiceAdapter<CustomerPortalApplicationPort> {
  return Object.freeze({
    service: new DurableCustomerPortalPostgresApplication(context, dependencies),
    postgres: context.postgres,
    product: context.product,
    session_context: context.session_context,
    proof_class: "POSTGRESQL_TRANSACTIONAL_ROUTE_SERVICE",
  });
}

async function requireOwner(
  context: PostgresTransactionContext,
  tenantId: string,
  caseId: string,
  subject: string,
): Promise<void> {
  const owner = await new PostgresCaseOwnerRepository(context.client).lookup({ tenant_id: tenantId, case_id: caseId, subject });
  if (!owner || owner.status !== "active") throw new PortalError("PORTAL_NOT_FOUND");
}

async function readState(context: PostgresTransactionContext, tenantId: string, caseId: string) {
  const result = await context.client.query(statement("portal_case_state_read", `
    select revision::text, lifecycle_state
    from public.engine_case_state
    where tenant_id = $1 and canonical_case_id = $2
    limit 1`, [tenantId, caseId]));
  const row = one(result.rows, "PORTAL_NOT_FOUND");
  return Object.freeze({ revision: count(row.revision), lifecycle_state: lifecycle(row.lifecycle_state) });
}

async function readHistory(context: PostgresTransactionContext, tenantId: string, caseId: string) {
  const result = await context.client.query(statement("portal_case_history_read", `
    select history.revision::text, history.state_after as lifecycle_state, history.occurred_at
    from public.engine_case_lifecycle_revisions history
    join public.engine_case_identity identity on identity.internal_case_id = history.case_id
    where history.tenant_id = $1 and identity.canonical_case_id = $2
    order by history.revision`, [tenantId, caseId]));
  return Object.freeze(result.rows.map((row) => Object.freeze({
    revision: count(row.revision), lifecycle_state: lifecycle(row.lifecycle_state), occurred_at: timestamp(row.occurred_at),
  })));
}

async function readDocuments(context: PostgresTransactionContext, tenantId: string, caseId: string) {
  const result = await context.client.query(statement("portal_documents_read", `
    select canonical_document_id as document_id, document_type
    from public.documents
    where tenant_id = $1 and canonical_case_id = $2
    order by canonical_document_id`, [tenantId, caseId]));
  return Object.freeze(result.rows.map((row) => Object.freeze({
    document_id: opaque(row.document_id),
    declared_type: documentType(row.document_type),
    status: "accepted" as const,
    revision: 1,
  })));
}

async function readClarifications(
  context: PostgresTransactionContext,
  tenantId: string,
  caseId: string,
): Promise<readonly CustomerClarificationTask[]> {
  const result = await context.client.query(statement("portal_clarifications_read", `
    select confirmation.canonical_confirmation_id as task_id,
           confirmation.canonical_case_id as case_id,
           confirmation.canonical_analysis_run_id as analysis_run_id,
           confirmation.target_fact_path, confirmation.question_id,
           confirmation.question_version::text, conversation.canonical_conversation_id as conversation_id,
           question.content as prompt,
           exists (
             select 1 from public.case_confirmations answer
             where answer.tenant_id = confirmation.tenant_id
               and answer.canonical_case_id = confirmation.canonical_case_id
               and answer.question_id = confirmation.question_id
               and answer.question_version = confirmation.question_version
               and answer.status <> 'pending'
           ) as answered
    from public.case_confirmations confirmation
    join public.case_conversations conversation
      on conversation.tenant_id = confirmation.tenant_id
     and conversation.canonical_case_id = confirmation.canonical_case_id
     and conversation.canonical_analysis_run_id = confirmation.canonical_analysis_run_id
    left join lateral (
      select message.content from public.case_messages message
      where message.tenant_id = confirmation.tenant_id
        and message.canonical_case_id = confirmation.canonical_case_id
        and message.question_id = confirmation.question_id
        and message.question_version = confirmation.question_version
        and message.role = 'system'
      order by message.created_at desc limit 1
    ) question on true
    where confirmation.tenant_id = $1 and confirmation.canonical_case_id = $2
      and confirmation.status = 'pending'
    order by confirmation.created_at, confirmation.canonical_confirmation_id`, [tenantId, caseId]));
  return Object.freeze(result.rows.map(clarificationTask));
}

function clarificationTask(row: Readonly<Record<string, unknown>>): CustomerClarificationTask {
  const factPath = factPathSchema.parse(row.target_fact_path);
  const taskId = opaque(row.task_id);
  const caseId = opaque(row.case_id);
  const questionId = opaque(row.question_id);
  const questionVersion = positive(row.question_version);
  const dependencySha256 = canonicalSha256({ task_id: taskId, case_id: caseId, fact_path: factPath, question_id: questionId,
    question_version: questionVersion });
  const unsigned = Object.freeze({
    task_id: taskId,
    case_id: caseId,
    fact_path: factPath,
    origin: "missing_fact" as const,
    question_code: questionId,
    question_version: questionVersion,
    prompt_he: typeof row.prompt === "string" && row.prompt.length > 0 ? row.prompt : "נא להשלים את המידע החסר.",
    dependency_sha256: dependencySha256,
    conflicting_fact_ids: Object.freeze([]),
    status: row.answered === true ? "answered" as const : "open" as const,
    requires_human_review: true as const,
  });
  return Object.freeze({ ...unsigned, task_sha256: canonicalSha256(unsigned) });
}

async function readClarification(context: PostgresTransactionContext, tenantId: string, caseId: string, taskId: string) {
  const result = await context.client.query(statement("portal_clarification_exact_read", `
    select confirmation.canonical_confirmation_id as task_id,
           confirmation.canonical_analysis_run_id as analysis_run_id,
           confirmation.target_fact_path, confirmation.question_id,
           confirmation.question_version::text, conversation.canonical_conversation_id as conversation_id
    from public.case_confirmations confirmation
    join public.case_conversations conversation
      on conversation.tenant_id = confirmation.tenant_id
     and conversation.canonical_case_id = confirmation.canonical_case_id
     and conversation.canonical_analysis_run_id = confirmation.canonical_analysis_run_id
    where confirmation.tenant_id = $1 and confirmation.canonical_case_id = $2
      and confirmation.canonical_confirmation_id = $3 and confirmation.status = 'pending'
    order by conversation.created_at desc limit 1`, [tenantId, caseId, taskId]));
  if (result.rows.length !== 1 || !result.rows[0]) return null;
  const row = result.rows[0];
  return Object.freeze({
    task_id: opaque(row.task_id),
    analysis_run_id: opaque(row.analysis_run_id),
    fact_path: factPathSchema.parse(row.target_fact_path),
    question_id: opaque(row.question_id),
    question_version: positive(row.question_version),
    conversation_id: opaque(row.conversation_id),
  });
}

async function readReports(
  context: PostgresTransactionContext,
  tenantId: string,
  caseId: string,
): Promise<readonly CustomerReportProjection[]> {
  const result = await context.client.query(statement("portal_reports_read", `
    select object.report_id, object.report_revision::text, object.report_sha256,
           object.grant_epoch::text
    from public.product_private_report_objects object
    join public.engine_case_state state
      on state.tenant_id = object.tenant_id and state.canonical_case_id = object.canonical_case_id
    where object.tenant_id = $1 and object.canonical_case_id = $2
      and object.state = 'approved' and object.revoked_at is null
      and object.report_revision = state.revision
      and state.lifecycle_state not in ('release_hold','cancelled')
    order by object.report_revision desc, object.report_id`, [tenantId, caseId]));
  const repository = new PostgresPrivateReportObjectRepository(context.client);
  const reports: CustomerReportProjection[] = [];
  for (const row of result.rows) {
    const reportId = opaque(row.report_id);
    const reportRevision = positive(row.report_revision);
    const reportSha256 = hash(row.report_sha256);
    const identity = await repository.currentCanonicalIdentity({
      tenant_id: tenantId,
      case_id: caseId,
      report_id: reportId,
      report_revision: reportRevision,
      download_grant_revision: count(row.grant_epoch),
    });
    if (!identity || identity.report_sha256 !== reportSha256) continue;
    reports.push(Object.freeze({
      report_id: reportId,
      report_revision: reportRevision,
      edition: "screening_summary" as const,
      report_sha256: reportSha256,
      scope_status: "screening_with_blockers" as const,
      blocker_codes: BLOCKED_TOPICS,
      customer_message_he: "הדוח הסינתטי אושר הנדסית; בדיקת הדין האמיתית עדיין חסומה לביקורת אנושית.",
      released: true as const,
    }));
  }
  return Object.freeze(reports);
}

async function requireReportIdentity(
  context: PostgresTransactionContext,
  tenantId: string,
  caseId: string,
  reportId: string,
  objectVersionId?: string,
): Promise<CanonicalReportIdentity> {
  const result = await context.client.query(statement("portal_report_locator_read", `
    select report_revision::text, grant_epoch::text, object_version_id
    from public.product_private_report_objects
    where tenant_id = $1 and canonical_case_id = $2 and report_id = $3
      and state = 'approved' and revoked_at is null
      and ($4::text is null or object_version_id = $4)
    order by report_revision desc limit 1`, [tenantId, caseId, reportId, objectVersionId ?? null]));
  const row = one(result.rows, "PORTAL_NOT_FOUND");
  const identity = await new PostgresPrivateReportObjectRepository(context.client).currentCanonicalIdentity({
    tenant_id: tenantId,
    case_id: caseId,
    report_id: reportId,
    report_revision: positive(row.report_revision),
    download_grant_revision: count(row.grant_epoch),
  });
  if (!identity || (objectVersionId && identity.storage_object_version_id !== objectVersionId)) {
    throw new PortalError("PORTAL_NOT_FOUND");
  }
  return identity;
}

async function readPrivacyRequest(
  context: PostgresTransactionContext,
  input: Readonly<{
    tenant_id: string;
    case_id: string;
    request_id: string;
    idempotency_key: string;
    request_kind: string;
  }>,
): Promise<Readonly<{
  revision: number;
  status: PrivacyRequestRevision["status"];
  command_sha256: string;
  created_at: string;
}>> {
  const result = await context.client.query(statement("portal_privacy_request_read", `
    select revision::text, request_kind, state, idempotency_key, command_sha256, created_at
    from public.product_privacy_request_versions
    where tenant_id = $1 and canonical_case_id = $2 and request_id = $3
    order by revision desc
    limit 1`, [input.tenant_id, input.case_id, input.request_id]));
  const row = one(result.rows, "PORTAL_NOT_FOUND");
  if (row.request_kind !== input.request_kind || row.idempotency_key !== input.idempotency_key) {
    throw new PortalError("PORTAL_NOT_FOUND");
  }
  return Object.freeze({
    revision: positive(row.revision),
    status: privacyStatus(row.state),
    command_sha256: hash(row.command_sha256),
    created_at: timestamp(row.created_at),
  });
}

async function requireExpectedState(
  context: PostgresTransactionContext,
  repository: PostgresCaseLifecycleRepository,
  tenantId: string,
  caseId: string,
  expectedRevision: number,
): Promise<Readonly<{ revision: number; lifecycle_state: CaseLifecycleState }>> {
  const state = await repository.get(context, { tenant_id: tenantId, case_id: caseId });
  if (!state) throw new PortalError("PORTAL_NOT_FOUND");
  if (state.revision !== expectedRevision) throw new PortalError("PORTAL_REVISION_CONFLICT");
  return Object.freeze({ revision: state.revision, lifecycle_state: state.lifecycle_state });
}

async function advanceRevision(
  context: PostgresTransactionContext,
  repository: PostgresCaseLifecycleRepository,
  input: Readonly<{
    tenant_id: string;
    case_id: string;
    expected_revision: number;
    lifecycle_state: CaseLifecycleState;
    command_sha256: string;
    event_kind: string;
    occurred_at: string;
  }>,
) {
  const previous = await context.client.query(statement("portal_lifecycle_tail_read", `
    select history.event_sha256
    from public.engine_case_lifecycle_revisions history
    join public.engine_case_identity identity on identity.internal_case_id = history.case_id
    where history.tenant_id = $1 and identity.canonical_case_id = $2
    order by history.revision desc limit 1`, [input.tenant_id, input.case_id]));
  const previousSha256 = previous.rows[0] ? hash(previous.rows[0].event_sha256) : null;
  const revision = input.expected_revision + 1;
  const stateSha256 = canonicalSha256({ tenant_id: input.tenant_id, case_id: input.case_id, revision,
    lifecycle_state: input.lifecycle_state, command_sha256: input.command_sha256 });
  const eventSha256 = canonicalSha256({ previous_sha256: previousSha256, state_sha256: stateSha256,
    event_kind: input.event_kind, occurred_at: input.occurred_at });
  return repository.append(context, {
    tenant_id: input.tenant_id,
    case_id: input.case_id,
    expected_revision: input.expected_revision,
    state_before: input.lifecycle_state,
    state_after: input.lifecycle_state,
    event_kind: input.event_kind,
    command_sha256: input.command_sha256,
    event_sha256: eventSha256,
    previous_sha256: previousSha256,
    state_sha256: stateSha256,
    occurred_at: input.occurred_at,
  });
}

function declaredCandidate(input: PortalAnswerInput, revision: number, commandSha256: string) {
  const candidateId = `candidate:${commandSha256.slice(0, 48)}`;
  const unsigned = Object.freeze({
    candidate_id: candidateId,
    case_id: input.case_id,
    fact_path: "documents.period" as FactPath,
    revision,
    value: input.value,
    status: "candidate" as const,
    provenance: Object.freeze({
      source_type: "declared" as const,
      source_reference: Object.freeze({
        kind: "portal_clarification_answer" as const,
        answer_id: candidateId,
        question_id: input.task_id,
        question_version: input.question_version,
        consent_version: input.consent_version,
        terms_version: input.terms_version,
        explicit_confirmation: true as const,
      }),
    }),
    conflicting_documented_fact_ids: Object.freeze([]),
    requires_human_review: true as const,
  });
  return Object.freeze({ ...unsigned, candidate_sha256: canonicalSha256(unsigned) });
}

async function concealDownloadFailure<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("RUNTIME_PRODUCT_DOWNLOAD_")) {
      throw new PortalError("PORTAL_NOT_FOUND");
    }
    throw error;
  }
}

async function portalMutation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PostgresIntakeError && error.code === "INTAKE_REVISION_CONFLICT") {
      throw new PortalError("PORTAL_REVISION_CONFLICT");
    }
    throw error;
  }
}

function jsonValue(value: unknown): z.infer<typeof JSON_VALUE> {
  const parsed = JSON_VALUE.safeParse(value);
  if (!parsed.success) throw new PortalError("INVALID_REQUEST");
  return parsed.data;
}

function correlation(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}

function requireTenant(actor: VerifiedActor): string {
  if (actor.tenant_id === null) throw new PortalError("PORTAL_NOT_FOUND");
  return actor.tenant_id;
}

function opaque(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._-]{2,255}$/u.test(value)) throw new PortalError("PORTAL_NOT_FOUND");
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new PortalError("PORTAL_NOT_FOUND");
  return value;
}

function byteSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function count(value: unknown): number {
  const number = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 0) throw new PortalError("PORTAL_NOT_FOUND");
  return number;
}

function positive(value: unknown): number {
  const number = count(value);
  if (number < 1) throw new PortalError("PORTAL_NOT_FOUND");
  return number;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new PortalError("PORTAL_NOT_FOUND");
  return new Date(value).toISOString();
}

function lifecycle(value: unknown): CaseLifecycleState {
  if (typeof value !== "string" || !isLifecycleState(value)) throw new PortalError("PORTAL_NOT_FOUND");
  return value;
}

function documentType(value: unknown): string {
  if (value === "contract") return "employment_agreement";
  if (value === "attendance") return "timesheet";
  if (value === "payslip") return value;
  throw new PortalError("PORTAL_NOT_FOUND");
}

function privacyStatus(value: unknown): PrivacyRequestRevision["status"] {
  if (value === "requested" || value === "acknowledged"
      || value === "restricted_by_legal_hold"
      || value === "completed_by_authorized_operations") return value;
  throw new PortalError("PORTAL_NOT_FOUND");
}

function one(rows: readonly Readonly<Record<string, unknown>>[], code: string): Readonly<Record<string, unknown>> {
  if (rows.length !== 1 || !rows[0]) throw new PortalError(code);
  return rows[0];
}

function isLifecycleState(value: string): value is CaseLifecycleState {
  return LIFECYCLE_STATES.some((state) => state === value);
}
