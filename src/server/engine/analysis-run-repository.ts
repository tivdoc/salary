import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { analysisRunTransitionSchema } from "@/engine/investigation/state-machine";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { analysisRunIdempotencyKey } from "./idempotency";
import { analysisRunFromRow, analysisRunToRow } from "./mappers";
import {
  analysisRunLifecycleUpdateSchema,
  type AnalysisRunPersistenceInput,
} from "./persistence-contracts";
import { EnginePersistenceError, isUniqueViolation } from "./repository-error";

export class AnalysisRunRepository {
  private readonly client: SupabaseClient;

  constructor(client?: SupabaseClient) {
    this.client = client ?? getSupabaseAdmin();
  }

  async create(input: AnalysisRunPersistenceInput) {
    let row: ReturnType<typeof analysisRunToRow>;
    try {
      row = analysisRunToRow(input);
      const expectedKey = analysisRunIdempotencyKey({
        case_id: row.case_id,
        run_type: row.run_type,
        trigger_reason: row.trigger_reason,
        input_snapshot_hash: row.input_snapshot_hash,
        engine_version: row.engine_version,
        contract_version: row.contract_version,
      });
      if (row.idempotency_key !== expectedKey) throw new TypeError("Invalid idempotency key");
    } catch {
      throw new EnginePersistenceError("invalid_persistence_input", "analysis_run.create");
    }

    const inserted = await this.client.from("analysis_runs").insert(row).select("*").single();
    if (!inserted.error) {
      return analysisRunFromRow(inserted.data);
    }
    if (!isUniqueViolation(inserted.error)) {
      throw new EnginePersistenceError("persistence_write_failed", "analysis_run.create");
    }

    const existing = await this.client
      .from("analysis_runs")
      .select("*")
      .eq("case_id", row.case_id)
      .eq("idempotency_key", row.idempotency_key)
      .single();
    if (existing.error || !existing.data) {
      throw new EnginePersistenceError("persistence_read_failed", "analysis_run.create_existing");
    }
    if (
      existing.data.input_snapshot_hash !== row.input_snapshot_hash ||
      existing.data.engine_version !== row.engine_version ||
      existing.data.contract_version !== row.contract_version
    ) {
      throw new EnginePersistenceError("persistence_conflict", "analysis_run.create_existing");
    }
    return analysisRunFromRow(existing.data);
  }

  async getById(analysisRunId: string) {
    const result = await this.client.from("analysis_runs").select("*").eq("id", analysisRunId).single();
    if (result.error || !result.data) {
      throw new EnginePersistenceError("persistence_record_not_found", "analysis_run.get");
    }
    try {
      return analysisRunFromRow(result.data);
    } catch {
      throw new EnginePersistenceError("persistence_read_failed", "analysis_run.get");
    }
  }

  async transition(input: unknown) {
    let update: ReturnType<typeof analysisRunLifecycleUpdateSchema.parse>;
    try {
      update = analysisRunLifecycleUpdateSchema.parse(input);
      analysisRunTransitionSchema.parse({
        analysis_run_id: update.analysis_run_id,
        from: update.from,
        to: update.to,
        reason: "repository_state_transition",
        occurred_at: update.occurred_at,
      });
      if ((update.to === "failed") !== (update.failure_code !== null)) {
        throw new TypeError("Failure metadata does not match the target state");
      }
    } catch {
      throw new EnginePersistenceError("invalid_state_transition", "analysis_run.transition");
    }

    const current = await this.getById(update.analysis_run_id);
    if (current.state !== update.from) {
      throw new EnginePersistenceError("persistence_conflict", "analysis_run.transition");
    }

    const terminal = new Set(["blocked", "completed", "failed"]).has(update.to);
    const values = {
      status: update.to,
      started_at: current.started_at ?? update.occurred_at,
      completed_at: terminal ? update.occurred_at : null,
      error_code: update.failure_code,
      error_stage: update.error_stage,
    };
    const result = await this.client
      .from("analysis_runs")
      .update(values)
      .eq("id", update.analysis_run_id)
      .eq("status", update.from)
      .select("*")
      .single();
    if (result.error || !result.data) {
      throw new EnginePersistenceError("persistence_write_failed", "analysis_run.transition");
    }
    return analysisRunFromRow(result.data);
  }
}
