import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  analysisJobIdempotencyKey,
  findingIdempotencyKey,
  hashCanonicalJson,
} from "./idempotency";
import {
  confirmationFromRow,
  confirmationToRow,
  employmentSnapshotFromRow,
  employmentSnapshotToRow,
  findingFromRow,
  findingToRow,
  hypothesisFromRow,
  hypothesisToRow,
  jobFromRow,
  jobToRow,
} from "./mappers";
import type {
  AnalysisJob,
  CaseConfirmation,
  EmploymentSnapshotPersistenceInput,
  FindingPersistenceInput,
  HypothesisPersistenceInput,
} from "./persistence-contracts";
import { EnginePersistenceError, isUniqueViolation } from "./repository-error";

export class InvestigationRepository {
  private readonly client: SupabaseClient;

  constructor(client?: SupabaseClient) {
    this.client = client ?? getSupabaseAdmin();
  }

  async saveSnapshot(input: EmploymentSnapshotPersistenceInput) {
    let row: ReturnType<typeof employmentSnapshotToRow>;
    try {
      row = employmentSnapshotToRow(input);
    } catch {
      throw new EnginePersistenceError("invalid_persistence_input", "snapshot.save");
    }
    const inserted = await this.client.from("employment_snapshots").insert(row).select("*").single();
    if (!inserted.error) return employmentSnapshotFromRow(inserted.data);
    if (!isUniqueViolation(inserted.error)) {
      throw new EnginePersistenceError("persistence_write_failed", "snapshot.save");
    }
    const existing = await this.client
      .from("employment_snapshots")
      .select("*")
      .eq("analysis_run_id", row.analysis_run_id)
      .single();
    if (existing.error || !existing.data) {
      throw new EnginePersistenceError("persistence_read_failed", "snapshot.save_existing");
    }
    if (existing.data.payload_hash !== row.payload_hash) {
      throw new EnginePersistenceError("persistence_conflict", "snapshot.save_existing");
    }
    return employmentSnapshotFromRow(existing.data);
  }

  async saveHypothesis(input: HypothesisPersistenceInput) {
    let row: ReturnType<typeof hypothesisToRow>;
    try {
      row = hypothesisToRow(input);
    } catch {
      throw new EnginePersistenceError("invalid_persistence_input", "hypothesis.save");
    }
    const inserted = await this.client.from("analysis_hypotheses").insert(row).select("*").single();
    if (!inserted.error) return hypothesisFromRow(inserted.data);
    if (!isUniqueViolation(inserted.error)) {
      throw new EnginePersistenceError("persistence_write_failed", "hypothesis.save");
    }
    const existing = await this.client
      .from("analysis_hypotheses")
      .select("*")
      .eq("analysis_run_id", row.analysis_run_id)
      .eq("idempotency_key", row.idempotency_key)
      .single();
    if (existing.error || !existing.data) {
      throw new EnginePersistenceError("persistence_read_failed", "hypothesis.save_existing");
    }
    if (existing.data.hypothesis_key !== row.hypothesis_key) {
      throw new EnginePersistenceError("persistence_conflict", "hypothesis.save_existing");
    }
    return hypothesisFromRow(existing.data);
  }

  async saveFinding(input: FindingPersistenceInput) {
    let row: ReturnType<typeof findingToRow>;
    try {
      row = findingToRow(input);
      const expectedKey = findingIdempotencyKey({
        analysis_run_id: row.analysis_run_id,
        category: row.category,
        period_start: row.period_start,
        period_end: row.period_end,
        rule_id: row.rule_id,
        rule_version: row.rule_version,
        fact_references: row.fact_references,
      });
      if (row.idempotency_key !== expectedKey) throw new TypeError("Invalid idempotency key");
    } catch {
      throw new EnginePersistenceError("invalid_persistence_input", "finding.save");
    }
    const inserted = await this.client.from("analysis_findings").insert(row).select("*").single();
    if (!inserted.error) return findingFromRow(inserted.data, input.finding.case_id);
    if (!isUniqueViolation(inserted.error)) {
      throw new EnginePersistenceError("persistence_write_failed", "finding.save");
    }
    const existing = await this.client
      .from("analysis_findings")
      .select("*")
      .eq("analysis_run_id", row.analysis_run_id)
      .eq("idempotency_key", row.idempotency_key)
      .single();
    if (existing.error || !existing.data) {
      throw new EnginePersistenceError("persistence_read_failed", "finding.save_existing");
    }
    if (
      existing.data.category !== row.category ||
      existing.data.rule_id !== row.rule_id ||
      existing.data.rule_version !== row.rule_version
    ) {
      throw new EnginePersistenceError("persistence_conflict", "finding.save_existing");
    }
    return findingFromRow(existing.data, input.finding.case_id);
  }

  async createConfirmation(input: CaseConfirmation) {
    let row: ReturnType<typeof confirmationToRow>;
    try {
      row = confirmationToRow(input);
      if (row.status !== "pending") throw new TypeError("Confirmations start pending");
    } catch {
      throw new EnginePersistenceError("invalid_persistence_input", "confirmation.create");
    }
    const inserted = await this.client.from("case_confirmations").insert(row).select("*").single();
    if (!inserted.error) return confirmationFromRow(inserted.data);
    if (!isUniqueViolation(inserted.error)) {
      throw new EnginePersistenceError("persistence_write_failed", "confirmation.create");
    }
    const existing = await this.client
      .from("case_confirmations")
      .select("*")
      .eq("case_id", row.case_id)
      .eq("idempotency_key", row.idempotency_key)
      .single();
    if (existing.error || !existing.data) {
      throw new EnginePersistenceError("persistence_read_failed", "confirmation.create_existing");
    }
    return confirmationFromRow(existing.data);
  }

  async answerConfirmation(input: CaseConfirmation) {
    let next: ReturnType<typeof confirmationToRow>;
    try {
      next = confirmationToRow(input);
      if (next.status === "pending") throw new TypeError("An answer must be terminal");
    } catch {
      throw new EnginePersistenceError("invalid_persistence_input", "confirmation.answer");
    }
    const currentResult = await this.client
      .from("case_confirmations")
      .select("*")
      .eq("id", next.id)
      .single();
    if (currentResult.error || !currentResult.data) {
      throw new EnginePersistenceError("persistence_record_not_found", "confirmation.answer");
    }
    const current = confirmationFromRow(currentResult.data);
    if (current.status !== "pending") {
      if (current.status === next.status && hashCanonicalJson(current.answer) === hashCanonicalJson(next.answer)) {
        return current;
      }
      throw new EnginePersistenceError("persistence_conflict", "confirmation.answer");
    }
    if (
      current.case_id !== next.case_id ||
      current.source_analysis_run_id !== next.source_analysis_run_id ||
      current.target_fact_path !== next.target_fact_path ||
      current.question_id !== next.question_id ||
      current.question_version !== next.question_version ||
      hashCanonicalJson(current.proposed_value) !== hashCanonicalJson(next.proposed_value) ||
      current.idempotency_key !== next.idempotency_key ||
      current.created_at !== next.created_at
    ) {
      throw new EnginePersistenceError("persistence_conflict", "confirmation.answer");
    }
    const result = await this.client
      .from("case_confirmations")
      .update({
        answer: next.answer,
        status: next.status,
        source_message_id: next.source_message_id,
        answered_at: next.answered_at,
      })
      .eq("id", next.id)
      .eq("status", "pending")
      .select("*")
      .single();
    if (result.error || !result.data) {
      throw new EnginePersistenceError("persistence_write_failed", "confirmation.answer");
    }
    return confirmationFromRow(result.data);
  }

  async createJob(input: AnalysisJob) {
    let row: ReturnType<typeof jobToRow>;
    try {
      row = jobToRow(input);
      if (row.status !== "queued" || row.retry_count !== 0 || row.locked_at !== null) {
        throw new TypeError("Jobs start queued and unlocked");
      }
      const expectedKey = analysisJobIdempotencyKey({
        analysis_run_id: row.analysis_run_id,
        stage: row.stage,
        document_id: row.document_id,
        extraction_id: row.extraction_id,
        input_hash: hashCanonicalJson(row.payload),
      });
      if (row.idempotency_key !== expectedKey) throw new TypeError("Invalid idempotency key");
    } catch {
      throw new EnginePersistenceError("invalid_persistence_input", "job.create");
    }
    const inserted = await this.client.from("analysis_jobs").insert(row).select("*").single();
    if (!inserted.error) return jobFromRow(inserted.data);
    if (!isUniqueViolation(inserted.error)) {
      throw new EnginePersistenceError("persistence_write_failed", "job.create");
    }
    const existing = await this.client
      .from("analysis_jobs")
      .select("*")
      .eq("analysis_run_id", row.analysis_run_id)
      .eq("idempotency_key", row.idempotency_key)
      .single();
    if (existing.error || !existing.data) {
      throw new EnginePersistenceError("persistence_read_failed", "job.create_existing");
    }
    if (existing.data.stage !== row.stage) {
      throw new EnginePersistenceError("persistence_conflict", "job.create_existing");
    }
    return jobFromRow(existing.data);
  }

  async advanceJob(input: AnalysisJob) {
    let next: ReturnType<typeof jobToRow>;
    try {
      next = jobToRow(input);
    } catch {
      throw new EnginePersistenceError("invalid_persistence_input", "job.advance");
    }
    const currentResult = await this.client.from("analysis_jobs").select("*").eq("id", next.id).single();
    if (currentResult.error || !currentResult.data) {
      throw new EnginePersistenceError("persistence_record_not_found", "job.advance");
    }
    const current = jobFromRow(currentResult.data);
    const transitions: Record<string, readonly string[]> = {
      queued: ["running", "cancelled"],
      running: ["retry_scheduled", "completed", "failed", "cancelled"],
      retry_scheduled: ["running", "cancelled"],
      completed: [],
      failed: [],
      cancelled: [],
    };
    if (!transitions[current.status].includes(next.status)) {
      throw new EnginePersistenceError("invalid_state_transition", "job.advance");
    }
    const expectedRetryCount = next.status === "retry_scheduled" ? current.retry_count + 1 : current.retry_count;
    if (
      current.analysis_run_id !== next.analysis_run_id ||
      current.document_id !== next.document_id ||
      current.extraction_id !== next.extraction_id ||
      current.stage !== next.stage ||
      hashCanonicalJson(current.payload) !== hashCanonicalJson(next.payload) ||
      current.idempotency_key !== next.idempotency_key ||
      current.max_attempts !== next.max_attempts ||
      current.created_at !== next.created_at ||
      next.retry_count !== expectedRetryCount
    ) {
      throw new EnginePersistenceError("persistence_conflict", "job.advance");
    }
    const result = await this.client
      .from("analysis_jobs")
      .update({
        status: next.status,
        retry_count: next.retry_count,
        available_at: next.available_at,
        locked_at: next.locked_at,
        completed_at: next.completed_at,
        error_code: next.error_code,
        updated_at: next.updated_at,
      })
      .eq("id", next.id)
      .eq("status", current.status)
      .select("*")
      .single();
    if (result.error || !result.data) {
      throw new EnginePersistenceError("persistence_write_failed", "job.advance");
    }
    return jobFromRow(result.data);
  }
}
