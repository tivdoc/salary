import { CaseAnalysisError } from "../../../../../engine/case-analysis/contracts";

export type PostgresAnalysisErrorCode =
  | "ANALYSIS_OWNER_SCOPE_INVALID"
  | "ANALYSIS_ROW_MALFORMED"
  | "ANALYSIS_ROW_VERSION_UNSUPPORTED"
  | "ANALYSIS_RUN_NOT_FOUND"
  | "ANALYSIS_RUN_ID_COLLISION"
  | "STALE_CASE_REVISION"
  | "IDEMPOTENCY_KEY_COMMAND_MISMATCH"
  | "IMMUTABLE_STAGE_MISMATCH"
  | "STAGE_HASH_MISMATCH"
  | "IMMUTABLE_COMPLETED_RUN_MISMATCH"
  | "PINNED_VERSION_UNAVAILABLE"
  | "TOPIC_SET_INVALID"
  | "FINDINGS_DISABLED"
  | "REPORT_HASH_BINDING_INVALID"
  | "REPORT_REVIEW_NOT_ELIGIBLE"
  | "STALE_REPORT_REVISION"
  | "POSTGRES_PERSISTENCE_UNAVAILABLE";

/** Safe boundary error: it deliberately carries no SQL, identifiers or driver message. */
export class PostgresAnalysisError extends CaseAnalysisError {
  declare readonly code: PostgresAnalysisErrorCode;

  constructor(code: PostgresAnalysisErrorCode) {
    super(code);
    this.name = "PostgresAnalysisError";
  }
}

type DriverError = Readonly<{ code?: unknown }>;

export function mapPostgresAnalysisError(error: unknown, uniqueCode: PostgresAnalysisErrorCode): never {
  if (error instanceof CaseAnalysisError) throw error;
  if (typeof error === "object" && error !== null && (error as DriverError).code === "23505") {
    throw new PostgresAnalysisError(uniqueCode);
  }
  throw new PostgresAnalysisError("POSTGRES_PERSISTENCE_UNAVAILABLE");
}
