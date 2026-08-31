import type { PostgresQueryResult, PostgresStatement } from "../contracts.ts";
import { CanonicalPostgresError } from "./errors.ts";
import type { ManagedPostgresClient, PostgresConnectionFactory } from "./transaction-manager.ts";

export type RecordingStep = Readonly<{
  statement_name: string;
  result?: PostgresQueryResult;
  fail_with?: "POSTGRES_STATEMENT_FAILED" | "POSTGRES_CONNECTION_FAILED";
}>;

export type RecordedStatement = Readonly<{
  sequence: number;
  name: string;
  text: string;
  parameter_count: number;
  transaction_control: boolean;
}>;

const EMPTY: PostgresQueryResult = Object.freeze({ rows: Object.freeze([]), row_count: 0 });

/** A hermetic SQL-shape harness. It is never PostgreSQL execution evidence. */
export class StrictRecordingPostgresDriver implements PostgresConnectionFactory {
  readonly #steps: RecordingStep[];
  readonly #recorded: RecordedStatement[] = [];
  #acquisitions = 0;
  #releases = 0;

  constructor(steps: readonly RecordingStep[]) {
    this.#steps = [...steps];
  }

  async acquire(): Promise<ManagedPostgresClient> {
    this.#acquisitions += 1;
    return new RecordingClient(this);
  }

  inventory(): Readonly<{
    proof_class: "STATIC_OR_RECORDING_DRIVER_PROOF";
    acquisitions: number;
    releases: number;
    remaining_steps: number;
    statements: readonly RecordedStatement[];
  }> {
    return Object.freeze({
      proof_class: "STATIC_OR_RECORDING_DRIVER_PROOF",
      acquisitions: this.#acquisitions,
      releases: this.#releases,
      remaining_steps: this.#steps.length,
      statements: Object.freeze(this.#recorded.map((entry) => Object.freeze({ ...entry }))),
    });
  }

  consume(statement: PostgresStatement): Promise<PostgresQueryResult> {
    const step = this.#steps.shift();
    this.#recorded.push(Object.freeze({
      sequence: this.#recorded.length + 1,
      name: statement.name,
      text: statement.text,
      parameter_count: statement.values.length,
      transaction_control: statement.name.startsWith("transaction_"),
    }));
    if (!step || step.statement_name !== statement.name) {
      throw new CanonicalPostgresError("POSTGRES_STATEMENT_FAILED");
    }
    if (step.fail_with) throw new CanonicalPostgresError(step.fail_with);
    return Promise.resolve(step.result ?? EMPTY);
  }

  released(): void {
    this.#releases += 1;
  }
}

class RecordingClient implements ManagedPostgresClient {
  readonly #driver: StrictRecordingPostgresDriver;
  #released = false;

  constructor(driver: StrictRecordingPostgresDriver) {
    this.#driver = driver;
  }

  query(statement: PostgresStatement): Promise<PostgresQueryResult> {
    if (this.#released) throw new CanonicalPostgresError("POSTGRES_STATEMENT_FAILED");
    return this.#driver.consume(statement);
  }

  release(): void {
    if (this.#released) throw new CanonicalPostgresError("POSTGRES_RELEASE_FAILED");
    this.#released = true;
    this.#driver.released();
  }
}
