import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { canonicalSha256 } from "../../../src/engine/rule-runtime/canonical.ts";
import {
  createMarathonV010DeterministicFixture,
  MARATHON_V010_DEVELOPMENT_RECEIPT_PATH,
  MARATHON_V010_RUNTIME_BOUNDARY,
  MARATHON_V010_TRUTH_COUNTERS,
} from "./marathon-v010.mts";
import { createSyntheticCapabilityFixtures } from "./synthetic-fixtures.mts";

describe("V0.10 real PostgreSQL delta-matrix contract", () => {
  it("derives one deterministic synthetic fixture from the third capability tenant", () => {
    const state = durableState("m00000001");
    const capability = createSyntheticCapabilityFixtures(state.fixture_suffix);
    const first = createMarathonV010DeterministicFixture(state);
    const second = createMarathonV010DeterministicFixture(state);

    expect(first.identity.tenant_id).toBe(state.tenant_id);
    expect(first.identity.case_id).toBe(state.case_id);
    expect(first.report.report_id).toBe(state.report_id);
    expect(first.report.report_revision).toBe(7);
    expect(first.report.report_sha256).toBe(state.report_sha256);
    expect(first.report.provider_locator).toMatch(/^objects\/[a-f0-9]{2}\/object_[a-f0-9]{48}$/u);
    expect(first.import_command.operation_id).toBe(second.import_command.operation_id);
    expect(first.import_artifact_sha256).toBe(second.import_artifact_sha256);
    expect(Buffer.from(first.import_bytes)).toEqual(Buffer.from(second.import_bytes));
    expect(first.import_artifact_sha256).toBe(sha256(first.import_bytes));
    expect(Buffer.from(first.report_bytes)).toEqual(Buffer.from(capability.report_artifacts.pdf));
    expect(first.report.artifact_sha256).toBe(capability.report_artifacts.pdf_sha256);
    expect(first.report.artifact_sha256).toBe(sha256(first.report_bytes));
    expect(first.report.staged_identity).toMatchObject({
      tenant_id: state.tenant_id,
      case_id: state.case_id,
      case_revision: state.case_revision,
      analysis_run_id: state.analysis_run_id,
      analysis_run_revision: state.case_revision,
      report_id: state.report_id,
      report_revision: state.case_revision,
      report_sha256: state.report_sha256,
      pdf_sha256: capability.report_artifacts.pdf_sha256,
      approval_task_id: state.review_task_id,
      approval_revision: 1,
      download_grant_revision: 0,
    });
    expect(first.report.approved_identity.download_grant_revision).toBe(1);
    expect(first.report.approved_identity.identity_sha256).not.toBe(first.report.staged_identity.identity_sha256);
    expect(first.report.storage_object_id).toBe(first.report.staged_identity.storage_object_id);
    expect(first.report.object_version_id).toBe(first.report.staged_identity.storage_object_version_id);
    expect(first.privacy_revision_1.state).toBe("requested");
    expect(first.privacy_revision_2.state).toBe("acknowledged");
    expect(first.privacy_revision_3.state).toBe("completed_by_authorized_operations");
  });

  it("rejects a tampered durable capability checkpoint before deriving any values", () => {
    const state = durableState("m00000002");
    const tampered = Object.freeze({ ...state, case_id: "case:dynamic:tampered" });
    expect(() => createMarathonV010DeterministicFixture(tampered)).toThrow(
      "MARATHON_V010_DURABLE_STATE_HASH_INVALID",
    );
  });

  it("keeps every prohibited and legal/customer truth counter fail-closed", () => {
    expect(MARATHON_V010_DEVELOPMENT_RECEIPT_PATH).toBe(
      "output/canonical-postgresql-dynamic-v0.9.1/development/marathon-v010-matrix.json",
    );
    expect(MARATHON_V010_TRUTH_COUNTERS).toEqual({
      REAL_LEGAL_TOPICS_READY: "0/7",
      REAL_SOURCES_ACTIVE: 0,
      REAL_PARAMETERS_ACTIVE: 0,
      REAL_RULES_ACTIVE: 0,
      REAL_CALCULATIONS_OR_FINDINGS: 0,
      HUMAN_GROUND_TRUTH_LOCKED: 0,
      REAL_CUSTOMER_DATA_READS: 0,
      CUSTOMER_PROCESSING_ENABLED: "NO",
      CUSTOMER_SHADOW_AUTHORIZED: "NO",
      PRODUCTION_DELIVERY_ENABLED: "NO",
      DEPLOYMENTS: 0,
      REMOTE_MIGRATIONS: 0,
      LIVE_PROVIDER_CALLS: 0,
      OPENAI_CALLS: 0,
      PRODUCT_REACHABLE_MEMORY_FALLBACKS: 0,
    });
  });

  it("declares the exact four-role verified runtime boundary", () => {
    expect(MARATHON_V010_RUNTIME_BOUNDARY).toEqual({
      schema_version: "tivdoc-marathon-v0102-runtime-boundary-v1",
      identity_session_verification: "tivdoc_identity_runtime",
      operations_mutations: "tivdoc_operations_runtime",
      report_binding: "tivdoc_worker_runtime",
      owner_portal_read: "tivdoc_web_runtime",
      identity_lifecycle_maintenance: "service_role",
      verified_context_function: "private.runtime_context_install",
      runtime_product_boundary_service_role_calls: 0,
      runtime_roles_verified: 4,
    });
  });

  it("routes product-boundary regression work through verified role sessions", async () => {
    const source = await readFile(new URL("./marathon-v010.mts", import.meta.url), "utf8");
    expect(source).not.toContain("service_role_connection_url");
    expect(source).toContain("private.runtime_context_install($1, $2, $3)");
    expect(source).toContain("withVerifiedRuntimeTransaction(managers.operations");
    expect(source).toContain("withVerifiedRuntimeTransaction(managers.worker");
    expect(source).toContain("withVerifiedRuntimeTransaction(managers.web");
    expect(source).toContain("managers.identity.transaction");
    expect(source).toContain("expectVerifiedRuntimeDenied");
    expect(source.match(/runtime_role_connection_urls/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("wires the marathon from generated least-privilege role URLs", async () => {
    const source = await readFile(new URL("../run.mts", import.meta.url), "utf8");
    expect(source).not.toContain("service_role_connection_url:");
    expect(source.match(/maintenance_connection_url: urls\.service_role/g)).toHaveLength(2);
    expect(source.match(/runtime_role_connection_urls: marathonRuntimeRoleConnectionUrls/g)).toHaveLength(2);
    for (const role of [
      "tivdoc_identity_runtime",
      "tivdoc_operations_runtime",
      "tivdoc_worker_runtime",
      "tivdoc_web_runtime",
    ]) expect(source).toContain(role);
  });
});

function durableState(suffix) {
  const fixture = createSyntheticCapabilityFixtures(suffix);
  const seed = Object.freeze({
    schema_version: "tivdoc-canonical-persistence-v091-durable-state-v1",
    fixture_suffix: suffix,
    tenant_id: fixture.tenant_id,
    case_id: fixture.case_id,
    case_revision: 7,
    analysis_run_id: fixture.analysis_run_id,
    report_id: fixture.report_id,
    report_sha256: fixture.report_artifacts.report_sha256,
    review_task_id: fixture.review_task_id,
    job_id: fixture.job_id,
    outbox_id: fixture.outbox_id,
    idempotency_key: fixture.idempotency_key,
    audit_tail_sha256: "a".repeat(64),
    capability_matrix_sha256: "b".repeat(64),
  });
  return Object.freeze({ ...seed, durable_state_sha256: canonicalSha256(seed) });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
