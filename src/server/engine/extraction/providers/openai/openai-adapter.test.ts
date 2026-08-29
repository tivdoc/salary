import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { minimizePayslipForSemanticProcessing } from "@/engine/extraction/minimize";
import { normalizePayslipExtraction } from "@/engine/extraction/normalization";
import { syntheticPayslipFixtures } from "@/engine/extraction/fixtures/source-fixtures";
import { safeEngineLogSchema } from "@/server/engine/safe-logging";
import { OpenAiDocumentExtractor } from "./adapter";
import { DEFAULT_OPENAI_EXTRACTION_MODEL, resolveOpenAiExtractionConfig } from "./config";
import { classifyOpenAiError } from "./errors";
import { buildOpenAiResponsesRequest } from "./request";
import { openAiPayslipStructuredOutputSchema, type OpenAiPayslipStructuredOutput } from "./schema";
import type { OpenAiResponsesTransport } from "./transport";

const fixture = syntheticPayslipFixtures[0];
const fixedTime = "2026-08-29T12:00:00.000Z";

const structuredOutput: OpenAiPayslipStructuredOutput = {
  detected_document_type: "payslip",
  document_quality: "high",
  page_count: 1,
  rotation_degrees: 0,
  source_resolution_dpi: 300,
  earnings_components_complete: true,
  fields: [
    {
      field: "salary_period",
      raw_value: "08/2026",
      confidence: "high",
      evidence: { page: 1, source_label: "תקופת שכר" },
      warnings: [],
    },
    {
      field: "salary_type",
      raw_value: "monthly",
      confidence: "high",
      evidence: { page: 1, source_label: "Salary type" },
      warnings: [],
    },
    {
      field: "gross_salary",
      raw_value: "8,500.00",
      confidence: "medium",
      evidence: { page: 1, source_label: "ברוטו" },
      warnings: ["ambiguous_value"],
    },
  ],
  additional_components: [
    {
      source_label: "בונוס ניסוי",
      quantity_raw: "1",
      rate_raw: null,
      amount_raw: "500.00",
      confidence: "high",
      evidence: { page: 1, source_label: "בונוס ניסוי" },
      warnings: ["unknown_component"],
    },
  ],
  sensitive_metadata: [
    {
      kind: "employee_name",
      raw_value: "עובדת סינתטית",
      confidence: "high",
      evidence: { page: 1, source_label: "שם עובד" },
      warnings: [],
    },
  ],
  warnings: [],
};

function response(outputParsed: OpenAiPayslipStructuredOutput | null = structuredOutput) {
  return {
    id: "resp_synthetic_001",
    status: "completed",
    outputParsed,
    usage: { input_tokens: 1200, output_tokens: 300, total_tokens: 1500 },
  };
}

function extractor(transport: OpenAiResponsesTransport, logs: unknown[] = []) {
  let tick = 100;
  return new OpenAiDocumentExtractor(
    { apiKey: "unit-test-key", model: "gpt-5.6-sol", timeoutMs: 10_000 },
    {
      transport,
      clock: () => new Date(fixedTime),
      durationClock: () => {
        tick += 25;
        return tick;
      },
      log: (entry) => logs.push(entry),
    },
  );
}

const source = { read: vi.fn(async () => new Uint8Array([1, 2, 3, 4])) };

describe("OpenAI Responses request construction", () => {
  it.each([
    ["application/pdf" as const, "input_file", "data:application/pdf;base64,"],
    ["image/jpeg" as const, "input_image", "data:image/jpeg;base64,"],
    ["image/png" as const, "input_image", "data:image/png;base64,"],
  ])("constructs private %s input with strict structured output", (mimeType, expectedType, prefix) => {
    const request = buildOpenAiResponsesRequest({ model: "gpt-5.6-sol", mimeType, bytes: new Uint8Array([1, 2]) });
    const documentInput = request.input[0].content[1];
    expect(documentInput.type).toBe(expectedType);
    if (documentInput.type === "input_text") throw new TypeError("Expected a document input");
    const encoded = documentInput.type === "input_file" ? documentInput.file_data : documentInput.image_url;
    expect(encoded.startsWith(prefix)).toBe(true);
    expect(request.store).toBe(false);
    expect(request.text.format.type).toBe("json_schema");
    expect(request.instructions).toContain("Do not decide legal entitlement");
    expect(JSON.stringify(request)).not.toContain("unit-test-key");
  });
});

describe("OpenAI extraction adapter", () => {
  it("implements the provider-independent contract and records safe operational metadata", async () => {
    const parse = vi.fn(async () => response());
    const logs: unknown[] = [];
    const result = await extractor({ parse }, logs).extract(fixture.request, source);

    expect(parse).toHaveBeenCalledOnce();
    expect(result.provider).toEqual({ provider_id: "openai", extractor_version: "1.0", model_version: "gpt-5.6-sol" });
    expect(result.operation).toEqual({
      duration_ms: 25,
      provider_response_id: "resp_synthetic_001",
      token_usage: { input_tokens: 1200, output_tokens: 300, total_tokens: 1500 },
    });
    expect(result.fields.find((field) => field.field === "gross_salary")).toMatchObject({
      raw_value: "8,500.00",
      confidence: 0.62,
      extraction_method: "ai_vision",
      warning_flags: ["ambiguous_value"],
      source: { document_id: fixture.request.document.document_id, page: 1 },
    });
    expect(logs).toHaveLength(1);
    expect(safeEngineLogSchema.safeParse(logs[0]).success).toBe(true);
  });

  it("keeps sensitive metadata out of the minimized representation", async () => {
    const result = await extractor({ parse: async () => response() }).extract(fixture.request, source);
    expect(result.sensitive_metadata[0].raw_value).toBe("עובדת סינתטית");
    const minimized = minimizePayslipForSemanticProcessing(normalizePayslipExtraction(result));
    const serialized = JSON.stringify(minimized);
    expect(serialized).not.toContain("עובדת סינתטית");
    expect(serialized).not.toContain("employee_name");
  });

  it("fails safely without an API key and never reads the document", async () => {
    const read = vi.fn(async () => new Uint8Array([1]));
    const result = await new OpenAiDocumentExtractor(
      { apiKey: null, model: "gpt-5.6-sol", timeoutMs: 10_000 },
      { clock: () => new Date(fixedTime), durationClock: () => 0 },
    ).extract(fixture.request, { read });
    expect(result.status).toBe("failed");
    expect(result.error_code).toBe("openai_not_configured");
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects unsupported documents before sending bytes", async () => {
    const parse = vi.fn(async () => response());
    const request = {
      ...fixture.request,
      document: { ...fixture.request.document, mime_type: "text/plain" },
    };
    const result = await extractor({ parse }).extract(request, source);
    expect(result.error_code).toBe("unsupported_document");
    expect(parse).not.toHaveBeenCalled();
  });

  it("maps absent values to missing candidates rather than invented values", async () => {
    const output = {
      ...structuredOutput,
      fields: structuredOutput.fields.map((field) => field.field === "gross_salary" ? { ...field, raw_value: null } : field),
    };
    const result = await extractor({ parse: async () => response(output) }).extract(fixture.request, source);
    expect(result.fields.some((field) => field.field === "gross_salary")).toBe(false);
  });

  it("returns safe categories for null or malformed provider output", async () => {
    const invalid = await extractor({ parse: async () => response(null) }).extract(fixture.request, source);
    expect(invalid.error_code).toBe("provider_invalid_response");

    const malformedTransport: OpenAiResponsesTransport = {
      parse: async () => ({ ...response(), outputParsed: {} as OpenAiPayslipStructuredOutput }),
    };
    const malformed = await extractor(malformedTransport).extract(fixture.request, source);
    expect(malformed.error_code).toBe("structured_output_validation_failed");
  });

  it("does not leak provider errors, PII, salary values, or API keys through safe logs", async () => {
    const logs: unknown[] = [];
    const result = await extractor({
      parse: async () => {
        throw Object.assign(new Error("עובדת סינתטית 8,500 unit-test-key"), { status: 429 });
      },
    }, logs).extract(fixture.request, source);
    expect(result.error_code).toBe("provider_rate_limit");
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("עובדת סינתטית");
    expect(serialized).not.toContain("8,500");
    expect(serialized).not.toContain("unit-test-key");
  });
});

describe("OpenAI configuration, errors, and schema safety", () => {
  it("uses a current configurable model default and treats blank keys as absent", () => {
    expect(resolveOpenAiExtractionConfig({})).toEqual({
      apiKey: null,
      model: DEFAULT_OPENAI_EXTRACTION_MODEL,
      timeoutMs: 120_000,
    });
    expect(resolveOpenAiExtractionConfig({ OPENAI_API_KEY: " ", OPENAI_EXTRACTION_MODEL: "gpt-5.6-terra" }).model)
      .toBe("gpt-5.6-terra");
  });

  it("classifies timeouts and rate limits without retaining raw error content", () => {
    expect(classifyOpenAiError({ name: "APITimeoutError", message: "private content" })).toBe("provider_timeout");
    expect(classifyOpenAiError({ status: 429, message: "private content" })).toBe("provider_rate_limit");
    expect(classifyOpenAiError(new Error("private content"))).toBe("extraction_failed");
  });

  it("strictly excludes legal conclusions and arbitrary prose", () => {
    expect(openAiPayslipStructuredOutputSchema.safeParse({
      ...structuredOutput,
      legal_conclusion: "The employer violated the law",
    }).success).toBe(false);
    expect(openAiPayslipStructuredOutputSchema.safeParse({
      ...structuredOutput,
      narrative: "arbitrary model prose",
    }).success).toBe(false);
  });
});
