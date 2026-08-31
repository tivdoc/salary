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
const V08_PERSISTENCE_WIRING_BASELINE: readonly PersistenceWiringEntry[] = Object.freeze([
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

const V09_MIGRATION = "supabase/migrations/202608310002_canonical_postgresql_composition.sql";
const V09_BINDINGS: Readonly<Record<PersistenceCapability, Readonly<{ adapter: string; binding: string; transaction: string; callers: readonly string[] }>>> = Object.freeze({
  cases_and_lifecycle_revisions: v09("src/server/platform/persistence/postgres/intake/repositories.ts:PostgresCaseLifecycleRepository", "intake.case_lifecycle", "case mutation + lifecycle revision + audit/outbox", ["stable_portal", "stable_operations"]),
  payment_evidence_references: v09("src/server/platform/persistence/postgres/intake/repositories.ts:PostgresPaymentEvidenceRepository", "intake.payment_evidence", "payment reconcile/invalidate + case revision + audit/outbox", ["stable_portal", "stable_operations"]),
  conversations_and_messages: v09("src/server/platform/persistence/postgres/intake/repositories.ts:PostgresConversationRepository", "intake.conversations", "conversation/message mutation + audit", ["stable_portal", "stable_operations"]),
  documents_and_artifact_references: v09("src/server/platform/persistence/postgres/intake/repositories.ts:PostgresDocumentArtifactRepository", "intake.documents_and_artifacts", "document reference + object reservation + audit/outbox", ["stable_portal", "stable_operations"]),
  extractions: v09("src/server/platform/persistence/postgres/intake/repositories.ts:PostgresExtractionRepository", "intake.extractions", "extraction transition + case revision + audit", ["stable_operations", "case_analysis"]),
  canonical_facts_and_conflicts: v09("src/server/platform/persistence/postgres/intake/repositories.ts:PostgresCanonicalFactsRepository", "intake.canonical_facts", "fact resolution + case revision + audit", ["stable_portal", "stable_operations", "case_analysis"]),
  hypotheses_and_rule_inputs: v09("src/server/platform/persistence/postgres/intake/repositories.ts:PostgresInvestigationRepository", "intake.investigation", "hypothesis and RuleInput versions in the analysis transaction", ["case_analysis"]),
  corpus_source_parameter_rule_pins: v09("src/server/platform/persistence/postgres/analysis/legal-pins.ts:PostgresLegalPinsRepository", "analysis.legalPins", "analysis begin + immutable dependency pins", ["case_analysis"]),
  analysis_runs_and_resume_cursors: v09("src/server/platform/persistence/postgres/analysis/case-analysis-repository.ts:PostgresCaseAnalysisRepository", "analysis.caseAnalysis", "run + stages + pins + seven topics + report completion", ["case_analysis", "stable_operations"]),
  per_topic_results: v09("src/server/platform/persistence/postgres/analysis/topic-results.ts:PostgresTopicResultRepository", "analysis.topicResults", "seven topic rows + trace references + run completion", ["case_analysis", "stable_operations"]),
  traces_findings_confirmations: v09("src/server/platform/persistence/postgres/analysis/traces.ts:PostgresTraceFindingRepository", "analysis.traceFindings", "trace and blocked/confirmed state in the analysis transaction", ["case_analysis", "stable_operations"]),
  reports_approvals_release_state: v09("src/server/platform/persistence/postgres/analysis/reports.ts:PostgresReportReviewRepository", "analysis.reports", "report hashes + approval/release/invalidation + audit/outbox", ["case_analysis", "stable_operations", "stable_portal"]),
  idempotency: v09("src/server/platform/persistence/postgres/runtime/idempotency.ts:PostgresIdempotencyRepository", "runtime.idempotency", "command result + all state/audit/outbox effects", ["stable_portal", "stable_operations", "case_analysis", "background_workers"]),
  jobs_fencing_outbox_audit: v09("src/server/platform/persistence/postgres/runtime/jobs-outbox-audit.ts:PostgresJobsOutboxAuditRepository", "runtime.jobs_outbox_audit", "job claim/complete/retry + fencing + audit/outbox", ["background_workers", "stable_operations"]),
});

export const PERSISTENCE_WIRING_MAP: readonly PersistenceWiringEntry[] = Object.freeze(
  V08_PERSISTENCE_WIRING_BASELINE.map((row) => {
    const binding = V09_BINDINGS[row.capability];
    return entry({
      ...row,
      implementation: Object.freeze([...row.implementation.filter((value) => !value.startsWith("no PostgreSQL")), binding.adapter]),
      tables_or_migration: Object.freeze([...row.tables_or_migration, V09_MIGRATION]),
      transaction_boundary: binding.transaction,
      composition_root_binding: `src/server/platform/composition/canonical-postgres-application.ts:${binding.binding}`,
      non_test_callers: Object.freeze(binding.callers.map((caller) => `src/server/platform/composition/canonical-postgres-application.ts:${caller}`)),
      adapter_kinds: Object.freeze(["postgresql", "transaction_scoped"]),
      status: "WIRED_DURABLE",
    });
  }),
);

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
    "Yes. V0.9 PostgreSQL adapters implement or adapt the existing canonical ports; PostgresCaseAnalysisRepository implements CaseAnalysisRepositoryPort.",
  platform_persistence_relationship:
    "src/server/platform/persistence supplies transaction-scoped PostgreSQL implementations without publishing competing domain contracts.",
  durable_non_test_service_bindings: canonicalBindingNames(),
  non_test_memory_construction:
    "Zero product-reachable automatic memory fallback. memory_test_only requires a hermetic boundary and explicit test sentinel; connection and schema failures fail closed.",
  shared_case_revision:
    "Statically and with a strict recording driver, portal, Internal Ops, case analysis and workers bind through one canonical application composition. Real PostgreSQL replay remains pending.",
  shared_command_transaction:
    "Yes at code and recording-driver level: all 14 adapters receive one PostgresTransactionContext; real PostgreSQL transaction semantics remain pending.",
  reported_19_descriptor_or_schema_only: REPORTED_19_DESCRIPTOR_OR_SCHEMA_ONLY,
});

export const PERSISTENCE_WIRING_SUMMARY = Object.freeze({
  capability_count: PERSISTENCE_WIRING_MAP.length,
  unknown_count: 0,
  duplicate_canonical_contract_count: PERSISTENCE_WIRING_MAP.filter((row) => row.status === "DUPLICATE_CONTRACT").length,
  wired_durable_count: PERSISTENCE_WIRING_MAP.filter((row) => row.status === "WIRED_DURABLE").length,
  non_test_memory_fallback_count: 0,
  status: "CANONICAL_PERSISTENCE_WIRING_COMPLETE" as const,
  blocker: "DYNAMIC_POSTGRESQL_VERIFICATION_PENDING" as const,
});

function entry(value: PersistenceWiringEntry): PersistenceWiringEntry {
  return Object.freeze(value);
}

function v09(
  adapter: string,
  binding: string,
  transaction: string,
  callers: readonly string[],
) {
  return Object.freeze({ adapter, binding, transaction, callers: Object.freeze([...callers]) });
}

function canonicalBindingNames(): readonly string[] {
  return Object.freeze(PERSISTENCE_CAPABILITIES.map((capability) => `${capability}:${V09_BINDINGS[capability].binding}`));
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
