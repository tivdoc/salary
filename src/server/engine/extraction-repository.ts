import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { documentExtractionIdempotencyKey } from "./idempotency";
import { extractionFromRow, extractionToRow } from "./mappers";
import { documentExtractionAttemptSchema, type DocumentExtractionAttempt } from "./persistence-contracts";
import { EnginePersistenceError, isUniqueViolation } from "./repository-error";

const extractionTransitions = {
  queued: new Set(["running", "partial", "completed", "failed"]),
  running: new Set(["partial", "completed", "failed"]),
  partial: new Set<string>(),
  completed: new Set<string>(),
  failed: new Set<string>(),
} as const;

export class ExtractionRepository {
  private readonly client: SupabaseClient;

  constructor(client?: SupabaseClient) {
    this.client = client ?? getSupabaseAdmin();
  }

  async createAttempt(input: DocumentExtractionAttempt) {
    let row: ReturnType<typeof extractionToRow>;
    try {
      row = extractionToRow(input);
      const expectedKey = documentExtractionIdempotencyKey({
        document_id: row.document_id,
        content_sha256: row.source_content_sha256,
        extractor_id: row.extractor_id,
        extractor_version: row.extractor_version,
        model_version: row.model_version,
      });
      if (row.idempotency_key !== expectedKey) throw new TypeError("Invalid idempotency key");
    } catch {
      throw new EnginePersistenceError("invalid_persistence_input", "extraction.create");
    }
    const inserted = await this.client.from("document_extractions").insert(row).select("*").single();
    if (!inserted.error) return extractionFromRow(inserted.data);
    if (!isUniqueViolation(inserted.error)) {
      throw new EnginePersistenceError("persistence_write_failed", "extraction.create");
    }
    const existing = await this.client
      .from("document_extractions")
      .select("*")
      .eq("document_id", row.document_id)
      .eq("idempotency_key", row.idempotency_key)
      .single();
    if (existing.error || !existing.data) {
      throw new EnginePersistenceError("persistence_read_failed", "extraction.create_existing");
    }
    return extractionFromRow(existing.data);
  }

  async advanceAttempt(input: DocumentExtractionAttempt) {
    let next: ReturnType<typeof documentExtractionAttemptSchema.parse>;
    try {
      next = documentExtractionAttemptSchema.parse(input);
    } catch {
      throw new EnginePersistenceError("invalid_persistence_input", "extraction.advance");
    }
    const currentResult = await this.client
      .from("document_extractions")
      .select("*")
      .eq("id", next.extraction_id)
      .single();
    if (currentResult.error || !currentResult.data) {
      throw new EnginePersistenceError("persistence_record_not_found", "extraction.advance");
    }
    const current = extractionFromRow(currentResult.data);
    if (!extractionTransitions[current.status].has(next.status)) {
      throw new EnginePersistenceError("invalid_state_transition", "extraction.advance");
    }
    if (
      current.document_id !== next.document_id ||
      current.analysis_run_id !== next.analysis_run_id ||
      current.extractor_id !== next.extractor_id ||
      current.extractor_version !== next.extractor_version ||
      current.model_version !== next.model_version ||
      current.source_content_sha256 !== next.source_content_sha256 ||
      current.idempotency_key !== next.idempotency_key ||
      current.created_at !== next.created_at
    ) {
      throw new EnginePersistenceError("persistence_conflict", "extraction.advance");
    }
    const result = await this.client
      .from("document_extractions")
      .update({
        status: next.status,
        payload: next.payload,
        quality_metrics: next.quality_metrics,
        raw_artifact_path: next.raw_artifact_path,
        completed_at: next.completed_at,
        error_code: next.error_code,
      })
      .eq("id", next.extraction_id)
      .eq("status", current.status)
      .select("*")
      .single();
    if (result.error || !result.data) {
      throw new EnginePersistenceError("persistence_write_failed", "extraction.advance");
    }
    return extractionFromRow(result.data);
  }
}
