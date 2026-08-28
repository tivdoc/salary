import "server-only";
import { createHash } from "node:crypto";
import type { AnalysisRunType } from "@/engine/investigation/analysis-run";
import { idempotencyKeySchema } from "./persistence-contracts";

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("Idempotency input must contain finite JSON numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

export function hashCanonicalJson(value: JsonValue) {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function key(scope: string, value: JsonValue) {
  return idempotencyKeySchema.parse(`${scope}:${hashCanonicalJson(value)}`);
}

export function analysisRunIdempotencyKey(input: {
  case_id: string;
  run_type: AnalysisRunType;
  trigger_reason: string;
  input_snapshot_hash: string;
  engine_version: string;
  contract_version: string;
}) {
  return key("analysis-run", input);
}

export function documentExtractionIdempotencyKey(input: {
  document_id: string;
  content_sha256: string;
  extractor_id: string;
  extractor_version: string;
  model_version: string | null;
}) {
  return key("document-extraction", input);
}

export function analysisJobIdempotencyKey(input: {
  analysis_run_id: string;
  stage: string;
  document_id: string | null;
  extraction_id: string | null;
  input_hash: string;
}) {
  return key("analysis-job", input);
}

export function conversationQuestionIdempotencyKey(input: {
  conversation_id: string;
  analysis_run_id: string;
  question_id: string;
  question_version: number;
}) {
  return key("conversation-question", input);
}

/** Deliberately excludes finding_id so retries cannot duplicate the same monetary conclusion. */
export function findingIdempotencyKey(input: {
  analysis_run_id: string;
  category: string;
  period_start: string | null;
  period_end: string | null;
  rule_id: string;
  rule_version: string;
  fact_references: readonly string[];
}) {
  return key("finding", { ...input, fact_references: [...input.fact_references].sort() });
}
