// UX Run 1 / U2. The one seam between the access service and its store: every
// operation is a SQL function of migration 202609050001, called by name with
// named arguments. In production the call is a PostgREST rpc through the
// service role, exactly as the MVP's payment functions are called; on the
// local runtime it is a `pg` call as the web runtime role. The service never
// sees which, and a test hands it a fake.
import { isolatedPreviewDatabase } from './preview-database.ts';
import { SUPABASE_ROOT_2021_CA } from './supabase-ca.ts';

export type CaseAccessDb = Readonly<{
  provider: "supabase" | "postgres" | "fake";
  rpc<T = Record<string, unknown>>(fn: string, args: Readonly<Record<string, unknown>>): Promise<readonly T[]>;
}>;

// The function families this seam will call. It is an allowlist and not a
// convention check: the name is interpolated into SQL by the postgres adapter,
// so anything not matching here never reaches a query. S3.4 added the thread
// (`case_request_*`), the case's documents (`case_documents_list`), S6.1's
// review queue (`case_report_qa_*`), D-11's counters
// (`case_funnel_event_counts`) and S4's abandonment sweep and opt-out
// (`case_abandonment_*`, `case_reminder_*`); a call
// to a family that is not listed is a programming error, not a runtime one.
const FUNCTION_NAME = /^case_(?:access|notification|request|documents|report|order|privacy|funnel|abandonment|reminder)_[a-z_]+$/u;

export function supabaseCaseAccessDb(client: {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}): CaseAccessDb {
  return Object.freeze({
    provider: "supabase" as const,
    async rpc<T>(fn: string, args: Readonly<Record<string, unknown>>): Promise<readonly T[]> {
      if (!FUNCTION_NAME.test(fn)) throw new Error(`CASE_ACCESS_DB_FUNCTION_UNKNOWN:${fn}`);
      const result = await client.rpc(fn, { ...args });
      if (result.error) throw Object.assign(new Error(`CASE_ACCESS_DB_RPC_FAILED:${fn}:${/^(?:UPLOAD|ORDER|PRIVACY|REQUEST)_[A-Z_]+$/u.test(result.error.message ?? "") ? result.error.message : "rpc_failed"}`), { code: result.error.code ?? "rpc_failed" });
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
      for (const name of names) if (!/^[a-z_][a-z0-9_]*$/u.test(name)) throw new Error(`CASE_ACCESS_DB_ARGUMENT_UNKNOWN:${name}`);
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

async function postgresPool(connectionString: string, tls?: Readonly<{ca:string;rejectUnauthorized:true}>): Promise<PgPoolLike> {
  const cacheKey = `${connectionString}:${tls?.ca ?? ""}`;
  if (pool && poolUrl === cacheKey) return pool;
  const { default: pg } = await import("pg");
  const created = new pg.Pool({ connectionString, ...(tls ? {ssl:tls} : {}), max: 2, connectionTimeoutMillis: 20_000, application_name: "tivdoc_case_access" });
  pool = created;
  poolUrl = cacheKey;
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
  const previewUrl = isolatedPreviewDatabase(process.env);
  if (previewUrl) {
    const target = new URL(previewUrl);
    // pg's URL sslmode parsing overrides its ssl object. The selector has
    // already required verify-full; pass the trusted CA/hostname verification
    // explicitly after removing that sole accepted query parameter.
    target.search = '';
    return postgresCaseAccessDb(await postgresPool(target.toString(), {ca:SUPABASE_ROOT_2021_CA,rejectUnauthorized:true}));
  }
  // The durable local runtime uses a separate replay database on DEV. Its
  // Storage API credentials must not silently switch SQL to PostgREST's default database.
  if (process.env.TIVDOC_RUNTIME_TARGET === "local_only" && process.env.TIVDOC_PRODUCT_PERSISTENCE_MODE === "isolated_postgres" && process.env.TIVDOC_WEB_POSTGRES_URL) {
    return postgresCaseAccessDb(await postgresPool(process.env.TIVDOC_WEB_POSTGRES_URL));
  }
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const { getSupabaseAdmin } = await import("../../../lib/supabase-admin.ts");
    return supabaseCaseAccessDb(getSupabaseAdmin());
  }
  const url = process.env.TIVDOC_WEB_POSTGRES_URL;
  if (url) return postgresCaseAccessDb(await postgresPool(url));
  return null;
}

/** Separate server credential for authenticated operations; never fall back to
 * the customer web role in an isolated database. */
let operationsPool:PgPoolLike|null=null;
export async function resolveReportOperationsDb():Promise<CaseAccessDb|null>{
 if(override)return override;
 const url=process.env.TIVDOC_OPERATIONS_POSTGRES_URL;
 if(url){if(!operationsPool){const {default:pg}=await import('pg');operationsPool=new pg.Pool({connectionString:url,max:2,connectionTimeoutMillis:20000,application_name:'tivdoc_report_operations'});}return postgresCaseAccessDb(operationsPool);}
 return null;
}
