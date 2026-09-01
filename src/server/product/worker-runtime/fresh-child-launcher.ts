import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import { extname, isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  decodeFreshWorkerResponse,
  encodeFreshWorkerRequest,
  executeFreshWorkerProtocol,
  type FreshWorkerExecutionPort,
  type FreshWorkerRequest,
  type FreshWorkerResponse,
} from "../durable-postgres/fresh-worker-protocol.ts";

export const FRESH_WORKER_CHILD_LAUNCHER_SCHEMA_VERSION =
  "tivdoc-fresh-worker-child-launcher-v0.10.2" as const;

const MAX_FRAME_BYTES = 16_384;
const MAX_STDERR_BYTES = 4_096;
const MAX_PATH_BYTES = 4_096;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 300_000;
const MAX_INPUT_TIMEOUT_MS = 30_000;
const MAX_TERMINATION_GRACE_MS = 5_000;
const CHILD_CANCEL_CONTROL = "tivdoc:fresh-worker:cancel:v0.10.2" as const;
const CHILD_ENTRYPOINT_EXTENSIONS = Object.freeze([".js", ".mjs", ".cjs", ".ts", ".mts"] as const);

export type FreshWorkerChildErrorCode =
  | "FRESH_WORKER_CHILD_CANCELLED"
  | "FRESH_WORKER_CHILD_TIMEOUT"
  | "FRESH_WORKER_CHILD_INPUT_INVALID"
  | "FRESH_WORKER_CHILD_OUTPUT_LIMIT"
  | "FRESH_WORKER_CHILD_IO_FAILED"
  | "FRESH_WORKER_CHILD_SPAWN_FAILED"
  | "FRESH_WORKER_CHILD_EXIT_FAILED"
  | "FRESH_WORKER_CHILD_PROTOCOL_INVALID"
  | "FRESH_WORKER_CHILD_RUNTIME_FAILED"
  | "FRESH_WORKER_CHILD_SHUTDOWN_FAILED";

/** Safe boundary error: child stderr, paths and underlying exception text are never attached. */
export class FreshWorkerChildError extends Error {
  readonly code: FreshWorkerChildErrorCode;

  constructor(code: FreshWorkerChildErrorCode) {
    super(code);
    this.name = "FreshWorkerChildError";
    this.code = code;
  }
}

export type FreshWorkerChildRuntime = Readonly<{
  worker: FreshWorkerExecutionPort;
  close(): Promise<void>;
}>;

export type FreshWorkerChildRuntimeFactory = () =>
  FreshWorkerChildRuntime | Promise<FreshWorkerChildRuntime>;

export type FreshWorkerChildProcessOutcome = "COMPLETED" | "FAILED";

export type FreshWorkerChildProcessLauncherConfig = Readonly<{
  entrypoint_path: string;
  working_directory: string;
  timeout_ms: number;
  termination_grace_ms: number;
}>;

export type FreshWorkerChildProcessLaunchInput = Readonly<{
  request: FreshWorkerRequest;
  signal?: AbortSignal;
}>;

type OwnedFreshWorkerProcess = ChildProcess & Readonly<{
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
}>;

/**
 * Parent-side single-use process launcher. The only bytes written to stdin are
 * the exact bounded protocol frame. Runtime credentials remain inherited
 * process configuration and can never be supplied through this API.
 */
export class FreshWorkerChildProcessLauncher {
  readonly #entrypointPath: string;
  readonly #workingDirectory: string;
  readonly #timeoutMs: number;
  readonly #terminationGraceMs: number;

  constructor(config: FreshWorkerChildProcessLauncherConfig) {
    assertLocalPath(config.entrypoint_path, true);
    assertLocalPath(config.working_directory, false);
    assertBoundedInteger(config.timeout_ms, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    assertBoundedInteger(config.termination_grace_ms, 0, MAX_TERMINATION_GRACE_MS);
    this.#entrypointPath = config.entrypoint_path;
    this.#workingDirectory = config.working_directory;
    this.#timeoutMs = config.timeout_ms;
    this.#terminationGraceMs = config.termination_grace_ms;
  }

  proof() {
    return Object.freeze({
      schema_version: FRESH_WORKER_CHILD_LAUNCHER_SCHEMA_VERSION,
      transport: "single_bounded_stdin_stdout_frame" as const,
      cancellation_control: "owned_child_ipc_cancel_only" as const,
      cancellation_control_fields: 0 as const,
      direct_child_required: true as const,
      shell: false as const,
      inherited_runtime_configuration: true as const,
      protocol_credentials_allowed: false as const,
      protocol_urls_allowed: false as const,
      protocol_storage_paths_allowed: false as const,
      entrypoint_path_disclosed: false as const,
      working_directory_disclosed: false as const,
      max_stdin_bytes: MAX_FRAME_BYTES,
      max_stdout_bytes: MAX_FRAME_BYTES,
      max_stderr_bytes: MAX_STDERR_BYTES,
      timeout_ms: this.#timeoutMs,
      termination_grace_ms: this.#terminationGraceMs,
    });
  }

  launch(input: FreshWorkerChildProcessLaunchInput): Promise<FreshWorkerResponse> {
    if (input.signal?.aborted) {
      return Promise.reject(new FreshWorkerChildError("FRESH_WORKER_CHILD_CANCELLED"));
    }
    if (input.request.parent_process_id !== process.pid) {
      return Promise.reject(new FreshWorkerChildError("FRESH_WORKER_CHILD_PROTOCOL_INVALID"));
    }
    if (this.#timeoutMs > input.request.lease_ms) {
      return Promise.reject(new FreshWorkerChildError("FRESH_WORKER_CHILD_PROTOCOL_INVALID"));
    }

    let frame: string;
    try {
      frame = encodeFreshWorkerRequest(input.request);
    } catch {
      return Promise.reject(new FreshWorkerChildError("FRESH_WORKER_CHILD_PROTOCOL_INVALID"));
    }
    if (!isSingleFrame(frame) || Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) {
      return Promise.reject(new FreshWorkerChildError("FRESH_WORKER_CHILD_INPUT_INVALID"));
    }

    let child: OwnedFreshWorkerProcess;
    try {
      child = spawnOwnedFreshWorker(this.#entrypointPath, this.#workingDirectory);
    } catch {
      return Promise.reject(new FreshWorkerChildError("FRESH_WORKER_CHILD_SPAWN_FAILED"));
    }

    return new Promise((resolve, reject) => {
      const spawnedProcessId = child.pid;
      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let terminalCode: FreshWorkerChildErrorCode | null = null;
      let settled = false;
      let forceTimer: NodeJS.Timeout | null = null;

      const cleanup = (): void => {
        clearTimeout(timeoutTimer);
        if (forceTimer) clearTimeout(forceTimer);
        input.signal?.removeEventListener("abort", onAbort);
      };
      const rejectSafely = (code: FreshWorkerChildErrorCode): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new FreshWorkerChildError(code));
      };
      const terminate = (code: FreshWorkerChildErrorCode): void => {
        terminalCode ??= code;
        if (!child.stdin.destroyed) child.stdin.destroy();
        if (this.#terminationGraceMs === 0) {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          return;
        }
        if (!forceTimer) {
          if (child.connected) child.send(CHILD_CANCEL_CONTROL, () => undefined);
          forceTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          }, this.#terminationGraceMs);
          forceTimer.unref();
        }
      };
      const onAbort = (): void => terminate("FRESH_WORKER_CHILD_CANCELLED");
      const timeoutTimer = setTimeout(
        () => terminate("FRESH_WORKER_CHILD_TIMEOUT"),
        this.#timeoutMs,
      );
      timeoutTimer.unref();

      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) onAbort();

      child.stdout.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
        stdoutBytes += bytes.byteLength;
        if (stdoutBytes > MAX_FRAME_BYTES) {
          child.stdout.pause();
          terminate("FRESH_WORKER_CHILD_OUTPUT_LIMIT");
          return;
        }
        stdoutChunks.push(bytes);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
        stderrBytes += bytes.byteLength;
        if (stderrBytes > MAX_STDERR_BYTES) {
          child.stderr.pause();
          terminate("FRESH_WORKER_CHILD_OUTPUT_LIMIT");
        }
      });
      child.stdin.on("error", () => {
        if (!terminalCode) terminate("FRESH_WORKER_CHILD_IO_FAILED");
      });
      child.once("error", () => {
        terminalCode ??= "FRESH_WORKER_CHILD_SPAWN_FAILED";
      });
      child.once("close", (exitCode, exitSignal) => {
        if (settled) return;
        if (terminalCode) {
          rejectSafely(terminalCode);
          return;
        }
        if (exitCode !== 0 || exitSignal !== null || stderrBytes !== 0 || spawnedProcessId === undefined) {
          rejectSafely("FRESH_WORKER_CHILD_EXIT_FAILED");
          return;
        }
        const serialized = Buffer.concat(stdoutChunks).toString("utf8");
        if (!isSingleFrame(serialized)) {
          rejectSafely("FRESH_WORKER_CHILD_PROTOCOL_INVALID");
          return;
        }
        let response: FreshWorkerResponse;
        try {
          response = decodeFreshWorkerResponse(serialized, input.request);
        } catch {
          rejectSafely("FRESH_WORKER_CHILD_PROTOCOL_INVALID");
          return;
        }
        if (response.process_id !== spawnedProcessId) {
          rejectSafely("FRESH_WORKER_CHILD_PROTOCOL_INVALID");
          return;
        }
        settled = true;
        cleanup();
        resolve(response);
      });

      child.stdin.end(frame, "utf8", (error?: Error | null) => {
        if (error && !terminalCode) terminate("FRESH_WORKER_CHILD_IO_FAILED");
      });
    });
  }
}

export type FreshWorkerChildServeOptions = Readonly<{
  input?: Readable;
  output?: Writable;
  signal?: AbortSignal;
  input_timeout_ms?: number;
  shutdown_timeout_ms?: number;
}>;

/**
 * Child-side one-shot runner. Entrypoints should await this function and do no
 * other stdout/stderr writes. All runtime resources are closed on every path.
 */
export async function serveFreshWorkerChildProcess(
  factory: FreshWorkerChildRuntimeFactory,
  options: FreshWorkerChildServeOptions = {},
): Promise<FreshWorkerChildProcessOutcome> {
  const inputTimeoutMs = options.input_timeout_ms ?? 10_000;
  const shutdownTimeoutMs = options.shutdown_timeout_ms ?? 1_000;
  assertBoundedInteger(inputTimeoutMs, MIN_TIMEOUT_MS, MAX_INPUT_TIMEOUT_MS);
  assertBoundedInteger(shutdownTimeoutMs, MIN_TIMEOUT_MS, MAX_TERMINATION_GRACE_MS);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const termination = new AbortController();
  const abort = (): void => termination.abort();
  const externalAbort = (): void => termination.abort();
  const onControl = (message: unknown): void => {
    if (message === CHILD_CANCEL_CONTROL) termination.abort();
  };
  let runtime: FreshWorkerChildRuntime | null = null;
  let outcome: FreshWorkerChildProcessOutcome = "FAILED";

  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  if (typeof process.send === "function") process.on("message", onControl);
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  if (options.signal?.aborted) termination.abort();
  try {
    const createdRuntime = await withAbort(Promise.resolve().then(factory), termination.signal);
    assertChildRuntime(createdRuntime);
    runtime = createdRuntime;
    const serializedRequest = await readSingleBoundedFrame(
      input,
      inputTimeoutMs,
      termination.signal,
    );
    let serializedResponse: string;
    try {
      serializedResponse = await withAbort(
        executeFreshWorkerProtocol(serializedRequest, createdRuntime.worker),
        termination.signal,
      );
    } catch (error) {
      if (error instanceof FreshWorkerChildError) throw error;
      throw new FreshWorkerChildError("FRESH_WORKER_CHILD_RUNTIME_FAILED");
    }
    if (!isSingleFrame(serializedResponse)
      || Buffer.byteLength(serializedResponse, "utf8") > MAX_FRAME_BYTES) {
      throw new FreshWorkerChildError("FRESH_WORKER_CHILD_OUTPUT_LIMIT");
    }
    await writeBoundedFrame(output, serializedResponse, termination.signal);
    outcome = "COMPLETED";
  } catch {
    outcome = "FAILED";
  } finally {
    input.pause();
    if (runtime) {
      try {
        await withTimeout(runtime.close(), shutdownTimeoutMs);
      } catch {
        outcome = "FAILED";
      }
    }
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    process.removeListener("message", onControl);
    options.signal?.removeEventListener("abort", externalAbort);
    if (process.connected && typeof process.disconnect === "function") process.disconnect();
  }
  if (outcome === "FAILED") process.exitCode = 70;
  return outcome;
}

function readSingleBoundedFrame(
  input: Readable,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteCount = 0;
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
    };
    const fail = (code: FreshWorkerChildErrorCode): void => {
      if (settled) return;
      settled = true;
      cleanup();
      input.pause();
      reject(new FreshWorkerChildError(code));
    };
    const onAbort = (): void => fail("FRESH_WORKER_CHILD_CANCELLED");
    const onError = (): void => fail("FRESH_WORKER_CHILD_IO_FAILED");
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      byteCount += bytes.byteLength;
      if (byteCount > MAX_FRAME_BYTES) {
        fail("FRESH_WORKER_CHILD_INPUT_INVALID");
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      if (settled) return;
      const frame = Buffer.concat(chunks).toString("utf8");
      if (!isSingleFrame(frame)) {
        fail("FRESH_WORKER_CHILD_INPUT_INVALID");
        return;
      }
      settled = true;
      cleanup();
      resolve(frame);
    };
    const timer = setTimeout(() => fail("FRESH_WORKER_CHILD_TIMEOUT"), timeoutMs);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    if (signal.aborted) onAbort();
    else input.resume();
  });
}

function writeBoundedFrame(output: Writable, frame: string, signal: AbortSignal): Promise<void> {
  if (!isSingleFrame(frame) || Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) {
    return Promise.reject(new FreshWorkerChildError("FRESH_WORKER_CHILD_OUTPUT_LIMIT"));
  }
  if (signal.aborted) {
    return Promise.reject(new FreshWorkerChildError("FRESH_WORKER_CHILD_CANCELLED"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => finish(new FreshWorkerChildError("FRESH_WORKER_CHILD_CANCELLED"));
    let settled = false;
    const finish = (error?: FreshWorkerChildError): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    output.write(frame, "utf8", (error?: Error | null) => {
      if (error) finish(new FreshWorkerChildError("FRESH_WORKER_CHILD_IO_FAILED"));
      else finish();
    });
  });
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new FreshWorkerChildError("FRESH_WORKER_CHILD_CANCELLED"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new FreshWorkerChildError("FRESH_WORKER_CHILD_CANCELLED"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new FreshWorkerChildError("FRESH_WORKER_CHILD_SHUTDOWN_FAILED")),
      timeoutMs,
    );
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        reject(new FreshWorkerChildError("FRESH_WORKER_CHILD_SHUTDOWN_FAILED"));
      },
    );
  });
}

function assertChildRuntime(value: unknown): asserts value is FreshWorkerChildRuntime {
  if (!value || typeof value !== "object" || !("worker" in value) || !("close" in value)) {
    throw new FreshWorkerChildError("FRESH_WORKER_CHILD_RUNTIME_FAILED");
  }
  const worker = value.worker;
  if (!worker || typeof worker !== "object" || !("process" in worker)
    || typeof worker.process !== "function" || typeof value.close !== "function") {
    throw new FreshWorkerChildError("FRESH_WORKER_CHILD_RUNTIME_FAILED");
  }
}

function spawnOwnedFreshWorker(
  entrypointPath: string,
  workingDirectory: string,
): OwnedFreshWorkerProcess {
  const child = spawn(process.execPath, [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--experimental-strip-types",
    entrypointPath,
  ], {
    cwd: workingDirectory,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  assertOwnedFreshWorkerProcess(child);
  return child;
}

function assertOwnedFreshWorkerProcess(child: ChildProcess): asserts child is OwnedFreshWorkerProcess {
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill("SIGKILL");
    throw new FreshWorkerChildError("FRESH_WORKER_CHILD_SPAWN_FAILED");
  }
}

function assertLocalPath(value: string, entrypoint: boolean): void {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")
    || /[\r\n]/u.test(value) || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES
    || (process.platform === "win32" && /^\\\\/u.test(value))) {
    throw new FreshWorkerChildError("FRESH_WORKER_CHILD_SPAWN_FAILED");
  }
  const extension = extname(value).toLowerCase();
  if (entrypoint && !CHILD_ENTRYPOINT_EXTENSIONS.some((candidate) => candidate === extension)) {
    throw new FreshWorkerChildError("FRESH_WORKER_CHILD_SPAWN_FAILED");
  }
}

function assertBoundedInteger(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new FreshWorkerChildError("FRESH_WORKER_CHILD_RUNTIME_FAILED");
  }
}

function isSingleFrame(value: string): boolean {
  if (!value.endsWith("\n") || value.includes("\0")) return false;
  return value.indexOf("\n") === value.length - 1;
}
