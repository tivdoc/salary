import { describe, expect, it } from "vitest";
import { createInternalOpsHttpAdapter } from "./http.ts";
import { disabledInternalOpsFlags, type InternalOpsFlagSnapshot } from "./flags.ts";
import { INTERNAL_OPS_SCHEMA_VERSION } from "./contracts.ts";
import { InternalOpsService } from "./service.ts";
import { createSyntheticOpsFixture } from "./synthetic-test-fixture.ts";

const HASH = Object.freeze({ a: "a".repeat(64), b: "b".repeat(64), c: "c".repeat(64), d: "d".repeat(64), f: "f".repeat(64) });
const CORRELATION = "test:correlation:0001";

function flags(overrides: Partial<InternalOpsFlagSnapshot> = {}): InternalOpsFlagSnapshot {
  return Object.freeze({ ...disabledInternalOpsFlags(), TIVDOC_INTERNAL_OPS_API_ENABLED: true, ...overrides });
}

function harness(overrides: Partial<InternalOpsFlagSnapshot> = {}) {
  const fixture = createSyntheticOpsFixture("test");
  const activeFlags = flags(overrides);
  const service = new InternalOpsService({ ports: fixture.ports, flags: activeFlags, now: () => "2030-02-01T10:00:00.000Z" });
  return { fixture, adapter: createInternalOpsHttpAdapter({ service, flags: activeFlags }) };
}

function request(path: string, body?: unknown) {
  return new Request(`http://localhost/api/internal-ops-v07/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), "x-correlation-id": CORRELATION },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function command(action: string, caseId: string, expectedRevision = 4, extra: Record<string, unknown> = {}, key = `idem-${action}-0001`) {
  return {
    schema_version: INTERNAL_OPS_SCHEMA_VERSION,
    command_id: `cmd-${action}-0001`,
    idempotency_key: key,
    expected_revision: expectedRevision,
    reason: "synthetic acceptance decision",
    payload: { action, case_id: caseId, ...extra },
  };
}

describe("V07-P5-OPS-API", () => {
  it("returns a non-disclosing 404 while disabled", async () => {
    const response = await createInternalOpsHttpAdapter({ service: null, flags: disabledInternalOpsFlags() }).handle(request("capabilities"), ["capabilities"]);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("exposes no backend details when enabled without P1/P2 ports", async () => {
    const response = await createInternalOpsHttpAdapter({ service: null, flags: flags() }).handle(request("capabilities"), ["capabilities"]);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, code: "OPS_BACKEND_UNAVAILABLE", correlation_id: CORRELATION, retryable: true });
  });

  it("enforces the role matrix before reaching a mutation port", async () => {
    const { fixture, adapter } = harness();
    fixture.setRole("fact_reviewer");
    const response = await adapter.handle(request(`cases/${fixture.caseId}/payment/reconcile`, command("payment_reconcile", fixture.caseId, 4, { payment_reference_sha256: HASH.a })), ["cases", fixture.caseId, "payment", "reconcile"]);
    expect(response.status).toBe(403);
    expect(fixture.mutationCount()).toBe(0);
  });

  it("rejects stale revisions and idempotency conflicts with zero extra mutation", async () => {
    const { fixture, adapter } = harness();
    fixture.setRole("fact_reviewer");
    const payload = command("fact_resolution", fixture.caseId, 3, { facts_snapshot_sha256: HASH.a, fact_ids: ["syn-fact-001"], decision: "confirmed" });
    const stale = await adapter.handle(request(`cases/${fixture.caseId}/facts/resolve`, payload), ["cases", fixture.caseId, "facts", "resolve"]);
    expect(stale.status).toBe(409);
    expect(fixture.mutationCount()).toBe(0);

    const valid = { ...payload, expected_revision: 4 };
    const first = await adapter.handle(request(`cases/${fixture.caseId}/facts/resolve`, valid), ["cases", fixture.caseId, "facts", "resolve"]);
    const replay = await adapter.handle(request(`cases/${fixture.caseId}/facts/resolve`, valid), ["cases", fixture.caseId, "facts", "resolve"]);
    expect(first.status).toBe(200);
    expect((await replay.json()).data.idempotent_replay).toBe(true);
    expect(fixture.mutationCount()).toBe(1);

    const conflict = await adapter.handle(request(`cases/${fixture.caseId}/facts/resolve`, { ...valid, reason: "different synthetic acceptance reason" }), ["cases", fixture.caseId, "facts", "resolve"]);
    expect(conflict.status).toBe(409);
    expect(fixture.mutationCount()).toBe(1);
  });

  it("fails closed on unsafe paths, filenames, script input and forbidden endpoints", async () => {
    const { fixture, adapter } = harness();
    fixture.setRole("intake_operator");
    expect((await adapter.handle(request("../audit"), ["..", "audit"])).status).toBe(404);
    expect((await adapter.handle(request(`cases/${fixture.caseId}/deliver`, {}), ["cases", fixture.caseId, "deliver"])).status).toBe(404);
    const unsafe = command("document_reference_add", fixture.caseId, 4, { object_version_id: "syn-object-002", object_sha256: HASH.a, byte_length: 100, detected_mime: "application/pdf", filename: "../../private.pdf" });
    expect((await adapter.handle(request(`cases/${fixture.caseId}/documents`, unsafe), ["cases", fixture.caseId, "documents"])).status).toBe(400);
    const scriptReason = { ...unsafe, reason: "<script>alert(1)</script>" };
    expect((await adapter.handle(request(`cases/${fixture.caseId}/documents`, scriptReason), ["cases", fixture.caseId, "documents"])).status).toBe(400);
    expect(fixture.mutationCount()).toBe(0);
  });
});

describe("V07-P5-OPS-E2E", () => {
  it("runs the seven-topic synthetic readiness journey through the canonical evaluator", async () => {
    const { fixture, adapter } = harness({ TIVDOC_SYNTHETIC_OPS_ENABLED: true });
    fixture.setRole("legal_reviewer");
    const response = await adapter.handle(request(`cases/${fixture.caseId}/readiness`), ["cases", fixture.caseId, "readiness"]);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.topics).toHaveLength(7);
    expect(body.data.topics.every((topic: { status: string; decision_source: string; blocker_codes: string[] }) => topic.status === "READY" && topic.decision_source === "evaluateLegalReadiness" && topic.blocker_codes.length === 0)).toBe(true);
  });

  it("keeps the real-data-shaped journey blocked and never renders missing topics as zero", async () => {
    const { fixture, adapter } = harness({ TIVDOC_CUSTOMER_PROCESSING_ENABLED: true });
    fixture.setRealBlocked();
    fixture.setRole("legal_reviewer");
    const readiness = await (await adapter.handle(request(`cases/${fixture.caseId}/readiness`), ["cases", fixture.caseId, "readiness"])).json();
    const analysis = await (await adapter.handle(request(`cases/${fixture.caseId}/analysis`), ["cases", fixture.caseId, "analysis"])).json();
    expect(readiness.data.topics).toHaveLength(7);
    expect(readiness.data.topics.every((topic: { status: string; blocker_codes: string[] }) => topic.status === "BLOCKED_NOT_READY" && topic.blocker_codes.length > 0)).toBe(true);
    expect(analysis.data.runs[0]).toMatchObject({ status: "blocked", known_subtotal_minor_units: null, coverage_complete: false });
  });

  it("places refunded payment evidence on hold and invalidates approvals", async () => {
    const { fixture, adapter } = harness();
    fixture.setPaymentAdverse();
    fixture.setRole("intake_operator");
    const response = await adapter.handle(request(`cases/${fixture.caseId}/payment/reconcile`, command("payment_reconcile", fixture.caseId, 4, { payment_reference_sha256: HASH.a })), ["cases", fixture.caseId, "payment", "reconcile"]);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.state).toBe("release_hold");
    expect(body.data.invalidation_codes).toContain("PAYMENT_REFUNDED");
  });

  it("requires an exact current report hash and approval receipt before local export", async () => {
    const { fixture, adapter } = harness({ TIVDOC_MANUAL_REPORT_EXPORT_ENABLED: true });
    fixture.setRole("report_approver");
    const wrong = command("report_approve", fixture.caseId, 4, { report_id: "syn-report-001", report_revision: 4, report_sha256: HASH.c, analysis_result_sha256: HASH.d, decision: "approved" });
    expect((await adapter.handle(request(`cases/${fixture.caseId}/report/approve`, wrong), ["cases", fixture.caseId, "report", "approve"])).status).toBe(409);
    expect(fixture.mutationCount()).toBe(0);

    const approve = command("report_approve", fixture.caseId, 4, { report_id: "syn-report-001", report_revision: 4, report_sha256: HASH.a, analysis_result_sha256: HASH.f, decision: "approved" });
    expect((await adapter.handle(request(`cases/${fixture.caseId}/report/approve`, approve), ["cases", fixture.caseId, "report", "approve"])).status).toBe(200);
    const exportCommand = command("report_manual_export", fixture.caseId, 5, { report_id: "syn-report-001", report_revision: 4, report_sha256: HASH.a, approval_receipt_sha256: HASH.b, format: "pdf", destination: "local_operator_download" });
    const exported = await adapter.handle(request(`cases/${fixture.caseId}/report/export`, exportCommand), ["cases", fixture.caseId, "report", "export"]);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toBe("application/pdf");
    expect(exported.headers.get("x-tivdoc-artifact-sha256")).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.from(await exported.arrayBuffer()).toString("utf8")).toContain("%PDF-1.7");
    expect(fixture.mutationCount()).toBe(2);
  });
});
