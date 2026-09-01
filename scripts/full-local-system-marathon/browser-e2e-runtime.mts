export const MARATHON_BROWSER_SESSION_COOKIE = "tivdoc_hermetic_session" as const;
export const MARATHON_BROWSER_RUNTIME_SENTINEL = "TIVDOC_HERMETIC_LOOPBACK_E2E_V0101" as const;
export const MARATHON_BROWSER_BASE_URL = "http://127.0.0.1:45123" as const;

type Environment = Readonly<Record<string, string | undefined>>;

const SAFE_CHILD_ENVIRONMENT_KEYS = Object.freeze([
  "ALLUSERSPROFILE", "APPDATA", "CI", "COMSPEC", "CommonProgramFiles", "CommonProgramFiles(x86)",
  "CommonProgramW6432", "HOMEDRIVE", "HOMEPATH", "LANG", "LC_ALL", "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS", "OS", "Path", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "ProgramData",
  "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "SystemDrive", "SystemRoot", "TEMP", "TMP", "TZ",
  "USERPROFILE", "windir",
] as const);

export const MARATHON_BROWSER_SERVER_ARGS = Object.freeze([
  "dev",
  "--webpack",
  "--hostname",
  "127.0.0.1",
  "--port",
  "45123",
] as const);

export const MARATHON_BROWSER_ROUTES = Object.freeze([
  Object.freeze({ id: "home", path: "/", audience: null, ticket: null }),
  Object.freeze({ id: "portal", path: "/portal", audience: "portal", ticket: "v010-marathon-owner-ticket-0001" }),
  Object.freeze({ id: "operations", path: "/operations", audience: "operations", ticket: "v010-marathon-legal-ticket-0001" }),
] as const);

const CASE_ID = "fb376586-bf37-4cec-8663-9a4065b10b7d";
const ACTOR_BASE = Object.freeze({
  tenant_id: "tenant01",
  assigned_case_ids: Object.freeze([CASE_ID]),
  verified_server_side: true,
  break_glass_reason: null,
  break_glass_expires_at: null,
});
const TICKETS = Object.freeze({
  "v010-marathon-owner-ticket-0001": Object.freeze({
    audience: "portal",
    actor: Object.freeze({ ...ACTOR_BASE, actor_id: "owner-a-01", role: "customer_owner" }),
  }),
  "v010-marathon-legal-ticket-0001": Object.freeze({
    audience: "operations",
    actor: Object.freeze({ ...ACTOR_BASE, actor_id: "legal-reviewer-01", role: "legal_reviewer" }),
  }),
});

export function marathonBrowserServerEnvironment(
  environment: Environment = process.env,
): NodeJS.ProcessEnv {
  return {
    ...marathonBrowserToolEnvironment(environment),
    NODE_ENV: "test",
    VERCEL_ENV: "",
    TIVDOC_HERMETIC_MODE: "true",
    TIVDOC_PRODUCT_BROWSER_RUNTIME_ENABLED: "true",
    TIVDOC_PRODUCT_BROWSER_RUNTIME_SENTINEL: MARATHON_BROWSER_RUNTIME_SENTINEL,
    TIVDOC_PRODUCT_BROWSER_RUNTIME_ORIGIN: MARATHON_BROWSER_BASE_URL,
    TIVDOC_PRODUCT_E2E_LANE: "synthetic",
    TIVDOC_PRODUCT_SESSION_SECRET: "v010-marathon-hermetic-session-key-material-00000001",
    TIVDOC_PRODUCT_SESSION_MAX_AGE_SECONDS: "900",
    TIVDOC_PRODUCT_HERMETIC_TICKETS_JSON: JSON.stringify(TICKETS),
    TIVDOC_PORTAL_UI_ENABLED: "true",
    TIVDOC_PORTAL_API_ENABLED: "true",
    TIVDOC_OPERATIONS_UI_ENABLED: "true",
    TIVDOC_OPERATIONS_API_ENABLED: "true",
  };
}

export function marathonBrowserToolEnvironment(
  environment: Environment = process.env,
): NodeJS.ProcessEnv {
  const safe: Record<string, string> = {};
  for (const key of SAFE_CHILD_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined) safe[key] = value;
  }
  return {
    ...safe,
    CI: "1",
    NODE_ENV: "test",
    NEXT_TELEMETRY_DISABLED: "1",
    OPENAI_API_KEY: "",
    TIVDOC_OPENAI_LIVE_TESTS: "0",
    TIVDOC_CUSTOMER_PROCESSING_ENABLED: "0",
    TIVDOC_CUSTOMER_SHADOW_AUTHORIZED: "0",
    TIVDOC_PRODUCTION_DELIVERY_ENABLED: "0",
    TIVDOC_RUNTIME_TARGET: "local_only",
  };
}

export function extractMarathonBrowserSessionCookie(setCookie: string | null): string {
  const value = setCookie?.match(/^tivdoc_hermetic_session=([A-Za-z0-9_.-]{40,4096})(?:;|$)/u)?.[1];
  if (!value) throw new Error("BROWSER_E2E_SESSION_COOKIE_MISSING");
  return value;
}
