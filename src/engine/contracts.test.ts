import { describe, expect, it } from "vitest";
import {
  agentPermissions,
  calculationTraceSchema,
  canInvestigationStop,
  canonicalFactSchema,
  conversationMessageSchema,
  conversationSchema,
  documentIntelligenceExchangeSchema,
  documentIntelligenceInputSchema,
  documentIntelligenceOutputSchema,
  factResolverExchangeSchema,
  factResolverInputSchema,
  factResolverOutputSchema,
  findingSchema,
  immutableDocumentSchema,
  interviewAgentExchangeSchema,
  interviewAgentOutputSchema,
  interviewQuestionSchema,
  investigatorExchangeSchema,
  investigatorInputSchema,
  investigatorOutputSchema,
  isAnalysisRunTransitionAllowed,
  legalApplicabilityInputSchema,
  legalApplicabilityExchangeSchema,
  legalApplicabilityOutputSchema,
  moneySchema,
  nonNegativeMoneySchema,
  reportAgentExchangeSchema,
  reportAgentInputSchema,
  reportAgentOutputSchema,
  ruleCatalogEntrySchema,
  analysisRunSchema,
  analysisRunTransitionSchema,
  investigationHypothesisSchema,
} from "./index.ts";

const ids = {
  case: "11111111-1111-4111-8111-111111111111",
  run: "22222222-2222-4222-8222-222222222222",
  parentRun: "23232323-2323-4232-8232-232323232323",
  fact: "33333333-3333-4333-8333-333333333333",
  factTwo: "44444444-4444-4444-8444-444444444444",
  factThree: "55555555-5555-4555-8555-555555555555",
  document: "66666666-6666-4666-8666-666666666666",
  calculation: "77777777-7777-4777-8777-777777777777",
  finding: "88888888-8888-4888-8888-888888888888",
  hypothesis: "99999999-9999-4999-8999-999999999999",
  conversation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  message: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  response: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  output: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  conflict: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
} as const;

const now = "2026-08-29T08:00:00.000Z";
const later = "2026-08-29T08:01:00.000Z";

const documentedEvidence = {
  source_type: "documented",
  source_reference: {
    kind: "document",
    document_id: ids.document,
    locator: { page: 1, text_span: "Base salary" },
  },
} as const;

const declaredEvidence = {
  source_type: "declared",
  source_reference: {
    kind: "conversation_message",
    conversation_id: ids.conversation,
    message_id: ids.message,
  },
} as const;

const inferredEvidence = {
  source_type: "inferred",
  source_reference: {
    kind: "agent_output",
    analysis_run_id: ids.run,
    agent: "investigator",
    output_id: ids.output,
  },
} as const;

function salaryFact(overrides: Record<string, unknown> = {}) {
  return {
    fact_id: ids.fact,
    case_id: ids.case,
    path: "compensation.base_monthly_salary",
    value: { currency: "ILS", minor_units: 940_000 },
    status: "confirmed",
    provenance: [documentedEvidence],
    confidence: 0.99,
    conflicting_fact_ids: [],
    resolution: null,
    created_at: now,
    ...overrides,
  };
}

const ruleReference = { rule_id: "wages.base_salary", rule_version: "1.0" } as const;

function calculationTrace(overrides: Record<string, unknown> = {}) {
  return {
    calculation_id: ids.calculation,
    formula_id: "salary.expected_minor_units",
    formula_version: "1.0",
    rule: ruleReference,
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
        explanation: "Carry the validated base salary into the expected amount.",
      },
    ],
    output: { kind: "money", value: { currency: "ILS", minor_units: 940_000 } },
    calculated_at: now,
    ...overrides,
  };
}

function finding(overrides: Record<string, unknown> = {}) {
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
    evidence_references: [documentedEvidence],
    rule: ruleReference,
    calculation_trace: calculationTrace(),
    requires_confirmation: false,
    created_at: now,
    ...overrides,
  };
}

function hypothesis(overrides: Record<string, unknown> = {}) {
  return {
    hypothesis_id: ids.hypothesis,
    case_id: ids.case,
    analysis_run_id: ids.run,
    category: "base_salary",
    status: "confirmed",
    priority: "high",
    reason: "Documented base salary differs from the recorded payment.",
    supporting_fact_ids: [ids.fact],
    conflicting_fact_ids: [],
    required_fact_paths: [],
    proposed_rules: [ruleReference],
    ...overrides,
  };
}

function approvedQuestion(overrides: Record<string, unknown> = {}) {
  return {
    question_id: "salary.type",
    version: 1,
    type: "single_choice",
    target_fact_path: "compensation.salary_type",
    text: "How is your salary defined?",
    options: [
      { option_id: "monthly", label: "Monthly", normalized_value: "monthly" },
      { option_id: "hourly", label: "Hourly", normalized_value: "hourly" },
    ],
    allow_free_text: true,
    reason: "Choose the correct calculation basis.",
    ...overrides,
  };
}

function approvedRule(overrides: Record<string, unknown> = {}) {
  return {
    ...ruleReference,
    title: "Fixture metadata only",
    jurisdiction: "IL",
    status: "approved",
    valid_from: "2026-01-01",
    valid_through: null,
    required_fact_paths: ["compensation.base_monthly_salary"],
    formula_ids: ["salary.expected_minor_units"],
    content_sha256: "a".repeat(64),
    published_at: now,
    ...overrides,
  };
}

function immutableDocument(overrides: Record<string, unknown> = {}) {
  return {
    document_id: ids.document,
    case_id: ids.case,
    document_type: "payslip",
    original_filename: "july.pdf",
    mime_type: "application/pdf",
    size_bytes: 120_000,
    content_sha256: "b".repeat(64),
    storage_path: `cases/${ids.case}/documents/${ids.document}/original.pdf`,
    document_period: { start_date: "2026-07-01", end_date: "2026-07-31" },
    supersedes_document_id: null,
    created_at: now,
    ...overrides,
  };
}

describe("money and deterministic calculation contracts", () => {
  it("stores money as safe integer minor units", () => {
    expect(moneySchema.parse({ currency: "ILS", minor_units: 999 }).minor_units).toBe(999);
    expect(moneySchema.safeParse({ currency: "ILS", minor_units: 9.99 }).success).toBe(false);
    expect(nonNegativeMoneySchema.safeParse({ currency: "ILS", minor_units: -1 }).success).toBe(false);
  });

  it("accepts an auditable ordered calculation trace", () => {
    expect(calculationTraceSchema.safeParse(calculationTrace()).success).toBe(true);
  });

  it("rejects a calculation step that references an unavailable value", () => {
    const trace = calculationTrace();
    trace.steps[0].input_refs = ["future_step"];
    expect(calculationTraceSchema.safeParse(trace).success).toBe(false);
  });
});

describe("canonical employment facts", () => {
  it("validates typed values and documentary provenance", () => {
    expect(canonicalFactSchema.safeParse(salaryFact()).success).toBe(true);
    expect(canonicalFactSchema.safeParse(salaryFact({ value: "9400" })).success).toBe(false);
  });

  it("allows a missing fact only when its value is null", () => {
    expect(canonicalFactSchema.safeParse(salaryFact({ status: "missing", value: null })).success).toBe(true);
    expect(canonicalFactSchema.safeParse(salaryFact({ status: "missing" })).success).toBe(false);
  });

  it("keeps conflicting facts conflicted until explicitly resolved", () => {
    const conflictIds = [ids.factTwo, ids.factThree];
    const unresolved = salaryFact({
      status: "conflicted",
      value: null,
      conflicting_fact_ids: conflictIds,
    });
    expect(canonicalFactSchema.safeParse(unresolved).success).toBe(true);
    expect(
      canonicalFactSchema.safeParse({ ...unresolved, status: "confirmed", value: { currency: "ILS", minor_units: 940_000 } })
        .success,
    ).toBe(false);

    const resolved = {
      ...unresolved,
      status: "confirmed",
      value: { currency: "ILS", minor_units: 940_000 },
      resolution: {
        method: "human_confirmation",
        resolved_by: "customer-message",
        selected_fact_ids: [ids.factTwo],
        rationale: "The customer confirmed the amount shown in the signed contract.",
        resolved_at: later,
      },
    };
    expect(canonicalFactSchema.safeParse(resolved).success).toBe(true);
  });

  it("traces declared facts to the originating conversation message", () => {
    const result = canonicalFactSchema.parse(salaryFact({ provenance: [declaredEvidence] }));
    expect(result.provenance[0].source_reference.kind).toBe("conversation_message");
  });
});

describe("question and conversation contracts", () => {
  it("accepts a versioned multiple-choice-first question", () => {
    expect(interviewQuestionSchema.safeParse(approvedQuestion()).success).toBe(true);
  });

  it("requires every question to target a known fact path", () => {
    expect(interviewQuestionSchema.safeParse(approvedQuestion({ target_fact_path: "unknown.field" })).success).toBe(false);
  });

  it.each([
    ["single_choice", approvedQuestion()],
    ["multi_choice", approvedQuestion({ type: "multi_choice" })],
    [
      "yes_no",
      approvedQuestion({
        type: "yes_no",
        options: [
          { option_id: "yes", label: "Yes", normalized_value: true },
          { option_id: "no", label: "No", normalized_value: false },
        ],
      }),
    ],
    ["number", approvedQuestion({ type: "number", options: [] })],
    ["money", approvedQuestion({ type: "money", options: [] })],
    ["date", approvedQuestion({ type: "date", options: [] })],
    ["time", approvedQuestion({ type: "time", options: [] })],
    ["document_request", approvedQuestion({ type: "document_request", options: [] })],
    ["free_text", approvedQuestion({ type: "free_text", options: [] })],
  ])("supports the %s question type", (_type, question) => {
    expect(interviewQuestionSchema.safeParse(question).success).toBe(true);
  });

  it("rejects duplicate choice option IDs and options on non-choice questions", () => {
    expect(
      interviewQuestionSchema.safeParse(
        approvedQuestion({
          options: [
            { option_id: "monthly", label: "Monthly", normalized_value: "monthly" },
            { option_id: "monthly", label: "Other monthly", normalized_value: "monthly_other" },
          ],
        }),
      ).success,
    ).toBe(false);
    expect(interviewQuestionSchema.safeParse(approvedQuestion({ type: "date" })).success).toBe(false);
  });

  it("validates conversation lifecycle timestamps", () => {
    expect(
      conversationSchema.safeParse({
        conversation_id: ids.conversation,
        case_id: ids.case,
        analysis_run_id: ids.run,
        status: "open",
        created_at: now,
        closed_at: null,
      }).success,
    ).toBe(true);
    expect(
      conversationSchema.safeParse({
        conversation_id: ids.conversation,
        case_id: ids.case,
        analysis_run_id: ids.run,
        status: "closed",
        created_at: now,
        closed_at: null,
      }).success,
    ).toBe(false);
  });

  it("requires answers to reference their question", () => {
    const answer = {
      message_id: ids.message,
      case_id: ids.case,
      conversation_id: ids.conversation,
      analysis_run_id: ids.run,
      role: "customer",
      agent: null,
      question: { question_id: "salary.type", version: 1 },
      selected_option_ids: ["monthly"],
      free_text_answer: null,
      content: null,
      model: null,
      prompt_version: null,
      created_at: now,
    };
    expect(conversationMessageSchema.safeParse(answer).success).toBe(true);
    expect(conversationMessageSchema.safeParse({ ...answer, question: null }).success).toBe(false);
  });

  it("requires assistant model and prompt provenance", () => {
    expect(
      conversationMessageSchema.safeParse({
        message_id: ids.message,
        case_id: ids.case,
        conversation_id: ids.conversation,
        analysis_run_id: ids.run,
        role: "assistant",
        agent: "interview",
        question: { question_id: "salary.type", version: 1 },
        selected_option_ids: [],
        free_text_answer: null,
        content: "How is your salary defined?",
        model: null,
        prompt_version: null,
        created_at: now,
      }).success,
    ).toBe(false);
  });
});

describe("analysis runs, hypotheses, and state machine", () => {
  it("parses an immutable, versioned historical child run", () => {
    const run = analysisRunSchema.parse({
      analysis_run_id: ids.run,
      case_id: ids.case,
      parent_run_id: ids.parentRun,
      run_type: "full_investigation",
      state: "completed",
      engine_version: "1.0",
      contract_version: "1.0",
      created_at: now,
      started_at: now,
      completed_at: later,
      failure_code: null,
    });
    expect(run.parent_run_id).toBe(ids.parentRun);
    expect(Object.isFrozen(run)).toBe(true);
  });

  it("rejects a self-parented or incompletely versioned run", () => {
    expect(
      analysisRunSchema.safeParse({
        analysis_run_id: ids.run,
        case_id: ids.case,
        parent_run_id: ids.run,
        run_type: "shadow",
        state: "queued",
        engine_version: "1.0",
        contract_version: "",
        created_at: now,
        started_at: null,
        completed_at: null,
        failure_code: null,
      }).success,
    ).toBe(false);
  });

  it("allows resumable states but makes completed runs terminal", () => {
    expect(isAnalysisRunTransitionAllowed("waiting_for_customer", "running")).toBe(true);
    expect(isAnalysisRunTransitionAllowed("completed", "running")).toBe(false);
    expect(
      analysisRunTransitionSchema.safeParse({
        analysis_run_id: ids.run,
        from: "completed",
        to: "running",
        reason: "Reuse a historical run",
        occurred_at: later,
      }).success,
    ).toBe(false);
  });

  it("does not mark a hypothesis ready while required facts remain", () => {
    expect(
      investigationHypothesisSchema.safeParse(
        hypothesis({ status: "ready_for_analysis", required_fact_paths: ["employment.start_date"] }),
      ).success,
    ).toBe(false);
  });

  it("stops only with terminal hypotheses and no material missing fact", () => {
    const terminal = investigationHypothesisSchema.parse(hypothesis());
    const materialRequest = {
      fact_path: "work.overtime_hours" as const,
      priority: "high" as const,
      reason: "Could materially change overtime analysis.",
      expected_to_materially_change_analysis: true,
      status: "outstanding" as const,
    };
    expect(canInvestigationStop([terminal], [materialRequest])).toBe(false);
    expect(canInvestigationStop([terminal], [{ ...materialRequest, status: "unavailable" }])).toBe(true);
    expect(canInvestigationStop([terminal], [])).toBe(true);
  });
});

describe("immutable documents and versioned rule metadata", () => {
  it("accepts the future UUID-based immutable document path", () => {
    expect(immutableDocumentSchema.safeParse(immutableDocument()).success).toBe(true);
  });

  it("rejects an overwrite-style legacy path for a new immutable record", () => {
    expect(
      immutableDocumentSchema.safeParse({
        ...immutableDocument(),
        storage_path: `cases/${ids.case}/payslip-01.pdf`,
      }).success,
    ).toBe(false);
  });

  it("requires approved rule versions to carry publication provenance", () => {
    expect(ruleCatalogEntrySchema.safeParse(approvedRule()).success).toBe(true);
    expect(ruleCatalogEntrySchema.safeParse(approvedRule({ published_at: null })).success).toBe(false);
  });
});

describe("structured findings", () => {
  it("accepts an evidence-backed, rule-versioned, deterministic monetary finding", () => {
    expect(findingSchema.safeParse(finding()).success).toBe(true);
  });

  it("prevents inferred evidence alone from producing a high-confidence monetary finding", () => {
    expect(findingSchema.safeParse(finding({ evidence_references: [inferredEvidence] })).success).toBe(false);
  });

  it("quarantines inference-only monetary output for confirmation", () => {
    expect(
      findingSchema.safeParse(
        finding({
          status: "needs_confirmation",
          evidence_references: [inferredEvidence],
          confidence: 0.3,
          confidence_tier: "low",
          requires_confirmation: true,
        }),
      ).success,
    ).toBe(true);
  });

  it("requires evidence, a rule, and a trace for calculated expectations", () => {
    expect(findingSchema.safeParse(finding({ evidence_references: [] })).success).toBe(false);
    expect(findingSchema.safeParse(finding({ rule: undefined })).success).toBe(false);
    expect(findingSchema.safeParse(finding({ calculation_trace: null })).success).toBe(false);
  });

  it("rejects invalid or mixed-currency monetary values", () => {
    expect(findingSchema.safeParse(finding({ paid: { currency: "ILS", minor_units: 90.5 } })).success).toBe(false);
    expect(findingSchema.safeParse(finding({ paid: { currency: "USD", minor_units: 900_000 } })).success).toBe(false);
  });
});

describe("strict agent boundaries", () => {
  it("gives every agent an explicit no-database permission contract", () => {
    expect(Object.values(agentPermissions)).toHaveLength(6);
    expect(Object.values(agentPermissions).every((permission) => permission.database_access === "none")).toBe(true);
  });

  it("validates Document Intelligence output as documentary candidates only", () => {
    expect(
      documentIntelligenceOutputSchema.safeParse({
        candidate_facts: [salaryFact({ status: "candidate" })],
      }).success,
    ).toBe(true);
    expect(documentIntelligenceOutputSchema.safeParse({ candidate_facts: [salaryFact()] }).success).toBe(false);
  });

  it("scopes Document Intelligence input and output to the supplied immutable document", () => {
    const input = {
      case_id: ids.case,
      analysis_run_id: ids.run,
      extraction: {
        document: immutableDocument(),
        extraction_id: ids.output,
        content_sha256: "b".repeat(64),
        pages: [{ page_number: 1, text: "Base salary: 9,400" }],
        extracted_at: now,
      },
    };
    const output = { candidate_facts: [salaryFact({ status: "candidate" })] };
    expect(documentIntelligenceInputSchema.safeParse(input).success).toBe(true);
    expect(documentIntelligenceExchangeSchema.safeParse({ input, output }).success).toBe(true);
    expect(
      documentIntelligenceExchangeSchema.safeParse({
        input,
        output: {
          candidate_facts: [
            salaryFact({
              status: "candidate",
              provenance: [
                {
                  source_type: "documented",
                  source_reference: { kind: "document", document_id: ids.factTwo },
                },
              ],
            }),
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("requires the Fact Resolver to preserve conflicts and propose resolution separately", () => {
    const conflictIds = [ids.factTwo, ids.factThree];
    const conflictedFact = salaryFact({
      status: "conflicted",
      value: null,
      conflicting_fact_ids: conflictIds,
    });
    const baseOutput = {
      canonical_facts: [conflictedFact],
      unresolved_conflicts: [
        {
          conflict_id: ids.conflict,
          fact_path: "compensation.base_monthly_salary",
          fact_ids: conflictIds,
          reason: "Contract and payslip disagree.",
        },
      ],
      resolution_proposals: [
        {
          conflict_id: ids.conflict,
          proposed_fact_id: ids.factTwo,
          rationale: "Prefer the signed contract after confirmation.",
          requires_human_confirmation: true,
        },
      ],
    };
    const input = {
      case_id: ids.case,
      analysis_run_id: ids.run,
      facts: [conflictedFact],
      unresolved_conflicts: baseOutput.unresolved_conflicts,
    };
    expect(factResolverInputSchema.safeParse(input).success).toBe(true);
    expect(factResolverOutputSchema.safeParse(baseOutput).success).toBe(true);
    expect(factResolverExchangeSchema.safeParse({ input, output: baseOutput }).success).toBe(true);
    expect(
      factResolverOutputSchema.safeParse({
        ...baseOutput,
        canonical_facts: [
          salaryFact({
            conflicting_fact_ids: conflictIds,
            resolution: {
              method: "human_confirmation",
              resolved_by: "agent",
              selected_fact_ids: [ids.factTwo],
              rationale: "Silent agent resolution",
              resolved_at: later,
            },
          }),
        ],
      }).success,
    ).toBe(false);
  });

  it("restricts Interview selection to the approved bank and requested fact", () => {
    const exchange = {
      input: {
        case_id: ids.case,
        analysis_run_id: ids.run,
        requested_fact: {
          fact_path: "compensation.salary_type",
          priority: "high",
          reason: "Salary basis is missing.",
          expected_to_materially_change_analysis: true,
          status: "outstanding",
        },
        approved_question_bank: [approvedQuestion()],
      },
      output: {
        selected_question: { question_id: "salary.type", version: 1 },
        reason: "Directly targets the missing salary basis.",
      },
    };
    expect(interviewAgentExchangeSchema.safeParse(exchange).success).toBe(true);
    expect(
      interviewAgentExchangeSchema.safeParse({
        ...exchange,
        output: { ...exchange.output, selected_question: { question_id: "invented.question", version: 1 } },
      }).success,
    ).toBe(false);
    expect(interviewAgentOutputSchema.safeParse({ ...exchange.output, database_query: "select *" }).success).toBe(false);
  });

  it("allows the Investigator to return hypotheses and requested facts, not findings", () => {
    const input = {
      case_id: ids.case,
      analysis_run_id: ids.run,
      canonical_facts: [salaryFact()],
      current_hypotheses: [hypothesis()],
    };
    const output = { hypotheses: [hypothesis()], requested_facts: [] };
    expect(investigatorInputSchema.safeParse(input).success).toBe(true);
    expect(investigatorOutputSchema.safeParse(output).success).toBe(true);
    expect(investigatorExchangeSchema.safeParse({ input, output }).success).toBe(true);
    expect(investigatorOutputSchema.safeParse({ ...output, findings: [finding()] }).success).toBe(false);
  });

  it("gives Legal Applicability only confirmed facts and approved rule metadata", () => {
    const input = {
      case_id: ids.case,
      analysis_run_id: ids.run,
      validated_facts: [salaryFact()],
      hypotheses: [hypothesis()],
      rule_catalog: [approvedRule()],
    };
    expect(legalApplicabilityInputSchema.safeParse(input).success).toBe(true);
    expect(
      legalApplicabilityInputSchema.safeParse({ ...input, validated_facts: [salaryFact({ status: "candidate" })] })
        .success,
    ).toBe(false);
    expect(legalApplicabilityInputSchema.safeParse({ ...input, rule_catalog: [approvedRule({ status: "draft" })] }).success).toBe(
      false,
    );
    expect(
      legalApplicabilityOutputSchema.safeParse({
        proposed_rules: [
          {
            hypothesis_id: ids.hypothesis,
            rule: ruleReference,
            reason: "The validated facts match the catalog preconditions.",
            missing_fact_paths: [],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      legalApplicabilityExchangeSchema.safeParse({
        input,
        output: {
          proposed_rules: [
            {
              hypothesis_id: ids.hypothesis,
              rule: ruleReference,
              reason: "The validated facts match the catalog preconditions.",
              missing_fact_paths: [],
            },
          ],
        },
      }).success,
    ).toBe(true);
    expect(legalApplicabilityOutputSchema.safeParse({ proposed_rules: [{ rule: ruleReference }] }).success).toBe(false);
  });

  it("lets the Report Agent narrate supplied verified findings only", () => {
    const input = { case_id: ids.case, analysis_run_id: ids.run, verified_findings: [finding()] };
    const output = {
      sections: [
        {
          section_id: "summary",
          title: "Summary",
          narrative: "A verified structured finding is available.",
          finding_ids: [ids.finding],
        },
      ],
    };
    expect(reportAgentInputSchema.safeParse(input).success).toBe(true);
    expect(reportAgentOutputSchema.safeParse(output).success).toBe(true);
    expect(reportAgentExchangeSchema.safeParse({ input, output }).success).toBe(true);
    expect(
      reportAgentExchangeSchema.safeParse({
        input,
        output: { ...output, sections: [{ ...output.sections[0], finding_ids: [ids.factTwo] }] },
      }).success,
    ).toBe(false);
    expect(reportAgentInputSchema.safeParse({ ...input, verified_findings: [finding({ status: "candidate" })] }).success).toBe(
      false,
    );
  });
});
