import { describe, expect, it } from "vitest";
import type { PortalRequestIdentityPort } from "./contracts";
import { createPortalApi } from "./api";
import { createHarness, seedEvidenceAndReport } from "./test-fixtures";

function context(...resource: string[]) { return { params: Promise.resolve({ resource }) }; }

function request(method: "GET" | "POST", body?: unknown, actor = "a", csrf = true): Request {
  const headers: Record<string, string> = { "x-synthetic-actor": actor };
  if (csrf) headers["x-synthetic-csrf"] = "valid";
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request("https://local.invalid/portal", { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

function apiHarness() {
  const harness = createHarness();
  const identity: PortalRequestIdentityPort = {
    async verify(input) {
      const actor = input.headers.get("x-synthetic-actor") === "b" ? harness.ownerB : harness.ownerA;
      return { actor, csrf_valid: input.headers.get("x-synthetic-csrf") === "valid" };
    },
  };
  return { ...harness, api: createPortalApi(harness.service, identity) };
}

describe("portal API boundary", () => {
  it("returns the same empty 404 for cross-owner and unknown case enumeration", async () => {
    const { api } = apiHarness();
    const crossOwner = await api.GET(request("GET", undefined, "b"), context("case", "synthetic-case-a"));
    const unknown = await api.GET(request("GET"), context("case", "synthetic-case-unknown"));
    expect(crossOwner.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await crossOwner.text()).toBe("");
    expect(await unknown.text()).toBe("");
    expect([...crossOwner.headers]).toEqual([...unknown.headers]);
  });

  it("requires verified CSRF and rejects client entitlement fields", async () => {
    const { api } = apiHarness();
    const noCsrf = await api.POST(request("POST", {
      consent_version: "consent-1", terms_version: "terms-1", granted: true, idempotency_key: "consent-key-0004",
    }, "a", false), context("case", "synthetic-case-a", "consent"));
    expect(noCsrf.status).toBe(404);

    const forged = await api.POST(request("POST", { amount: "synthetic", product_flag: true }), context("case", "synthetic-case-a", "reports", "synthetic-report", "grant"));
    expect(forged.status).toBe(400);
    expect(await forged.json()).toEqual({ error: "invalid_request" });
  });

  it("records revisioned consent and privacy commands through strict JSON", async () => {
    const { api } = apiHarness();
    const consentBody = { consent_version: "consent-1", terms_version: "terms-1", granted: true, idempotency_key: "consent-key-0005" };
    const consent = await api.POST(request("POST", consentBody), context("case", "synthetic-case-a", "consent"));
    expect(consent.status).toBe(200);
    expect((await consent.json()).consent.revision).toBe(1);
    const replay = await api.POST(request("POST", consentBody), context("case", "synthetic-case-a", "consent"));
    expect((await replay.json()).idempotent_replay).toBe(true);
    const privacy = await api.POST(request("POST", { request_kind: "correction", idempotency_key: "privacy-key-0003" }), context("case", "synthetic-case-a", "privacy"));
    expect(privacy.status).toBe(200);
    expect((await privacy.json()).request.status).toBe("requested");
  });

  it("downloads only a short-lived exact released artifact with private headers", async () => {
    const { api, repository } = apiHarness();
    const report = seedEvidenceAndReport(repository, { edition: "full_reviewed_report" });
    const grantResponse = await api.POST(request("POST", {}), context("case", "synthetic-case-a", "reports", report.report_id, "grant"));
    expect(grantResponse.status).toBe(200);
    const grant = await grantResponse.json();
    const download = await api.POST(request("POST", grant), context("reports", "download"));
    expect(download.status).toBe(200);
    expect(download.headers.get("cache-control")).toBe("private, no-store");
    expect(download.headers.get("content-disposition")).toMatch(/^attachment; filename="tivdoc-report-[0-9a-f]{12}-r1\.pdf"$/);
    expect(new TextDecoder().decode(await download.arrayBuffer())).toContain("synthetic-pdf-artifact");
  });

  it("caps JSON size and accepts invite only once without identity", async () => {
    const { api, repository } = apiHarness();
    const invite = repository.createInvite({ invite_id: "synthetic-api-invite", case_id: "synthetic-case-a", owner_actor_id: "synthetic-owner-a", audience: "portal-v07", expires_at: "2030-01-01T00:10:00.000Z", synthetic_secret: "local-secret" });
    const accepted = await api.POST(new Request("https://local.invalid", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: invite.token, audience: "portal-v07" }) }), context("invite", "accept"));
    expect(accepted.status).toBe(200);
    const replay = await api.POST(new Request("https://local.invalid", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: invite.token, audience: "portal-v07" }) }), context("invite", "accept"));
    expect(replay.status).toBe(404);
    const oversized = await api.POST(request("POST", { token: "x".repeat(17_000), audience: "portal-v07" }), context("invite", "accept"));
    expect(oversized.status).toBe(400);
  });
});
