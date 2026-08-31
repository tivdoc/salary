export type CanonicalPostgresErrorCode =
  | "POSTGRES_TARGET_REQUIRED"
  | "POSTGRES_TARGET_NOT_LOOPBACK"
  | "POSTGRES_TARGET_NOT_DISPOSABLE"
  | "POSTGRES_SCHEMA_INCOMPATIBLE"
  | "POSTGRES_CONNECTION_FAILED"
  | "POSTGRES_TRANSACTION_FAILED"
  | "POSTGRES_TRANSACTION_NESTING_FORBIDDEN"
  | "POSTGRES_ROW_MALFORMED"
  | "POSTGRES_STATEMENT_FAILED"
  | "POSTGRES_RELEASE_FAILED"
  | "MEMORY_TEST_ONLY_SENTINEL_REQUIRED"
  | "MEMORY_TEST_ONLY_OUTSIDE_HERMETIC_EXECUTION"
  | "PERSISTENCE_DISABLED";

/** A deliberately low-cardinality error. Driver messages and identifiers never escape this boundary. */
export class CanonicalPostgresError extends Error {
  readonly code: CanonicalPostgresErrorCode;

  constructor(code: CanonicalPostgresErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "CanonicalPostgresError";
    this.code = code;
  }
}

export function mapPostgresFailure(error: unknown, fallback: CanonicalPostgresErrorCode): CanonicalPostgresError {
  if (error instanceof CanonicalPostgresError) return error;
  return new CanonicalPostgresError(fallback, { cause: error });
}
