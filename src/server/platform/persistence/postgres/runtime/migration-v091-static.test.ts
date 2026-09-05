import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = "supabase/migrations/202608310003_canonical_postgresql_dynamic_hardening.sql";
const sql = readFileSync(path.resolve(process.cwd(), migrationPath), "utf8");
const compatibilityPath = "supabase/migrations/202608300001_canonical_upgrade_compatibility.sql";
const compatibilitySql = readFileSync(path.resolve(process.cwd(), compatibilityPath), "utf8");

describe("V0.9.1 plain-PostgreSQL forward hardening migration", () => {
  it("pins the portability-amended predecessor chain byte-for-byte", () => {
    expect(digest("supabase/migrations/202608290001_engine_persistence_foundation.sql", true))
      .toBe("e4e036fd3c01134a7e449cf50d586d4bf6790c0e00a4f62ad0a898acfec31373");
    expect(digest("supabase/migrations/202608310001_engine_platform_persistence.sql", true))
      .toBe("3174a97ef2b13ca705d8a620f686b470649e6b768421b0a0347816088941cc25");
    expect(digest("supabase/migrations/202608310002_canonical_postgresql_composition.sql", true))
      .toBe("bf9100dc11d3f0a73afa93274be72debf348f97dcff122a2237df28c69c759e9");
  });

  it("permits canonical metadata backfill without weakening legacy history", () => {
    expect(compatibilityPath).toMatch(/202608300001_/u);
    expect(compatibilitySql).toContain("create or replace function private.enforce_engine_analysis_run_history()");
    expect(compatibilitySql).toContain("if old.status is not distinct from new.status then");
    for (const field of [
      "id", "case_id", "parent_run_id", "run_type", "status", "trigger_reason",
      "engine_version", "engine_git_sha", "contract_version", "ontology_version",
      "rule_set_hash", "input_snapshot", "input_snapshot_hash", "idempotency_key",
      "started_at", "completed_at", "created_at", "error_code", "error_stage",
    ]) {
      if (field !== "status") expect(compatibilitySql).toContain(`old.${field} is distinct from new.${field}`);
    }
    expect(compatibilitySql).toContain("Same-status analysis run updates may enrich canonical metadata only");
    expect(compatibilitySql).toContain("old_metadata := to_jsonb(old)");
    for (const field of [
      "tenant_id", "canonical_case_id", "canonical_analysis_run_id",
      "command_sha256", "command_payload", "case_revision",
    ]) expect(compatibilitySql).toContain(`'${field}'`);
    expect(compatibilitySql).toContain("Only canonical analysis ownership and command metadata may be enriched from null");
    expect(compatibilitySql).toContain("Same-status analysis run updates require canonical metadata enrichment");
    expect(compatibilitySql).not.toMatch(/prior\.key not in \([^)]*completion_payload/u);
    expect(compatibilitySql).toContain("Terminal analysis runs are immutable");
    expect(sql).toContain("create or replace function private.enforce_engine_analysis_run_history()");
    expect(sql).toContain("old.completion_payload is distinct from new.completion_payload");
    expect(sql).toContain("Completed analysis runs require a completion payload");
    expect(compatibilitySql).not.toMatch(/\b(?:disable trigger|session_replication_role|drop trigger)\b/iu);
  });

  it("uses canonical document paths while retaining an explicit legacy UUID branch", () => {
    expect(sql).toContain("canonical_case_id || '/documents/' || canonical_document_id || '/original.'");
    expect(sql).toContain("case_id::text || '/documents/' || id::text || '/original.'");
    expect(sql).toContain("validate constraint documents_immutable_metadata_check");
    expect(sql).toContain("Document canonical ownership conflicts with engine case state");
  });

  it("supplies the plain-PostgreSQL service role privileges without broadening anonymous access", () => {
    expect(sql).toContain("grant usage on schema public, private to service_role");
    expect(sql).toContain("public.engine_job_history_sequence_seq");
    expect(sql).toContain("public.engine_platform_audit_events_sequence_seq");
    expect(sql).not.toMatch(/grant[^;]+to\s+(?:public|anon|authenticated)/iu);
  });

  it("covers every canonical legacy table with a fail-closed tenant policy", () => {
    for (const table of [
      "documents", "analysis_runs", "analysis_hypotheses", "case_conversations",
      "case_messages", "analysis_findings", "document_extractions", "case_confirmations",
      "engine_object_write_sagas",
    ]) expect(sql).toContain(`'${table}'`);
    expect(sql).toContain("nullif(current_setting(''tivdoc.tenant_id'', true), '''')");
  });

  it("tenant-scopes every callable SECURITY DEFINER queue function", () => {
    for (const functionName of [
      "claim_engine_platform_jobs", "heartbeat_engine_platform_job",
      "finish_engine_platform_job", "claim_engine_platform_outbox",
    ]) {
      expect(sql).toContain(`function private.${functionName}`);
    }
    expect(sql.match(/security definer\s+set search_path = ''/gu)).toHaveLength(5);
    expect(sql.match(/nullif\(current_setting\('tivdoc\.tenant_id', true\), ''\)/gu)?.length).toBeGreaterThanOrEqual(6);
    expect(sql).toContain("job.attempt_count < job.max_attempts");
    expect(sql).toContain("event.tenant_id = locked_job.tenant_id");
  });

  it("does not bypass guards or introduce destructive table operations", () => {
    expect(sql).not.toMatch(/\b(?:disable trigger|session_replication_role|drop table|truncate table)\b/iu);
    expect(sql).not.toContain(["DATABASE", "URL"].join("_"));
  });
});

// L9-7: pinned on the repository's bytes (LF, as git stores them), not the working copy's — a Windows checkout carries CRLF and a Linux one does not.
function digest(relativePath: string, normalizeLineEndings = false): string {
  const bytes = readFileSync(path.resolve(process.cwd(), relativePath));
  const content = normalizeLineEndings ? Buffer.from(bytes.toString("utf8").replace(/\r\n/gu, "\n"), "utf8") : bytes;
  return createHash("sha256").update(content).digest("hex");
}
