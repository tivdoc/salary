import { describe, expect, it } from "vitest";

import { readDurableWorkerRuntimeConfiguration } from "./durable-worker-runtime.ts";

const BASE = Object.freeze({
  NODE_ENV: "development",
  TIVDOC_WORKER_RUNTIME_SENTINEL: "TIVDOC_FRESH_WORKER_V0102",
  TIVDOC_WORKER_ACTOR_ID: "worker-synthetic-001",
  TIVDOC_WORKER_TENANT_ID: "tenant-synthetic-001",
  TIVDOC_WORKER_SESSION_ID: "session-synthetic-001",
  TIVDOC_WORKER_TOKEN_ID: "token-synthetic-001",
  TIVDOC_WORKER_ROTATION_COUNTER: "2",
  TIVDOC_WORKER_BUILD_IDENTITY_SHA: "a".repeat(40),
  TIVDOC_WORKER_POSTGRES_URL: "postgresql://worker:redacted@127.0.0.1:5432/tivdoc_v09_synthetic01",
  TIVDOC_WORKER_PRIVATE_STORAGE_ROOT: "C:\\ignored\\tivdoc-private-runtime-synthetic",
});

describe("durable fresh worker runtime configuration", () => {
  it("accepts only the explicit local worker sentinel and exact bounded identity", () => {
    expect(readDurableWorkerRuntimeConfiguration(BASE)).toEqual({
      actor_id: "worker-synthetic-001",
      tenant_id: "tenant-synthetic-001",
      session_id: "session-synthetic-001",
      token_id: "token-synthetic-001",
      rotation_counter: 2,
      build_identity_sha: "a".repeat(40),
      postgres_url: BASE.TIVDOC_WORKER_POSTGRES_URL,
      private_storage_root: BASE.TIVDOC_WORKER_PRIVATE_STORAGE_ROOT,
    });
  });

  it("fails closed for ordinary runtime, malformed revisions, or incomplete configuration", () => {
    expect(() => readDurableWorkerRuntimeConfiguration({ ...BASE, TIVDOC_WORKER_RUNTIME_SENTINEL: undefined }))
      .toThrow("DURABLE_WORKER_RUNTIME_DISABLED");
    expect(() => readDurableWorkerRuntimeConfiguration({ ...BASE, NODE_ENV: "production" }))
      .toThrow("DURABLE_WORKER_RUNTIME_DISABLED");
    expect(() => readDurableWorkerRuntimeConfiguration({ ...BASE, TIVDOC_WORKER_ROTATION_COUNTER: "-1" }))
      .toThrow("DURABLE_WORKER_CONFIGURATION_INVALID");
    expect(() => readDurableWorkerRuntimeConfiguration({ ...BASE, TIVDOC_WORKER_POSTGRES_URL: undefined }))
      .toThrow("DURABLE_WORKER_CONFIGURATION_INVALID");
  });

  it("does not ingest web identity keys or download secrets", () => {
    const config = readDurableWorkerRuntimeConfiguration({
      ...BASE,
      TIVDOC_DURABLE_DOWNLOAD_HMAC_KEY: "must-not-be-ingested",
      TIVDOC_IDENTITY_PUBLIC_KEY: "must-not-be-ingested",
    });
    expect(JSON.stringify(config)).not.toContain("must-not-be-ingested");
    expect(Object.keys(config)).not.toContain("TIVDOC_DURABLE_DOWNLOAD_HMAC_KEY");
  });
});
