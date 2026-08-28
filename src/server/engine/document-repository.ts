import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { documentFromRow } from "./mappers";
import { EnginePersistenceError } from "./repository-error";

/** Phase A is intentionally read-only; immutable document writes arrive with the future engine upload API. */
export class EngineDocumentRepository {
  private readonly client: SupabaseClient;

  constructor(client?: SupabaseClient) {
    this.client = client ?? getSupabaseAdmin();
  }

  async getById(documentId: string) {
    const result = await this.client.from("documents").select("*").eq("id", documentId).single();
    if (result.error || !result.data) {
      throw new EnginePersistenceError("persistence_record_not_found", "document.get");
    }
    try {
      return documentFromRow(result.data);
    } catch {
      throw new EnginePersistenceError("persistence_read_failed", "document.get");
    }
  }
}
