// UX Run 1 / U7 acceptance: /check/upload with no case cookie redirects to
// /check rather than rendering the picker.
import { beforeEach, describe, expect, it, vi } from "vitest";

const cookieJar = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: () => undefined,
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (destination: string) => { throw new Error(`REDIRECT:${destination}`); },
  notFound: () => { throw new Error("NOT_FOUND"); },
}));

vi.mock("@/server/platform/capabilities/stable-next-entrypoint", () => ({
  guardStableAppEntrypoint: async () => ({ outcome: "ALLOW" }),
}));

vi.mock("@/components/check/upload-form", () => ({ UploadForm: () => null }));

describe("/check/upload without a case", () => {
  beforeEach(() => {
    cookieJar.clear();
    process.env.CASE_TOKEN_SECRET = ["s1", "test", "secret"].join("-").repeat(3);
  });

  it("redirects to /check instead of rendering the file picker", async () => {
    const { default: UploadPage } = await import("./page.tsx");
    await expect(UploadPage()).rejects.toThrow("REDIRECT:/check");
  });

  it("renders when a signed case cookie is present", async () => {
    const { createHmac } = await import("node:crypto");
    const caseId = "22222222-2222-4222-8222-222222222222";
    const signature = createHmac("sha256", process.env.CASE_TOKEN_SECRET!).update(caseId).digest("base64url");
    cookieJar.set("tivdoc_salary_case", `${caseId}.${signature}`);
    const { default: UploadPage } = await import("./page.tsx");
    await expect(UploadPage()).resolves.toBeDefined();
  });
});
