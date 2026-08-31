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
  readonly sqlstate: string | null;
  readonly domain_code: string | null;

  constructor(
    code: CanonicalPostgresErrorCode,
    semantics: Readonly<{ sqlstate?: string | null; domain_code?: string | null }> = {},
  ) {
    super(code);
    this.name = "CanonicalPostgresError";
    this.code = code;
    this.sqlstate = safeSqlstate(semantics.sqlstate);
    this.domain_code = safeDomainCode(semantics.domain_code);
  }
}

export function mapPostgresFailure(error: unknown, fallback: CanonicalPostgresErrorCode): CanonicalPostgresError {
  if (error instanceof CanonicalPostgresError) return error;
  return new CanonicalPostgresError(fallback, {
    sqlstate: postgresSqlstate(error),
    domain_code: trustedDomainCode(error),
  });
}

const TRUSTED_DOMAIN_ERROR_NAMES = new Set([
  "CaseAnalysisError",
  "PlatformPersistenceError",
  "PostgresAnalysisError",
  "PostgresIntakeError",
]);

function postgresSqlstate(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return safeSqlstate((error as { code?: unknown }).code);
}

function trustedDomainCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("name" in error) || !("code" in error)) return null;
  const candidate = error as { name?: unknown; code?: unknown };
  if (typeof candidate.name !== "string" || !TRUSTED_DOMAIN_ERROR_NAMES.has(candidate.name)) return null;
  return safeDomainCode(candidate.code);
}

function safeSqlstate(value: unknown): string | null {
  return typeof value === "string" && /^[0-9A-Z]{5}$/u.test(value) ? value : null;
}

function safeDomainCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{2,80}$/u.test(value) ? value : null;
}
