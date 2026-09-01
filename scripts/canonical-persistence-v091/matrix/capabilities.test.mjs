import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createCapabilityWorkerIdentity } from "./capabilities.mts";

describe("canonical capability least-privilege worker rehearsal", () => {
  it("derives one deterministic non-reviewer worker identity", () => {
    expect(createCapabilityWorkerIdentity("fixture001", "tenant:synthetic:001")).toEqual({
      session_id: "session:capability-worker:fixture001",
      token_id: "token:capability-worker:fixture001",
      tenant_id: "tenant:synthetic:001",
      actor_id: "worker:dynamic:fixture001",
      reviewer_organization_id: null,
      rotation_counter: 0,
    });
    expect(() => createCapabilityWorkerIdentity("../unsafe", "tenant:synthetic:001"))
      .toThrow("CAPABILITY_WORKER_IDENTITY_INVALID");
  });

  it("installs the durable session and performs worker/restart claims through verified_transaction", async () => {
    const source = await readFile(new URL("./capabilities.mts", import.meta.url), "utf8");
    expect(source).toContain("capability_worker_session_seed");
    expect(source).toContain("application.verified_transaction({");
    expect(source).toContain('runtime_role: "worker"');
    expect(source).not.toContain("return application.transaction(identity.tenant_id");
    expect(source).toContain('worker_runtime_principal: "tivdoc_worker_runtime" as const');
    expect(source).toContain("EXACTLY_ONE_WORKER_RUNTIME_CONNECTION_REQUIRED");
    expect(source).not.toContain("LEGACY_MIGRATION_COMPATIBILITY_BROAD_APPLICATION");
    expect(source).toContain('broad_application_scope: "LEGACY_CANONICAL_V091_MIGRATION_COMPATIBILITY"');
  });

  it("threads the exact worker runtime connection through every non-migration caller", async () => {
    const [run, marathon, child, backup] = await Promise.all([
      readFile(new URL("../run.mts", import.meta.url), "utf8"),
      readFile(new URL("./marathon-v010.mts", import.meta.url), "utf8"),
      readFile(new URL("./restart-replay-child.mts", import.meta.url), "utf8"),
      readFile(new URL("./backup-restore.mts", import.meta.url), "utf8"),
    ]);
    expect(run.match(/worker_runtime_connection_url: runtimeUrls\.tivdoc_worker_runtime/g)).toHaveLength(3);
    expect(run).toContain("TIVDOC_V091_REPLAY_WORKER_RUNTIME_CONNECTION_URL");
    expect(run).toContain("TIVDOC_V091_REPLAY_LEGACY_APPLICATION_CONNECTION_URL");
    expect(run).toContain("worker_runtime_secret: runtimeRoleSecrets.tivdoc_worker_runtime");
    expect(marathon.match(/worker_runtime_connection_url: input\.runtime_role_connection_urls\.worker/g))
      .toHaveLength(2);
    expect(child).toContain("TIVDOC_V091_REPLAY_WORKER_RUNTIME_CONNECTION_URL");
    expect(backup).toContain("worker_runtime_connection_url: restoredRuntimeRoleUrls.tivdoc_worker_runtime");
  });
});
