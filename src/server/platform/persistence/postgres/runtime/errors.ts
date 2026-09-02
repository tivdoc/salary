export type CanonicalPostgresErrorCode =
  | "POSTGRES_TARGET_REQUIRED"
  | "POSTGRES_TARGET_NOT_LOOPBACK"
  | "POSTGRES_TARGET_NOT_DISPOSABLE"
  | "POSTGRES_SCHEMA_INCOMPATIBLE"
  | "POSTGRES_CONNECTION_FAILED"
  | "POSTGRES_TRANSACTION_FAILED"
  | "POSTGRES_TRANSACTION_NESTING_FORBIDDEN"
  | "POSTGRES_RUNTIME_IDENTITY_INVALID"
  | "POSTGRES_RUNTIME_IDENTITY_MISMATCH"
  | "POSTGRES_RUNTIME_IDENTITY_REQUIRED"
  | "POSTGRES_RUNTIME_REVIEWER_ORGANIZATION_REQUIRED"
  | "POSTGRES_RUNTIME_ROLE_UNAVAILABLE"
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

/** Where a persistence failure was classified. */
export const POSTGRES_FAILURE_STAGES = Object.freeze([
  "acquire", "begin", "operation", "commit", "rollback", "release", "unspecified",
] as const);

export type PostgresFailureStage = (typeof POSTGRES_FAILURE_STAGES)[number];

/**
 * A failure described well enough to act on, and no further.
 *
 * The low-cardinality code that crosses the boundary is correct and unchanged,
 * but on its own it erased everything about what threw. Three runs were spent
 * on failures that concealed their own cause, so the classifier now keeps an
 * internal descriptor: the stage, the thrown constructor, and the small set of
 * fields that are themselves classifications. Never a message, a parameter, an
 * identifier or any part of a connection string.
 */
export type PostgresFailureDescriptor = Readonly<{
  stage: PostgresFailureStage;
  code: CanonicalPostgresErrorCode;
  constructor_name: string;
  error_code: string | null;
  errno: number | null;
  severity: string | null;
  routine: string | null;
  sqlstate: string | null;
  at: string;
}>;

const FAILURE_LOG_LIMIT = 64;
const failureLog: PostgresFailureDescriptor[] = [];

export function readPostgresFailureLog(): readonly PostgresFailureDescriptor[] {
  return Object.freeze([...failureLog]);
}

export function clearPostgresFailureLog(): void {
  failureLog.length = 0;
}

const SAFE_TOKEN = /^[A-Za-z0-9_]{1,32}$/u;

function safeToken(value: unknown): string | null {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : null;
}

function describeFailure(
  error: unknown,
  code: CanonicalPostgresErrorCode,
  stage: PostgresFailureStage,
): PostgresFailureDescriptor {
  const candidate = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
  return Object.freeze({
    stage,
    code,
    constructor_name: error instanceof Error ? error.constructor.name : typeof error,
    error_code: safeToken(candidate.code),
    errno: typeof candidate.errno === "number" ? candidate.errno : null,
    severity: safeToken(candidate.severity),
    routine: safeToken(candidate.routine),
    sqlstate: postgresSqlstate(error),
    at: new Date().toISOString(),
  });
}

/** Records a descriptor internally. Nothing here reaches a response body. */
export function recordPostgresFailure(
  error: unknown,
  code: CanonicalPostgresErrorCode,
  stage: PostgresFailureStage,
): void {
  const descriptor = describeFailure(error, code, stage);
  failureLog.push(descriptor);
  if (failureLog.length > FAILURE_LOG_LIMIT) failureLog.shift();
  if (process.env.NODE_ENV !== "test") {
    process.stderr.write(`postgres_failure ${descriptor.code} stage=${descriptor.stage}`
      + ` ctor=${descriptor.constructor_name} code=${descriptor.error_code ?? "-"}`
      + ` errno=${descriptor.errno ?? "-"} sqlstate=${descriptor.sqlstate ?? "-"}`
      + ` severity=${descriptor.severity ?? "-"} routine=${descriptor.routine ?? "-"}\n`);
  }
}

export function mapPostgresFailure(
  error: unknown,
  fallback: CanonicalPostgresErrorCode,
  stage: PostgresFailureStage = "unspecified",
): CanonicalPostgresError {
  if (error instanceof CanonicalPostgresError) {
    recordPostgresFailure(error, error.code, stage);
    return error;
  }
  recordPostgresFailure(error, fallback, stage);
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
