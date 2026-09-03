import { z } from "zod";
import { agentNameSchema, domainCodeSchema, isoTimestampSchema, uuidSchema } from "../domain/primitives.ts";
import { questionReferenceSchema } from "./contracts.ts";

export const conversationSchema = z
  .object({
    conversation_id: uuidSchema,
    case_id: uuidSchema,
    analysis_run_id: uuidSchema,
    status: z.enum(["open", "waiting_for_customer", "closed"]),
    created_at: isoTimestampSchema,
    closed_at: isoTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((conversation, context) => {
    if (conversation.status === "closed" && conversation.closed_at === null) {
      context.addIssue({ code: "custom", message: "Closed conversations need a timestamp", path: ["closed_at"] });
    }
    if (conversation.status !== "closed" && conversation.closed_at !== null) {
      context.addIssue({
        code: "custom",
        message: "Only closed conversations may have a closed timestamp",
        path: ["closed_at"],
      });
    }
  });

export const modelReferenceSchema = z
  .object({
    provider: domainCodeSchema,
    model: z.string().trim().min(1).max(200),
  })
  .strict();

export const conversationMessageSchema = z
  .object({
    message_id: uuidSchema,
    case_id: uuidSchema,
    conversation_id: uuidSchema,
    analysis_run_id: uuidSchema,
    role: z.enum(["system", "assistant", "customer"]),
    agent: agentNameSchema.nullable(),
    question: questionReferenceSchema.nullable(),
    selected_option_ids: z.array(domainCodeSchema),
    free_text_answer: z.string().trim().min(1).max(10_000).nullable(),
    content: z.string().trim().min(1).max(20_000).nullable(),
    model: modelReferenceSchema.nullable(),
    prompt_version: z.string().trim().min(1).max(120).nullable(),
    created_at: isoTimestampSchema,
  })
  .strict()
  .superRefine((message, context) => {
    if (message.role === "assistant") {
      if (message.agent === null) {
        context.addIssue({ code: "custom", message: "Assistant messages require an agent", path: ["agent"] });
      }
      if (message.model === null || message.prompt_version === null) {
        context.addIssue({
          code: "custom",
          message: "Assistant messages require model and prompt-version provenance",
          path: ["model"],
        });
      }
    }

    if (message.role === "customer" && (message.agent !== null || message.model !== null || message.prompt_version !== null)) {
      context.addIssue({
        code: "custom",
        message: "Customer messages cannot claim agent or model provenance",
        path: ["agent"],
      });
    }

    const containsAnswer = message.selected_option_ids.length > 0 || message.free_text_answer !== null;
    if (containsAnswer && message.question === null) {
      context.addIssue({
        code: "custom",
        message: "Structured answers must reference their originating question",
        path: ["question"],
      });
    }
    if (!containsAnswer && message.content === null) {
      context.addIssue({
        code: "custom",
        message: "A message requires content or a structured answer",
        path: ["content"],
      });
    }
    if (new Set(message.selected_option_ids).size !== message.selected_option_ids.length) {
      context.addIssue({
        code: "custom",
        message: "Selected option IDs must be unique",
        path: ["selected_option_ids"],
      });
    }
  });

export type Conversation = Readonly<z.infer<typeof conversationSchema>>;
export type ConversationMessage = Readonly<z.infer<typeof conversationMessageSchema>>;
