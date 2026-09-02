import { AsyncLocalStorage } from "node:async_hooks";

import {
  statement,
  type PostgresClient,
  type PostgresTransactionContext,
  type PostgresTransactionManager,
} from "../contracts.ts";
import {
  CanonicalPostgresError,
  mapPostgresFailure,
  recordPostgresFailure,
  type PostgresFailureStage,
} from "./errors.ts";

export interface ManagedPostgresClient extends PostgresClient {
  release(): Promise<void> | void;
}

export interface PostgresConnectionFactory {
  acquire(): Promise<ManagedPostgresClient>;
}

const BEGIN = statement("transaction_begin", "begin", []);
const COMMIT = statement("transaction_commit", "commit", []);
const ROLLBACK = statement("transaction_rollback", "rollback", []);

/**
 * One acquired client and one explicit context per command. Nested transactions
 * are rejected instead of silently opening a second, non-atomic connection.
 */
export class CanonicalPostgresTransactionManager implements PostgresTransactionManager {
  readonly #factory: PostgresConnectionFactory;
  readonly #active = new AsyncLocalStorage<PostgresTransactionContext>();
  #sequence = 0;

  constructor(factory: PostgresConnectionFactory) {
    this.#factory = factory;
  }

  async transaction<T>(operation: (context: PostgresTransactionContext) => Promise<T>): Promise<T> {
    if (this.#active.getStore()) throw new CanonicalPostgresError("POSTGRES_TRANSACTION_NESTING_FORBIDDEN");

    let client: ManagedPostgresClient;
    try {
      client = await this.#factory.acquire();
    } catch (error) {
      throw mapPostgresFailure(error, "POSTGRES_CONNECTION_FAILED", "acquire");
    }

    const transactionId = `postgres-transaction-${String(++this.#sequence).padStart(8, "0")}`;
    const context = Object.freeze({ client, transaction_id: transactionId });
    let began = false;
    let committed = false;
    // Which of BEGIN, the operation and COMMIT was in flight. One catch covers
    // all three, and without this the classified failure cannot say which —
    // "fails before any statement" stayed an inference for two runs.
    let stage: PostgresFailureStage = "begin";
    try {
      await client.query(BEGIN);
      began = true;
      stage = "operation";
      const result = await this.#active.run(context, () => operation(context));
      stage = "commit";
      await client.query(COMMIT);
      committed = true;
      return result;
    } catch (error) {
      if (began && !committed) {
        try {
          await client.query(ROLLBACK);
        } catch (rollbackError) {
          // Preserve the initiating safe error; a failed connection is already
          // unusable. The rollback failure is still described internally.
          recordPostgresFailure(rollbackError, "POSTGRES_TRANSACTION_FAILED", "rollback");
        }
      }
      throw mapPostgresFailure(error, "POSTGRES_TRANSACTION_FAILED", stage);
    } finally {
      try {
        await client.release();
      } catch (error) {
        if (committed) throw mapPostgresFailure(error, "POSTGRES_RELEASE_FAILED", "release");
        recordPostgresFailure(error, "POSTGRES_RELEASE_FAILED", "release");
      }
    }
  }
}
