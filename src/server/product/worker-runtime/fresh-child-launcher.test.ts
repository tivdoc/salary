import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FreshWorkerChildProcessLauncher,
} from "./fresh-child-launcher.ts";
import {
  FRESH_WORKER_PROTOCOL_SCHEMA_VERSION,
  type FreshWorkerRequest,
} from "../durable-postgres/fresh-worker-protocol.ts";

const HASH = "a".repeat(64);
const MODULE_URL = new URL("./fresh-child-launcher.ts", import.meta.url).href;

describe("V0.10.2 bounded fresh worker child launcher", () => {
  it("runs one exact protocol frame in the direct fresh child and discloses no runtime path", async () => {
    await withEntrypoint(successProgram(), async (entrypointPath, workingDirectory) => {
      const launcher = createLauncher(entrypointPath, workingDirectory, 2_000);
      const request = fixtureRequest();
      const response = await launcher.launch({ request });

      expect(response).toMatchObject({
        request_id: request.request_id,
        parent_process_id: process.pid,
        fresh_process_verified: true,
        result: {
          state: "SUCCEEDED",
          job_revision: 3,
          report_sha256: HASH,
        },
      });
      expect(response.process_id).not.toBe(process.pid);
      expect(launcher.proof()).toMatchObject({
        transport: "single_bounded_stdin_stdout_frame",
        shell: false,
        direct_child_required: true,
        inherited_runtime_configuration: false,
        inherited_parent_environment_keys: 0,
        protocol_credentials_allowed: false,
        protocol_urls_allowed: false,
        protocol_storage_paths_allowed: false,
      });
      expect(JSON.stringify(launcher.proof())).not.toContain(entrypointPath);
      expect(JSON.stringify(launcher.proof())).not.toContain(workingDirectory);
    });
  });

  it("cancels the owned child and gives its runtime a bounded clean shutdown", async () => {
    await withEntrypoint("", async (entrypointPath, workingDirectory) => {
      const readyPath = join(workingDirectory, "ready.marker");
      const closedPath = join(workingDirectory, "closed.marker");
      await writeFile(entrypointPath, cancellationProgram(readyPath, closedPath), "utf8");
      const launcher = createLauncher(entrypointPath, workingDirectory, 3_000, 1_000);
      const controller = new AbortController();
      const launched = launcher.launch({ request: fixtureRequest(), signal: controller.signal });
      await waitForFile(readyPath);
      controller.abort();

      await expect(launched).rejects.toMatchObject({
        code: "FRESH_WORKER_CHILD_CANCELLED",
        message: "FRESH_WORKER_CHILD_CANCELLED",
      });
      expect(await readFile(closedPath, "utf8")).toBe("closed");
    });
  });

  it("enforces its deadline and rejects output beyond the single-frame bound", async () => {
    await withEntrypoint(hangingProgram(), async (entrypointPath, workingDirectory) => {
      const launcher = createLauncher(entrypointPath, workingDirectory, 100, 100);
      await expect(launcher.launch({ request: fixtureRequest() })).rejects.toMatchObject({
        code: "FRESH_WORKER_CHILD_TIMEOUT",
      });
    });

    await withEntrypoint(oversizedOutputProgram(), async (entrypointPath, workingDirectory) => {
      const launcher = createLauncher(entrypointPath, workingDirectory, 2_000, 100);
      await expect(launcher.launch({ request: fixtureRequest() })).rejects.toMatchObject({
        code: "FRESH_WORKER_CHILD_OUTPUT_LIMIT",
      });
    });
  });

  it("never returns child stderr, credentials, URLs or local paths in an error", async () => {
    const connectionScheme = ["postgresql", ":", "/", "/"].join("");
    const secret = `${connectionScheme}worker:credential@example.invalid/private-storage/path`;
    await withEntrypoint(stderrProgram(secret), async (entrypointPath, workingDirectory) => {
      const launcher = createLauncher(entrypointPath, workingDirectory, 2_000);
      let observed: unknown = null;
      try {
        await launcher.launch({ request: fixtureRequest() });
      } catch (error) {
        observed = error;
      }
      expect(observed).toMatchObject({
        code: "FRESH_WORKER_CHILD_EXIT_FAILED",
        message: "FRESH_WORKER_CHILD_EXIT_FAILED",
      });
      const serialized = JSON.stringify(observed);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(entrypointPath);
      expect(serialized).not.toContain(workingDirectory);
      expect(serialized).not.toContain(connectionScheme);
    });
  });

  it("passes only the explicit worker environment and never inherits parent web secrets", async () => {
    const parentSecretKey = "TIVDOC_DURABLE_DOWNLOAD_HMAC_KEY";
    const previous = process.env[parentSecretKey];
    process.env[parentSecretKey] = "parent-web-secret-must-not-enter-child";
    try {
      await withEntrypoint(environmentProgram(), async (entrypointPath, workingDirectory) => {
        const launcher = new FreshWorkerChildProcessLauncher({
          entrypoint_path: entrypointPath,
          working_directory: workingDirectory,
          timeout_ms: 2_000,
          termination_grace_ms: 500,
          child_environment: {
            NODE_ENV: "development",
            TIVDOC_WORKER_RUNTIME_SENTINEL: "TIVDOC_FRESH_WORKER_V0102",
          },
        });
        await expect(launcher.launch({ request: fixtureRequest() })).resolves.toMatchObject({
          fresh_process_verified: true,
        });
      });
    } finally {
      if (previous === undefined) delete process.env[parentSecretKey];
      else process.env[parentSecretKey] = previous;
    }
  });

  it("rejects a non-worker environment key before spawning", async () => {
    await withEntrypoint(successProgram(), async (entrypointPath, workingDirectory) => {
      expect(() => new FreshWorkerChildProcessLauncher({
        entrypoint_path: entrypointPath,
        working_directory: workingDirectory,
        timeout_ms: 2_000,
        termination_grace_ms: 500,
        child_environment: { NODE_ENV: "development", TIVDOC_DURABLE_DOWNLOAD_HMAC_KEY: "forbidden" } as never,
      })).toThrow("FRESH_WORKER_CHILD_RUNTIME_FAILED");
    });
  });
});

function createLauncher(
  entrypointPath: string,
  workingDirectory: string,
  timeoutMs: number,
  terminationGraceMs = 500,
): FreshWorkerChildProcessLauncher {
  return new FreshWorkerChildProcessLauncher({
    entrypoint_path: entrypointPath,
    working_directory: workingDirectory,
    timeout_ms: timeoutMs,
    termination_grace_ms: terminationGraceMs,
    child_environment: { NODE_ENV: "development" },
  });
}

function environmentProgram(): string {
  return `
import { serveFreshWorkerChildProcess } from ${JSON.stringify(MODULE_URL)};
if (process.env.TIVDOC_WORKER_RUNTIME_SENTINEL !== "TIVDOC_FRESH_WORKER_V0102"
    || process.env.TIVDOC_DURABLE_DOWNLOAD_HMAC_KEY !== undefined) {
  throw new Error("unsafe child environment");
}
const hash = ${JSON.stringify(HASH)};
await serveFreshWorkerChildProcess(async () => ({
  worker: {
    async process() {
      return {
        state: "SUCCEEDED",
        job_revision: 3,
        fencing_token: 2,
        attempt_count: 1,
        report_sha256: hash,
        artifact_sha256: hash,
        logical_effect_sha256: hash,
        storage_locator_sha256: hash,
        worker_process_sha256: hash,
        audit_event_sha256: hash,
      };
    },
  },
  async close() {},
}), { input_timeout_ms: 1_000, shutdown_timeout_ms: 500 });
`;
}

function fixtureRequest(): FreshWorkerRequest {
  return Object.freeze({
    schema_version: FRESH_WORKER_PROTOCOL_SCHEMA_VERSION,
    request_id: "worker-request-launcher-001",
    parent_process_id: process.pid,
    worker_id: "fresh-worker-launcher-001",
    tenant_id: "tenant-synthetic-001",
    case_id: "case-synthetic-001",
    correlation_id: "correlation-synthetic-001",
    job_id: "job-synthetic-001",
    now_ms: 1_788_000_000_000,
    lease_ms: 30_000,
    retry_delay_ms: 1_000,
  });
}

function successProgram(): string {
  return `
import { serveFreshWorkerChildProcess } from ${JSON.stringify(MODULE_URL)};
const hash = ${JSON.stringify(HASH)};
await serveFreshWorkerChildProcess(async () => ({
  worker: {
    async process() {
      return {
        state: "SUCCEEDED",
        job_revision: 3,
        fencing_token: 2,
        attempt_count: 1,
        report_sha256: hash,
        artifact_sha256: hash,
        logical_effect_sha256: hash,
        storage_locator_sha256: hash,
        worker_process_sha256: hash,
        audit_event_sha256: hash,
      };
    },
  },
  async close() {},
}), { input_timeout_ms: 1_000, shutdown_timeout_ms: 500 });
`;
}

function cancellationProgram(readyPath: string, closedPath: string): string {
  return `
import { writeFile } from "node:fs/promises";
import { serveFreshWorkerChildProcess } from ${JSON.stringify(MODULE_URL)};
await serveFreshWorkerChildProcess(async () => {
  await writeFile(${JSON.stringify(readyPath)}, "ready", "utf8");
  return {
    worker: { async process() { return new Promise(() => {}); } },
    async close() { await writeFile(${JSON.stringify(closedPath)}, "closed", "utf8"); },
  };
}, { input_timeout_ms: 1_000, shutdown_timeout_ms: 500 });
`;
}

function hangingProgram(): string {
  return `
import { serveFreshWorkerChildProcess } from ${JSON.stringify(MODULE_URL)};
await serveFreshWorkerChildProcess(async () => ({
  worker: { async process() { return new Promise(() => {}); } },
  async close() {},
}), { input_timeout_ms: 1_000, shutdown_timeout_ms: 100 });
`;
}

function oversizedOutputProgram(): string {
  return `
process.stdin.resume();
process.stdout.write("x".repeat(20_000));
setInterval(() => {}, 1_000);
`;
}

function stderrProgram(secret: string): string {
  return `
process.stdin.resume();
process.stdin.once("end", () => {
  process.stderr.write(${JSON.stringify(secret)});
  process.exitCode = 1;
});
`;
}

async function withEntrypoint(
  program: string,
  operation: (entrypointPath: string, workingDirectory: string) => Promise<void>,
): Promise<void> {
  const workingDirectory = await mkdtemp(join(tmpdir(), "tivdoc-fresh-worker-child-"));
  const entrypointPath = join(workingDirectory, "child.mjs");
  try {
    await writeFile(entrypointPath, program, "utf8");
    await operation(entrypointPath, workingDirectory);
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await readFile(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("FRESH_WORKER_CHILD_TEST_READY_TIMEOUT");
}
