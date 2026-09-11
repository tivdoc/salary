import {z} from 'zod';
import {savedCaseTenant} from './saved-admission';

const opaque=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/u);
export const managedWorkerCandidateSchema=z.object({case_id:z.uuid(),identity:z.object({
 session_id:opaque,token_id:opaque,tenant_id:opaque,actor_id:opaque,reviewer_organization_id:z.null(),rotation_counter:z.number().int().nonnegative(),
}).strict()}).strict().refine(row=>row.identity.tenant_id===savedCaseTenant(row.case_id));
export type ManagedWorkerCandidate=z.infer<typeof managedWorkerCandidateSchema>;
export const MANAGED_WORKER_STATES=['waiting','processing','awaiting_input','failed','complete'] as const;
export const managedWorkerStatusSchema=z.object({case_id:z.uuid(),state:z.enum(MANAGED_WORKER_STATES),
 input_revision:z.coerce.number().int().positive().nullable(),job_id:z.string().nullable(),job_revision:z.coerce.number().int().positive().nullable(),
 attempt_count:z.coerce.number().int().nonnegative(),max_attempts:z.coerce.number().int().min(1).max(5),
 next_attempt_at:z.coerce.date().transform(value=>value.toISOString()).nullable(),last_error:z.string().regex(/^[a-z][a-z0-9_]{2,95}$/u).nullable(),
 current_run_id:z.uuid().nullable(),updated_at:z.coerce.date().transform(value=>value.toISOString()),
}).strict();
export type ManagedWorkerStatus=z.infer<typeof managedWorkerStatusSchema>;

/** No raw provider/DB messages are persisted or returned. Specific codes are
 * retained only where they tell an operator what must change before retry. */
export function managedWorkerError(error:unknown):string{
 const message=error instanceof Error?error.message:'';
 const known:Readonly<Record<string,string>>={
  SAVED_EXTRACTION_RECEIPT_REQUIRED:'provider_receipt_required',SAVED_EXTRACTION_OUTCOME_PENDING:'provider_outcome_unknown',SAVED_EXTRACTION_PROVIDER_DISABLED:'provider_disabled',
  SAVED_EXTRACTION_PROVIDER_UNCONFIGURED:'provider_unconfigured',SAVED_EXTRACTION_PERIOD_MISMATCH:'period_confirmation_required',
  SAVED_PURCHASED_MONTH_DOCUMENT_REQUIRED:'purchased_document_missing',SAVED_ORDER_ENTITLEMENT_REQUIRED:'entitlement_unavailable',
  SAVED_PAID_SOURCE_REQUIRED:'payment_unavailable',ANALYSIS_INPUT_SUPERSEDED:'source_superseded',
  ANALYSIS_AUTHORITY_SUPERSEDED:'authority_superseded',
  SAVED_JOB_INTERRUPTED:'worker_interrupted',SAVED_JOB_FENCE:'worker_lease_lost',
  SAVED_WORKER_SCOPE_FORBIDDEN:'worker_scope_forbidden',MANAGED_DEV_SCOPE_UNSUPPORTED:'scope_unsupported',
  DEV_FINANCIAL_SCENARIO_UNSUPPORTED:'scenario_unsupported',DEV_FINANCIAL_CANONICAL_SCENARIO:'canonical_confirmation_required',
  MANAGED_DEV_CANONICAL_ACTIVATION_BLOCKED:'canonical_activation_blocked',MANAGED_DEV_BUDGET_EXHAUSTED:'daily_budget_exhausted',
  MANAGED_DEV_SOL_BUDGET_UNCONFIGURED:'provider_budget_unconfigured',SOL_SAVED_GENERATION_LIMIT:'provider_budget_exhausted',
  SOL_BUDGET_EXHAUSTED:'provider_budget_exhausted',SOL_MANAGED_PACKAGE_EXPIRED:'provider_budget_expired',
  SOL_PRICING_EXPIRED:'provider_pricing_expired',SOL_UNKNOWN_OUTCOME_REQUIRES_REVIEW:'provider_outcome_unknown',
  SOL_REPLAY_REQUIRES_REVIEW:'provider_outcome_requires_review',SOL_MANAGED_PACKAGE_REQUIRED:'provider_budget_unconfigured',
  SOL_SAVED_SOURCE_NOT_ALLOWED:'provider_source_not_allowed',SOL_SAVED_CASE_NOT_ALLOWED:'provider_case_not_allowed',
  SOL_LEDGER_RECOVERY_ACTIVE:'provider_budget_locked',SOL_LEDGER_LOCK_OWNERSHIP_CHANGED:'provider_budget_locked',
 };
 return known[message]??'processing_failed';
}
