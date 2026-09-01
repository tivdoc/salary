import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MARATHON_BROWSER_BASE_URL,
  MARATHON_BROWSER_ROUTES,
  MARATHON_BROWSER_RUNTIME_SENTINEL,
  MARATHON_BROWSER_SERVER_ARGS,
  extractMarathonBrowserSessionCookie,
  isHermeticBrowserDocumentResponse,
  marathonBrowserServerEnvironment,
  marathonBrowserToolEnvironment,
} from "../../../scripts/full-local-system-marathon/browser-e2e-runtime.mts";
import { hermeticBrowserRuntimeBootstrapEnabled } from "../../instrumentation.ts";

describe("V0.10 marathon browser runtime preflight", () => {
  it("starts the canonical synthetic browser runtime in hermetic test mode", () => {
    const environment = marathonBrowserServerEnvironment({
      NODE_ENV: "production",
      OPENAI_API_KEY: "must-be-cleared",
      TIVDOC_CUSTOMER_PROCESSING_ENABLED: "1",
      TIVDOC_CUSTOMER_SHADOW_AUTHORIZED: "1",
      TIVDOC_PRODUCTION_DELIVERY_ENABLED: "1",
    });

    expect(MARATHON_BROWSER_SERVER_ARGS).toEqual([
      "dev", "--webpack", "--hostname", "127.0.0.1", "--port", "45123",
    ]);
    expect(environment).toMatchObject({
      NODE_ENV: "test",
      VERCEL_ENV: "",
      TIVDOC_HERMETIC_MODE: "true",
      TIVDOC_PRODUCT_BROWSER_RUNTIME_ENABLED: "true",
      TIVDOC_PRODUCT_BROWSER_RUNTIME_SENTINEL: MARATHON_BROWSER_RUNTIME_SENTINEL,
      TIVDOC_PRODUCT_BROWSER_RUNTIME_ORIGIN: MARATHON_BROWSER_BASE_URL,
      TIVDOC_PRODUCT_E2E_LANE: "synthetic",
      TIVDOC_PORTAL_UI_ENABLED: "true",
      TIVDOC_PORTAL_API_ENABLED: "true",
      TIVDOC_OPERATIONS_UI_ENABLED: "true",
      TIVDOC_OPERATIONS_API_ENABLED: "true",
      OPENAI_API_KEY: "",
      TIVDOC_OPENAI_LIVE_TESTS: "0",
      TIVDOC_CUSTOMER_PROCESSING_ENABLED: "0",
      TIVDOC_CUSTOMER_SHADOW_AUTHORIZED: "0",
      TIVDOC_PRODUCTION_DELIVERY_ENABLED: "0",
      TIVDOC_RUNTIME_TARGET: "local_only",
    });
    expect(hermeticBrowserRuntimeBootstrapEnabled(environment, "nodejs")).toBe(true);
    expect(JSON.parse(environment.TIVDOC_PRODUCT_HERMETIC_TICKETS_JSON!)).toMatchObject({
      "v010-marathon-owner-ticket-0001": { audience: "portal", actor: { role: "customer_owner" } },
      "v010-marathon-legal-ticket-0001": { audience: "operations", actor: { role: "legal_reviewer" } },
    });
    expect(MARATHON_BROWSER_ROUTES.map(({ id, audience }) => ({ id, audience }))).toEqual([
      { id: "home", audience: null },
      { id: "portal", audience: "portal" },
      { id: "operations", audience: "operations" },
    ]);
  });

  it("pre-gates the browser runtime to the explicit test sentinel and exact loopback origin", () => {
    const environment = marathonBrowserServerEnvironment();
    expect(hermeticBrowserRuntimeBootstrapEnabled({ ...environment, TIVDOC_PRODUCT_BROWSER_RUNTIME_ENABLED: "false" }, "nodejs")).toBe(false);
    expect(hermeticBrowserRuntimeBootstrapEnabled(environment, "edge")).toBe(false);
    expect(() => hermeticBrowserRuntimeBootstrapEnabled({ ...environment, NODE_ENV: "development" }, "nodejs"))
      .toThrow("BROWSER_RUNTIME_BOOTSTRAP_ENVIRONMENT_FORBIDDEN");
    expect(() => hermeticBrowserRuntimeBootstrapEnabled({ ...environment, NODE_ENV: "production" }, "nodejs"))
      .toThrow("BROWSER_RUNTIME_BOOTSTRAP_ENVIRONMENT_FORBIDDEN");
    expect(() => hermeticBrowserRuntimeBootstrapEnabled({ ...environment, VERCEL_ENV: "preview" }, "nodejs"))
      .toThrow("BROWSER_RUNTIME_BOOTSTRAP_ENVIRONMENT_FORBIDDEN");
    expect(() => hermeticBrowserRuntimeBootstrapEnabled({ ...environment, TIVDOC_PRODUCT_BROWSER_RUNTIME_SENTINEL: "wrong" }, "nodejs"))
      .toThrow("BROWSER_RUNTIME_BOOTSTRAP_SENTINEL_INVALID");
    expect(() => hermeticBrowserRuntimeBootstrapEnabled({ ...environment, TIVDOC_PRODUCT_BROWSER_RUNTIME_ORIGIN: "http://0.0.0.0:45123" }, "nodejs"))
      .toThrow("BROWSER_RUNTIME_BOOTSTRAP_ORIGIN_FORBIDDEN");
    expect(() => hermeticBrowserRuntimeBootstrapEnabled({ ...environment, TIVDOC_PRODUCT_BROWSER_RUNTIME_ORIGIN: "http://127.0.0.1:45123/?leak=true" }, "nodejs"))
      .toThrow("BROWSER_RUNTIME_BOOTSTRAP_ORIGIN_FORBIDDEN");
    expect(() => hermeticBrowserRuntimeBootstrapEnabled({ ...environment, TIVDOC_CUSTOMER_PROCESSING_ENABLED: "1" }, "nodejs"))
      .toThrow("BROWSER_RUNTIME_BOOTSTRAP_FLAGS_INVALID");
  });

  it("passes only operating-system essentials into browser child processes", () => {
    const inherited = {
      Path: "C:\\Windows\\System32",
      TEMP: "C:\\Temp",
      DATABASE_URL: "postgres://must-not-pass",
      SUPABASE_SERVICE_ROLE_KEY: "must-not-pass",
      OPENAI_API_KEY: "must-be-cleared",
      NODE_OPTIONS: "--require must-not-pass",
    };
    const tool = marathonBrowserToolEnvironment(inherited);
    const server = marathonBrowserServerEnvironment(inherited);
    expect(tool).toMatchObject({ Path: inherited.Path, TEMP: inherited.TEMP, OPENAI_API_KEY: "", CI: "1" });
    expect(server).toMatchObject({ Path: inherited.Path, TEMP: inherited.TEMP, NODE_ENV: "test" });
    for (const candidate of [tool, server]) {
      expect(candidate.DATABASE_URL).toBeUndefined();
      expect(candidate.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
      expect(candidate.NODE_OPTIONS).toBeUndefined();
    }
  });

  it("keeps compiler-folded NODE_ENV and test providers out of ordinary startup", () => {
    const root = resolve(process.cwd());
    const instrumentation = readFileSync(resolve(root, "src/instrumentation.ts"), "utf8");
    const claims = readFileSync(resolve(root, "src/server/platform/auth/claims.ts"), "utf8");
    const sessions = readFileSync(resolve(root, "src/server/product/auth/hermetic-session.ts"), "utf8");
    const browserRuntime = readFileSync(resolve(root, "scripts/full-local-system-marathon/browser-e2e-runtime.mts"), "utf8");
    const browserRunner = readFileSync(resolve(root, "scripts/full-local-system-marathon/browser-e2e.mts"), "utf8");
    expect(instrumentation).not.toContain("process.env.NODE_ENV");
    expect(claims).not.toContain("process.env.NODE_ENV");
    expect(sessions).not.toContain("process.env.NODE_ENV");
    expect(instrumentation).toContain("Reflect.get(environment, key)");
    expect(claims).toContain("Reflect.get(process.env, key)");
    expect(sessions).toContain("Reflect.get(environment, key)");
    const register = instrumentation.slice(instrumentation.indexOf("export async function register"));
    expect(register.indexOf("hermeticBrowserRuntimeBootstrapEnabled()")).toBeLessThan(register.indexOf("await import("));
    expect(browserRuntime).not.toContain("...environment");
    expect(browserRunner).toContain("function safeEnvironment()");
  });

  it("accepts only a bounded signed-session cookie shape", () => {
    const token = `${"a".repeat(48)}.${"b".repeat(43)}`;
    expect(extractMarathonBrowserSessionCookie(`tivdoc_hermetic_session=${token}; Path=/; HttpOnly; SameSite=Strict`)).toBe(token);
    expect(() => extractMarathonBrowserSessionCookie("other=value; Path=/")).toThrow("BROWSER_E2E_SESSION_COOKIE_MISSING");
  });

  it("accepts only the exact hermetic document cache policies with CSP", () => {
    const headers = (cacheControl: string, csp = "default-src 'self'") => new Headers({
      "cache-control": cacheControl,
      "content-security-policy": csp,
    });
    expect(isHermeticBrowserDocumentResponse(headers("private, no-store, max-age=0"))).toBe(true);
    expect(isHermeticBrowserDocumentResponse(headers("no-cache, must-revalidate"))).toBe(true);
    expect(isHermeticBrowserDocumentResponse(headers("public, max-age=3600"))).toBe(false);
    expect(isHermeticBrowserDocumentResponse(new Headers({ "cache-control": "no-cache, must-revalidate" }))).toBe(false);
  });
});
