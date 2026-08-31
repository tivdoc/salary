import { AsyncLocalStorage } from "node:async_hooks";

import {
  statement,
  type PostgresClient,
  type PostgresTransactionContext,
  type PostgresTransactionManager,
} from "../contracts.ts";
import { CanonicalPostgresError, mapPostgresFailure } from "./errors.ts";

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
      throw mapPostgresFailure(error, "POSTGRES_CONNECTION_FAILED");
    }

    const transactionId = `postgres-transaction-${String(++this.#sequence).padStart(8, "0")}`;
    const context = Object.freeze({ client, transaction_id: transactionId });
    let began = false;
    let committed = false;
    try {
      await client.query(BEGIN);
      began = true;
      const result = await this.#active.run(context, () => operation(context));
      await client.query(COMMIT);
      committed = true;
      return result;
    } catch (error) {
      if (began && !committed) {
        try {
          await client.query(ROLLBACK);
        } catch {
          // Preserve the initiating safe error; a failed connection is already unusable.
        }
      }
      throw mapPostgresFailure(error, "POSTGRES_TRANSACTION_FAILED");
    } finally {
      try {
        await client.release();
      } catch (error) {
        if (committed) throw mapPostgresFailure(error, "POSTGRES_RELEASE_FAILED");
      }
    }
  }
}
