import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { LocalRuntimePrivateBlobProvider } from "../../platform/storage/local-runtime/private-blob-provider.ts";
import {
  CANONICAL_POSTGRES_SCHEMA_VERSION,
  type CanonicalVerifiedTransactionInput,
} from "../../platform/composition/canonical-postgres.ts";
import {
  DURABLE_RUNTIME_POSTGRES_CONTEXT_REQUIREMENTS,
  DURABLE_RUNTIME_PRODUCT_SCHEMA_VERSION,
  createDurableRuntimeWorkerContext,
  createDurableRuntimeProductRegistrar,
  createDurableRuntimeReportJobEnvelope,
  type DurableRuntimePostgresContextPort,
  type DurableRuntimeDatabasePrincipal,
  type DurableRuntimeTransactionBundle,
  type DurableRuntimeTimelineBinding,
} from "./runtime-product-lane.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

describe("V0.10.2 durable worker/storage/timeline registrar", () => {
  it("builds one deterministic synthetic-only content-addressed job envelope", () => {
    const timeline = fixtureTimeline();
    const input = {
      timeline,
      pipeline: {
        job_id: "job-synthetic-001",
        outbox_id: "outbox-synthetic-001",
        logical_effect_id: "effect-synthetic-001",
        idempotency_key: "idempotency-synthetic-001",
      },
    } as const;
    const first = createDurableRuntimeReportJobEnvelope(input);
    const second = createDurableRuntimeReportJobEnvelope(input);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toMatchObject({
      schema_version: DURABLE_RUNTIME_PRODUCT_SCHEMA_VERSION,
      analysis_mode: "synthetic_seven_topic_only",
      legal_rules_activated: 0,
      storage: {
        provider_class: "local_private_immutable_filesystem",
        managed_platform_verified: false,
      },
    });
    expect(first.storage.quarantine_locator).toMatch(/^quarantine\/[a-f0-9]{2}\/object_[a-f0-9]{48}$/u);
    expect(first.pipeline.logical_effect_sha256).toMatch(/^[a-f0-9]{64}$/u);
    const extraTimeline = Object.freeze({ ...timeline, connection_url: "forbidden" });
    expect(() => createDurableRuntimeReportJobEnvelope({ ...input, timeline: extraTimeline }))
      .toThrow("RUNTIME_PRODUCT_JOB_ENVELOPE_INVALID");

    const mutableTimeline = { ...timeline };
    const isolated = createDurableRuntimeReportJobEnvelope({ ...input, timeline: mutableTimeline });
    mutableTimeline.actor_id = "mutated-operator-001";
    expect(isolated.timeline.actor_id).toBe("operator-synthetic-001");
  });

  it("publishes the exact least-privilege role and transaction-context contract", () => {
    expect(DURABLE_RUNTIME_POSTGRES_CONTEXT_REQUIREMENTS).toEqual(expect.objectContaining({
      runtime_roles: {
        web: "tivdoc_web_runtime",
        operations: "tivdoc_operations_runtime",
        worker: "tivdoc_worker_runtime",
      },
      runtime_context_values: { web: "web", operations: "operations", worker: "worker" },
      context_installer: "private.runtime_context_install(text,text,text)",
      transaction_local_settings: [
        "tivdoc.tenant_id",
        "tivdoc.actor_id",
        "tivdoc.identity_sid",
        "tivdoc.identity_jti",
        "tivdoc.runtime_role",
        "tivdoc.correlation_id",
        "tivdoc.reviewer_organization_id",
      ],
      direct_table_owner_execution_forbidden: true,
      bypassrls_forbidden: true,
    }));
  });

  it("rejects a non-PostgreSQL context and has no production recording or memory seam", async () => {
    const context = new DisabledContext();
    const storage = new LocalRuntimePrivateBlobProvider({
      root: join(tmpdir(), "tivdoc-private-runtime-focused-constructor"),
      runtime_class: "ignored_local_private_filesystem",
      publicly_addressable: false,
      managed_platform_verified: false,
    });
    expect(() => createDurableRuntimeProductRegistrar({
      context,
      storage,
      download_grant_hmac_key: new Uint8Array(32).fill(7),
    })).toThrow("PERSISTENCE_DISABLED");

    const source = await readFile(new URL("./runtime-product-lane.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/recording-driver|RecordingPostgres|InMemory|memory_test_only_factory/u);
    expect(source).toContain("RUNTIME_PRODUCT_VERIFIED_CONTEXT_REQUIRED");
    expect(source).toContain("session_user as database_principal");
    expect(source).toContain("role.rolbypassrls as bypasses_rls");
    expect(source).toContain("timingSafeEqual(actual, expected)");
    expect(source).toContain("input.ttl_seconds > 300");
    expect(source).toContain("subject = nullif(current_setting('tivdoc.actor_id', true), '')");
    expect(source).toContain("currentCanonicalIdentity");
    expect(source).toContain("for update skip locked");
  });

  it("keeps the download HMAC secret out of operations and worker registrars", () => {
    const storage = new LocalRuntimePrivateBlobProvider({
      root: join(tmpdir(), "tivdoc-private-runtime-focused-key-scope"),
      runtime_class: "ignored_local_private_filesystem",
      publicly_addressable: false,
      managed_platform_verified: false,
    });
    const key = new Uint8Array(32).fill(9);
    const worker = new IsolatedContext("tivdoc_worker_runtime");
    expect(createDurableRuntimeProductRegistrar({ context: worker, storage }).proof())
      .toMatchObject({ database_principal: "tivdoc_worker_runtime", uses_service_role: false });
    expect(() => createDurableRuntimeProductRegistrar({
      context: worker,
      storage,
      download_grant_hmac_key: key,
    })).toThrow("RUNTIME_PRODUCT_DOWNLOAD_GRANT_KEY_SCOPE_INVALID");

    const web = new IsolatedContext("tivdoc_web_runtime");
    expect(() => createDurableRuntimeProductRegistrar({ context: web, storage }))
      .toThrow("RUNTIME_PRODUCT_DOWNLOAD_GRANT_KEY_INVALID");
    expect(createDurableRuntimeProductRegistrar({
      context: web,
      storage,
      download_grant_hmac_key: key,
    }).proof()).toMatchObject({ database_principal: "tivdoc_web_runtime" });
  });

  it("binds worker authority through verified transactions without exposing session credentials", () => {
    const postgres = new IsolatedContext("tivdoc_worker_runtime").postgres;
    const context = createDurableRuntimeWorkerContext({
      postgres,
      identity: {
        session_id: "session-worker-secret-001",
        token_id: "token-worker-secret-001",
        tenant_id: "tenant-synthetic-001",
        actor_id: "runtime-actor-synthetic-001",
        reviewer_organization_id: null,
        rotation_counter: 3,
      },
    });

    expect(context).toMatchObject({
      database_principal: "tivdoc_worker_runtime",
      tenant_id: "tenant-synthetic-001",
      actor_id: "runtime-actor-synthetic-001",
      session_revision: 3,
      uses_service_role: false,
      bypasses_rls: false,
    });
    expect(Object.keys(context)).not.toContain("session_id");
    expect(Object.keys(context)).not.toContain("token_id");
    expect(JSON.stringify(context)).not.toContain("session-worker-secret-001");
    expect(JSON.stringify(context)).not.toContain("token-worker-secret-001");
  });
});

class DisabledContext implements DurableRuntimePostgresContextPort {
  readonly proof_class = "DURABLE_VERIFIED_RUNTIME_CONTEXT" as const;
  readonly uses_service_role = false as const;
  readonly bypasses_rls = false as const;
  readonly database_principal = "tivdoc_worker_runtime" as const;
  readonly tenant_id = "tenant-synthetic-001";
  readonly actor_id = "fresh-worker-001";
  readonly session_revision = 0;
  readonly session_binding_sha256 = HASH_A;
  readonly postgres = Object.freeze({
    mode: "disabled" as const,
    durable: false as const,
    reason: "PERSISTENCE_DISABLED" as const,
  });

  async transaction<T>(
    _input: Readonly<{ case_id: string; correlation_id: string }>,
    _operation: (bundle: DurableRuntimeTransactionBundle) => Promise<T>,
  ): Promise<T> {
    throw new Error("TEST_CONTEXT_MUST_NOT_EXECUTE");
  }
}

class IsolatedContext implements DurableRuntimePostgresContextPort {
  readonly proof_class = "DURABLE_VERIFIED_RUNTIME_CONTEXT" as const;
  readonly uses_service_role = false as const;
  readonly bypasses_rls = false as const;
  readonly database_principal: DurableRuntimeDatabasePrincipal;
  readonly tenant_id = "tenant-synthetic-001";
  readonly actor_id = "runtime-actor-synthetic-001";
  readonly session_revision = 1;
  readonly session_binding_sha256 = HASH_A;
  readonly postgres = Object.freeze({
    mode: "isolated_postgres" as const,
    durable: true as const,
    target_id: "runtime-product-focused-test",
    schema_version: CANONICAL_POSTGRES_SCHEMA_VERSION,
    async transaction<T>(
      _tenantId: string,
      _caseId: string,
      _operation: (bundle: DurableRuntimeTransactionBundle) => Promise<T>,
    ): Promise<T> {
      throw new Error("TEST_POSTGRES_MUST_NOT_EXECUTE");
    },
    async verified_transaction<T>(
      _input: CanonicalVerifiedTransactionInput,
      _operation: (bundle: DurableRuntimeTransactionBundle) => Promise<T>,
    ): Promise<T> {
      throw new Error("TEST_POSTGRES_MUST_NOT_EXECUTE");
    },
  });

  constructor(principal: DurableRuntimeDatabasePrincipal) {
    this.database_principal = principal;
  }

  async transaction<T>(
    _input: Readonly<{ case_id: string; correlation_id: string }>,
    _operation: (bundle: DurableRuntimeTransactionBundle) => Promise<T>,
  ): Promise<T> {
    throw new Error("TEST_CONTEXT_MUST_NOT_EXECUTE");
  }
}

function fixtureTimeline(): DurableRuntimeTimelineBinding {
  return Object.freeze({
    correlation_id: "correlation-synthetic-001",
    tenant_id: "tenant-synthetic-001",
    case_id: "case-synthetic-001",
    case_revision: 1,
    owner_binding_revision: 1,
    owner_binding_sha256: HASH_A,
    actor_id: "operator-synthetic-001",
    session_binding_sha256: HASH_B,
    session_revision: 1,
    analysis_run_id: "analysis-synthetic-001",
    report_id: "report-synthetic-001",
    report_revision: 1,
    report_sha256: HASH_C,
    pdf_sha256: HASH_D,
  });
}
