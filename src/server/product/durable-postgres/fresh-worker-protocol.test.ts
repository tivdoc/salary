import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  FRESH_WORKER_PROTOCOL_SCHEMA_VERSION,
  decodeFreshWorkerRequest,
  decodeFreshWorkerResponse,
  encodeFreshWorkerRequest,
  type FreshWorkerRequest,
} from "./fresh-worker-protocol.ts";

const HASH = "a".repeat(64);

describe("V0.10.2 distinct fresh worker process protocol", () => {
  it("round-trips an exact credential-free request and rejects extra fields", () => {
    const request = fixtureRequest();
    expect(decodeFreshWorkerRequest(encodeFreshWorkerRequest(request))).toEqual(request);
    expect(() => decodeFreshWorkerRequest(JSON.stringify({ ...request, connection_url: "forbidden" })))
      .toThrow("FRESH_WORKER_PROTOCOL_INVALID");
  });

  it("executes in a direct fresh Node process and returns only the bounded receipt", async () => {
    const request = fixtureRequest();
    const moduleUrl = new URL("./fresh-worker-protocol.ts", import.meta.url).href;
    const program = `
      import { executeFreshWorkerProtocol } from ${JSON.stringify(moduleUrl)};
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", async () => {
        const hash = ${JSON.stringify(HASH)};
        const output = await executeFreshWorkerProtocol(input, {
          async process() {
            return {
              state: "SUCCEEDED",
              job_revision: 3,
              fencing_token: 1,
              attempt_count: 1,
              report_sha256: hash,
              artifact_sha256: hash,
              logical_effect_sha256: hash,
              storage_locator_sha256: hash,
              worker_process_sha256: hash,
              audit_event_sha256: hash,
            };
          },
        });
        process.stdout.write(output);
      });
    `;
    const result = await directChild(program, encodeFreshWorkerRequest(request));
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const response = decodeFreshWorkerResponse(result.stdout, request);
    expect(response).toMatchObject({
      request_id: request.request_id,
      parent_process_id: process.pid,
      fresh_process_verified: true,
      result: { state: "SUCCEEDED", job_revision: 3 },
    });
    expect(response.process_id).not.toBe(process.pid);
    expect(Object.keys(response).sort()).toEqual([
      "boot_nonce_sha256",
      "fresh_process_verified",
      "parent_process_id",
      "process_id",
      "request_id",
      "result",
      "schema_version",
    ]);
  });

  it("rejects a response that claims execution in the parent process", () => {
    const request = fixtureRequest();
    expect(() => decodeFreshWorkerResponse(JSON.stringify({
      schema_version: FRESH_WORKER_PROTOCOL_SCHEMA_VERSION,
      request_id: request.request_id,
      process_id: request.parent_process_id,
      parent_process_id: request.parent_process_id,
      boot_nonce_sha256: HASH,
      fresh_process_verified: true,
      result: {
        state: "SUCCEEDED",
        job_revision: 1,
        fencing_token: 1,
        attempt_count: 1,
        report_sha256: HASH,
        artifact_sha256: HASH,
        logical_effect_sha256: HASH,
        storage_locator_sha256: HASH,
        worker_process_sha256: HASH,
        audit_event_sha256: HASH,
      },
    }), request)).toThrow("FRESH_WORKER_PROTOCOL_INVALID");
  });
});

function fixtureRequest(): FreshWorkerRequest {
  return Object.freeze({
    schema_version: FRESH_WORKER_PROTOCOL_SCHEMA_VERSION,
    request_id: "worker-request-001",
    parent_process_id: process.pid,
    worker_id: "fresh-worker-001",
    tenant_id: "tenant-synthetic-001",
    case_id: "case-synthetic-001",
    correlation_id: "correlation-synthetic-001",
    job_id: "job-synthetic-001",
    now_ms: 1_788_000_000_000,
    lease_ms: 30_000,
    retry_delay_ms: 1_000,
  });
}

function directChild(program: string, input: string): Promise<Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      program,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "test" },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
    child.stdin.end(input, "utf8");
  });
}
