import { afterEach, describe, expect, it } from "vitest";

import { guardStableHttpEntrypoint } from "./stable-http-entrypoint.ts";
import {
  LOCAL_SYSTEM_LIMITS,
  SYSTEM_CAPABILITY_SCHEMA_VERSION,
  buildSystemCapabilityProjection,
} from "./system-capabilities.ts";
import {
  createStableEntrypointRuntime,
  installStableEntrypointRuntime,
  resetStableEntrypointRuntimeForTests,
} from "./stable-entrypoint-runtime.ts";

afterEach(() => resetStableEntrypointRuntimeForTests());

describe("stable HTTP entrypoint guard", () => {
  it("fails closed before body work when a product capability is disabled", async () => {
    installDisabledRuntime();
    const request = new Request("http://127.0.0.1/api/cases", { method: "POST", body: "{}" });
    await expect(guardStableHttpEntrypoint("CEP-013", request)).rejects.toThrow(
      "CAPABILITY_ENTRYPOINT_BLOCKED:CEP-013",
    );
    expect(request.bodyUsed).toBe(false);
  });

  it("bounds declared and chunked JSON bodies and rejects malformed lengths", async () => {
    installDisabledRuntime();
    await expect(guardStableHttpEntrypoint("CEP-010", new Request("http://127.0.0.1/robots.txt", {
      method: "POST",
      body: "{}",
    }))).resolves.toMatchObject({ outcome: "ALLOW" });

    await expect(guardStableHttpEntrypoint("CEP-010", new Request("http://127.0.0.1/robots.txt", {
      method: "POST",
      headers: { "content-length": String(LOCAL_SYSTEM_LIMITS.maximum_json_body_bytes + 1) },
      body: "{}",
    }))).rejects.toThrow("CAPABILITY_CONTENT_LENGTH_LIMIT");

    const chunked = new Request("http://127.0.0.1/robots.txt", {
      method: "POST",
      body: "x".repeat(LOCAL_SYSTEM_LIMITS.maximum_json_body_bytes + 1),
    });
    expect(chunked.headers.get("content-length")).toBeNull();
    await expect(guardStableHttpEntrypoint("CEP-010", chunked)).rejects.toThrow("CAPABILITY_BODY_LIMIT");

    await expect(guardStableHttpEntrypoint("CEP-010", new Request("http://127.0.0.1/robots.txt", {
      headers: { "content-length": "not-a-number" },
    }))).rejects.toThrow("CAPABILITY_CONTENT_LENGTH_INVALID");
  });

  it("applies upload and structured dimensions and rejects a previously consumed body", async () => {
    installDisabledRuntime();
    await expect(guardStableHttpEntrypoint("CEP-010", new Request("http://127.0.0.1/robots.txt", {
      method: "POST",
      body: "x".repeat(LOCAL_SYSTEM_LIMITS.maximum_json_body_bytes + 1),
    }), { body_kind: "upload" })).resolves.toMatchObject({ outcome: "ALLOW" });

    await expect(guardStableHttpEntrypoint("CEP-010", new Request("http://127.0.0.1/robots.txt"), {
      page_count: LOCAL_SYSTEM_LIMITS.maximum_pages_per_document + 1,
    })).rejects.toThrow("CAPABILITY_PAGE_LIMIT");

    const used = new Request("http://127.0.0.1/robots.txt", { method: "POST", body: "{}" });
    await used.text();
    await expect(guardStableHttpEntrypoint("CEP-010", used)).rejects.toThrow("CAPABILITY_REQUEST_BODY_ALREADY_USED");
  });
});

function installDisabledRuntime(): void {
  const projection = buildSystemCapabilityProjection({
    schema_version: SYSTEM_CAPABILITY_SCHEMA_VERSION,
    runtime_mode: "test",
    execution_scope: "local_only",
    fixture_mode: "none",
    declarations: {},
  });
  installStableEntrypointRuntime(createStableEntrypointRuntime({ projection }));
}
