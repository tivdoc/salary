import { describe, expect, it, vi } from "vitest";
import { POST as createCase } from "./cases/route";
import { POST as startPayment } from "./payments/start/route";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { readCaseIdFromCookie } from "@/lib/case-cookie";
vi.mock("@/lib/meta-capi", () => ({ metaRequestContext: vi.fn(), sendMetaCapiEvent: vi.fn() }));
vi.mock("@/lib/funnel-server", () => ({ recordCaseFunnelEvent: vi.fn() }));
vi.mock("@/lib/invoice4u", () => ({ Invoice4uClient: vi.fn(), invoice4uErrorCode: vi.fn() }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/case-cookie", () => ({ readCaseIdFromCookie: vi.fn(), setCaseCookie: vi.fn() }));
describe("launch availability", () => {
  it.each([["cases", createCase], ["payments/start", startPayment]] as const)("blocks direct %s requests before accessing customer data or providers", async (path, handler) => {
    const request = new Request("https://tivdoc.com/api/" + path, { method: "POST", body: "invalid-json" });
    const response = await handler(request);
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("SERVICE_UNAVAILABLE");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
    expect(readCaseIdFromCookie).not.toHaveBeenCalled();
  });
});
