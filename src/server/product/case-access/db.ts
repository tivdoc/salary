// UX Run 1 / U2. The one seam between the access service and its store: every
// operation is a SQL function of migration 202609050001, called by name with
// named arguments. In production the call is a PostgREST rpc through the
// service role, exactly as the MVP's payment functions are called; on the
// local runtime it is a `pg` call as the web runtime role. The service never
// sees which, and a test hands it a fake.
import "server-only";

export type CaseAccessDb = Readonly<{
  provider: "supabase" | "postgres" | "fake";
  rpc<T = Record<string, unknown>>(fn: string, args: Readonly<Record<string, unknown>>): Promise<readonly T[]>;
}>;

const FUNCTION_NAME = /^case_(?:access|notification)_[a-z_]+$/u;

export function supabaseCaseAccessDb(client: {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}): CaseAccessDb {
  return Object.freeze({
    provider: "supabase" as const,
    async rpc<T>(fn: string, args: Readonly<Record<string, unknown>>): Promise<readonly T[]> {
      if (!FUNCTION_NAME.test(fn)) throw new Error(`CASE_ACCESS_DB_FUNCTION_UNKNOWN:${fn}`);
      const result = await client.rpc(fn, { ...args });
      if (result.error) throw Object.assign(new Error(`CASE_ACCESS_DB_RPC_FAILED:${fn}`), { code: result.error.code ?? "rpc_failed" });
      const data = result.data;
      if (Array.isArray(data)) return data as T[];
      if (data === null || data === undefined) return [];
      // A scalar-returning function comes back as its value; the service reads it as { value }.
      return [{ value: data } as unknown as T];
    },
  });
}

type PgPoolLike = { query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }> };

export function postgresCaseAccessDb(pool: PgPoolLike): CaseAccessDb {
  return Object.freeze({
    provider: "postgres" as const,
    async rpc<T>(fn: string, args: Readonly<Record<string, unknown>>): Promise<readonly T[]> {
      if (!FUNCTION_NAME.test(fn)) throw new Error(`CASE_ACCESS_DB_FUNCTION_UNKNOWN:${fn}`);
      const names = Object.keys(args);
      for (const name of names) if (!/^[a-z_]+$/u.test(name)) throw new Error(`CASE_ACCESS_DB_ARGUMENT_UNKNOWN:${name}`);
      const placeholders = names.map((name, index) => `${name} => $${index + 1}`).join(", ");
      const result = await pool.query(`select * from public.${fn}(${placeholders})`, names.map((name) => args[name]));
      return result.rows.map((row) => {
        // A scalar-returning function yields one column named after the function; expose it as { value }.
        const record = row as Record<string, unknown>;
        const keys = Object.keys(record);
        return (keys.length === 1 && keys[0] === fn ? { value: record[fn] } : record) as T;
      });
    },
  });
}

let pool: PgPoolLike | null = null;
let poolUrl: string | null = null;

async function postgresPool(connectionString: string): Promise<PgPoolLike> {
  if (pool && poolUrl === connectionString) return pool;
  const { default: pg } = await import("pg");
  const created = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 20_000, application_name: "tivdoc_case_access" });
  pool = created;
  poolUrl = connectionString;
  return created;
}

let override: CaseAccessDb | null = null;

/** Tests and the access journey install their store here; production never calls this. */
export function installCaseAccessDbForTests(db: CaseAccessDb | null): void {
  override = db;
}

/**
 * The store for this process: the Supabase service role when the product is
 * configured for it (production), the web runtime role's Postgres URL on the
 * local runtime, or nothing — in which case the caller answers as if the
 * store were empty and records the send as failed rather than throwing.
 */
export async function resolveCaseAccessDb(): Promise<CaseAccessDb | null> {
  if (override) return override;
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const { getSupabaseAdmin } = await import("@/lib/supabase-admin");
    return supabaseCaseAccessDb(getSupabaseAdmin());
  }
  const url = process.env.TIVDOC_WEB_POSTGRES_URL;
  if (url) return postgresCaseAccessDb(await postgresPool(url));
  return null;
}
