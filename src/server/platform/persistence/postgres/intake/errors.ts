export type PostgresIntakeErrorCode =
  | "INTAKE_INPUT_INVALID"
  | "INTAKE_ROW_INVALID"
  | "INTAKE_RECORD_NOT_FOUND"
  | "INTAKE_REVISION_CONFLICT"
  | "INTAKE_IMMUTABLE_VERSION_MISMATCH"
  | "INTAKE_IDEMPOTENCY_MISMATCH"
  | "INTAKE_QUERY_FAILED"
  | "INTAKE_TRANSACTION_CONTEXT_INVALID";

/** A deliberately non-diagnostic error boundary: driver details never cross it. */
export class PostgresIntakeError extends Error {
  readonly code: PostgresIntakeErrorCode;
  readonly operation: string;

  constructor(code: PostgresIntakeErrorCode, operation: string) {
    super(`${code}:${operation}`);
    this.name = "PostgresIntakeError";
    this.code = code;
    this.operation = operation;
  }
}
