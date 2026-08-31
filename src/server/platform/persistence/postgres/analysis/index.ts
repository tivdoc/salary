import type { PostgresTransactionContext } from "../contracts";
import { PostgresCaseAnalysisRepository } from "./case-analysis-repository";
import { PostgresLegalPinsRepository } from "./legal-pins";
import { PostgresReportReviewRepository } from "./reports";
import { PostgresTopicResultRepository } from "./topic-results";
import { PostgresTraceFindingRepository } from "./traces";
import { assertSafeIdentifier } from "./validation";

export type PostgresAnalysisRepositories = Readonly<{
  caseAnalysis: PostgresCaseAnalysisRepository;
  legalPins: PostgresLegalPinsRepository;
  topicResults: PostgresTopicResultRepository;
  traceFindings: PostgresTraceFindingRepository;
  reports: PostgresReportReviewRepository;
}>;

/** Builds the five W2 adapters on one explicit transaction context. */
export function createPostgresAnalysisRepositories(
  context: PostgresTransactionContext,
  tenantId: string,
): PostgresAnalysisRepositories {
  assertSafeIdentifier(tenantId);
  const legalPins = new PostgresLegalPinsRepository(context, tenantId);
  const topicResults = new PostgresTopicResultRepository(context, tenantId);
  const traceFindings = new PostgresTraceFindingRepository(context, tenantId);
  const reports = new PostgresReportReviewRepository(context, tenantId);
  const caseAnalysis = new PostgresCaseAnalysisRepository(context, tenantId, {
    legalPins,
    topicResults,
    traceFindings,
    reports,
  });
  return Object.freeze({ caseAnalysis, legalPins, topicResults, traceFindings, reports });
}

export { PostgresAnalysisError, type PostgresAnalysisErrorCode } from "./errors";
export { PostgresCaseAnalysisRepository } from "./case-analysis-repository";
export { PostgresLegalPinsRepository, dependencyPins } from "./legal-pins";
export { PostgresTopicResultRepository } from "./topic-results";
export { PostgresTraceFindingRepository } from "./traces";
export { PostgresReportReviewRepository } from "./reports";
