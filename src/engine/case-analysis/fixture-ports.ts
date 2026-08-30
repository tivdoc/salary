import { createHash } from "node:crypto";
import { calculationTraceSchema } from "../calculations/contracts";
import { canonicalSha256, canonicalStringify } from "../rule-runtime/canonical";
import { evaluateLegalReadiness, type LegalReadinessCandidate } from "../legal-knowledge/canonical-readiness/evaluate-legal-readiness";
import type {
  AnalysisResultBundle,
  CanonicalHashPort,
  CaseAnalysisCommand,
  CaseReviewDecision,
  CaseReviewPort,
  DeterministicClockPort,
  DeterministicIdPort,
  DeterministicReportArtifacts,
  LegalCatalogSelection,
  LegalRuleCatalogPort,
  ReportBuilderPort,
  RuleSpecExecutionResult,
  RuleSpecExecutorPort,
  Wave3Topic,
} from "../wave3/contracts";
import type {
  CaseAnalysisLogPort,
  CaseAnalysisSafeLog,
  ReportRegistrationPort,
  StoredCaseInputSnapshot,
  StoredCaseSnapshotPort,
} from "./contracts";
import { CaseAnalysisError } from "./contracts";

export function deterministicUuid(seed: string) {
  const hash = canonicalSha256(seed);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export class FixedClock implements DeterministicClockPort {
  constructor(private readonly value = "2025-04-01T00:00:00.000Z") {}
  now() { return this.value; }
}

export class ContentAddressedIdPort implements DeterministicIdPort {
  derive(namespace: string, canonicalInputHash: string) {
    return deterministicUuid(`${namespace}:${canonicalInputHash}`);
  }
}

export class NodeCanonicalHashPort implements CanonicalHashPort {
  hashCanonical(value: unknown) { return canonicalSha256(value); }
  hashBytes(value: Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
}

export class InMemoryStoredSnapshotPort implements StoredCaseSnapshotPort {
  readonly counters = { loads: 0, openai_calls: 0, provider_calls: 0, customer_file_reads: 0, external_reads: 0 };
  private readonly snapshots = new Map<string, StoredCaseInputSnapshot>();

  add(snapshot: StoredCaseInputSnapshot) {
    this.snapshots.set(`${snapshot.document_snapshot_id}:${snapshot.extraction_snapshot_id}:${snapshot.declared_fact_snapshot.snapshot_id}`, snapshot);
  }

  async loadPinned(command: CaseAnalysisCommand) {
    this.counters.loads += 1;
    const key = `${command.document_snapshot_id}:${command.extraction_snapshot_id}:${command.declared_fact_snapshot_id}`;
    const snapshot = this.snapshots.get(key);
    if (!snapshot) throw new CaseAnalysisError("PINNED_INPUT_SNAPSHOT_UNAVAILABLE");
    return snapshot;
  }
}

export class SafeLogCollector implements CaseAnalysisLogPort {
  readonly entries: CaseAnalysisSafeLog[] = [];
  write(entry: CaseAnalysisSafeLog) { this.entries.push(Object.freeze({ ...entry })); }
}

export type SyntheticCatalogDefect = "none" | "inactive_unreviewed" | "wrong_interval_scope" | "non_dual_parameter" | "unreviewed_rule";

function readyCandidate(topic: Wave3Topic, defect: SyntheticCatalogDefect): LegalReadinessCandidate {
  const sourceVersionId = `synthetic-source-version:${topic}:1.0.0`;
  return {
    source_version_id: sourceVersionId,
    source_id: `synthetic-source:${topic}`,
    topics: [topic],
    parse_succeeded: true,
    citation_verified: true,
    operative_role_eligible: true,
    human_reviewed: defect !== "inactive_unreviewed",
    effective_interval_verified: true,
    verified_sectors: defect === "wrong_interval_scope" ? ["different_synthetic_sector"] : ["synthetic_sector"],
    verified_populations: ["synthetic_population"],
    active: defect !== "inactive_unreviewed",
    acquisition_status: "available",
    technical_parse_status: "parsed",
    instrument_boundary_status: "resolved",
    publication_status: "review_candidate",
    retrieval_visibility: "visible",
    retrieval_surface: "canonical_review",
    source_role: "binding_role_candidate",
    monetary_support_eligibility: "eligible",
    citation: { citation_id: `synthetic-citation:${topic}`, verified: true, source_version_id: sourceVersionId },
    review_attestation: {
      attestation_id: `synthetic-review:${topic}`,
      status: defect === "inactive_unreviewed" ? "needs_review" : "reviewed",
      source_version_id: sourceVersionId,
      reviewed_at: "2025-01-01",
    },
    valid_time: {
      from: defect === "wrong_interval_scope" ? "2026-01-01" : "2020-01-01",
      to: null,
      verified: true,
    },
    knowledge_time: { available_from: "2020-01-01", unavailable_from: null },
    sector_status: "verified",
    population_status: "verified",
    activation_status: defect === "inactive_unreviewed" ? "inactive" : "active",
    bound_source_version_id: sourceVersionId,
  };
}

export class FixtureLegalRuleCatalog implements LegalRuleCatalogPort {
  readonly counters = { resolve_calls: 0 };
  private revision = 1;
  constructor(private defect: SyntheticCatalogDefect = "none") {}

  setDefect(defect: SyntheticCatalogDefect) { this.defect = defect; }
  bumpRevision() { this.revision += 1; }

  async resolve(input: Readonly<{
    topic: Wave3Topic;
    target_date: string;
    as_of: string;
    sector: string;
    population: string;
    mode: "real" | "synthetic_test";
  }>): Promise<LegalCatalogSelection> {
    this.counters.resolve_calls += 1;
    const synthetic = input.mode === "synthetic_test";
    const candidates = synthetic ? [readyCandidate(input.topic, this.defect)] : [];
    const readiness = evaluateLegalReadiness({
      readinessCase: {
        case_id: `readiness:${input.topic}:${input.mode}`,
        topic: input.topic,
        kind: synthetic ? "synthetic" : "current",
        target_date: input.target_date,
        as_of: input.as_of,
        sector: input.sector,
        population: input.population,
        contract_version: "v0.5.0",
        use_case: "monetary_rule",
      },
      candidates,
    });
    const sourceVersionIds = synthetic
      ? [`synthetic-source-version:${input.topic}:1.0.0`]
      : Array.from({ length: 17 }, (_, index) => `current-real-source-${String(index + 1).padStart(3, "0")}:needs-review`);
    return Object.freeze({
      catalog_id: synthetic ? "synthetic-test-catalog" : "current-real-corpus-catalog",
      catalog_version: `${this.revision}.0.0`,
      catalog_sha256: canonicalSha256({ mode: input.mode, revision: this.revision, defect: this.defect }),
      mode: input.mode,
      topic: input.topic,
      source_version_ids: sourceVersionIds,
      parameter_version_ids: synthetic
        ? (this.defect === "non_dual_parameter" ? [] : [
          `synthetic-parameter:${input.topic}:dual-attested`,
        ])
        : [],
      rule_spec_id: synthetic && this.defect !== "unreviewed_rule" ? `synthetic.${input.topic}.identity` : null,
      rule_spec_version: synthetic && this.defect !== "unreviewed_rule" ? "1.0.0" : null,
      readiness,
    });
  }
}

const TOPIC_INDEX: Readonly<Record<Wave3Topic, number>> = Object.freeze({
  minimum_wage: 1, working_time: 2, pension: 3, travel: 4, convalescence: 5, vacation: 6, sick_leave: 7,
});

export class FixtureRuleSpecExecutor implements RuleSpecExecutorPort {
  readonly counters = { execute_calls: 0, external_calls: 0 };
  async execute(input: Parameters<RuleSpecExecutorPort["execute"]>[0]): Promise<RuleSpecExecutionResult> {
    this.counters.execute_calls += 1;
    if (input.selection.mode !== "synthetic_test" || input.selection.readiness.status !== "READY"
        || !input.selection.rule_spec_id || !input.selection.rule_spec_version) {
      throw new CaseAnalysisError("FIXTURE_EXECUTOR_ADMISSION_DENIED");
    }
    const amount = Object.freeze({ currency: "XTS", minor_units: TOPIC_INDEX[input.selection.topic] * 1_000 });
    const factId = deterministicUuid(`trace-fact:${input.rule_input.snapshot_sha256}`);
    const trace = calculationTraceSchema.parse({
      calculation_id: deterministicUuid(`trace:${input.execution_id}`),
      formula_id: `synthetic.${input.selection.topic}.identity`,
      formula_version: "1.0.0",
      rule: { rule_id: input.selection.rule_spec_id, rule_version: input.selection.rule_spec_version },
      engine_version: "1.0.0",
      inputs: [{
        input_id: `synthetic.${input.selection.topic}.leaf`,
        fact_id: factId,
        fact_path: input.selection.topic === "minimum_wage" ? "compensation.base_monthly_salary"
          : input.selection.topic === "working_time" ? "work.regular_hours"
            : input.selection.topic === "pension" ? "pension.base_salary"
              : input.selection.topic === "travel" ? "travel.reimbursement"
                : input.selection.topic === "convalescence" ? "convalescence.payment"
                  : input.selection.topic === "vacation" ? "leave.vacation_balance" : "leave.sick_balance",
        value: { kind: "money", value: amount },
      }],
      steps: [{
        step_id: `synthetic.${input.selection.topic}.output`,
        operation: "identity",
        input_refs: [`synthetic.${input.selection.topic}.leaf`],
        result: { kind: "money", value: amount },
        explanation: "Neutral synthetic identity operation; no legal meaning.",
      }],
      output: { kind: "money", value: amount },
      calculated_at: input.calculated_at,
    });
    return Object.freeze({
      topic: input.selection.topic,
      rule_spec_id: input.selection.rule_spec_id,
      rule_spec_version: input.selection.rule_spec_version,
      amount,
      trace,
      result_sha256: canonicalSha256({ amount, trace }),
    });
  }
}

function bytes(value: string) { return new TextEncoder().encode(value); }

export class FixtureReportBuilder implements ReportBuilderPort {
  readonly counters = { build_calls: 0 };
  constructor(private readonly hashes: CanonicalHashPort, private readonly ids: DeterministicIdPort) {}
  async build(bundle: AnalysisResultBundle): Promise<DeterministicReportArtifacts> {
    this.counters.build_calls += 1;
    const reportId = this.ids.derive("report", bundle.result_sha256);
    const canonical = bytes(`${canonicalStringify({
      schema_version: "synthetic-report-v0.6.0",
      report_id: reportId,
      analysis_result_sha256: bundle.result_sha256,
      coverage: bundle.topic_results.map(({ topic, status, blockers }) => ({ topic, status, blockers })),
      known_subtotal: bundle.known_subtotal,
      known_subtotal_label: bundle.coverage_complete ? "synthetic_complete_coverage" : "known_subtotal_excludes_blocked_topics",
    })}\n`);
    const html = bytes(`<html dir="rtl"><body data-report-id="${reportId}" data-result-sha256="${bundle.result_sha256}">synthetic deterministic report</body></html>\n`);
    const pdf = bytes(`%PDF-1.4\n% synthetic fixture only\nreport_id=${reportId}\nresult_sha256=${bundle.result_sha256}\n%%EOF\n`);
    const jsonSha = this.hashes.hashBytes(canonical);
    const htmlSha = this.hashes.hashBytes(html);
    const pdfSha = this.hashes.hashBytes(pdf);
    const manifest = bytes(`${canonicalStringify({ report_id: reportId, json_sha256: jsonSha, html_sha256: htmlSha, pdf_sha256: pdfSha })}\n`);
    const manifestSha = this.hashes.hashBytes(manifest);
    const reportSha = this.hashes.hashCanonical({ report_id: reportId, json_sha256: jsonSha, html_sha256: htmlSha, pdf_sha256: pdfSha, manifest_sha256: manifestSha });
    return Object.freeze({
      report_id: reportId, report_revision: 1, analysis_result_sha256: bundle.result_sha256,
      json: canonical, html, pdf, manifest,
      json_sha256: jsonSha, html_sha256: htmlSha, pdf_sha256: pdfSha,
      manifest_sha256: manifestSha, report_sha256: reportSha,
    });
  }
}

type RegisteredReport = { case_id: string; report_sha256: string; analysis_result_sha256: string; eligible: boolean };

export class FixtureCaseReviewPort implements CaseReviewPort, ReportRegistrationPort {
  readonly counters = { decisions: 0, approvals: 0 };
  private readonly latest = new Map<string, RegisteredReport>();
  private readonly approved = new Set<string>();

  registerReport(input: Readonly<{
    case_id: string;
    report_sha256: string;
    analysis_result_sha256: string;
    export_eligible_after_review: boolean;
  }>) {
    const prior = this.latest.get(input.case_id);
    if (prior && prior.report_sha256 !== input.report_sha256) this.approved.delete(`${input.case_id}:${prior.report_sha256}`);
    this.latest.set(input.case_id, { ...input, eligible: input.export_eligible_after_review });
  }

  async decide(decision: CaseReviewDecision) {
    this.counters.decisions += 1;
    const report = [...this.latest.values()].find((candidate) => candidate.report_sha256 === decision.input_sha256);
    if (decision.task_kind !== "report_approval" || decision.decision !== "approved" || !report?.eligible
        || decision.output_sha256 !== decision.input_sha256) {
      throw new CaseAnalysisError("REPORT_REVIEW_NOT_ELIGIBLE");
    }
    this.approved.add(`${report.case_id}:${report.report_sha256}`);
    this.counters.approvals += 1;
    return Object.freeze({
      task_id: decision.task_id,
      revision: 1,
      receipt_sha256: canonicalSha256(decision),
    });
  }

  async isReportExportEligible(caseId: string, reportSha256: string) {
    return this.latest.get(caseId)?.report_sha256 === reportSha256 && this.approved.has(`${caseId}:${reportSha256}`);
  }
}

export const PROHIBITED_BOUNDARY_OPERATIONS = [
  "customer_file", "openai", "external_database", "migration", "deploy", "delivery", "customer_shadow",
] as const;

export function denyProhibitedBoundaryOperation(operation: (typeof PROHIBITED_BOUNDARY_OPERATIONS)[number], attempt: () => unknown): never {
  void attempt;
  throw new CaseAnalysisError(`PROHIBITED_BOUNDARY_DENIED_BEFORE_ATTEMPT:${operation}`);
}
