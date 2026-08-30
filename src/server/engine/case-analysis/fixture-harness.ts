import type { StoredCaseInputSnapshot } from "../../../engine/case-analysis/contracts";
import {
  ContentAddressedIdPort,
  FixedClock,
  FixtureCaseReviewPort,
  FixtureLegalRuleCatalog,
  FixtureReportBuilder,
  FixtureRuleSpecExecutor,
  InMemoryStoredSnapshotPort,
  NodeCanonicalHashPort,
  SafeLogCollector,
  type SyntheticCatalogDefect,
} from "../../../engine/case-analysis/fixture-ports";
import { CaseAnalysisService } from "../../../engine/case-analysis/service";
import { InMemoryCaseAnalysisRepository } from "./in-memory-repository";
import { CaseAnalysisApplication } from "./application";

export function createFixtureCaseAnalysisHarness(
  snapshots: readonly StoredCaseInputSnapshot[],
  defect: SyntheticCatalogDefect = "none",
) {
  const clock = new FixedClock();
  const ids = new ContentAddressedIdPort();
  const hashes = new NodeCanonicalHashPort();
  const snapshotPort = new InMemoryStoredSnapshotPort();
  for (const snapshot of snapshots) snapshotPort.add(snapshot);
  const repository = new InMemoryCaseAnalysisRepository();
  const legalCatalog = new FixtureLegalRuleCatalog(defect);
  const executor = new FixtureRuleSpecExecutor();
  const review = new FixtureCaseReviewPort();
  const reportBuilder = new FixtureReportBuilder(hashes, ids);
  const logs = new SafeLogCollector();
  const service = new CaseAnalysisService({
    clock,
    ids,
    hashes,
    snapshots: snapshotPort,
    repository,
    legalCatalog,
    executor,
    reportBuilder,
    reportRegistration: review,
    logs,
    templateVersion: "synthetic-report-template@1.0.0",
  });
  const application = new CaseAnalysisApplication(service);
  return {
    application, service, repository, legalCatalog, executor, review, reportBuilder, logs,
    snapshots: snapshotPort, clock, ids, hashes,
  };
}
