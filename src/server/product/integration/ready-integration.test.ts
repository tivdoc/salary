import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { pendingDependencies, NO_ELIGIBLE_PUBLIC_FIXTURE } from "./dependency-seams";
import { assertP8ReadyReceipt, runP8ReadyIntegration } from "./ready-integration";
import { createP8Harness, opsEnvelope, opsRequest, verifiedSyntheticActor } from "./ready-harness";

describe("V0.7 P8 ready integration", () => {
  it("runs actual P1/P2/P5/P6/P7 and canonical CaseAnalysis services with declared P3/P4 skips", async () => {
    const receipt = await runP8ReadyIntegration();
    assertP8ReadyReceipt(receipt);
    expect(receipt.overall_status).toBe("READY_PORTION_PASS_WITH_DECLARED_SKIPS");
    expect(receipt.counts.failed).toBe(0);
    expect(receipt.counts.prohibited_actions).toBe(0);
    expect(receipt.checks.filter((item) => item.status === "PASS").map((item) => item.id)).toEqual([
      "V07-P8-SYNTHETIC-READY",
      "V07-P8-CONCURRENCY-FENCING",
      "V07-P8-REVISION-IDEMPOTENCY",
      "V07-P8-PAYMENT-ADVERSE",
      "V07-P8-PORTAL-JOURNEY",
      "V07-P8-ADVERSARIAL-READY",
      "V07-P8-REAL-CORPUS-FAIL-CLOSED",
      "V07-P8-OPERABILITY",
    ]);
    if (process.env.P8_RECEIPT_OUTPUT) {
      await mkdir(dirname(process.env.P8_RECEIPT_OUTPUT), { recursive: true });
      await writeFile(process.env.P8_RECEIPT_OUTPUT, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    }
  }, 30_000);

  it("keeps unavailable dependencies explicit and provenance gated", () => {
    expect(pendingDependencies(NO_ELIGIBLE_PUBLIC_FIXTURE)).toEqual(expect.arrayContaining([
      expect.objectContaining({ lane: "P3", status: "PENDING_NOT_IN_INTEGRATION_BASE" }),
      expect.objectContaining({ lane: "P4", status: "PENDING_NOT_IN_INTEGRATION_BASE" }),
      expect.objectContaining({ lane: "public_fixture", status: "SKIPPED_NO_ELIGIBLE_PROVENANCE" }),
    ]));
  });

  it("rejects a forged header role and production synthetic identities", async () => {
    const harness = await createP8Harness();
    const body = opsEnvelope("case_create", "caseid001", 0, { intake_reference_sha256: "a".repeat(64) }, "forged");
    const request = opsRequest("unknown_session", body, { method: "POST" });
    request.headers.set("x-role", "break_glass_admin");
    const response = await harness.http.handle(request, ["cases"]);
    expect(response.status).toBe(401);
    expect(() => verifiedSyntheticActor({ actor_id: "production01", role: "intake_operator", tenant_id: "tenant01", assigned_case_ids: ["caseid001"], runtime: "production" })).toThrow("TEST_IDENTITY_PRODUCTION_FORBIDDEN");
  });
});
