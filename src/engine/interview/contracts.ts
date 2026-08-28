import { z } from "zod";
import { domainCodeSchema } from "../domain/primitives";
import { factPathSchema } from "../facts/fact-paths";

export const questionTypeSchema = z.enum([
  "single_choice",
  "multi_choice",
  "yes_no",
  "number",
  "money",
  "date",
  "time",
  "document_request",
  "free_text",
]);

export const normalizedOptionValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

export const questionOptionSchema = z
  .object({
    option_id: domainCodeSchema,
    label: z.string().trim().min(1).max(300),
    normalized_value: normalizedOptionValueSchema,
  })
  .strict();

export const interviewQuestionSchema = z
  .object({
    question_id: domainCodeSchema,
    version: z.number().int().positive(),
    type: questionTypeSchema,
    target_fact_path: factPathSchema,
    text: z.string().trim().min(1).max(2_000),
    options: z.array(questionOptionSchema),
    allow_free_text: z.boolean(),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict()
  .superRefine((question, context) => {
    const choiceTypes = new Set(["single_choice", "multi_choice", "yes_no"]);
    if (choiceTypes.has(question.type) && question.options.length < 2) {
      context.addIssue({
        code: "custom",
        message: "Choice questions require at least two options",
        path: ["options"],
      });
    }
    if (!choiceTypes.has(question.type) && question.options.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Only choice questions may define options",
        path: ["options"],
      });
    }

    const optionIds = question.options.map((option) => option.option_id);
    if (new Set(optionIds).size !== optionIds.length) {
      context.addIssue({ code: "custom", message: "Option IDs must be unique", path: ["options"] });
    }

    if (question.type === "yes_no") {
      const normalizedValues = question.options.map((option) => option.normalized_value);
      if (
        question.options.length !== 2 ||
        !normalizedValues.includes(true) ||
        !normalizedValues.includes(false)
      ) {
        context.addIssue({
          code: "custom",
          message: "Yes/no questions require exactly one true and one false option",
          path: ["options"],
        });
      }
    }
  });

export const questionReferenceSchema = z
  .object({
    question_id: domainCodeSchema,
    version: z.number().int().positive(),
  })
  .strict();

export type InterviewQuestion = Readonly<z.infer<typeof interviewQuestionSchema>>;
export type QuestionReference = Readonly<z.infer<typeof questionReferenceSchema>>;
