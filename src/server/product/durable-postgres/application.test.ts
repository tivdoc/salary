import { describe, expect, it, vi } from "vitest";

import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";
import type { CanonicalApplicationPostgresComposition } from "../../platform/composition/canonical-postgres-application.ts";
import {
  DurableProductPostgresApplication,
  __durableProductTest,
  createSyntheticDurableReport,
} from "./application.ts";
import {
  DURABLE_PRODUCT_BLOCKERS,
  DURABLE_PRODUCT_CAPABILITIES,
} from "./contracts.ts";

const TENANT = "tenant_w2_synthetic";
const CASE = "case_w2_synthetic";

function actor(role: VerifiedActor["role"], assigned = [CASE]): VerifiedActor {
  return Object.freeze({
    actor_id: `actor_${role}`,
    role,
    tenant_id: TENANT,
    assigned_case_ids: Object.freeze(assigned),
    verified_server_side: true,
    break_glass_reason: null,
    break_glass_expires_at: null,
  });
}

function isolated(transaction = vi.fn()): CanonicalApplicationPostgresComposition {
  return Object.freeze({
    mode: "isolated_postgres" as const,
    durable: true as const,
    target_id: "tivdoc-v09-test-only",
    schema_version: "tivdoc-canonical-postgresql-v0.9.0" as const,
    transaction,
  }) as CanonicalApplicationPostgresComposition;
}

describe("W2 durable PostgreSQL product boundary", () => {
  it("fails closed for disabled and memory-only compositions", () => {
    expect(() => new DurableProductPostgresApplication(Object.freeze({
      mode: "disabled",
      durable: false,
      reason: "PERSISTENCE_DISABLED",
    }))).toThrow("PERSISTENCE_DISABLED");
    expect(() => new DurableProductPostgresApplication(Object.freeze({
      mode: "memory_test_only",
      durable: false,
      test_only: true,
      bundle: Object.freeze({}),
    }) as unknown as CanonicalApplicationPostgresComposition)).toThrow("PERSISTENCE_DISABLED");
  });

  it("declares exactly zero product-reachable memory fallbacks", () => {
    const proof = new DurableProductPostgresApplication(isolated()).proof();
    expect(proof).toMatchObject({
      persistence_mode: "isolated_postgres",
      durable: true,
      product_reachable_memory_fallbacks: 0,
    });
    expect(proof.capabilities).toEqual(DURABLE_PRODUCT_CAPABILITIES);
  });

  it("builds deterministic exact-byte synthetic RTL reports without legal activation", () => {
    const left = createSyntheticDurableReport({ report_id: "report_w2_001", report_revision: 1, marker: "marker_w2_001" });
    const right = createSyntheticDurableReport({ report_id: "report_w2_001", report_revision: 1, marker: "marker_w2_001" });
    expect(left).toEqual(right);
    expect(Buffer.from(left.html).toString("utf8")).toContain('dir="rtl"');
    expect(Buffer.from(left.manifest).toString("utf8")).toContain('"legal_rules_activated":0');
    expect(__durableProductTest.byteSha256(left.pdf)).toBe(left.pdf_sha256);
    expect(left.report_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("conceals cross-owner report downloads before opening a transaction", async () => {
    const transaction = vi.fn();
    const application = new DurableProductPostgresApplication(isolated(transaction));
    const report = createSyntheticDurableReport({ report_id: "report_w2_002", report_revision: 1, marker: "marker_w2_002" });
    await expect(application.downloadApprovedPdf({
      tenant_id: TENANT,
      case_id: CASE,
      actor: actor("customer_owner", ["case_other_owner"]),
      report: __durableProductTest.reportReference(report),
    })).rejects.toThrow("DURABLE_PRODUCT_NOT_FOUND");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("requires a verified organization-bound report approver", async () => {
    const transaction = vi.fn();
    const application = new DurableProductPostgresApplication(isolated(transaction));
    const report = createSyntheticDurableReport({ report_id: "report_w2_003", report_revision: 1, marker: "marker_w2_003" });
    await expect(application.approveExactReport({
      tenant_id: TENANT,
      case_id: CASE,
      identity: Object.freeze({
        actor: actor("report_approver"),
        issuer: "issuer.synthetic",
        audience: "operations",
        session_id: "session_w2_001",
        token_id: "token_w2_001",
        rotation_counter: 1,
        reviewer_organization_id: null,
        issued_at_epoch: 1_788_000_000,
        expires_at_epoch: 1_788_000_900,
        product_audience: "operations",
      }),
      report: __durableProductTest.reportReference(report),
      task_id: "review_task_w2_001",
      idempotency_key: "approval_idem_w2_001",
      expected_revision: 1,
      decided_at: "2026-09-01T10:00:00.000Z",
      reason: "Synthetic exact report approval.",
    })).rejects.toThrow("DURABLE_PRODUCT_REVIEWER_ORGANIZATION_REQUIRED");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("publishes exact machine-readable blockers for unsupported frozen-schema claims", () => {
    expect(DURABLE_PRODUCT_BLOCKERS).toHaveLength(5);
    expect(new Set(DURABLE_PRODUCT_BLOCKERS.map((item) => item.blocker_id)).size).toBe(5);
    expect(DURABLE_PRODUCT_BLOCKERS.every((item) => item.safe_behavior === "FAIL_CLOSED")).toBe(true);
    expect(DURABLE_PRODUCT_BLOCKERS.some((item) => item.blocker_id === "W2_PRIVACY_WORKFLOW_SCHEMA_ABSENT")).toBe(true);
    expect(DURABLE_PRODUCT_BLOCKERS.some((item) => item.blocker_id === "W2_RENDERED_NEXT_COMPOSITION_BOOTSTRAP_ABSENT")).toBe(true);
  });
});
