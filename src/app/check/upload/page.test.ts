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

const caseId = "22222222-2222-4222-8222-222222222222";

describe("/check/upload without a case", () => {
  beforeEach(() => {
    cookieJar.clear();
    process.env.CASE_TOKEN_SECRET = ["s1", "test", "secret"].join("-").repeat(3);
  });

  // The first dynamic import of this page pulls the whole review screen's graph (S2's document
  // review, validation, readability). Under the full suite that transform contends with 300+ other
  // files, so the budget is generous on purpose: this test measures a redirect, not import speed.
  it("redirects to /check instead of rendering the file picker", async () => {
    const { default: UploadPage } = await import("./page.tsx");
    await expect(UploadPage()).rejects.toThrow("REDIRECT:/check");
  }, 30_000);

  // External review #1, finding 1: a case whose contact was never verified is sent to the verification step, not to the picker.
  it("redirects an unverified contact to the verification step", async () => {
    const { createHmac } = await import("node:crypto");
    const { fakeCaseAccessDb } = await import("@/server/product/case-access/fake-db");
    const { installCaseAccessDbForTests } = await import("@/server/product/case-access/db");
    installCaseAccessDbForTests(fakeCaseAccessDb([{ id: caseId, public_id: "TV-UPLOAD01", email: "u@example.com", phone: null, first_name: null, status: "questionnaire_completed", payment_status: "not_started", created_at: "2026-09-05T09:00:00.000Z", payment_verified: false }]));
    cookieJar.set("tivdoc_salary_case", `${caseId}.${createHmac("sha256", process.env.CASE_TOKEN_SECRET!).update(caseId).digest("base64url")}`);
    const { default: UploadPage } = await import("./page.tsx");
    await expect(UploadPage()).rejects.toThrow("REDIRECT:/check?verify=1");
    installCaseAccessDbForTests(null);
  });

  it("renders when a signed case cookie names a verified case", async () => {
    const { createHmac } = await import("node:crypto");
    const { fakeCaseAccessDb } = await import("@/server/product/case-access/fake-db");
    const { installCaseAccessDbForTests } = await import("@/server/product/case-access/db");
    installCaseAccessDbForTests(fakeCaseAccessDb([{ id: caseId, public_id: "TV-UPLOAD01", email: "u@example.com", phone: null, first_name: null, status: "questionnaire_completed", payment_status: "not_started", created_at: "2026-09-05T09:00:00.000Z", payment_verified: false, contact_verified_at: Date.now(), contact_verified_channel: "email" }]));
    cookieJar.set("tivdoc_salary_case", `${caseId}.${createHmac("sha256", process.env.CASE_TOKEN_SECRET!).update(caseId).digest("base64url")}`);
    const { default: UploadPage } = await import("./page.tsx");
    await expect(UploadPage()).resolves.toBeDefined();
    installCaseAccessDbForTests(null);
  });
});
