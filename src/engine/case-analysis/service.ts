import { canonicalFactSchema, type CanonicalFact } from "../facts/contracts";
import { employmentSnapshotSchema, type EmploymentSnapshot } from "../facts/snapshot";
import { resolvedPayslipFactPaths, resolvePayslipSnapshot } from "../extraction/resolver";
import { validatePayslipGate0 } from "../extraction/validation";
import { canonicalSha256, canonicalStringify, deepFreeze } from "../rule-runtime/canonical";
import { ruleInputSnapshotSchema, type RuleInputSnapshot } from "../wave1/contracts";
import { createCanonicalRuleInputSnapshot } from "../rule-input/snapshot";
import { evaluateLegalReadiness, type LegalReadinessCandidate, type LegalReadinessCase } from "../legal-knowledge/canonical-readiness/evaluate-legal-readiness";
import type {
  AnalysisResultBundle,
  CanonicalHashPort,
  CaseAnalysisCommand,
  CaseAnalysisPort,
  DeterministicClockPort,
  DeterministicIdPort,
  LegalCatalogSelection,
  LegalRuleCatalogPort,
  ReportBuilderPort,
  RuleSpecExecutorPort,
  TopicAnalysisResult,
  Wave3Topic,
} from "../wave3/contracts";
import { WAVE3_TOPICS } from "../wave3/contracts";
import {
  CaseAnalysisError,
  type CaseAnalysisLogPort,
  type CaseAnalysisRepositoryPort,
  type CaseAnalysisStage,
  type PinnedAnalysisDependencies,
  type ReportRegistrationPort,
  type StoredCaseInputSnapshot,
  type StoredCaseSnapshotPort,
} from "./contracts";

const criticalFactPath: Readonly<Record<Wave3Topic, CanonicalFact["path"]>> = Object.freeze({
  minimum_wage: "compensation.base_monthly_salary",
  working_time: "work.regular_hours",
  pension: "pension.base_salary",
  travel: "travel.reimbursement",
  convalescence: "convalescence.payment",
  vacation: "leave.vacation_balance",
  sick_leave: "leave.sick_balance",
});

type EmbeddedReadinessDecision = LegalCatalogSelection["readiness"] & Readonly<{
  normalized_input?: Readonly<{
    readiness_case: LegalReadinessCase;
    candidates: readonly LegalReadinessCandidate[];
  }>;
}>;

export type CaseAnalysisMetrics = {
  run_case_analysis_calls: number;
  replay_calls: number;
  canonical_readiness_calls: number;
  executor_calls: number;
};

export type CaseAnalysisServiceDependencies = Readonly<{
  clock: DeterministicClockPort;
  ids: DeterministicIdPort;
  hashes: CanonicalHashPort;
  snapshots: StoredCaseSnapshotPort;
  repository: CaseAnalysisRepositoryPort;
  legalCatalog: LegalRuleCatalogPort;
  executor: RuleSpecExecutorPort;
  reportBuilder: ReportBuilderPort;
  reportRegistration: ReportRegistrationPort;
  logs: CaseAnalysisLogPort;
  templateVersion: string;
}>;

function sortStrings(values: readonly string[]) {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function assertCommand(command: CaseAnalysisCommand) {
  if (command.period.end_date < command.period.start_date) throw new CaseAnalysisError("ANALYSIS_PERIOD_INVALID");
  if (command.requested_topics.length === 0 || new Set(command.requested_topics).size !== command.requested_topics.length) {
    throw new CaseAnalysisError("REQUESTED_TOPICS_INVALID");
  }
  if (command.requested_topics.some((topic) => !WAVE3_TOPICS.includes(topic))) throw new CaseAnalysisError("REQUESTED_TOPIC_UNKNOWN");
  for (const hash of [command.document_snapshot_sha256, command.extraction_snapshot_sha256, command.declared_fact_snapshot_sha256]) {
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new CaseAnalysisError("SNAPSHOT_HASH_INVALID");
  }
}

function aggregateFact(
  path: CanonicalFact["path"],
  facts: readonly CanonicalFact[],
  caseId: string,
  factId: string,
  createdAt: string,
): CanonicalFact {
  const provenance = facts
    .flatMap((fact) => fact.provenance)
    .sort((left, right) => {
      const leftKey = canonicalStringify(left);
      const rightKey = canonicalStringify(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  const conflicts = sortStrings(facts.flatMap((fact) => [fact.fact_id, ...fact.conflicting_fact_ids]));
  if (facts.length === 0 || facts.some((fact) => fact.status === "missing")) {
    return canonicalFactSchema.parse({
      fact_id: factId, case_id: caseId, path, value: null, status: "missing",
      provenance: provenance.length > 0 ? provenance : [], confidence: 1,
      conflicting_fact_ids: [], resolution: null, created_at: createdAt,
    });
  }
  const distinctValues = new Set(facts.map((fact) => canonicalStringify(fact.value)));
  if (facts.some((fact) => fact.status === "conflicted") || distinctValues.size > 1) {
    return canonicalFactSchema.parse({
      fact_id: factId, case_id: caseId, path, value: null, status: "conflicted",
      provenance, confidence: Math.min(...facts.map((fact) => fact.confidence)),
      conflicting_fact_ids: [...new Set(conflicts)].slice(0, Math.max(2, conflicts.length)),
      resolution: null, created_at: createdAt,
    });
  }
  const first = facts[0]!;
  const status = facts.every((fact) => fact.status === "confirmed") ? "confirmed" : "needs_confirmation";
  return canonicalFactSchema.parse({
    ...first,
    fact_id: factId,
    case_id: caseId,
    status,
    provenance,
    confidence: Math.min(...facts.map((fact) => fact.confidence)),
    conflicting_fact_ids: [],
    resolution: null,
    created_at: createdAt,
  });
}

function verifyStoredSnapshot(command: CaseAnalysisCommand, stored: StoredCaseInputSnapshot, hashCanonical: (value: unknown) => string) {
  if (stored.document_snapshot_id !== command.document_snapshot_id
      || stored.extraction_snapshot_id !== command.extraction_snapshot_id
      || stored.declared_fact_snapshot.snapshot_id !== command.declared_fact_snapshot_id) {
    throw new CaseAnalysisError("PINNED_SNAPSHOT_ID_MISMATCH");
  }
  const actualDocumentHash = hashCanonical(stored.documents);
  const actualExtractionHash = hashCanonical(stored.extractions);
  const actualDeclaredHash = hashCanonical(stored.declared_fact_snapshot.facts);
  if (actualDocumentHash !== command.document_snapshot_sha256 || actualDocumentHash !== stored.document_snapshot_sha256
      || actualExtractionHash !== command.extraction_snapshot_sha256 || actualExtractionHash !== stored.extraction_snapshot_sha256
      || actualDeclaredHash !== command.declared_fact_snapshot_sha256 || actualDeclaredHash !== stored.declared_fact_snapshot.snapshot_sha256) {
    throw new CaseAnalysisError("PINNED_SNAPSHOT_HASH_MISMATCH");
  }
  if (stored.documents.length === 0 || stored.documents.length !== stored.extractions.length) {
    throw new CaseAnalysisError("DOCUMENT_EXTRACTION_CARDINALITY_MISMATCH");
  }
}

function projectFacts(input: Readonly<{
  command: CaseAnalysisCommand;
  stored: StoredCaseInputSnapshot;
  analysisRunId: string;
  createdAt: string;
  ids: DeterministicIdPort;
}>): EmploymentSnapshot {
  const documentFacts: CanonicalFact[][] = [];
  for (const [index, document] of input.stored.documents.entries()) {
    const extraction = input.stored.extractions[index]!;
    if (document.document_id !== extraction.document_id || document.case_id !== input.command.case_id) {
      throw new CaseAnalysisError("DOCUMENT_EXTRACTION_SCOPE_MISMATCH");
    }
    const validation = validatePayslipGate0(extraction, { reference_year: Number(input.command.period.start_date.slice(0, 4)) });
    const factIds = Object.fromEntries(resolvedPayslipFactPaths.map((path) => [
      path,
      input.ids.derive("document-fact", canonicalSha256({ analysis_run_id: input.analysisRunId, document_id: document.document_id, path })),
    ]));
    const snapshot = resolvePayslipSnapshot({
      document,
      extraction,
      validation,
      context: {
        snapshot_id: input.ids.derive("document-fact-snapshot", canonicalSha256({ analysis_run_id: input.analysisRunId, index })),
        case_id: input.command.case_id,
        analysis_run_id: input.analysisRunId,
        schema_version: "1.0.0",
        created_at: input.createdAt,
        fact_ids: factIds,
      },
    });
    documentFacts.push(snapshot.facts);
  }
  const declaredByPath = new Map(input.stored.declared_fact_snapshot.facts.map((fact) => [fact.path, fact] as const));
  const facts = Object.values(criticalFactPath).map((path) => {
    const declared = declaredByPath.get(path);
    if (declared) return canonicalFactSchema.parse(declared);
    const candidates = documentFacts.flatMap((entries) => entries.filter((fact) => fact.path === path));
    return aggregateFact(
      path,
      candidates,
      input.command.case_id,
      input.ids.derive("canonical-fact", canonicalSha256({ analysis_run_id: input.analysisRunId, path })),
      input.createdAt,
    );
  });
  const uniqueFacts = [...new Map(facts.map((fact) => [fact.path, fact])).values()]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return employmentSnapshotSchema.parse({
    snapshot_id: input.ids.derive("canonical-facts-snapshot", canonicalSha256({ analysis_run_id: input.analysisRunId })),
    case_id: input.command.case_id,
    analysis_run_id: input.analysisRunId,
    schema_version: "1.0.0",
    facts: uniqueFacts,
    created_at: input.createdAt,
  });
}

function projectRuleInputs(facts: EmploymentSnapshot, topics: readonly Wave3Topic[]): readonly RuleInputSnapshot[] {
  const canonical = createCanonicalRuleInputSnapshot(facts);
  return topics.map((topic) => ruleInputSnapshotSchema.parse({
    snapshot_id: `rule-input:${facts.analysis_run_id}:${topic}`,
    snapshot_version: `${canonical.reference.snapshot_version}:${topic}`,
    snapshot_sha256: canonicalSha256({ topic, canonical_rule_input: canonical.reference }),
  }));
}

function independentlyEvaluateReadiness(selection: LegalCatalogSelection) {
  const embedded = selection.readiness as EmbeddedReadinessDecision;
  const normalized = embedded.normalized_input;
  if (!normalized) throw new CaseAnalysisError("CATALOG_READINESS_INPUT_MISSING");
  const evaluated = evaluateLegalReadiness({
    readinessCase: normalized.readiness_case,
    candidates: normalized.candidates,
  });
  if (evaluated.decision_sha256 !== selection.readiness.decision_sha256) {
    throw new CaseAnalysisError("CATALOG_READINESS_HASH_MISMATCH");
  }
  return evaluated;
}

function topicResult(input: Readonly<{
  topic: Wave3Topic;
  fact: CanonicalFact;
  ruleInput: RuleInputSnapshot;
  selection: LegalCatalogSelection;
  readiness: ReturnType<typeof evaluateLegalReadiness>;
  execution: Awaited<ReturnType<RuleSpecExecutorPort["execute"]>> | null;
}>): TopicAnalysisResult {
  if (input.fact.status === "conflicted") return deepFreeze({
    topic: input.topic, status: "blocked_conflict", blockers: ["UNRESOLVED_CRITICAL_FACT_CONFLICT"],
    rule_input_sha256: input.ruleInput.snapshot_sha256, amount: null, trace: null, legal_readiness: input.readiness,
  });
  if (input.fact.status !== "confirmed") return deepFreeze({
    topic: input.topic, status: "blocked_missing_facts", blockers: [`CRITICAL_FACT_${input.fact.status.toUpperCase()}`],
    rule_input_sha256: input.ruleInput.snapshot_sha256, amount: null, trace: null, legal_readiness: input.readiness,
  });
  const legalBlockers = [
    ...input.readiness.reason_codes,
    ...(input.selection.parameter_version_ids.length > 0 ? [] : ["PARAMETER_DUAL_ATTESTATION_REQUIRED"]),
    ...(input.selection.rule_spec_id && input.selection.rule_spec_version ? [] : ["REVIEWED_RULE_VERSION_REQUIRED"]),
  ];
  if (input.readiness.status !== "READY" || legalBlockers.length > 0) return deepFreeze({
    topic: input.topic, status: "blocked_legal_readiness", blockers: sortStrings(legalBlockers),
    rule_input_sha256: input.ruleInput.snapshot_sha256, amount: null, trace: null, legal_readiness: input.readiness,
  });
  if (!input.execution) return deepFreeze({
    topic: input.topic, status: "error", blockers: ["RULE_EXECUTION_MISSING"],
    rule_input_sha256: input.ruleInput.snapshot_sha256, amount: null, trace: null, legal_readiness: input.readiness,
  });
  if (input.execution.amount === null) return deepFreeze({
    topic: input.topic, status: "not_applicable", blockers: [],
    rule_input_sha256: input.ruleInput.snapshot_sha256, amount: null, trace: input.execution.trace, legal_readiness: input.readiness,
  });
  if (input.execution.trace.output.kind !== "money"
      || canonicalStringify(input.execution.trace.output.value) !== canonicalStringify(input.execution.amount)) {
    throw new CaseAnalysisError(`TRACE_AMOUNT_BINDING_INVALID:${input.topic}`);
  }
  return deepFreeze({
    topic: input.topic, status: "calculated", blockers: [],
    rule_input_sha256: input.ruleInput.snapshot_sha256, amount: input.execution.amount,
    trace: input.execution.trace, legal_readiness: input.readiness,
  });
}

function knownSubtotal(results: readonly TopicAnalysisResult[]) {
  const amounts = results.flatMap((result) => result.status === "calculated" && result.amount ? [result.amount] : []);
  if (amounts.length === 0) return null;
  const currencies = new Set(amounts.map((amount) => amount.currency));
  if (currencies.size !== 1) throw new CaseAnalysisError("KNOWN_SUBTOTAL_CURRENCY_MISMATCH");
  const minorUnits = amounts.reduce((sum, amount) => {
    const next = sum + amount.minor_units;
    if (!Number.isSafeInteger(next)) throw new CaseAnalysisError("KNOWN_SUBTOTAL_OVERFLOW");
    return next;
  }, 0);
  return Object.freeze({ currency: amounts[0]!.currency, minor_units: minorUnits });
}

export class CaseAnalysisService implements CaseAnalysisPort {
  readonly metrics: CaseAnalysisMetrics = {
    run_case_analysis_calls: 0,
    replay_calls: 0,
    canonical_readiness_calls: 0,
    executor_calls: 0,
  };

  constructor(private readonly dependencies: CaseAnalysisServiceDependencies) {}

  private async stage(analysisRunId: string, stage: CaseAnalysisStage, payload: unknown) {
    await this.dependencies.repository.persistStage({
      analysis_run_id: analysisRunId,
      stage,
      payload,
      payload_sha256: this.dependencies.hashes.hashCanonical(payload),
    });
  }

  async runCaseAnalysis(command: CaseAnalysisCommand): Promise<AnalysisResultBundle> {
    this.metrics.run_case_analysis_calls += 1;
    assertCommand(command);
    const commandSha256 = this.dependencies.hashes.hashCanonical(command);
    const analysisRunId = this.dependencies.ids.derive("case-analysis-run", commandSha256);
    const existing = await this.dependencies.repository.begin({
      analysis_run_id: analysisRunId,
      idempotency_key: command.idempotency_key,
      command_sha256: commandSha256,
      command,
    });
    if (existing.completed && existing.bundle) return existing.bundle;
    this.dependencies.logs.write({
      event: existing.stages.length > 0 ? "analysis_resumed" : "analysis_started",
      case_id: command.case_id,
      analysis_run_id: analysisRunId,
      topic: null,
      status: existing.stages.length > 0 ? "resumed" : "started",
      sha256: commandSha256,
    });

    const stored = await this.dependencies.snapshots.loadPinned(command);
    verifyStoredSnapshot(command, stored, this.dependencies.hashes.hashCanonical.bind(this.dependencies.hashes));
    const persistedInput = existing.stages.find((stage) => stage.stage === "input_snapshot")?.payload as Readonly<{
      created_at?: string;
      selections?: readonly LegalCatalogSelection[];
    }> | undefined;
    const createdAt = persistedInput?.created_at ?? this.dependencies.clock.now();
    const selections: LegalCatalogSelection[] = persistedInput?.selections ? [...persistedInput.selections] : [];
    if (selections.length === 0) {
      for (const topic of command.requested_topics) {
        const selection = await this.dependencies.legalCatalog.resolve({
          topic,
          target_date: command.period.end_date,
          as_of: command.as_of,
          sector: command.sector,
          population: command.population,
          mode: command.mode,
        });
        if (selection.topic !== topic || selection.mode !== command.mode) throw new CaseAnalysisError("CATALOG_SELECTION_SCOPE_MISMATCH");
        selections.push(selection);
      }
    }
    if (selections.length !== command.requested_topics.length
        || selections.some((selection, index) => selection.topic !== command.requested_topics[index])) {
      throw new CaseAnalysisError("PINNED_CATALOG_SELECTION_MISMATCH");
    }
    await this.stage(analysisRunId, "input_snapshot", {
      command_sha256: commandSha256,
      document_snapshot_sha256: stored.document_snapshot_sha256,
      extraction_snapshot_sha256: stored.extraction_snapshot_sha256,
      declared_fact_snapshot_sha256: stored.declared_fact_snapshot.snapshot_sha256,
      created_at: createdAt,
      selections,
      provider_independent: true,
    });

    const facts = projectFacts({ command, stored, analysisRunId, createdAt, ids: this.dependencies.ids });
    const factsSnapshotSha256 = this.dependencies.hashes.hashCanonical(facts);
    await this.stage(analysisRunId, "canonical_facts", { facts, facts_snapshot_sha256: factsSnapshotSha256 });

    const ruleInputs = projectRuleInputs(facts, command.requested_topics);
    await this.stage(analysisRunId, "rule_inputs", { rule_inputs: ruleInputs });

    const readiness = new Map<Wave3Topic, ReturnType<typeof evaluateLegalReadiness>>();
    for (const selection of selections) {
      const topic = selection.topic;
      readiness.set(topic, independentlyEvaluateReadiness(selection));
      this.metrics.canonical_readiness_calls += 1;
    }
    const catalogHashes = new Set(selections.map((selection) => selection.catalog_sha256));
    if (catalogHashes.size !== 1) throw new CaseAnalysisError("CATALOG_HASH_DIVERGENCE");
    const catalogSha256 = selections[0]!.catalog_sha256;
    const dependencies: PinnedAnalysisDependencies = deepFreeze({
      extraction_snapshot_sha256: stored.extraction_snapshot_sha256,
      facts_snapshot_sha256: factsSnapshotSha256,
      catalog_sha256: catalogSha256,
      source_version_ids: sortStrings([...new Set(selections.flatMap((selection) => selection.source_version_ids))]),
      parameter_version_ids: sortStrings([...new Set(selections.flatMap((selection) => selection.parameter_version_ids))]),
      rule_spec_versions: sortStrings([...new Set(selections.flatMap((selection) => selection.rule_spec_id && selection.rule_spec_version
        ? [`${selection.rule_spec_id}@${selection.rule_spec_version}`]
        : []))]),
      code_version: "case-analysis@0.6.0",
      template_version: this.dependencies.templateVersion,
    });
    await this.stage(analysisRunId, "analysis_run", { selections, dependencies });

    const factByPath = new Map(facts.facts.map((fact) => [fact.path, fact] as const));
    const ruleInputByTopic = new Map(command.requested_topics.map((topic, index) => [topic, ruleInputs[index]!] as const));
    const selectionByTopic = new Map(selections.map((selection) => [selection.topic, selection] as const));
    const topicResults: TopicAnalysisResult[] = [];
    for (const topic of command.requested_topics) {
      const fact = factByPath.get(criticalFactPath[topic]);
      if (!fact) throw new CaseAnalysisError(`CRITICAL_FACT_PROJECTION_MISSING:${topic}`);
      const selection = selectionByTopic.get(topic)!;
      const decision = readiness.get(topic)!;
      const readyToExecute = fact.status === "confirmed" && decision.status === "READY"
        && selection.parameter_version_ids.length > 0 && selection.rule_spec_id !== null && selection.rule_spec_version !== null;
      let execution: Awaited<ReturnType<RuleSpecExecutorPort["execute"]>> | null = null;
      if (readyToExecute) {
        this.metrics.executor_calls += 1;
        execution = await this.dependencies.executor.execute({
          selection,
          rule_input: ruleInputByTopic.get(topic)!,
          execution_id: this.dependencies.ids.derive("rule-execution", canonicalSha256({ analysisRunId, topic })),
          calculated_at: createdAt,
        });
      }
      const result = topicResult({
        topic,
        fact,
        ruleInput: ruleInputByTopic.get(topic)!,
        selection,
        readiness: decision,
        execution,
      });
      topicResults.push(result);
      this.dependencies.logs.write({
        event: "topic_completed", case_id: command.case_id, analysis_run_id: analysisRunId,
        topic, status: result.status, sha256: this.dependencies.hashes.hashCanonical(result),
      });
    }
    const subtotal = knownSubtotal(topicResults);
    const coverageComplete = topicResults.every((result) => result.status === "calculated" || result.status === "not_applicable");
    const bundleSeed = {
      schema_version: "tivdoc-analysis-result-bundle-v0.6.0" as const,
      analysis_run_id: analysisRunId,
      case_id: command.case_id,
      case_revision: command.case_revision,
      period: command.period,
      as_of: command.as_of,
      document_snapshot_sha256: stored.document_snapshot_sha256,
      extraction_snapshot_sha256: stored.extraction_snapshot_sha256,
      declared_fact_snapshot_sha256: stored.declared_fact_snapshot.snapshot_sha256,
      facts_snapshot_sha256: factsSnapshotSha256,
      facts: facts.facts,
      rule_inputs: ruleInputs,
      catalog_sha256: catalogSha256,
      topic_results: topicResults,
      known_subtotal: subtotal,
      coverage_complete: coverageComplete,
    };
    const bundle: AnalysisResultBundle = deepFreeze({
      ...bundleSeed,
      result_sha256: this.dependencies.hashes.hashCanonical(bundleSeed),
    });
    await this.stage(analysisRunId, "topic_results", { bundle });

    const report = await this.dependencies.reportBuilder.build(bundle);
    await this.stage(analysisRunId, "report_artifacts", {
      report_id: report.report_id,
      report_revision: report.report_revision,
      analysis_result_sha256: report.analysis_result_sha256,
      json_sha256: report.json_sha256,
      html_sha256: report.html_sha256,
      pdf_sha256: report.pdf_sha256,
      manifest_sha256: report.manifest_sha256,
      report_sha256: report.report_sha256,
    });
    this.dependencies.reportRegistration.registerReport({
      case_id: command.case_id,
      report_sha256: report.report_sha256,
      analysis_result_sha256: bundle.result_sha256,
      export_eligible_after_review: command.mode === "synthetic_test" && coverageComplete,
    });
    await this.stage(analysisRunId, "review_pending", {
      report_sha256: report.report_sha256,
      auto_approved: false,
      export_eligible_before_review: false,
    });
    await this.dependencies.repository.complete({ analysis_run_id: analysisRunId, selections, dependencies, bundle, report });
    this.dependencies.logs.write({
      event: "analysis_completed", case_id: command.case_id, analysis_run_id: analysisRunId,
      topic: null, status: coverageComplete ? "complete" : "partial", sha256: bundle.result_sha256,
    });
    return bundle;
  }

  async replay(analysisRunId: string): Promise<AnalysisResultBundle> {
    this.metrics.replay_calls += 1;
    const run = await this.dependencies.repository.getByRunId(analysisRunId);
    if (!run?.completed || !run.bundle || !run.dependencies || !run.report) throw new CaseAnalysisError("PINNED_RUN_UNAVAILABLE");
    await this.dependencies.repository.assertPinnedDependenciesAvailable(run.dependencies);
    const seed = Object.fromEntries(Object.entries(run.bundle).filter(([key]) => key !== "result_sha256"));
    if (this.dependencies.hashes.hashCanonical(seed) !== run.bundle.result_sha256) throw new CaseAnalysisError("PINNED_RESULT_HASH_MISMATCH");
    this.dependencies.logs.write({
      event: "replay_completed", case_id: run.bundle.case_id, analysis_run_id: analysisRunId,
      topic: null, status: "byte_identical", sha256: run.bundle.result_sha256,
    });
    return run.bundle;
  }

  async getCompletedRun(analysisRunId: string) {
    const run = await this.dependencies.repository.getByRunId(analysisRunId);
    return run?.completed ? run : null;
  }
}

export const RUN_CASE_ANALYSIS_CANONICAL_PATH = "CaseAnalysisService.runCaseAnalysis" as const;
