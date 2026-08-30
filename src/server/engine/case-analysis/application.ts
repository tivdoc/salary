import type { AnalysisResultBundle, CaseAnalysisCommand, CaseAnalysisPort } from "../../../engine/wave3/contracts";
import { RUN_CASE_ANALYSIS_CANONICAL_PATH, type CaseAnalysisService } from "../../../engine/case-analysis/service";

/** CLI/API/test adapters share this single application dispatch. */
export class CaseAnalysisApplication implements CaseAnalysisPort {
  readonly canonical_path = RUN_CASE_ANALYSIS_CANONICAL_PATH;
  readonly counters = { run_dispatches: 0, replay_dispatches: 0 };

  constructor(private readonly service: CaseAnalysisService) {}

  async runCaseAnalysis(command: CaseAnalysisCommand): Promise<AnalysisResultBundle> {
    this.counters.run_dispatches += 1;
    return this.service.runCaseAnalysis(command);
  }

  async replay(analysisRunId: string): Promise<AnalysisResultBundle> {
    this.counters.replay_dispatches += 1;
    return this.service.replay(analysisRunId);
  }
}
