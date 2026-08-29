import { createHash } from "node:crypto";

export const ENGINE_PERSISTENCE_TABLES = [
  "analysis_runs",
  "employment_snapshots",
  "analysis_hypotheses",
  "case_conversations",
  "case_messages",
  "analysis_findings",
  "document_extractions",
  "case_confirmations",
  "analysis_jobs",
] as const;

export type PersistenceStaticCheck = Readonly<{
  id: string;
  passed: boolean;
  evidence: string;
}>;

export type PersistenceStaticReport = Readonly<{
  method: "offline_sql_and_source_structure_only";
  database_semantics_verified: false;
  migration_sha256: string;
  checks: readonly PersistenceStaticCheck[];
  passed: boolean;
}>;

function normalized(source: string) {
  return source.replace(/\s+/g, " ").trim().toLowerCase();
}

function check(id: string, passed: boolean, evidence: string): PersistenceStaticCheck {
  return { id, passed, evidence };
}

export function verifyPersistenceFoundationStatically(input: Readonly<{
  migration: string;
  repositories: string;
  safeLogging: string;
}>): PersistenceStaticReport {
  const sql = normalized(input.migration);
  const repositories = normalized(input.repositories);
  const safeLogging = normalized(input.safeLogging);
  const checks: PersistenceStaticCheck[] = [];

  for (const table of ENGINE_PERSISTENCE_TABLES) {
    checks.push(
      check(
        `table.${table}`,
        sql.includes(`create table public.${table} (`),
        `create table public.${table}`,
      ),
      check(
        `rls.${table}`,
        sql.includes(`alter table public.${table} enable row level security`),
        `RLS enabled for public.${table}`,
      ),
      check(
        `browser_roles_revoked.${table}`,
        sql.includes(`revoke all on table public.${table} from anon, authenticated`),
        `anon/authenticated revoked for public.${table}`,
      ),
      check(
        `service_boundary.${table}`,
        sql.includes(`on table public.${table} to service_role`),
        `explicit service_role grant for public.${table}`,
      ),
    );
  }

  const structuralTokens = [
    ["fk.run_case", "case_id uuid not null references public.cases(id) on delete cascade"],
    ["fk.extraction_document", "document_id uuid not null references public.documents(id) on delete cascade"],
    ["fk.message_conversation_case", "constraint case_messages_conversation_case_fkey"],
    ["guard.run_history", "create trigger analysis_runs_history_guard"],
    ["guard.extraction_history", "create trigger document_extractions_history_guard"],
    ["guard.conversation_history", "create trigger case_conversations_history_guard"],
    ["guard.confirmation_history", "create trigger case_confirmations_history_guard"],
    ["guard.job_history", "create trigger analysis_jobs_history_guard"],
    ["guard.case_scope", "create or replace function private.enforce_engine_case_scope()"],
    ["index.job_claim", "create index analysis_jobs_claim_idx"],
    ["index.run_case", "create index analysis_runs_case_created_idx"],
    ["index.extraction_document", "create index document_extractions_document_created_idx"],
    ["append_only.snapshots", "grant select, insert on table public.employment_snapshots to service_role"],
    ["append_only.messages", "grant select, insert on table public.case_messages to service_role"],
    ["append_only.findings", "grant select, insert on table public.analysis_findings to service_role"],
    ["document.compatibility", "storage_layout in ('legacy_slot', 'immutable_v1')"],
  ] as const;
  for (const [id, token] of structuralTokens) {
    checks.push(check(id, sql.includes(token), token));
  }

  const repositoryTokens = [
    ["repository.analysis_runs", "class analysisrunrepository"],
    ["repository.conversations_messages", "class conversationrepository"],
    ["repository.documents", "class enginedocumentrepository"],
    ["repository.extractions", "class extractionrepository"],
    ["repository.hypotheses_findings_confirmations_jobs", "class investigationrepository"],
    ["repository.unique_violation", "isuniqueviolation"],
    ["repository.optimistic_status_guard", '.eq("status", current.status)'],
  ] as const;
  for (const [id, token] of repositoryTokens) {
    checks.push(check(id, repositories.includes(token), token));
  }

  checks.push(
    check("safe_log.strict_schema", safeLogging.includes(".strict()"), "strict operational log schema"),
    check("safe_log.no_document_bytes", !safeLogging.includes("document_bytes"), "document bytes are not accepted"),
    check("safe_log.no_raw_prompt", !safeLogging.includes("raw_prompt"), "raw prompts are not accepted"),
    check("safe_error.no_database_text", repositories.includes("enginepersistenceerror"), "safe repository error boundary"),
  );

  return {
    method: "offline_sql_and_source_structure_only",
    database_semantics_verified: false,
    migration_sha256: createHash("sha256").update(input.migration).digest("hex"),
    checks,
    passed: checks.every((item) => item.passed),
  };
}
