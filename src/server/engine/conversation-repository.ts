import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { conversationQuestionIdempotencyKey } from "./idempotency";
import { conversationFromRow, conversationToRow, messageFromRow, messageToRow } from "./mappers";
import type { ConversationPersistenceInput, MessagePersistenceInput } from "./persistence-contracts";
import { EnginePersistenceError, isUniqueViolation } from "./repository-error";

export class ConversationRepository {
  private readonly client: SupabaseClient;

  constructor(client?: SupabaseClient) {
    this.client = client ?? getSupabaseAdmin();
  }

  async create(input: ConversationPersistenceInput) {
    let row: ReturnType<typeof conversationToRow>;
    try {
      row = conversationToRow(input);
    } catch {
      throw new EnginePersistenceError("invalid_persistence_input", "conversation.create");
    }
    const inserted = await this.client.from("case_conversations").insert(row).select("*").single();
    if (!inserted.error) return conversationFromRow(inserted.data);
    if (!isUniqueViolation(inserted.error)) {
      throw new EnginePersistenceError("persistence_write_failed", "conversation.create");
    }
    const existing = await this.client
      .from("case_conversations")
      .select("*")
      .eq("case_id", row.case_id)
      .eq("idempotency_key", row.idempotency_key)
      .single();
    if (existing.error || !existing.data) {
      throw new EnginePersistenceError("persistence_read_failed", "conversation.create_existing");
    }
    return conversationFromRow(existing.data);
  }

  async appendMessage(input: MessagePersistenceInput) {
    let row: ReturnType<typeof messageToRow>;
    try {
      row = messageToRow(input);
      if (row.role === "assistant" && row.question_id !== null && row.question_version !== null) {
        const expectedKey = conversationQuestionIdempotencyKey({
          conversation_id: row.conversation_id,
          analysis_run_id: row.analysis_run_id,
          question_id: row.question_id,
          question_version: row.question_version,
        });
        if (row.idempotency_key !== expectedKey) throw new TypeError("Invalid idempotency key");
      }
    } catch {
      throw new EnginePersistenceError("invalid_persistence_input", "conversation.append_message");
    }
    const inserted = await this.client.from("case_messages").insert(row).select("*").single();
    if (!inserted.error) return messageFromRow(inserted.data);
    if (!isUniqueViolation(inserted.error)) {
      throw new EnginePersistenceError("persistence_write_failed", "conversation.append_message");
    }
    const existing = await this.client
      .from("case_messages")
      .select("*")
      .eq("conversation_id", row.conversation_id)
      .eq("idempotency_key", row.idempotency_key)
      .single();
    if (existing.error || !existing.data) {
      throw new EnginePersistenceError("persistence_read_failed", "conversation.append_message_existing");
    }
    return messageFromRow(existing.data);
  }

  async close(conversationId: string, closedAt: string) {
    const currentResult = await this.client
      .from("case_conversations")
      .select("*")
      .eq("id", conversationId)
      .single();
    if (currentResult.error || !currentResult.data) {
      throw new EnginePersistenceError("persistence_record_not_found", "conversation.close");
    }
    let current: ReturnType<typeof conversationFromRow>;
    try {
      current = conversationFromRow(currentResult.data);
    } catch {
      throw new EnginePersistenceError("persistence_read_failed", "conversation.close");
    }
    if (current.status === "closed") return current;

    const result = await this.client
      .from("case_conversations")
      .update({ status: "closed", closed_at: closedAt })
      .eq("id", conversationId)
      .eq("status", current.status)
      .select("*")
      .single();
    if (result.error || !result.data) {
      throw new EnginePersistenceError("persistence_write_failed", "conversation.close");
    }
    try {
      return conversationFromRow(result.data);
    } catch {
      throw new EnginePersistenceError("persistence_read_failed", "conversation.close");
    }
  }
}
