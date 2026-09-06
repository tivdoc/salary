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
vi.mock("@/components/check/document-review", () => ({ DocumentReview: () => null }));

const caseId = "22222222-2222-4222-8222-222222222222";

function verifiedCase() {
  return { id: caseId, public_id: "TV-UPLOAD01", email: "u@example.com", phone: null, first_name: null, status: "questionnaire_completed", payment_status: "not_started", created_at: "2026-09-05T09:00:00.000Z", payment_verified: false, contact_verified_at: Date.now(), contact_verified_channel: "email" };
}

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
    installCaseAccessDbForTests(fakeCaseAccessDb([verifiedCase()]));
    cookieJar.set("tivdoc_salary_case", `${caseId}.${createHmac("sha256", process.env.CASE_TOKEN_SECRET!).update(caseId).digest("base64url")}`);
    const { default: UploadPage } = await import("./page.tsx");
    await expect(UploadPage()).resolves.toBeDefined();
    installCaseAccessDbForTests(null);
  });

  // Site S2.4: the customer already answered "I'll find it later". The screen
  // says the case is saved and how long the request stands, instead of asking
  // the same question again.
  it("tells a case that is waiting for a payslip what it is waiting for", async () => {
    const { createHmac } = await import("node:crypto");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { fakeCaseAccessDb } = await import("@/server/product/case-access/fake-db");
    const { installCaseAccessDbForTests } = await import("@/server/product/case-access/db");
    const { beginAwaitingDocument } = await import("@/server/product/reports/awaiting-document");

    const db = fakeCaseAccessDb([verifiedCase()]);
    installCaseAccessDbForTests(db);
    await beginAwaitingDocument(caseId, db);
    cookieJar.set("tivdoc_salary_case", `${caseId}.${createHmac("sha256", process.env.CASE_TOKEN_SECRET!).update(caseId).digest("base64url")}`);

    const { default: UploadPage } = await import("./page.tsx");
    const markup = renderToStaticMarkup(await UploadPage());
    expect(markup).toContain("\u05d4\u05ea\u05d9\u05e7 \u05e9\u05dc\u05da \u05e9\u05de\u05d5\u05e8 \u05d5\u05de\u05de\u05ea\u05d9\u05df \u05dc\u05ea\u05dc\u05d5\u05e9");
    expect(markup).toContain("10");
    installCaseAccessDbForTests(null);
  });

  it("does not say a case is waiting when nothing was asked of it", async () => {
    const { createHmac } = await import("node:crypto");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { fakeCaseAccessDb } = await import("@/server/product/case-access/fake-db");
    const { installCaseAccessDbForTests } = await import("@/server/product/case-access/db");
    installCaseAccessDbForTests(fakeCaseAccessDb([verifiedCase()]));
    cookieJar.set("tivdoc_salary_case", `${caseId}.${createHmac("sha256", process.env.CASE_TOKEN_SECRET!).update(caseId).digest("base64url")}`);
    const { default: UploadPage } = await import("./page.tsx");
    const markup = renderToStaticMarkup(await UploadPage());
    expect(markup).not.toContain("\u05de\u05de\u05ea\u05d9\u05df \u05dc\u05ea\u05dc\u05d5\u05e9");
    installCaseAccessDbForTests(null);
  });
});
