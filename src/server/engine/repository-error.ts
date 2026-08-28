import "server-only";

export type EnginePersistenceErrorCode =
  | "invalid_persistence_input"
  | "persistence_conflict"
  | "persistence_read_failed"
  | "persistence_write_failed"
  | "persistence_record_not_found"
  | "invalid_state_transition";

/** Safe at the application/logging boundary: it never includes database text or case content. */
export class EnginePersistenceError extends Error {
  readonly code: EnginePersistenceErrorCode;
  readonly operation: string;

  constructor(code: EnginePersistenceErrorCode, operation: string) {
    super(`${operation} failed (${code})`);
    this.name = "EnginePersistenceError";
    this.code = code;
    this.operation = operation;
  }
}

export function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}
