export type PostgresParameter = string | number | boolean | Uint8Array | null;

export type PostgresStatement = Readonly<{
  name: string;
  text: string;
  values: readonly PostgresParameter[];
}>;

export type PostgresQueryResult = Readonly<{
  rows: readonly Readonly<Record<string, unknown>>[];
  row_count: number;
}>;

/**
 * Project-owned PostgreSQL boundary. Adapters depend on this narrow contract;
 * the runtime may supply a real loopback driver only after target validation.
 */
export interface PostgresClient {
  query(statement: PostgresStatement): Promise<PostgresQueryResult>;
}

export type PostgresTransactionContext = Readonly<{
  client: PostgresClient;
  transaction_id: string;
}>;

export interface PostgresTransactionManager {
  transaction<T>(operation: (context: PostgresTransactionContext) => Promise<T>): Promise<T>;
}

export type PostgresRuntimeMode = "memory_test_only" | "isolated_postgres" | "disabled";

export function statement(
  name: string,
  text: string,
  values: readonly PostgresParameter[],
): PostgresStatement {
  if (!/^[a-z][a-z0-9_]{2,63}$/u.test(name)) throw new TypeError("POSTGRES_STATEMENT_NAME_INVALID");
  if (text.includes("${")) throw new TypeError("POSTGRES_INTERPOLATED_SQL_FORBIDDEN");
  const placeholders = [...text.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1]));
  const maximum = placeholders.length === 0 ? 0 : Math.max(...placeholders);
  if (maximum !== values.length || placeholders.some((value) => value < 1 || value > values.length)) {
    throw new TypeError("POSTGRES_PARAMETER_COUNT_MISMATCH");
  }
  return Object.freeze({ name, text, values: Object.freeze([...values]) });
}
