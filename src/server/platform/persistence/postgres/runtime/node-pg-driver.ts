import { Pool, type PoolConfig } from "pg";

import type {
  PostgresParameter,
  PostgresQueryResult,
  PostgresStatement,
} from "../contracts.ts";
import { CanonicalPostgresError, mapPostgresFailure } from "./errors.ts";
import type { ManagedPostgresClient, PostgresConnectionFactory } from "./transaction-manager.ts";

const LOOPBACK_HOSTS = new Map([
  ["127.0.0.1", "127.0.0.1"],
  ["localhost", "localhost"],
  ["::1", "::1"],
  ["[::1]", "::1"],
] as const);
const DISPOSABLE_DATABASE = /^tivdoc_v09_[a-z0-9_]{8,48}$/u;
const VALIDATED_TARGET = "NODE_POSTGRES_LOOPBACK_DISPOSABLE_VALIDATED" as const;

export type NodePostgresTargetDescriptor = Readonly<{
  target_id: string;
  host: "127.0.0.1" | "localhost" | "::1";
  port: number;
  database: string;
  disposable: true;
  validation: "LOOPBACK_DISPOSABLE_VALIDATED";
}>;

export type NodePostgresConnectionInput = Readonly<{
  connection_url: string;
  max_connections?: number;
  connection_timeout_ms?: number;
  application_name?: string;
}>;

export type ValidatedNodePostgresConnectionConfig = Readonly<{
  validation: typeof VALIDATED_TARGET;
  connection_url: string;
  target: NodePostgresTargetDescriptor;
  pool_config: Readonly<{
    max: number;
    connectionTimeoutMillis: number;
    application_name: string;
  }>;
}>;

export type NodePostgresDriverMetrics = Readonly<{
  driver: "node-postgres";
  target: NodePostgresTargetDescriptor;
  connection_attempts: number;
  acquisitions: number;
  queries: number;
  releases: number;
  active_clients: number;
  closed: boolean;
}>;

type NodePostgresQueryConfig = Readonly<{
  name: string;
  text: string;
  values: readonly PostgresParameter[];
}>;

type NodePostgresPoolResult = Readonly<{
  rows: readonly Readonly<Record<string, unknown>>[];
  rowCount: number | null;
}>;

export interface NodePostgresPoolClient {
  query(config: NodePostgresQueryConfig): Promise<NodePostgresPoolResult>;
  release(): void;
}

export interface NodePostgresPool {
  connect(): Promise<NodePostgresPoolClient>;
  end(): Promise<void>;
}

export type NodePostgresPoolFactory = (config: PoolConfig) => NodePostgresPool;

/**
 * Validates the actual connection URL and derives the only target descriptor
 * accepted by the canonical PostgreSQL application root. Credentials are never
 * copied into the target descriptor or driver metrics.
 */
export function validateNodePostgresConnection(
  input: NodePostgresConnectionInput,
): ValidatedNodePostgresConnectionConfig {
  const parsed = parseConnectionUrl(input.connection_url);
  const target = targetFromUrl(parsed);
  const max = boundedInteger(input.max_connections ?? 8, 1, 32, "POSTGRES_TARGET_REQUIRED");
  const connectionTimeoutMillis = boundedInteger(
    input.connection_timeout_ms ?? 5_000,
    100,
    30_000,
    "POSTGRES_TARGET_REQUIRED",
  );
  const applicationName = input.application_name ?? "tivdoc-canonical-postgresql-dynamic-v0.9.1";
  if (!/^[a-z0-9][a-z0-9._-]{2,95}$/u.test(applicationName)) {
    throw new CanonicalPostgresError("POSTGRES_TARGET_REQUIRED");
  }
  return Object.freeze({
    validation: VALIDATED_TARGET,
    connection_url: input.connection_url,
    target,
    pool_config: Object.freeze({ max, connectionTimeoutMillis, application_name: applicationName }),
  });
}

export function deriveNodePostgresTargetDescriptor(connectionUrl: string): NodePostgresTargetDescriptor {
  return targetFromUrl(parseConnectionUrl(connectionUrl));
}

/** A Pool-backed implementation of the project-owned PostgreSQL boundary. */
export class NodePostgresConnectionFactory implements PostgresConnectionFactory {
  readonly #pool: NodePostgresPool;
  readonly #target: NodePostgresTargetDescriptor;
  #connectionAttempts = 0;
  #acquisitions = 0;
  #queries = 0;
  #releases = 0;
  #activeClients = 0;
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(
    config: ValidatedNodePostgresConnectionConfig,
    poolFactory: NodePostgresPoolFactory = defaultPoolFactory,
  ) {
    const revalidated = validateNodePostgresConnection({
      connection_url: config.connection_url,
      max_connections: config.pool_config.max,
      connection_timeout_ms: config.pool_config.connectionTimeoutMillis,
      application_name: config.pool_config.application_name,
    });
    if (config.validation !== VALIDATED_TARGET || !sameTarget(config.target, revalidated.target)) {
      throw new CanonicalPostgresError("POSTGRES_TARGET_NOT_DISPOSABLE");
    }
    this.#target = revalidated.target;
    try {
      this.#pool = poolFactory({
        connectionString: revalidated.connection_url,
        max: revalidated.pool_config.max,
        connectionTimeoutMillis: revalidated.pool_config.connectionTimeoutMillis,
        application_name: revalidated.pool_config.application_name,
        ssl: false,
        allowExitOnIdle: true,
      });
    } catch (error) {
      throw mapPostgresFailure(error, "POSTGRES_CONNECTION_FAILED");
    }
  }

  static fromConnectionUrl(
    input: NodePostgresConnectionInput,
    poolFactory: NodePostgresPoolFactory = defaultPoolFactory,
  ): NodePostgresConnectionFactory {
    return new NodePostgresConnectionFactory(validateNodePostgresConnection(input), poolFactory);
  }

  get target(): NodePostgresTargetDescriptor {
    return this.#target;
  }

  async acquire(): Promise<ManagedPostgresClient> {
    if (this.#closed) throw new CanonicalPostgresError("POSTGRES_CONNECTION_FAILED");
    this.#connectionAttempts += 1;
    let client: NodePostgresPoolClient;
    try {
      client = await this.#pool.connect();
    } catch (error) {
      throw mapPostgresFailure(error, "POSTGRES_CONNECTION_FAILED");
    }
    if (this.#closed) {
      client.release();
      throw new CanonicalPostgresError("POSTGRES_CONNECTION_FAILED");
    }
    this.#acquisitions += 1;
    this.#activeClients += 1;
    return new NodePostgresManagedClient(client, {
      query: () => { this.#queries += 1; },
      release: () => {
        this.#releases += 1;
        this.#activeClients -= 1;
      },
    });
  }

  metrics(): NodePostgresDriverMetrics {
    return Object.freeze({
      driver: "node-postgres",
      target: this.#target,
      connection_attempts: this.#connectionAttempts,
      acquisitions: this.#acquisitions,
      queries: this.#queries,
      releases: this.#releases,
      active_clients: this.#activeClients,
      closed: this.#closed,
    });
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#activeClients !== 0) throw new CanonicalPostgresError("POSTGRES_RELEASE_FAILED");
    this.#closed = true;
    this.#closePromise = this.#pool.end().catch((error: unknown) => {
      throw mapPostgresFailure(error, "POSTGRES_RELEASE_FAILED");
    });
    return this.#closePromise;
  }
}

class NodePostgresManagedClient implements ManagedPostgresClient {
  readonly #client: NodePostgresPoolClient;
  readonly #metrics: Readonly<{ query(): void; release(): void }>;
  #released = false;

  constructor(
    client: NodePostgresPoolClient,
    metrics: Readonly<{ query(): void; release(): void }>,
  ) {
    this.#client = client;
    this.#metrics = metrics;
  }

  async query(statement: PostgresStatement): Promise<PostgresQueryResult> {
    if (this.#released) throw new CanonicalPostgresError("POSTGRES_STATEMENT_FAILED");
    this.#metrics.query();
    try {
      const result = await this.#client.query({
        name: statement.name,
        text: statement.text,
        values: [...statement.values],
      });
      return Object.freeze({
        rows: Object.freeze(result.rows.map(normalizePostgresRow)),
        row_count: result.rowCount ?? result.rows.length,
      });
    } catch (error) {
      throw mapPostgresFailure(error, "POSTGRES_STATEMENT_FAILED");
    }
  }

  release(): void {
    if (this.#released) throw new CanonicalPostgresError("POSTGRES_RELEASE_FAILED");
    this.#released = true;
    try {
      this.#client.release();
    } catch (error) {
      throw mapPostgresFailure(error, "POSTGRES_RELEASE_FAILED");
    } finally {
      this.#metrics.release();
    }
  }
}

function normalizePostgresRow(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    normalizePostgresValue(value),
  ])));
}

/** node-postgres returns typed timestamp values as Date objects. */
function normalizePostgresValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function parseConnectionUrl(connectionUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(connectionUrl);
  } catch {
    throw new CanonicalPostgresError("POSTGRES_TARGET_REQUIRED");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)
      || parsed.username === "" || parsed.password === ""
      || parsed.hash !== "" || parsed.search !== "") {
    throw new CanonicalPostgresError("POSTGRES_TARGET_REQUIRED");
  }
  return parsed;
}

function targetFromUrl(parsed: URL): NodePostgresTargetDescriptor {
  const normalizedHost = LOOPBACK_HOSTS.get(parsed.hostname.toLowerCase() as "127.0.0.1" | "localhost" | "::1" | "[::1]");
  if (!normalizedHost) throw new CanonicalPostgresError("POSTGRES_TARGET_NOT_LOOPBACK");
  let database: string;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  } catch {
    throw new CanonicalPostgresError("POSTGRES_TARGET_NOT_DISPOSABLE");
  }
  if (!DISPOSABLE_DATABASE.test(database)) {
    throw new CanonicalPostgresError("POSTGRES_TARGET_NOT_DISPOSABLE");
  }
  const port = parsed.port === "" ? 5432 : Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new CanonicalPostgresError("POSTGRES_TARGET_REQUIRED");
  }
  const suffix = database.slice("tivdoc_v09_".length).replaceAll("_", "-");
  return Object.freeze({
    target_id: `tivdoc-v09-${suffix}`,
    host: normalizedHost,
    port,
    database,
    disposable: true,
    validation: "LOOPBACK_DISPOSABLE_VALIDATED",
  });
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  code: "POSTGRES_TARGET_REQUIRED",
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CanonicalPostgresError(code);
  }
  return value;
}

function sameTarget(left: NodePostgresTargetDescriptor, right: NodePostgresTargetDescriptor): boolean {
  return left.target_id === right.target_id
    && left.host === right.host
    && left.port === right.port
    && left.database === right.database
    && left.disposable === right.disposable
    && left.validation === right.validation;
}

function defaultPoolFactory(config: PoolConfig): NodePostgresPool {
  return new Pool(config) as unknown as NodePostgresPool;
}
