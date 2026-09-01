import { createPostgresAnalysisRepositories, type PostgresAnalysisRepositories } from "../persistence/postgres/analysis/index.ts";
import { intake_factory, type PostgresIntakeAdapterBundle } from "../persistence/postgres/intake/index.ts";
import type { PostgresConnectionFactory } from "../persistence/postgres/runtime/transaction-manager.ts";
import {
  startCanonicalPostgresComposition,
  type CanonicalPostgresComposition,
  type CanonicalPostgresConfig,
} from "./canonical-postgres.ts";

export const CANONICAL_POSTGRES_CAPABILITY_BINDINGS = Object.freeze([
  { capability: "cases_and_lifecycle_revisions", binding: "intake.case_lifecycle" },
  { capability: "payment_evidence_references", binding: "intake.payment_evidence" },
  { capability: "conversations_and_messages", binding: "intake.conversations" },
  { capability: "documents_and_artifact_references", binding: "intake.documents_and_artifacts" },
  { capability: "extractions", binding: "intake.extractions" },
  { capability: "canonical_facts_and_conflicts", binding: "intake.canonical_facts" },
  { capability: "hypotheses_and_rule_inputs", binding: "intake.investigation" },
  { capability: "corpus_source_parameter_rule_pins", binding: "analysis.legalPins" },
  { capability: "analysis_runs_and_resume_cursors", binding: "analysis.caseAnalysis" },
  { capability: "per_topic_results", binding: "analysis.topicResults" },
  { capability: "traces_findings_confirmations", binding: "analysis.traceFindings" },
  { capability: "reports_approvals_release_state", binding: "analysis.reports" },
  { capability: "idempotency", binding: "runtime.idempotency" },
  { capability: "jobs_fencing_outbox_audit", binding: "runtime.jobs_outbox_audit" },
] as const);

export const CANONICAL_POSTGRES_ENTRYPOINT_BINDINGS = Object.freeze([
  { entrypoint: "stable_portal", root: "src/server/product/routes/runtime.ts", transaction_bundle: "canonical_application_postgres" },
  { entrypoint: "stable_operations", root: "src/server/product/routes/runtime.ts", transaction_bundle: "canonical_application_postgres" },
  { entrypoint: "case_analysis", root: "analysis.caseAnalysis", transaction_bundle: "canonical_application_postgres" },
  { entrypoint: "background_workers", root: "runtime.jobs_outbox_audit", transaction_bundle: "canonical_application_postgres" },
] as const);

export type CanonicalApplicationPostgresComposition<TMemoryTestOnly = never> = CanonicalPostgresComposition<
  PostgresIntakeAdapterBundle,
  PostgresAnalysisRepositories,
  TMemoryTestOnly
>;

/** The only application-level binding of the exact 14 canonical PostgreSQL adapters. */
export function startCanonicalApplicationPostgres<TMemoryTestOnly = never>(
  config: CanonicalPostgresConfig,
  dependencies: Readonly<{
    connection_factory?: PostgresConnectionFactory;
    memory_test_only_factory?: () => TMemoryTestOnly;
  }>,
): Promise<CanonicalApplicationPostgresComposition<TMemoryTestOnly>> {
  return startCanonicalPostgresComposition(config, {
    connection_factory: dependencies.connection_factory,
    intake_factory,
    analysis_factory: createPostgresAnalysisRepositories,
    memory_test_only_factory: dependencies.memory_test_only_factory,
  });
}
