import "../routes/server-boundary.ts";

import type { DateRange } from "../../../engine/domain/primitives.ts";
import {
  dateRangeSchema,
  isoTimestampSchema,
  uuidSchema,
} from "../../../engine/domain/primitives.ts";
import { immutableDocumentSchema } from "../../../engine/domain/documents.ts";
import { extractionResultSchema } from "../../../engine/extraction/contracts.ts";
import { employmentSnapshotSchema } from "../../../engine/facts/snapshot.ts";
import { canonicalSha256, deepFreeze } from "../../../engine/rule-runtime/canonical.ts";
import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";
import {
  DurableMultiDocumentIntakeApplication,
  type DurableMultiDocumentIntakeCommand,
  type DurableMultiDocumentIntakeReceipt,
  type DurableMultiDocumentSnapshotPort,
  type DurableMultiDocumentSourceSnapshot,
  type DurableMultiDocumentTransactionBundle,
} from "../../engine/multi-document-intake/application.ts";
import type { TransactionScopedPostgresBundle } from "../../platform/composition/canonical-postgres.ts";
import type { PostgresAnalysisRepositories } from "../../platform/persistence/postgres/analysis/index.ts";
import { validateCanonicalConfirmation } from "../../platform/persistence/postgres/analysis/traces.ts";
import {
  statement,
  type PostgresQueryResult,
  type PostgresTransactionContext,
} from "../../platform/persistence/postgres/contracts.ts";
import type { PostgresIntakeAdapterBundle } from "../../platform/persistence/postgres/intake/index.ts";
import type { CaseConfirmation } from "../../engine/persistence-contracts.ts";
import { actorScopePermits, rolePermits } from "../internal-ops/policy.ts";
import type {
  DurableProductRouteContext,
  DurableProductRouteServiceAdapter,
} from "../routes/durable-registration.ts";

export const DURABLE_MULTI_DOCUMENT_PRODUCT_SCHEMA_VERSION =
  "tivdoc-durable-multi-document-product-v0.10.2" as const;

const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,95}$/u;
const WARNING_CODE = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;

const SOURCE_SNAPSHOT_SQL = `
with selected_run as materialized (
  select ar.id, ar.created_at, ar.command_payload
    from public.analysis_runs ar
    join public.engine_case_state state
      on state.case_id = ar.case_id
     and state.tenant_id = ar.tenant_id
     and state.canonical_case_id = ar.canonical_case_id
   where ar.tenant_id = $1
     and ar.canonical_case_id = $2
     and ar.canonical_analysis_run_id = $3
     and ar.case_revision = state.revision
   limit 1
   for update of state, ar
),
selected_documents as materialized (
  select document.canonical_document_id as sort_id,
         document.content_sha256,
         jsonb_build_object(
           'document_id', document.canonical_document_id,
           'case_id', document.canonical_case_id,
           'document_type', coalesce(document.declared_type, document.document_type),
           'original_filename', document.original_filename,
           'mime_type', document.mime_type,
           'size_bytes', document.size,
           'content_sha256', document.content_sha256,
           'storage_path', document.storage_path,
           'document_period', case
             when document.period_start is null and document.period_end is null then null
             else jsonb_build_object(
               'start_date', document.period_start::text,
               'end_date', document.period_end::text
             )
           end,
           'supersedes_document_id', predecessor.canonical_document_id,
           'created_at', to_char(document.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         ) as payload
    from public.documents document
    cross join selected_run
    left join public.documents predecessor
      on predecessor.id = document.supersedes_document_id
     and predecessor.tenant_id = document.tenant_id
   where document.tenant_id = $1
     and document.canonical_case_id = $2
     and document.storage_layout = 'immutable_v1'
     and document.processing_status <> 'rejected'
     and (
       document.period_start is null
       or (
         document.period_start <= $5::date
         and coalesce(document.period_end, document.period_start) >= $4::date
       )
     )
),
latest_extractions as materialized (
  select distinct on (extraction.canonical_document_id)
         extraction.canonical_document_id as sort_id,
         extraction.payload
    from public.document_extractions extraction
    join selected_documents document
      on document.sort_id = extraction.canonical_document_id
   where extraction.tenant_id = $1
     and extraction.canonical_case_id = $2
     and extraction.source_content_sha256 = document.content_sha256
     and extraction.payload is not null
   order by extraction.canonical_document_id, extraction.created_at desc, extraction.id desc
),
current_facts as materialized (
  select distinct on (fact.fact_id)
         fact.payload ->> 'path' || E'\\x1f' || fact.fact_id as sort_path,
         fact.payload,
         fact.created_at
    from public.engine_canonical_fact_versions fact
    cross join selected_run
   where fact.tenant_id = $1
     and fact.canonical_case_id = $2
     and fact.canonical_analysis_run_id = $3
     and fact.payload ? 'path'
   order by fact.fact_id, fact.revision desc
),
source_confirmations as materialized (
  select confirmation.canonical_confirmation_id as sort_id,
         jsonb_build_object(
           'confirmation_id', confirmation.canonical_confirmation_id,
           'case_id', confirmation.canonical_case_id,
           'source_analysis_run_id', confirmation.canonical_analysis_run_id,
           'target_fact_path', confirmation.target_fact_path,
           'question_id', confirmation.question_id,
           'question_version', confirmation.question_version,
           'proposed_value', confirmation.proposed_value,
           'answer', confirmation.answer,
           'status', confirmation.status,
           'source_message_id', confirmation.canonical_source_message_id,
           'idempotency_key', confirmation.idempotency_key,
           'created_at', to_char(confirmation.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'answered_at', case when confirmation.answered_at is null then null
             else to_char(confirmation.answered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end
         ) as payload
    from public.case_confirmations confirmation
    cross join selected_run
   where confirmation.tenant_id = $1
     and confirmation.canonical_case_id = $2
     and confirmation.canonical_analysis_run_id = $3
)
select
  coalesce((select jsonb_agg(payload order by sort_id) from selected_documents), '[]'::jsonb) as documents,
  coalesce((select jsonb_agg(payload order by sort_id) from latest_extractions), '[]'::jsonb) as extractions,
  coalesce((select jsonb_agg(payload order by sort_path) from current_facts), '[]'::jsonb) as facts,
  coalesce((select jsonb_agg(payload order by sort_id) from source_confirmations), '[]'::jsonb) as confirmations,
  case when jsonb_typeof(selected_run.command_payload -> 'prior_warning_codes') = 'array'
    then selected_run.command_payload -> 'prior_warning_codes'
    else '[]'::jsonb
  end as prior_warning_codes,
  to_char(
    coalesce((select max(created_at) from current_facts), selected_run.created_at) at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) as snapshot_created_at
from selected_run`;

export type DurableMultiDocumentProductProof = Readonly<{
  schema_version: typeof DURABLE_MULTI_DOCUMENT_PRODUCT_SCHEMA_VERSION;
  persistence: "isolated_postgres";
  source_snapshot_statements: 1;
  canonical_transaction_contexts: 1;
  reconcile_audience: "operations";
  clarification_answer_path: "canonical_customer_portal_application";
  canonical_document_contract_reused: true;
  canonical_extraction_contract_reused: true;
  canonical_fact_contract_reused: true;
  canonical_clarification_contract_reused: true;
  product_reachable_memory_fallbacks: 0;
  legal_conclusions_created: 0;
  calculations_created: 0;
}>;

export type DurableMultiDocumentProductReconcileInput = Readonly<{
  actor: VerifiedActor;
  command: DurableMultiDocumentIntakeCommand;
  correlation_id: string;
}>;

export type DurableMultiDocumentProductTransactionInput =
  DurableMultiDocumentProductReconcileInput & Readonly<{
    transaction: TransactionScopedPostgresBundle<
      PostgresIntakeAdapterBundle,
      PostgresAnalysisRepositories
    >;
  }>;

export interface DurableMultiDocumentProductApplication {
  proof(): DurableMultiDocumentProductProof;
  reconcile(input: DurableMultiDocumentProductReconcileInput): Promise<DurableMultiDocumentIntakeReceipt>;
  reconcileInTransaction(
    input: DurableMultiDocumentProductTransactionInput,
  ): Promise<DurableMultiDocumentIntakeReceipt>;
}

export type DurableMultiDocumentProductRouteAdapter = DurableProductRouteServiceAdapter<
  DurableMultiDocumentProductApplication
> & Readonly<{ product_proof: DurableMultiDocumentProductProof }>;

/**
 * Reads the complete durable intake source at one PostgreSQL statement
 * snapshot. The required period is passed by the validated product command,
 * so unrelated historical documents cannot leak into the projection.
 */
export class PostgresDurableMultiDocumentSnapshotPort implements DurableMultiDocumentSnapshotPort {
  readonly persistence_mode = "isolated_postgres" as const;
  readonly product_reachable_memory_fallbacks = 0 as const;

  async load(
    context: PostgresTransactionContext,
    input: Readonly<{
      tenant_id: string;
      case_id: string;
      analysis_run_id: string;
      required_period: DateRange;
    }>,
  ): Promise<DurableMultiDocumentSourceSnapshot> {
    assertContext(context);
    const caseId = uuidSchema.parse(input.case_id);
    const analysisRunId = uuidSchema.parse(input.analysis_run_id);
    const requiredPeriod = dateRangeSchema.parse(input.required_period);
    if (!input.tenant_id || input.tenant_id.length > 160) {
      throw new Error("DURABLE_MULTI_DOCUMENT_PRODUCT_OWNER_INVALID");
    }
    const result = await context.client.query(statement(
      "product_multi_document_source_snapshot",
      SOURCE_SNAPSHOT_SQL,
      [
        input.tenant_id,
        caseId,
        analysisRunId,
        requiredPeriod.start_date,
        requiredPeriod.end_date ?? requiredPeriod.start_date,
      ],
    ));
    return parseSourceSnapshot(result, caseId, analysisRunId);
  }
}

class PostgresDurableMultiDocumentProductApplication implements DurableMultiDocumentProductApplication {
  readonly #context: DurableProductRouteContext;
  readonly #application: DurableMultiDocumentIntakeApplication;
  readonly #now: () => Date;

  constructor(
    context: DurableProductRouteContext,
    application: DurableMultiDocumentIntakeApplication,
    now: () => Date,
  ) {
    this.#context = context;
    this.#application = application;
    this.#now = now;
  }

  proof(): DurableMultiDocumentProductProof {
    return PRODUCT_PROOF;
  }

  async reconcile(
    input: DurableMultiDocumentProductReconcileInput,
  ): Promise<DurableMultiDocumentIntakeReceipt> {
    const validated = this.#validate(input);
    return this.#context.session_context.transaction({
      actor: input.actor,
      audience: "operations",
      case_id: validated.caseId,
      correlation_id: validated.correlationId,
    }, (transaction) => this.#reconcileTransaction(transaction, input.command));
  }

  async reconcileInTransaction(
    input: DurableMultiDocumentProductTransactionInput,
  ): Promise<DurableMultiDocumentIntakeReceipt> {
    this.#validate(input);
    if (input.transaction.intake.tenant_id !== input.actor.tenant_id) {
      throw new Error("DURABLE_MULTI_DOCUMENT_PRODUCT_TRANSACTION_OWNER_MISMATCH");
    }
    return this.#reconcileTransaction(input.transaction, input.command);
  }

  async #reconcileTransaction(
    transaction: DurableMultiDocumentTransactionBundle,
    command: DurableMultiDocumentIntakeCommand,
  ): Promise<DurableMultiDocumentIntakeReceipt> {
    return this.#application.reconcile(transaction, command);
  }

  #validate(input: DurableMultiDocumentProductReconcileInput): Readonly<{
    caseId: string;
    correlationId: string;
  }> {
    const caseId = uuidSchema.parse(input.command.case_id);
    const now = this.#now();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error("DURABLE_MULTI_DOCUMENT_PRODUCT_CLOCK_INVALID");
    }
    if (
      input.actor.verified_server_side !== true
      || input.actor.tenant_id === null
      || !rolePermits(input.actor.role, "command.analysis_request")
      || !actorScopePermits(input.actor, caseId, now.toISOString())
    ) {
      throw new Error("DURABLE_MULTI_DOCUMENT_PRODUCT_FORBIDDEN");
    }
    if (!CORRELATION_ID.test(input.correlation_id)) {
      throw new Error("DURABLE_MULTI_DOCUMENT_PRODUCT_CORRELATION_INVALID");
    }
    return Object.freeze({ caseId, correlationId: input.correlation_id });
  }
}

const PRODUCT_PROOF: DurableMultiDocumentProductProof = Object.freeze({
  schema_version: DURABLE_MULTI_DOCUMENT_PRODUCT_SCHEMA_VERSION,
  persistence: "isolated_postgres",
  source_snapshot_statements: 1,
  canonical_transaction_contexts: 1,
  reconcile_audience: "operations",
  clarification_answer_path: "canonical_customer_portal_application",
  canonical_document_contract_reused: true,
  canonical_extraction_contract_reused: true,
  canonical_fact_contract_reused: true,
  canonical_clarification_contract_reused: true,
  product_reachable_memory_fallbacks: 0,
  legal_conclusions_created: 0,
  calculations_created: 0,
});

/**
 * Composition-only registrar. It deliberately returns the same structural
 * adapter proof used by portal/operations instead of installing another
 * runtime root or constructing an alternate repository family.
 */
export function createDurableMultiDocumentProductRouteAdapter(
  context: DurableProductRouteContext,
  dependencies: Readonly<{ now?: () => Date }> = Object.freeze({}),
): DurableMultiDocumentProductRouteAdapter {
  const productProof = context.product.proof();
  if (
    context.postgres.mode !== "isolated_postgres"
    || context.postgres.durable !== true
    || context.session_context.proof_class !== "LEAST_PRIVILEGE_VERIFIED_SESSION_CONTEXT"
    || context.session_context.uses_service_role !== false
    || context.session_context.bypasses_rls !== false
    || context.session_context.postgres !== context.postgres
    || productProof.persistence_mode !== "isolated_postgres"
    || productProof.durable !== true
    || productProof.product_reachable_memory_fallbacks !== 0
    || (dependencies.now !== undefined && typeof dependencies.now !== "function")
  ) {
    throw new Error("DURABLE_MULTI_DOCUMENT_PRODUCT_ROOT_INVALID");
  }
  const source = new PostgresDurableMultiDocumentSnapshotPort();
  const application = new DurableMultiDocumentIntakeApplication(source);
  const service = new PostgresDurableMultiDocumentProductApplication(
    context,
    application,
    dependencies.now ?? (() => new Date()),
  );
  return Object.freeze({
    service,
    postgres: context.postgres,
    product: context.product,
    session_context: context.session_context,
    proof_class: "POSTGRESQL_TRANSACTIONAL_ROUTE_SERVICE" as const,
    product_proof: service.proof(),
  });
}

function parseSourceSnapshot(
  result: PostgresQueryResult,
  caseId: string,
  analysisRunId: string,
): DurableMultiDocumentSourceSnapshot {
  const row = result.rows[0];
  if (result.row_count !== 1 || result.rows.length !== 1 || !row) {
    throw new Error("DURABLE_MULTI_DOCUMENT_PRODUCT_SOURCE_NOT_FOUND");
  }
  const documents = array(row.documents, "DOCUMENTS").map((value) => immutableDocumentSchema.parse(value));
  const extractions = array(row.extractions, "EXTRACTIONS").map((value) => extractionResultSchema.parse(value));
  const facts = array(row.facts, "FACTS");
  const confirmations = resolveConfirmationAnswers(
    array(row.confirmations, "CONFIRMATIONS").map((value) => validateCanonicalConfirmation(record(value))),
  );
  const warnings = uniqueSorted(array(row.prior_warning_codes, "WARNINGS").map((value) => {
    if (typeof value !== "string" || !WARNING_CODE.test(value)) {
      throw new Error("DURABLE_MULTI_DOCUMENT_PRODUCT_WARNINGS_INVALID");
    }
    return value;
  }));
  const createdAt = isoTimestampSchema.parse(row.snapshot_created_at);
  const snapshotId = uuidFromHash(canonicalSha256({
    case_id: caseId,
    analysis_run_id: analysisRunId,
    facts,
  }));
  const factSnapshot = employmentSnapshotSchema.parse({
    snapshot_id: snapshotId,
    case_id: caseId,
    analysis_run_id: analysisRunId,
    schema_version: "1.0.0",
    facts,
    created_at: createdAt,
  });
  return deepFreeze({
    documents,
    extractions,
    fact_snapshot: factSnapshot,
    prior_confirmations: confirmations,
    prior_warning_codes: warnings,
  });
}

/**
 * Portal answers are immutable rows. Resolve them onto their original pending
 * question identity for intake currentness without mutating either row or
 * inventing a second clarification model.
 */
function resolveConfirmationAnswers(
  confirmations: readonly CaseConfirmation[],
): readonly CaseConfirmation[] {
  const answered = confirmations
    .filter((confirmation) => confirmation.status !== "pending")
    .sort((left, right) => compareStrings(
      `${right.answered_at ?? ""}\u0000${right.confirmation_id}`,
      `${left.answered_at ?? ""}\u0000${left.confirmation_id}`,
    ));
  return Object.freeze(confirmations.map((confirmation) => {
    if (confirmation.status !== "pending") return confirmation;
    const current = answered.find((candidate) =>
      candidate.case_id === confirmation.case_id
      && candidate.source_analysis_run_id === confirmation.source_analysis_run_id
      && candidate.target_fact_path === confirmation.target_fact_path
      && candidate.question_id === confirmation.question_id
      && candidate.question_version === confirmation.question_version
      && (candidate.answered_at ?? "") >= confirmation.created_at);
    if (!current) return confirmation;
    return validateCanonicalConfirmation(deepFreeze({
      ...confirmation,
      answer: current.answer,
      status: current.status,
      source_message_id: current.source_message_id,
      answered_at: current.answered_at,
    }));
  }));
}

function assertContext(context: PostgresTransactionContext): void {
  if (!context || typeof context.transaction_id !== "string" || context.transaction_id.length === 0
      || !context.client || typeof context.client.query !== "function") {
    throw new Error("DURABLE_MULTI_DOCUMENT_PRODUCT_TRANSACTION_REQUIRED");
  }
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`DURABLE_MULTI_DOCUMENT_PRODUCT_${label}_INVALID`);
  return value;
}

function record(value: unknown): CaseConfirmation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("DURABLE_MULTI_DOCUMENT_PRODUCT_CONFIRMATIONS_INVALID");
  }
  return value as CaseConfirmation;
}

function uuidFromHash(hash: string): string {
  return uuidSchema.parse(
    `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareStrings));
}

export const __durableMultiDocumentProductTest = Object.freeze({
  SOURCE_SNAPSHOT_SQL,
  parseSourceSnapshot,
  resolveConfirmationAnswers,
});
