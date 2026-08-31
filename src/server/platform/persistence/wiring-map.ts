export const PERSISTENCE_WIRING_STATUSES = [
  "WIRED_DURABLE",
  "IMPLEMENTED_NOT_WIRED",
  "CONTRACT_ONLY",
  "IN_MEMORY_ONLY",
  "DUPLICATE_CONTRACT",
  "SCHEMA_ONLY",
  "MISSING",
] as const;

export type PersistenceWiringStatus = (typeof PERSISTENCE_WIRING_STATUSES)[number];

export const PERSISTENCE_CAPABILITIES = [
  "cases_and_lifecycle_revisions",
  "payment_evidence_references",
  "conversations_and_messages",
  "documents_and_artifact_references",
  "extractions",
  "canonical_facts_and_conflicts",
  "hypotheses_and_rule_inputs",
  "corpus_source_parameter_rule_pins",
  "analysis_runs_and_resume_cursors",
  "per_topic_results",
  "traces_findings_confirmations",
  "reports_approvals_release_state",
  "idempotency",
  "jobs_fencing_outbox_audit",
] as const;

export type PersistenceCapability = (typeof PERSISTENCE_CAPABILITIES)[number];

export type PersistenceWiringEntry = Readonly<{
  capability: PersistenceCapability;
  canonical_contract: readonly string[];
  implementation: readonly string[];
  tables_or_migration: readonly string[];
  ownership_key: string;
  revision_or_idempotency: string;
  transaction_boundary: string;
  composition_root_binding: string;
  non_test_callers: readonly string[];
  adapter_kinds: readonly string[];
  status: PersistenceWiringStatus;
}>;

const PLATFORM_MIGRATION = "supabase/migrations/202608310001_engine_platform_persistence.sql";
const FOUNDATION_MIGRATION = "supabase/migrations/202608290001_engine_persistence_foundation.sql";
const NO_PRODUCT_CALLER = ["none located in product-reachable non-test entrypoints"] as const;

/**
 * Audit truth at the frozen V0.8 contract commit. A row is never marked
 * WIRED_DURABLE merely because a SQL table or an exported class exists.
 */
export const PERSISTENCE_WIRING_MAP: readonly PersistenceWiringEntry[] = Object.freeze([
  entry({
    capability: "cases_and_lifecycle_revisions",
    canonical_contract: ["src/engine/wave3/contracts.ts:CaseOperationsPort", "src/server/platform/persistence/contracts.ts:AtomicCommand"],
    implementation: ["src/server/platform/persistence/transactional-store.ts:LocalDurablePlatformStore"],
    tables_or_migration: [`${PLATFORM_MIGRATION}:engine_case_state,engine_case_lifecycle_revisions`],
    ownership_key: "tenant_id + case_id",
    revision_or_idempotency: "expected_case_revision + append-only lifecycle revision",
    transaction_boundary: "LocalDurablePlatformStore clone-and-commit gate only; no PostgreSQL adapter is bound",
    composition_root_binding: "memory_test_only branch of createCanonicalPersistenceComposition",
    non_test_callers: NO_PRODUCT_CALLER,
    adapter_kinds: ["schema", "memory_test_adapter"],
    status: "IN_MEMORY_ONLY",
  }),
  entry({
    capability: "payment_evidence_references",
    canonical_contract: ["src/engine/wave3/contracts.ts:VerifiedPaymentEvidencePort"],
    implementation: ["src/server/engine/case-operations/verified-payment-evidence.ts:InMemoryVerifiedPaymentEvidenceStore"],
    tables_or_migration: [`${PLATFORM_MIGRATION}:engine_payment_evidence_refs`],
    ownership_key: "tenant_id through case_id",
    revision_or_idempotency: "evidence_revision + evidence_sha256",
    transaction_boundary: "schema describes append-only rows; no PostgreSQL repository method is bound",
    composition_root_binding: "not bound by canonical persistence composition",
    non_test_callers: NO_PRODUCT_CALLER,
    adapter_kinds: ["schema", "memory_test_adapter"],
    status: "IN_MEMORY_ONLY",
  }),
  entry({
    capability: "conversations_and_messages",
    canonical_contract: ["src/server/engine/persistence-contracts.ts:ConversationPersistenceInput,MessagePersistenceInput"],
    implementation: ["src/server/engine/conversation-repository.ts:ConversationRepository"],
    tables_or_migration: [`${FOUNDATION_MIGRATION}:case_conversations,case_messages`],
    ownership_key: "case_id; same-case triggers",
    revision_or_idempotency: "per-conversation/message idempotency keys and guarded status transition",
    transaction_boundary: "individual Supabase REST statements; no command-scoped shared transaction",
    composition_root_binding: "repository self-constructs getSupabaseAdmin when no client is supplied; canonical root does not bind it",
    non_test_callers: NO_PRODUCT_CALLER,
    adapter_kinds: ["supabase_rest_repository", "schema"],
    status: "IMPLEMENTED_NOT_WIRED",
  }),
  entry({
    capability: "documents_and_artifact_references",
    canonical_contract: ["src/server/engine/document-repository.ts:EngineDocumentRepository", "src/engine/wave4/contracts.ts:ObjectStoragePort"],
    implementation: ["src/server/engine/document-repository.ts:EngineDocumentRepository", "src/server/platform/storage/private-object-storage.ts:LocalPrivateObjectStorage"],
    tables_or_migration: [`${FOUNDATION_MIGRATION}:documents`, `${PLATFORM_MIGRATION}:engine_object_write_sagas`],
    ownership_key: "case_id; storage scope_ref authorization",
    revision_or_idempotency: "content_sha256 + object reservation idempotency",
    transaction_boundary: "database metadata and local object bytes do not share a PostgreSQL transaction",
    composition_root_binding: "local storage is available only in memory_test_only composition; durable document repository is unbound",
    non_test_callers: NO_PRODUCT_CALLER,
    adapter_kinds: ["supabase_rest_read_repository", "local_test_storage", "schema"],
    status: "IMPLEMENTED_NOT_WIRED",
  }),
  entry({
    capability: "extractions",
    canonical_contract: ["src/server/engine/persistence-contracts.ts:DocumentExtractionAttempt"],
    implementation: ["src/server/engine/extraction-repository.ts:ExtractionRepository"],
    tables_or_migration: [`${FOUNDATION_MIGRATION}:document_extractions`],
    ownership_key: "through document.case_id",
    revision_or_idempotency: "document_id + idempotency_key; guarded status transition",
    transaction_boundary: "individual Supabase REST statements",
    composition_root_binding: "not bound by canonical persistence composition",
    non_test_callers: NO_PRODUCT_CALLER,
    adapter_kinds: ["supabase_rest_repository", "schema"],
    status: "IMPLEMENTED_NOT_WIRED",
  }),
  entry({
    capability: "canonical_facts_and_conflicts",
    canonical_contract: ["src/engine/facts/snapshot.ts:employmentSnapshotSchema", "src/engine/facts/conflicts.ts"],
    implementation: ["no PostgreSQL repository implementation located for engine_canonical_fact_versions or conflict revisions"],
    tables_or_migration: [`${PLATFORM_MIGRATION}:engine_canonical_fact_versions`],
    ownership_key: "tenant_id through case_id",
    revision_or_idempotency: "fact_id + revision + payload_sha256",
    transaction_boundary: "SQL schema only",
    composition_root_binding: "not bound",
    non_test_callers: NO_PRODUCT_CALLER,
    adapter_kinds: ["schema"],
    status: "SCHEMA_ONLY",
  }),
  entry({
    capability: "hypotheses_and_rule_inputs",
    canonical_contract: ["src/server/engine/persistence-contracts.ts:HypothesisPersistenceInput", "src/engine/rule-input/contracts.ts"],
    implementation: ["src/server/engine/investigation-repository.ts:InvestigationRepository.saveHypothesis", "no PostgreSQL RuleInput repository located"],
    tables_or_migration: [`${FOUNDATION_MIGRATION}:analysis_hypotheses`, `${PLATFORM_MIGRATION}:engine_rule_input_versions`],
    ownership_key: "analysis_run_id through case_id",
    revision_or_idempotency: "hypothesis idempotency key; RuleInput revision + payload_sha256",
    transaction_boundary: "individual Supabase REST statement for hypotheses; RuleInput schema only",
    composition_root_binding: "not bound",
    non_test_callers: NO_PRODUCT_CALLER,
    adapter_kinds: ["partial_supabase_rest_repository", "schema"],
    status: "IMPLEMENTED_NOT_WIRED",
  }),
  entry({
    capability: "corpus_source_parameter_rule_pins",
    canonical_contract: ["src/engine/case-analysis/contracts.ts:PinnedAnalysisDependencies"],
    implementation: ["no PostgreSQL repository implementation located"],
    tables_or_migration: [`${PLATFORM_MIGRATION}:engine_legal_version_pins`],
    ownership_key: "analysis_run_id + case_id",
    revision_or_idempotency: "pin_kind + version_id + immutable version_sha256",
    transaction_boundary: "SQL schema only",
    composition_root_binding: "not bound",
    non_test_callers: NO_PRODUCT_CALLER,
    adapter_kinds: ["schema"],
    status: "SCHEMA_ONLY",
  }),
  entry({
    capability: "analysis_runs_and_resume_cursors",
    canonical_contract: ["src/engine/case-analysis/contracts.ts:CaseAnalysisRepositoryPort", "src/server/engine/persistence-contracts.ts:AnalysisRunPersistenceInput"],
    implementation: ["src/server/engine/analysis-run-repository.ts:AnalysisRunRepository", "src/server/engine/case-analysis/in-memory-repository.ts:InMemoryCaseAnalysisRepository"],
    tables_or_migration: [`${FOUNDATION_MIGRATION}:analysis_runs`, `${PLATFORM_MIGRATION}:engine_analysis_stage_versions`],
    ownership_key: "case_id",
    revision_or_idempotency: "analysis run idempotency + immutable stage hashes + resume_cursor",
    transaction_boundary: "durable run repository and in-memory CaseAnalysisRepositoryPort are separate; no shared PostgreSQL transaction",
    composition_root_binding: "memory_test_only canonical composition binds InMemoryCaseAnalysisRepository; isolated_postgres remains fail-closed",
    non_test_callers: NO_PRODUCT_CALLER,
    adapter_kinds: ["supabase_rest_repository", "memory_test_adapter", "schema"],
    status: "IMPLEMENTED_NOT_WIRED",
  }),
  entry({
    capability: "per_topic_results",
    canonical_contract: ["src/engine/wave3/contracts.ts:TopicAnalysisResult"],
    implementation: ["no PostgreSQL repository implementation located"],
    tables_or_migration: [`${PLATFORM_MIGRATION}:engine_topic_result_versions`],
    ownership_key: "analysis_run_id + case_id",
    revision_or_idempotency: "analysis_run_id + topic + result_sha256",
    transaction_boundary: "SQL schema only",
    composition_root_binding: "not bound",
    non_test_callers: NO_PRODUCT_CALLER,
    adapter_kinds: ["schema"],
    status: "SCHEMA_ONLY",
  }),
  entry({
    capability: "traces_findings_confirmations",
    canonical_contract: ["src/engine/findings/contracts.ts:findingSchema", "src/server/engine/persistence-contracts.ts:CaseConfirmation"],
    implementation: ["src/server/engine/investigation-repository.ts:InvestigationRepository", "no PostgreSQL calculation-trace repository located"],
    tables_or_migration: [`${FOUNDATION_MIGRATION}:analysis_findings,case_confirmations`, `${PLATFORM_MIGRATION}:engine_calculation_trace_versions`],
    ownership_key: "analysis_run_id through case_id",
    revision_or_idempotency: "finding/confirmation idempotency; trace_sha256",
    transaction_boundary: "individual Supabase REST statements; trace schema only",
    composition_root_binding: "not bound",
    non_test_callers: NO_PRODUCT_CALLER,
    adapter_kinds: ["partial_supabase_rest_repository", "schema"],
    status: "IMPLEMENTED_NOT_WIRED",
  }),
  entry({
    capability: "reports_approvals_release_state",
    canonical_contract: ["src/engine/case-analysis/contracts.ts:ReportRegistrationPort", "src/engine/wave3/contracts.ts:CaseReviewPort"],
    implementation: ["src/server/platform/persistence/canonical-repository.ts:CanonicalPlatformRepository.approveExactReport", "src/server/engine/case-analysis/integrated-harness.ts:IntegratedCaseReviewAdapter"],
    tables_or_migration: [`${PLATFORM_MIGRATION}:engine_report_versions,engine_review_task_versions,engine_case_lifecycle_revisions`],
    ownership_key: "tenant_id through case_id",
    revision_or_idempotency: "report revision + exact report_sha256 + approval decision hash + command idempotency",
    transaction_boundary: "exact-hash mutation is atomic only in LocalDurablePlatformStore",
    composition_root_binding: "memory_test_only canonical repository; no PostgreSQL binding",
    non_test_callers: NO_PRODUCT_CALLER,
    adapter_kinds: ["memory_test_adapter", "schema"],
    status: "IN_MEMORY_ONLY",
  }),
  entry({
    capability: "idempotency",
    canonical_contract: ["src/server/platform/persistence/contracts.ts:AtomicCommand"],
    implementation: ["src/server/platform/persistence/transactional-store.ts:LocalDurablePlatformStore"],
    tables_or_migration: [`${PLATFORM_MIGRATION}:engine_idempotency_records`],
    ownership_key: "tenant_id + scope + idempotency_key",
    revision_or_idempotency: "command_sha256 binds replay result",
    transaction_boundary: "atomic with local cloned state only",
    composition_root_binding: "memory_test_only",
    non_test_callers: NO_PRODUCT_CALLER,
    adapter_kinds: ["memory_test_adapter", "schema"],
    status: "IN_MEMORY_ONLY",
  }),
  entry({
    capability: "jobs_fencing_outbox_audit",
    canonical_contract: ["src/engine/wave4/contracts.ts:AuditEventPort", "src/server/platform/jobs/durable-job-queue.ts:DurableJob"],
    implementation: ["src/server/platform/jobs/durable-job-queue.ts:LocalDurableJobQueue", "src/server/platform/audit/hash-chain.ts:InMemoryHashChainAudit", "src/server/platform/persistence/transactional-store.ts:LocalDurablePlatformStore"],
    tables_or_migration: [`${PLATFORM_MIGRATION}:engine_durable_jobs,engine_job_history,engine_outbox_events,engine_logical_effect_receipts,engine_platform_audit_events`],
    ownership_key: "tenant_id + case_id",
    revision_or_idempotency: "job revision/fencing token + logical effect id + audit hash chain",
    transaction_boundary: "local job, audit and transactional stores are separate objects; PostgreSQL functions exist without application adapter",
    composition_root_binding: "memory_test_only composition constructs all local adapters, but they do not share one database transaction",
    non_test_callers: NO_PRODUCT_CALLER,
    adapter_kinds: ["memory_test_adapter", "schema", "sql_functions"],
    status: "IN_MEMORY_ONLY",
  }),
]);

export const REPORTED_19_DESCRIPTOR_OR_SCHEMA_ONLY = Object.freeze([
  "cases",
  "lifecycle_revisions",
  "payment_evidence_references",
  "documents",
  "extractions",
  "canonical_facts",
  "rule_inputs",
  "legal_version_pins",
  "analysis_runs",
  "analysis_stages",
  "topic_results",
  "calculation_traces",
  "reports",
  "review_tasks",
  "idempotency_records",
  "jobs",
  "outbox",
  "audit_events",
  "object_write_reservations",
] as const);

export const PERSISTENCE_ARCHITECTURE_ANSWERS = Object.freeze({
  server_engine_repositories_authoritative:
    "Yes for the existing phase-A contracts they implement (analysis runs, conversations/messages, documents, extractions, hypotheses/findings/confirmations). CaseAnalysisRepositoryPort remains the authoritative analysis contract and lacks a PostgreSQL adapter.",
  platform_persistence_relationship:
    "src/server/platform/persistence supplies atomic envelope/schema metadata and local test adapters. It does not replace the existing engine contracts and is not yet a PostgreSQL adapter for them.",
  durable_non_test_service_bindings: [] as readonly string[],
  non_test_memory_construction:
    "No stable product-reachable service is proven to construct memory automatically. Existing synthetic/evidence harnesses construct memory explicitly. The canonical composition rejects memory_test_only outside test or hermetic_synthetic execution.",
  shared_case_revision:
    "Not proven. Case analysis, Internal Ops and portal do not yet share a bound PostgreSQL case revision.",
  shared_command_transaction:
    "No. Existing Supabase REST repositories issue separate statements and local platform adapters are separate in-memory objects.",
  reported_19_descriptor_or_schema_only: REPORTED_19_DESCRIPTOR_OR_SCHEMA_ONLY,
});

export const PERSISTENCE_WIRING_SUMMARY = Object.freeze({
  capability_count: PERSISTENCE_WIRING_MAP.length,
  unknown_count: 0,
  duplicate_canonical_contract_count: PERSISTENCE_WIRING_MAP.filter((row) => row.status === "DUPLICATE_CONTRACT").length,
  wired_durable_count: PERSISTENCE_WIRING_MAP.filter((row) => row.status === "WIRED_DURABLE").length,
  non_test_memory_fallback_count: 0,
  status: "CANONICAL_PERSISTENCE_WIRING_INCOMPLETE" as const,
  blocker: "CASE_ANALYSIS_NON_DURABLE_ONLY" as const,
});

function entry(value: PersistenceWiringEntry): PersistenceWiringEntry {
  return Object.freeze(value);
}

export function renderPersistenceWiringMarkdown(): string {
  const lines = [
    "# Canonical persistence wiring map",
    "",
    `Overall: **${PERSISTENCE_WIRING_SUMMARY.status} / ${PERSISTENCE_WIRING_SUMMARY.blocker}**`,
    "",
    "| Capability | Status | Composition binding | Non-test callers |",
    "|---|---|---|---|",
    ...PERSISTENCE_WIRING_MAP.map((row) =>
      `| ${row.capability} | ${row.status} | ${row.composition_root_binding} | ${row.non_test_callers.join("; ")} |`,
    ),
    "",
    "## Architecture answers",
    "",
    ...Object.entries(PERSISTENCE_ARCHITECTURE_ANSWERS).map(([key, value]) =>
      `- ${key}: ${Array.isArray(value) ? (value.length === 0 ? "none" : value.join(", ")) : value}`,
    ),
    "",
  ];
  return `${lines.join("\n")}\n`;
}
