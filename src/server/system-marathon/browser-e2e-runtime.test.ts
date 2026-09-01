import { describe, expect, it } from "vitest";

import {
  MARATHON_BROWSER_ROUTES,
  MARATHON_BROWSER_SERVER_ARGS,
  extractMarathonBrowserSessionCookie,
  marathonBrowserServerEnvironment,
} from "../../../scripts/full-local-system-marathon/browser-e2e-runtime.mts";

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

  it("accepts only a bounded signed-session cookie shape", () => {
    const token = `${"a".repeat(48)}.${"b".repeat(43)}`;
    expect(extractMarathonBrowserSessionCookie(`tivdoc_hermetic_session=${token}; Path=/; HttpOnly; SameSite=Strict`)).toBe(token);
    expect(() => extractMarathonBrowserSessionCookie("other=value; Path=/")).toThrow("BROWSER_E2E_SESSION_COOKIE_MISSING");
  });
});
