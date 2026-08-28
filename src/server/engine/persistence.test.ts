import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

import { AnalysisRunRepository } from "./analysis-run-repository";
import { ExtractionRepository } from "./extraction-repository";
import {
  analysisJobIdempotencyKey,
  analysisRunIdempotencyKey,
  conversationQuestionIdempotencyKey,
  documentExtractionIdempotencyKey,
  findingIdempotencyKey,
  hashCanonicalJson,
} from "./idempotency";
import {
  analysisRunFromRow,
  analysisRunToRow,
  documentFromRow,
  extractionToRow,
  findingFromRow,
  findingToRow,
} from "./mappers";
import {
  analysisJobSchema,
  analysisRunInputSnapshotSchema,
  documentExtractionAttemptSchema,
  employmentSnapshotPersistenceInputSchema,
} from "./persistence-contracts";
import { EnginePersistenceError } from "./repository-error";
import { safeEngineLogSchema, toSafeEngineLog } from "./safe-logging";
import { employmentSnapshotSchema } from "@/engine/facts/snapshot";
import { findingSchema } from "@/engine/findings/contracts";

const ids = {
  case: "11111111-1111-4111-8111-111111111111",
  run: "22222222-2222-4222-8222-222222222222",
  parentRun: "23232323-2323-4232-8232-232323232323",
  fact: "33333333-3333-4333-8333-333333333333",
  document: "66666666-6666-4666-8666-666666666666",
  extraction: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  calculation: "77777777-7777-4777-8777-777777777777",
  finding: "88888888-8888-4888-8888-888888888888",
  conversation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  job: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
} as const;
const now = "2026-08-29T08:00:00.000Z";
const later = "2026-08-29T08:01:00.000Z";
const sourceHash = "b".repeat(64);

const evidence = {
  source_type: "documented" as const,
  source_reference: {
    kind: "document" as const,
    document_id: ids.document,
    locator: { page: 1, text_span: "Base salary" },
  },
};

function immutableDocument() {
  return {
    document_id: ids.document,
    case_id: ids.case,
    document_type: "payslip",
    original_filename: "july.pdf",
    mime_type: "application/pdf",
    size_bytes: 120_000,
    content_sha256: sourceHash,
    storage_path: `cases/${ids.case}/documents/${ids.document}/original.pdf`,
    document_period: { start_date: "2026-07-01", end_date: "2026-07-31" },
    supersedes_document_id: null,
    created_at: now,
  };
}

function salaryFact(overrides: Record<string, unknown> = {}) {
  return {
    fact_id: ids.fact,
    case_id: ids.case,
    path: "compensation.base_monthly_salary",
    value: { currency: "ILS", minor_units: 940_000 },
    status: "confirmed",
    provenance: [evidence],
    confidence: 0.99,
    conflicting_fact_ids: [],
    resolution: null,
    created_at: now,
    ...overrides,
  };
}

function finding(overrides: Record<string, unknown> = {}) {
  const rule = { rule_id: "wages.base_salary", rule_version: "1.0" };
  return {
    finding_id: ids.finding,
    case_id: ids.case,
    analysis_run_id: ids.run,
    category: "base_salary",
    status: "verified",
    period: { start_date: "2026-07-01", end_date: "2026-07-31" },
    paid: { currency: "ILS", minor_units: 900_000 },
    expected: { currency: "ILS", minor_units: 940_000 },
    potential_gap: { currency: "ILS", minor_units: 40_000 },
    confidence: 0.97,
    confidence_tier: "high",
    fact_references: [ids.fact],
    evidence_references: [evidence],
    rule,
    calculation_trace: {
      calculation_id: ids.calculation,
      formula_id: "salary.expected_minor_units",
      formula_version: "1.0",
      rule,
      engine_version: "1.0",
      inputs: [
        {
          input_id: "base_salary",
          fact_id: ids.fact,
          fact_path: "compensation.base_monthly_salary",
          value: { kind: "money", value: { currency: "ILS", minor_units: 940_000 } },
        },
      ],
      steps: [
        {
          step_id: "expected_salary",
          operation: "identity",
          input_refs: ["base_salary"],
          result: { kind: "money", value: { currency: "ILS", minor_units: 940_000 } },
          explanation: "Carry the validated salary into the expected amount.",
        },
      ],
      output: { kind: "money", value: { currency: "ILS", minor_units: 940_000 } },
      calculated_at: now,
    },
    requires_confirmation: false,
    created_at: now,
    ...overrides,
  };
}

function inputSnapshot() {
  return {
    schema_version: "1.0",
    document_ids: [ids.document],
    extraction_ids: [ids.extraction],
    conversation_message_ids: [],
    questionnaire_response_id: null,
    parent_snapshot_id: null,
  };
}

function runPersistenceInput() {
  const snapshot = inputSnapshot();
  const run = {
    analysis_run_id: ids.run,
    case_id: ids.case,
    parent_run_id: ids.parentRun,
    run_type: "full_investigation" as const,
    state: "queued" as const,
    engine_version: "1.0",
    contract_version: "1.0",
    created_at: now,
    started_at: null,
    completed_at: null,
    failure_code: null,
  };
  return {
    run,
    trigger_reason: "new_evidence",
    engine_git_sha: "a".repeat(40),
    ontology_version: "1.0",
    rule_set_hash: null,
    input_snapshot: snapshot,
    idempotency_key: analysisRunIdempotencyKey({
      case_id: ids.case,
      run_type: run.run_type,
      trigger_reason: "new_evidence",
      input_snapshot_hash: hashCanonicalJson(snapshot),
      engine_version: run.engine_version,
      contract_version: run.contract_version,
    }),
    error_stage: null,
  };
}

function extraction(status: "queued" | "running" | "partial" | "completed" | "failed" = "queued") {
  const terminal = new Set(["partial", "completed", "failed"]).has(status);
  return {
    extraction_id: ids.extraction,
    document_id: ids.document,
    analysis_run_id: ids.run,
    extractor_id: "fixture_extractor",
    extractor_version: "1.0",
    model_version: null,
    source_content_sha256: sourceHash,
    status,
    payload:
      status === "completed"
        ? {
            document: immutableDocument(),
            extraction_id: ids.extraction,
            content_sha256: sourceHash,
            pages: [{ page_number: 1, text: "Base salary" }],
            extracted_at: later,
          }
        : null,
    quality_metrics: { page_count: status === "completed" ? 1 : null, mean_confidence: null, warning_codes: [] },
    raw_artifact_path: null,
    idempotency_key: documentExtractionIdempotencyKey({
      document_id: ids.document,
      content_sha256: sourceHash,
      extractor_id: "fixture_extractor",
      extractor_version: "1.0",
      model_version: null,
    }),
    created_at: now,
    completed_at: terminal ? later : null,
    error_code: status === "failed" ? "extractor_timeout" : null,
  };
}

describe("persistence validators and mappings", () => {
  it("validates a canonical snapshot and rejects cross-case or duplicate-path facts", () => {
    const snapshot = {
      snapshot_id: ids.parentRun,
      case_id: ids.case,
      analysis_run_id: ids.run,
      schema_version: "1.0",
      facts: [salaryFact()],
      created_at: now,
    };
    expect(employmentSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(employmentSnapshotSchema.safeParse({ ...snapshot, facts: [salaryFact(), salaryFact()] }).success).toBe(false);
    expect(
      employmentSnapshotSchema.safeParse({
        ...snapshot,
        facts: [salaryFact({ case_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" })],
      }).success,
    ).toBe(false);
    expect(
      employmentSnapshotPersistenceInputSchema.safeParse({
        snapshot,
        payload_hash: hashCanonicalJson(snapshot),
      }).success,
    ).toBe(true);
  });

  it("keeps the analysis-run lineage and reference-only input manifest intact", () => {
    const input = runPersistenceInput();
    const row = analysisRunToRow(input);
    expect(row.parent_run_id).toBe(ids.parentRun);
    expect(row.input_snapshot_hash).toBe(hashCanonicalJson(input.input_snapshot));
    expect(analysisRunFromRow(row).parent_run_id).toBe(ids.parentRun);
    expect(
      analysisRunInputSnapshotSchema.safeParse({ ...inputSnapshot(), document_ids: [ids.document, ids.document] }).success,
    ).toBe(false);
  });

  it("maps money only as safe integer minor units", () => {
    const value = findingSchema.parse(finding());
    const key = findingIdempotencyKey({
      analysis_run_id: ids.run,
      category: "base_salary",
      period_start: "2026-07-01",
      period_end: "2026-07-31",
      rule_id: "wages.base_salary",
      rule_version: "1.0",
      fact_references: [ids.fact],
    });
    const row = findingToRow({ finding: value, idempotency_key: key });
    expect(row.potential_gap_minor_units).toBe(40_000);
    expect(findingFromRow(row, ids.case).potential_gap?.minor_units).toBe(40_000);
    expect(() =>
      findingToRow({
        finding: findingSchema.parse(finding({ paid: { currency: "ILS", minor_units: 1.5 } })),
        idempotency_key: key,
      }),
    ).toThrow();
    expect(() => findingFromRow({ ...row, paid_minor_units: "9007199254740992" }, ids.case)).toThrow();
  });

  it("distinguishes legacy upload rows from immutable engine documents", () => {
    const legacy = documentFromRow({
      id: ids.document,
      case_id: ids.case,
      document_type: "payslip",
      declared_type: null,
      content_sha256: null,
      storage_path: `cases/${ids.case}/payslip-01.pdf`,
      original_filename: "legacy.pdf",
      mime_type: "application/pdf",
      size: 1000,
      period_start: null,
      period_end: null,
      supersedes_document_id: null,
      processing_status: "uploaded",
      storage_layout: "legacy_slot",
      created_at: now,
    });
    expect("storage_layout" in legacy && legacy.storage_layout).toBe("legacy_slot");
    expect(() => documentFromRow({ ...legacy, storage_layout: "immutable_v1" })).toThrow();
  });

  it("enforces extraction completion, source hashes, and retryable job limits", () => {
    expect(documentExtractionAttemptSchema.safeParse(extraction("completed")).success).toBe(true);
    expect(
      documentExtractionAttemptSchema.safeParse({ ...extraction("completed"), source_content_sha256: "c".repeat(64) }).success,
    ).toBe(false);
    expect(
      analysisJobSchema.safeParse({
        job_id: ids.job,
        analysis_run_id: ids.run,
        document_id: ids.document,
        extraction_id: ids.extraction,
        stage: "extract_document",
        status: "retry_scheduled",
        payload: {},
        idempotency_key: analysisJobIdempotencyKey({
          analysis_run_id: ids.run,
          stage: "extract_document",
          document_id: ids.document,
          extraction_id: ids.extraction,
          input_hash: hashCanonicalJson({}),
        }),
        retry_count: 3,
        max_attempts: 3,
        available_at: later,
        locked_at: null,
        completed_at: null,
        error_code: null,
        created_at: now,
        updated_at: now,
      }).success,
    ).toBe(false);
  });
});

describe("stable idempotency boundaries", () => {
  it("canonicalizes object key order", () => {
    expect(hashCanonicalJson({ a: 1, b: 2 })).toBe(hashCanonicalJson({ b: 2, a: 1 }));
  });

  it("keeps finding retries stable regardless of fact ordering or generated finding ID", () => {
    const base = {
      analysis_run_id: ids.run,
      category: "base_salary",
      period_start: "2026-07-01",
      period_end: "2026-07-31",
      rule_id: "wages.base_salary",
      rule_version: "1.0",
      fact_references: [ids.fact, ids.document],
    };
    expect(findingIdempotencyKey(base)).toBe(findingIdempotencyKey({ ...base, fact_references: [...base.fact_references].reverse() }));
    expect(findingIdempotencyKey(base)).not.toBe(findingIdempotencyKey({ ...base, rule_version: "2.0" }));
  });

  it("separates extraction, job, run, and question boundaries", () => {
    const questionKey = conversationQuestionIdempotencyKey({
      conversation_id: ids.conversation,
      analysis_run_id: ids.run,
      question_id: "salary.type",
      question_version: 1,
    });
    expect(questionKey).not.toBe(
      conversationQuestionIdempotencyKey({
        conversation_id: ids.conversation,
        analysis_run_id: ids.run,
        question_id: "salary.type",
        question_version: 2,
      }),
    );
    expect(extraction("queued").idempotency_key.startsWith("document-extraction:")).toBe(true);
    expect(runPersistenceInput().idempotency_key.startsWith("analysis-run:")).toBe(true);
  });
});

describe("safe logging", () => {
  it("accepts identifiers and operational metadata only", () => {
    expect(
      toSafeEngineLog({
        event: "extraction_failed",
        timestamp: now,
        case_id: ids.case,
        document_id: ids.document,
        stage: "extract_document",
        duration_ms: 900,
        error_code: "extractor_timeout",
        retry_count: 1,
      }).error_code,
    ).toBe("extractor_timeout");
  });

  it("rejects PII and raw document or chat content", () => {
    for (const unsafeField of ["employee_name", "email", "phone", "ocr_text", "salary", "message_text"]) {
      expect(safeEngineLogSchema.safeParse({ event: "unsafe", timestamp: now, [unsafeField]: "sensitive" }).success).toBe(false);
    }
  });
});

describe("repository history and duplicate handling", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns the existing analysis run after a scoped idempotency conflict without updating it", async () => {
    const input = runPersistenceInput();
    const row = analysisRunToRow(input);
    const insertSingle = vi.fn().mockResolvedValue({ data: null, error: { code: "23505" } });
    const existingSingle = vi.fn().mockResolvedValue({ data: row, error: null });
    const secondEq = vi.fn(() => ({ single: existingSingle }));
    const firstEq = vi.fn(() => ({ eq: secondEq }));
    const from = vi
      .fn()
      .mockReturnValueOnce({ insert: () => ({ select: () => ({ single: insertSingle }) }) })
      .mockReturnValueOnce({ select: () => ({ eq: firstEq }) });
    const repository = new AnalysisRunRepository({ from } as unknown as SupabaseClient);

    await expect(repository.create(input)).resolves.toMatchObject({ analysis_run_id: ids.run });
    expect(from).toHaveBeenCalledTimes(2);
  });

  it("refuses to advance a terminal extraction attempt", async () => {
    const terminalRow = extractionToRow(extraction("failed"));
    const currentSingle = vi.fn().mockResolvedValue({ data: terminalRow, error: null });
    const from = vi.fn(() => ({ select: () => ({ eq: () => ({ single: currentSingle }) }) }));
    const repository = new ExtractionRepository({ from } as unknown as SupabaseClient);

    await expect(repository.advanceAttempt(extraction("running"))).rejects.toMatchObject({
      code: "invalid_state_transition",
    } satisfies Partial<EnginePersistenceError>);
    expect(from).toHaveBeenCalledTimes(1);
  });
});
