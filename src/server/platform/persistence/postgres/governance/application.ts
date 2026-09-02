import { frozen } from "../../../../../engine/legal-operations/canonical.ts";
import type { PostgresTransactionContext } from "../contracts.ts";
import {
  GOVERNANCE_SCHEMA_VERSION,
  GovernanceRepositoryError,
  governanceIdSchema,
} from "./contracts.ts";
import { PostgresHistoricalObservationImportService } from "./historical-observation-import.ts";
import {
  PostgresGovernanceWorkRepository,
  PostgresGroundTruthRepository,
  PostgresLegalReconciliationRepository,
  PostgresLegalReviewRepository,
  PostgresParameterApprovalRepository,
  PostgresReviewerTrustRepository,
  PostgresRuleSpecApprovalRepository,
} from "./repositories.ts";

export type DurableGovernanceApplication = Readonly<{
  schema_version: typeof GOVERNANCE_SCHEMA_VERSION;
  persistence: "postgresql_required";
  tenant_id: string;
  transaction_id: string;
  product_reachable_memory_fallback: false;
  activation_allowed: false;
  durable_replacement_count: 4;
  reviewer_trust: PostgresReviewerTrustRepository;
  work_queue: PostgresGovernanceWorkRepository;
  ground_truth: PostgresGroundTruthRepository;
  legal_reconciliation: PostgresLegalReconciliationRepository;
  parameters: PostgresParameterApprovalRepository;
  rulespec: PostgresRuleSpecApprovalRepository;
  legal_review: PostgresLegalReviewRepository;
  historical_observations: PostgresHistoricalObservationImportService;
}>;

/**
 * Builds one command-scoped governance application over one already-open
 * PostgreSQL transaction.  It deliberately accepts no fallback factory and
 * must not be cached outside the lifetime of the supplied transaction.
 */
export function createDurableGovernanceApplication(
  context: PostgresTransactionContext,
  tenantIdInput: string,
): DurableGovernanceApplication {
  if (!context || !context.client || typeof context.client.query !== "function"
      || typeof context.transaction_id !== "string" || context.transaction_id.trim() === "") {
    throw new GovernanceRepositoryError("GOVERNANCE_INPUT_INVALID", "durable_governance_application");
  }
  const tenantId = governanceIdSchema.parse(tenantIdInput);
  const reviewerTrust = new PostgresReviewerTrustRepository(context, tenantId);
  const workQueue = new PostgresGovernanceWorkRepository(context, tenantId);
  const groundTruth = new PostgresGroundTruthRepository(context, tenantId);
  const legalReconciliation = new PostgresLegalReconciliationRepository(context, tenantId);
  const parameters = new PostgresParameterApprovalRepository(context, tenantId);
  const rulespec = new PostgresRuleSpecApprovalRepository(context, tenantId);
  const legalReview = new PostgresLegalReviewRepository(context, tenantId);
  return frozen({
    schema_version: GOVERNANCE_SCHEMA_VERSION,
    persistence: "postgresql_required",
    tenant_id: tenantId,
    transaction_id: context.transaction_id,
    product_reachable_memory_fallback: false,
    activation_allowed: false,
    durable_replacement_count: 4,
    reviewer_trust: reviewerTrust,
    work_queue: workQueue,
    ground_truth: groundTruth,
    legal_reconciliation: legalReconciliation,
    parameters,
    rulespec,
    legal_review: legalReview,
    historical_observations: new PostgresHistoricalObservationImportService(legalReconciliation, workQueue),
  });
}
