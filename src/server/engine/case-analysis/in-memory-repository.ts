import { canonicalSha256, deepFreeze } from "../../../engine/rule-runtime/canonical";
import type {
  CaseAnalysisRepositoryPort,
  CaseAnalysisStage,
  PersistedAnalysisStage,
  PersistedCaseAnalysisRun,
  PinnedAnalysisDependencies,
} from "../../../engine/case-analysis/contracts";
import { CaseAnalysisError } from "../../../engine/case-analysis/contracts";
import type {
  AnalysisResultBundle,
  CaseAnalysisCommand,
  DeterministicReportArtifacts,
  LegalCatalogSelection,
} from "../../../engine/wave3/contracts";

type MutableRun = {
  analysis_run_id: string;
  idempotency_key: string;
  command_sha256: string;
  command: CaseAnalysisCommand;
  stages: PersistedAnalysisStage[];
  selections: readonly LegalCatalogSelection[];
  dependencies: PinnedAnalysisDependencies | null;
  bundle: AnalysisResultBundle | null;
  report: DeterministicReportArtifacts | null;
  completed: boolean;
};

function publicRun(run: MutableRun): PersistedCaseAnalysisRun {
  return Object.freeze({
    ...run,
    stages: Object.freeze([...run.stages]),
    selections: Object.freeze([...run.selections]),
  }) as PersistedCaseAnalysisRun;
}

export class InMemoryCaseAnalysisRepository implements CaseAnalysisRepositoryPort {
  private readonly runs = new Map<string, MutableRun>();
  private readonly idempotency = new Map<string, string>();
  private readonly unavailableDependencies = new Set<string>();
  private failureAfter: CaseAnalysisStage | null = null;
  private readonly injectedFailures = new Set<string>();

  setFailureAfter(stage: CaseAnalysisStage | null) {
    this.failureAfter = stage;
  }

  setDependencyAvailable(sha256: string, available: boolean) {
    if (available) this.unavailableDependencies.delete(sha256);
    else this.unavailableDependencies.add(sha256);
  }

  runCount() {
    return this.runs.size;
  }

  completedCount() {
    return [...this.runs.values()].filter((run) => run.completed).length;
  }

  async begin(input: Readonly<{
    analysis_run_id: string;
    idempotency_key: string;
    command_sha256: string;
    command: CaseAnalysisCommand;
  }>) {
    const existingRunId = this.idempotency.get(input.idempotency_key);
    if (existingRunId) {
      const existing = this.runs.get(existingRunId)!;
      if (existing.command_sha256 !== input.command_sha256) {
        throw new CaseAnalysisError("IDEMPOTENCY_KEY_COMMAND_MISMATCH");
      }
      return publicRun(existing);
    }
    if (this.runs.has(input.analysis_run_id)) throw new CaseAnalysisError("ANALYSIS_RUN_ID_COLLISION");
    const created: MutableRun = {
      ...input,
      stages: [],
      selections: [],
      dependencies: null,
      bundle: null,
      report: null,
      completed: false,
    };
    this.runs.set(input.analysis_run_id, created);
    this.idempotency.set(input.idempotency_key, input.analysis_run_id);
    return publicRun(created);
  }

  async persistStage(input: Readonly<{
    analysis_run_id: string;
    stage: CaseAnalysisStage;
    payload_sha256: string;
    payload: unknown;
  }>) {
    const run = this.runs.get(input.analysis_run_id);
    if (!run) throw new CaseAnalysisError("ANALYSIS_RUN_NOT_FOUND");
    const existing = run.stages.find((stage) => stage.stage === input.stage);
    if (existing) {
      if (existing.payload_sha256 !== input.payload_sha256) {
        throw new CaseAnalysisError(`IMMUTABLE_STAGE_MISMATCH:${input.stage}`);
      }
      return;
    }
    if (canonicalSha256(input.payload) !== input.payload_sha256) {
      throw new CaseAnalysisError(`STAGE_HASH_MISMATCH:${input.stage}`);
    }
    run.stages.push(deepFreeze({ ...input }));
    const failureKey = `${input.analysis_run_id}:${input.stage}`;
    if (this.failureAfter === input.stage && !this.injectedFailures.has(failureKey)) {
      this.injectedFailures.add(failureKey);
      throw new CaseAnalysisError(`INJECTED_FAILURE_AFTER:${input.stage}`);
    }
  }

  async complete(input: Readonly<{
    analysis_run_id: string;
    selections: readonly LegalCatalogSelection[];
    dependencies: PinnedAnalysisDependencies;
    bundle: AnalysisResultBundle;
    report: DeterministicReportArtifacts;
  }>) {
    const run = this.runs.get(input.analysis_run_id);
    if (!run) throw new CaseAnalysisError("ANALYSIS_RUN_NOT_FOUND");
    if (run.completed) {
      if (run.bundle?.result_sha256 !== input.bundle.result_sha256 || run.report?.report_sha256 !== input.report.report_sha256) {
        throw new CaseAnalysisError("IMMUTABLE_COMPLETED_RUN_MISMATCH");
      }
      return publicRun(run);
    }
    run.selections = deepFreeze([...input.selections]);
    run.dependencies = deepFreeze(input.dependencies);
    run.bundle = deepFreeze(input.bundle);
    run.report = input.report;
    run.completed = true;
    return publicRun(run);
  }

  async getByRunId(analysisRunId: string) {
    const run = this.runs.get(analysisRunId);
    return run ? publicRun(run) : null;
  }

  async getCompletedByIdempotencyKey(idempotencyKey: string) {
    const runId = this.idempotency.get(idempotencyKey);
    if (!runId) return null;
    const run = this.runs.get(runId)!;
    return run.completed ? publicRun(run) : null;
  }

  async assertPinnedDependenciesAvailable(dependencies: PinnedAnalysisDependencies) {
    const hashes = [
      dependencies.extraction_snapshot_sha256,
      dependencies.facts_snapshot_sha256,
      dependencies.catalog_sha256,
      ...dependencies.source_version_ids,
      ...dependencies.parameter_version_ids,
      ...dependencies.rule_spec_versions,
      canonicalSha256(dependencies.code_version),
      canonicalSha256(dependencies.template_version),
    ];
    const unavailable = hashes.find((value) => this.unavailableDependencies.has(value));
    if (unavailable) throw new CaseAnalysisError(`PINNED_VERSION_UNAVAILABLE:${unavailable}`);
  }
}
