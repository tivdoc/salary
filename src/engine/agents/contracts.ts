import { z } from "zod";
import { agentNameSchema, domainCodeSchema, isoTimestampSchema, uuidSchema } from "../domain/primitives.ts";
import { immutableDocumentSchema } from "../domain/documents.ts";
import { canonicalFactSchema } from "../facts/contracts.ts";
import { factPathSchema } from "../facts/fact-paths.ts";
import { findingSchema } from "../findings/contracts.ts";
import {
  investigationHypothesisSchema,
  requestedFactSchema,
} from "../investigation/hypothesis.ts";
import { interviewQuestionSchema, questionReferenceSchema } from "../interview/contracts.ts";
import { ruleCatalogEntrySchema, ruleReferenceSchema } from "../rules/contracts.ts";

const agentResourceSchema = z.enum([
  "document_extraction",
  "canonical_facts",
  "hypotheses",
  "requested_facts",
  "approved_question_bank",
  "rule_catalog",
  "verified_findings",
]);

const agentArtifactSchema = z.enum([
  "candidate_facts",
  "canonical_facts",
  "conflict_resolution_proposals",
  "selected_question",
  "hypotheses",
  "requested_facts",
  "rule_proposals",
  "report_sections",
]);

export const agentPermissionSchema = z
  .object({
    agent: agentNameSchema,
    database_access: z.literal("none"),
    reads: z.array(agentResourceSchema),
    produces: z.array(agentArtifactSchema),
  })
  .strict();

export const agentPermissions = z
  .record(agentNameSchema, agentPermissionSchema)
  .parse({
    document_intelligence: {
      agent: "document_intelligence",
      database_access: "none",
      reads: ["document_extraction"],
      produces: ["candidate_facts"],
    },
    fact_resolver: {
      agent: "fact_resolver",
      database_access: "none",
      reads: ["canonical_facts"],
      produces: ["canonical_facts", "conflict_resolution_proposals"],
    },
    interview: {
      agent: "interview",
      database_access: "none",
      reads: ["requested_facts", "approved_question_bank"],
      produces: ["selected_question"],
    },
    investigator: {
      agent: "investigator",
      database_access: "none",
      reads: ["canonical_facts", "hypotheses"],
      produces: ["hypotheses", "requested_facts"],
    },
    legal_applicability: {
      agent: "legal_applicability",
      database_access: "none",
      reads: ["canonical_facts", "hypotheses", "rule_catalog"],
      produces: ["rule_proposals"],
    },
    report: {
      agent: "report",
      database_access: "none",
      reads: ["verified_findings"],
      produces: ["report_sections"],
    },
  });

const invocationContextShape = {
  case_id: uuidSchema,
  analysis_run_id: uuidSchema,
} as const;

export const documentExtractionSchema = z
  .object({
    document: immutableDocumentSchema,
    extraction_id: uuidSchema,
    content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    pages: z
      .array(
        z
          .object({
            page_number: z.number().int().positive(),
            text: z.string().max(100_000),
          })
          .strict(),
      )
      .min(1),
    extracted_at: isoTimestampSchema,
  })
  .strict()
  .refine((extraction) => extraction.content_sha256 === extraction.document.content_sha256, {
    message: "Extraction content must match the immutable document hash",
    path: ["content_sha256"],
  });

export const documentIntelligenceInputSchema = z
  .object({ ...invocationContextShape, extraction: documentExtractionSchema })
  .strict()
  .refine((input) => input.extraction.document.case_id === input.case_id, {
    message: "The document snapshot must belong to the invocation case",
    path: ["extraction", "document", "case_id"],
  });

export const documentIntelligenceOutputSchema = z
  .object({ candidate_facts: z.array(canonicalFactSchema) })
  .strict()
  .superRefine((output, context) => {
    for (const [index, fact] of output.candidate_facts.entries()) {
      if (fact.status !== "candidate" && fact.status !== "needs_confirmation") {
        context.addIssue({
          code: "custom",
          message: "Document intelligence may emit only candidate facts",
          path: ["candidate_facts", index, "status"],
        });
      }
      if (fact.provenance.some((reference) => reference.source_type !== "documented")) {
        context.addIssue({
          code: "custom",
          message: "Document intelligence facts must point to documentary provenance",
          path: ["candidate_facts", index, "provenance"],
        });
      }
    }
  });

export const documentIntelligenceExchangeSchema = z
  .object({ input: documentIntelligenceInputSchema, output: documentIntelligenceOutputSchema })
  .strict()
  .superRefine((exchange, context) => {
    const documentId = exchange.input.extraction.document.document_id;
    for (const [factIndex, fact] of exchange.output.candidate_facts.entries()) {
      if (fact.case_id !== exchange.input.case_id) {
        context.addIssue({
          code: "custom",
          message: "Candidate facts must belong to the invocation case",
          path: ["output", "candidate_facts", factIndex, "case_id"],
        });
      }
      if (
        fact.provenance.some(
          (reference) =>
            reference.source_type !== "documented" || reference.source_reference.document_id !== documentId,
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "Candidate facts must reference the supplied immutable document",
          path: ["output", "candidate_facts", factIndex, "provenance"],
        });
      }
    }
  });

export const unresolvedFactConflictSchema = z
  .object({
    conflict_id: uuidSchema,
    fact_path: factPathSchema,
    fact_ids: z.array(uuidSchema).min(2),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const conflictResolutionProposalSchema = z
  .object({
    conflict_id: uuidSchema,
    proposed_fact_id: uuidSchema.nullable(),
    rationale: z.string().trim().min(1).max(2_000),
    requires_human_confirmation: z.boolean(),
  })
  .strict();

export const factResolverInputSchema = z
  .object({
    ...invocationContextShape,
    facts: z.array(canonicalFactSchema),
    unresolved_conflicts: z.array(unresolvedFactConflictSchema),
  })
  .strict()
  .refine((input) => input.facts.every((fact) => fact.case_id === input.case_id), {
    message: "Fact Resolver inputs must belong to the invocation case",
    path: ["facts"],
  });

export const factResolverOutputSchema = z
  .object({
    canonical_facts: z.array(canonicalFactSchema),
    unresolved_conflicts: z.array(unresolvedFactConflictSchema),
    resolution_proposals: z.array(conflictResolutionProposalSchema),
  })
  .strict()
  .superRefine((output, context) => {
    for (const [index, fact] of output.canonical_facts.entries()) {
      if (fact.conflicting_fact_ids.length > 0 && (fact.status !== "conflicted" || fact.resolution !== null)) {
        context.addIssue({
          code: "custom",
          message: "The Fact Resolver must preserve conflicts and emit resolution proposals separately",
          path: ["canonical_facts", index],
        });
      }
    }
  });

export const factResolverExchangeSchema = z
  .object({ input: factResolverInputSchema, output: factResolverOutputSchema })
  .strict()
  .superRefine((exchange, context) => {
    const knownConflictIds = new Set([
      ...exchange.input.unresolved_conflicts.map((conflict) => conflict.conflict_id),
      ...exchange.output.unresolved_conflicts.map((conflict) => conflict.conflict_id),
    ]);
    if (exchange.output.canonical_facts.some((fact) => fact.case_id !== exchange.input.case_id)) {
      context.addIssue({
        code: "custom",
        message: "Resolved facts must belong to the invocation case",
        path: ["output", "canonical_facts"],
      });
    }
    if (exchange.output.resolution_proposals.some((proposal) => !knownConflictIds.has(proposal.conflict_id))) {
      context.addIssue({
        code: "custom",
        message: "Resolution proposals must reference a recorded conflict",
        path: ["output", "resolution_proposals"],
      });
    }
  });

export const interviewAgentInputSchema = z
  .object({
    ...invocationContextShape,
    requested_fact: requestedFactSchema,
    approved_question_bank: z.array(interviewQuestionSchema).min(1),
  })
  .strict();

export const interviewAgentOutputSchema = z
  .object({
    selected_question: questionReferenceSchema,
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const interviewAgentExchangeSchema = z
  .object({ input: interviewAgentInputSchema, output: interviewAgentOutputSchema })
  .strict()
  .superRefine((exchange, context) => {
    const selectedQuestion = exchange.input.approved_question_bank.find(
      (question) =>
        question.question_id === exchange.output.selected_question.question_id &&
        question.version === exchange.output.selected_question.version,
    );
    if (!selectedQuestion) {
      context.addIssue({
        code: "custom",
        message: "The Interview Agent must select a question from the approved bank",
        path: ["output", "selected_question"],
      });
    } else if (selectedQuestion.target_fact_path !== exchange.input.requested_fact.fact_path) {
      context.addIssue({
        code: "custom",
        message: "The selected question must target the requested fact",
        path: ["output", "selected_question"],
      });
    }
  });

export const investigatorInputSchema = z
  .object({
    ...invocationContextShape,
    canonical_facts: z.array(canonicalFactSchema),
    current_hypotheses: z.array(investigationHypothesisSchema),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.canonical_facts.some((fact) => fact.case_id !== input.case_id)) {
      context.addIssue({ code: "custom", message: "Facts must belong to the invocation case", path: ["canonical_facts"] });
    }
    if (
      input.current_hypotheses.some(
        (hypothesis) => hypothesis.case_id !== input.case_id || hypothesis.analysis_run_id !== input.analysis_run_id,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Hypotheses must belong to the invocation case and run",
        path: ["current_hypotheses"],
      });
    }
  });

export const investigatorOutputSchema = z
  .object({
    hypotheses: z.array(investigationHypothesisSchema),
    requested_facts: z.array(requestedFactSchema),
  })
  .strict();

export const investigatorExchangeSchema = z
  .object({ input: investigatorInputSchema, output: investigatorOutputSchema })
  .strict()
  .refine(
    (exchange) =>
      exchange.output.hypotheses.every(
        (hypothesis) =>
          hypothesis.case_id === exchange.input.case_id &&
          hypothesis.analysis_run_id === exchange.input.analysis_run_id,
      ),
    {
      message: "Investigator output must remain scoped to the invocation case and run",
      path: ["output", "hypotheses"],
    },
  );

export const legalApplicabilityInputSchema = z
  .object({
    ...invocationContextShape,
    validated_facts: z.array(canonicalFactSchema),
    hypotheses: z.array(investigationHypothesisSchema),
    rule_catalog: z.array(ruleCatalogEntrySchema),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.validated_facts.some((fact) => fact.status !== "confirmed")) {
      context.addIssue({
        code: "custom",
        message: "Legal applicability accepts confirmed facts only",
        path: ["validated_facts"],
      });
    }
    if (input.rule_catalog.some((rule) => rule.status !== "approved")) {
      context.addIssue({
        code: "custom",
        message: "Legal applicability accepts approved rule versions only",
        path: ["rule_catalog"],
      });
    }
  });

export const ruleProposalSchema = z
  .object({
    hypothesis_id: uuidSchema,
    rule: ruleReferenceSchema,
    reason: z.string().trim().min(1).max(2_000),
    missing_fact_paths: z.array(factPathSchema),
  })
  .strict();

export const legalApplicabilityOutputSchema = z
  .object({ proposed_rules: z.array(ruleProposalSchema) })
  .strict();

export const legalApplicabilityExchangeSchema = z
  .object({ input: legalApplicabilityInputSchema, output: legalApplicabilityOutputSchema })
  .strict()
  .superRefine((exchange, context) => {
    const hypothesisIds = new Set(exchange.input.hypotheses.map((hypothesis) => hypothesis.hypothesis_id));
    const ruleKeys = new Set(
      exchange.input.rule_catalog.map((rule) => `${rule.rule_id}@${rule.rule_version}`),
    );
    for (const [proposalIndex, proposal] of exchange.output.proposed_rules.entries()) {
      if (!hypothesisIds.has(proposal.hypothesis_id)) {
        context.addIssue({
          code: "custom",
          message: "Rule proposals must reference an input hypothesis",
          path: ["output", "proposed_rules", proposalIndex, "hypothesis_id"],
        });
      }
      if (!ruleKeys.has(`${proposal.rule.rule_id}@${proposal.rule.rule_version}`)) {
        context.addIssue({
          code: "custom",
          message: "Rule proposals must reference an approved input rule version",
          path: ["output", "proposed_rules", proposalIndex, "rule"],
        });
      }
    }
  });

export const reportAgentInputSchema = z
  .object({ ...invocationContextShape, verified_findings: z.array(findingSchema).min(1) })
  .strict()
  .refine((input) => input.verified_findings.every((finding) => finding.status === "verified"), {
    message: "The Report Agent accepts verified findings only",
    path: ["verified_findings"],
  });

export const reportSectionSchema = z
  .object({
    section_id: domainCodeSchema,
    title: z.string().trim().min(1).max(300),
    narrative: z.string().trim().min(1).max(20_000),
    finding_ids: z.array(uuidSchema).min(1),
  })
  .strict();

export const reportAgentOutputSchema = z.object({ sections: z.array(reportSectionSchema).min(1) }).strict();

export const reportAgentExchangeSchema = z
  .object({ input: reportAgentInputSchema, output: reportAgentOutputSchema })
  .strict()
  .superRefine((exchange, context) => {
    const availableFindingIds = new Set(exchange.input.verified_findings.map((finding) => finding.finding_id));
    for (const [sectionIndex, section] of exchange.output.sections.entries()) {
      for (const findingId of section.finding_ids) {
        if (!availableFindingIds.has(findingId)) {
          context.addIssue({
            code: "custom",
            message: "Report sections may reference only supplied verified findings",
            path: ["output", "sections", sectionIndex, "finding_ids"],
          });
        }
      }
    }
  });

export type AgentPermission = Readonly<z.infer<typeof agentPermissionSchema>>;
export type DocumentIntelligenceInput = Readonly<z.infer<typeof documentIntelligenceInputSchema>>;
export type DocumentIntelligenceOutput = Readonly<z.infer<typeof documentIntelligenceOutputSchema>>;
export type FactResolverInput = Readonly<z.infer<typeof factResolverInputSchema>>;
export type FactResolverOutput = Readonly<z.infer<typeof factResolverOutputSchema>>;
export type InterviewAgentInput = Readonly<z.infer<typeof interviewAgentInputSchema>>;
export type InterviewAgentOutput = Readonly<z.infer<typeof interviewAgentOutputSchema>>;
export type InvestigatorInput = Readonly<z.infer<typeof investigatorInputSchema>>;
export type InvestigatorOutput = Readonly<z.infer<typeof investigatorOutputSchema>>;
export type LegalApplicabilityInput = Readonly<z.infer<typeof legalApplicabilityInputSchema>>;
export type LegalApplicabilityOutput = Readonly<z.infer<typeof legalApplicabilityOutputSchema>>;
export type ReportAgentInput = Readonly<z.infer<typeof reportAgentInputSchema>>;
export type ReportAgentOutput = Readonly<z.infer<typeof reportAgentOutputSchema>>;
