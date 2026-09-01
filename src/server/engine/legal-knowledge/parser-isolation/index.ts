import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  buildNodePermissionParserLaunchProfile,
  parserSandboxExpectedEnvironmentKeys,
} from "../../../platform/security/parser-sandbox.ts";

export const isolatedParserLimitsSchema = z.object({
  timeout_ms: z.number().int().min(25).max(30_000).default(2_000),
  max_input_bytes: z.number().int().min(512).max(100 * 1024 * 1024).default(20 * 1024 * 1024),
  max_output_bytes: z.number().int().min(256).max(1024 * 1024).default(64 * 1024),
  max_pages: z.number().int().min(1).max(10_000).default(500),
  max_objects: z.number().int().min(1).max(1_000_000).default(100_000),
  max_declared_stream_bytes: z.number().int().min(1).max(1024 * 1024 * 1024).default(100 * 1024 * 1024),
  max_decompressed_bytes: z.number().int().min(1).max(1024 * 1024 * 1024).default(64 * 1024 * 1024),
  max_decompression_ratio: z.number().int().min(1).max(10_000).default(200),
  max_old_space_mb: z.number().int().min(16).max(512).default(64),
  max_cpu_ms: z.number().int().min(10).max(30_000).default(1_500),
  max_files: z.number().int().min(4).max(64).default(8),
  max_stderr_bytes: z.number().int().min(0).max(64 * 1024).default(8 * 1024),
}).strict();

export type IsolatedParserLimits = z.input<typeof isolatedParserLimitsSchema>;

const receiptBindingSchema = z.object({
  schema_version: z.literal("tivdoc-parser-sandbox-receipt-v0.10.0"),
  request_id: z.string().regex(/^[a-f0-9]{64}$/u),
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  input_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  tool_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  config_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  environment_allowlist_verified: z.literal(true),
  scratch_root_used: z.literal(false),
});

const screenedReceiptSchema = receiptBindingSchema.extend({
  status: z.literal("screened"),
  media_type: z.literal("application/pdf"),
  input_bytes: z.number().int().nonnegative(),
  page_count: z.number().int().positive(),
  object_count: z.number().int().positive(),
  decompressed_bytes: z.number().int().nonnegative(),
  network_disabled: z.literal(true),
  published: z.literal(false),
  cpu_time_ms: z.number().int().nonnegative(),
}).strict();

const rejectedReceiptSchema = receiptBindingSchema.extend({
  status: z.literal("rejected"),
  safe_error_code: z.string().regex(/^[a-z0-9_]+$/u),
}).strict();

const networkCanaryReceiptSchema = receiptBindingSchema.extend({
  status: z.literal("network_canary"),
  network_disabled: z.literal(true),
}).strict();

const permissionCanaryReceiptSchema = receiptBindingSchema.extend({
  status: z.literal("permission_canaries"),
  filesystem_read_denied: z.literal(true),
  child_process_denied: z.literal(true),
  network_kernel_denial: z.literal(false),
}).strict();

export const parserIsolationAssurance = Object.freeze({
  application_isolation: "PARSER_APPLICATION_ISOLATION_VERIFIED" as const,
  os_sandbox: "PARSER_OS_SANDBOX_NOT_VERIFIED" as const,
  persistent_owner_import_enabled: false as const,
  application_controls: [
    "separate_node_child_process",
    "node_permission_model_exact_fs_read_allowlist",
    "node_permission_model_separate_fs_write_roots",
    "node_permission_model_child_and_worker_denial",
    "no_inherited_environment_outside_allowlist",
    "bounded_input_output_pages_objects_heap_files_cpu_and_time",
    "whole_child_process_forced_termination_before_cleanup",
    "immutable_request_receipt_input_tool_and_config_hash_binding",
  ] as const,
  unsupported_os_guarantees: [
    "no_kernel_network_namespace",
    "no_container_or_vm_boundary",
    "no_native_rss_or_pid_cgroup_or_job_object_limit",
    "no_read_only_os_rootfs",
    "cpu_limit_is_cooperative_plus_wall_timeout",
  ] as const,
});

export type IsolatedParserResult = z.infer<typeof screenedReceiptSchema> & typeof parserIsolationAssurance & Readonly<{
  receipt_sha256: string;
  workspace_cleanup_verified: true;
}>;

type ParserIsolationCanaryResult = (
  | z.infer<typeof networkCanaryReceiptSchema>
  | z.infer<typeof permissionCanaryReceiptSchema>
) & typeof parserIsolationAssurance & Readonly<{
  receipt_sha256: string;
  workspace_cleanup_verified: true;
}>;

type ParserIsolationPendingResult = (
  | z.infer<typeof screenedReceiptSchema>
  | z.infer<typeof networkCanaryReceiptSchema>
  | z.infer<typeof permissionCanaryReceiptSchema>
) & typeof parserIsolationAssurance & Readonly<{ receipt_sha256: string }>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function stableJson(value: unknown) {
  return `${JSON.stringify(stableValue(value))}\n`;
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(filePath: string) {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

let nodeToolDigest: Promise<string> | undefined;
function pinnedNodeToolDigest() {
  nodeToolDigest ??= fileSha256(process.execPath);
  return nodeToolDigest;
}

async function filesBelow(root: string): Promise<readonly string[]> {
  const result: string[] = [];
  async function visit(current: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else result.push(target);
    }
  }
  await visit(root);
  return result.sort();
}

type TestBehavior = "hang" | "partial_then_hang" | "oversize_output" | "network_canary" | "permission_canaries";

type ParserIsolationInput = Readonly<{
  bytes: Uint8Array;
  limits?: IsolatedParserLimits;
  signal?: AbortSignal;
}>;

export function screenUntrustedPdfIsolated(input: ParserIsolationInput & Readonly<{ testOnlyBehavior?: undefined }>): Promise<IsolatedParserResult>;
export function screenUntrustedPdfIsolated(input: ParserIsolationInput & Readonly<{ testOnlyBehavior: TestBehavior }>): Promise<IsolatedParserResult | ParserIsolationCanaryResult>;
export async function screenUntrustedPdfIsolated(input: ParserIsolationInput & Readonly<{ testOnlyBehavior?: TestBehavior }>): Promise<IsolatedParserResult | ParserIsolationCanaryResult> {
  const limits = isolatedParserLimitsSchema.parse(input.limits ?? {});
  const bytes = Buffer.from(input.bytes);
  if (bytes.byteLength > limits.max_input_bytes) throw new Error("isolated_parser_input_limit_exceeded");
  if (input.signal?.aborted) throw new Error("isolated_parser_cancelled");

  const workerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "screener-worker.mts");
  const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-parser-sandbox-"));
  let resolvedResult: ParserIsolationPendingResult | undefined;
  try {
    const controlRoot = path.join(root, "control");
    const inputRoot = path.join(root, "input");
    const scratchRoot = path.join(root, "scratch");
    const outputRoot = path.join(root, "output");
    await Promise.all([controlRoot, inputRoot, scratchRoot, outputRoot].map((item) => mkdir(item, { recursive: false })));
    const requestPath = path.join(controlRoot, "request.json");
    const inputPath = path.join(inputRoot, "artifact.pdf");
    const deniedReadCanaryPath = path.join(root, "denied-read-canary.txt");
    const outputPath = path.join(outputRoot, "receipt.json");
    const inputSha256 = sha256(bytes);
    const workerSha256 = await fileSha256(workerPath);
    const toolSha256 = await pinnedNodeToolDigest();
    const configSha256 = sha256(stableJson({
      schema_version: "tivdoc-parser-config-v0.10.0",
      worker_sha256: workerSha256,
      node_version: process.versions.node,
      limits,
    }));
    const environmentKeys = parserSandboxExpectedEnvironmentKeys(input.testOnlyBehavior);
    const requestWithoutHash = {
      schema_version: "tivdoc-parser-sandbox-request-v0.10.0" as const,
      request_id: sha256(stableJson({ input_sha256: inputSha256, tool_sha256: toolSha256, config_sha256: configSha256 })),
      request_sha256: "0".repeat(64),
      input_sha256: inputSha256,
      tool_sha256: toolSha256,
      config_sha256: configSha256,
      expected_environment_keys: environmentKeys,
      limits: {
        max_input_bytes: limits.max_input_bytes,
        max_output_bytes: limits.max_output_bytes,
        max_pages: limits.max_pages,
        max_objects: limits.max_objects,
        max_declared_stream_bytes: limits.max_declared_stream_bytes,
        max_decompressed_bytes: limits.max_decompressed_bytes,
        max_decompression_ratio: limits.max_decompression_ratio,
        max_cpu_ms: limits.max_cpu_ms,
      },
    };
    const request = { ...requestWithoutHash, request_sha256: sha256(stableJson(requestWithoutHash)) };
    await Promise.all([
      writeFile(requestPath, stableJson(request), { flag: "wx", mode: 0o400 }),
      writeFile(inputPath, bytes, { flag: "wx", mode: 0o400 }),
      writeFile(deniedReadCanaryPath, "synthetic permission canary\n", { flag: "wx", mode: 0o400 }),
    ]);
    await Promise.all([chmod(requestPath, 0o400), chmod(inputPath, 0o400), chmod(deniedReadCanaryPath, 0o400)]);

    const profile = buildNodePermissionParserLaunchProfile({
      worker_path: workerPath,
      request_path: requestPath,
      input_path: inputPath,
      denied_read_canary_path: deniedReadCanaryPath,
      scratch_root: scratchRoot,
      output_root: outputRoot,
      output_path: outputPath,
      tool_sha256: toolSha256,
      request_sha256: request.request_sha256,
      input_sha256: inputSha256,
      config_sha256: configSha256,
      max_old_space_mb: limits.max_old_space_mb,
      max_input_bytes: limits.max_input_bytes,
      max_output_bytes: limits.max_output_bytes,
      max_pages: limits.max_pages,
      max_objects: limits.max_objects,
      max_declared_stream_bytes: limits.max_declared_stream_bytes,
      max_decompressed_bytes: limits.max_decompressed_bytes,
      max_decompression_ratio: limits.max_decompression_ratio,
      max_files: limits.max_files,
      test_behavior: input.testOnlyBehavior,
    });

    const child = spawn(profile.executable, profile.args, {
      cwd: profile.cwd,
      env: profile.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let terminalError: Error | undefined;
    let stderrBytes = 0;
    const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      const terminate = (error: Error) => {
        if (terminalError) return;
        terminalError = error;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => terminate(new Error("isolated_parser_timeout")), limits.timeout_ms);
      const onAbort = () => terminate(new Error("isolated_parser_cancelled"));
      input.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.byteLength > 0) terminate(new Error("isolated_parser_unexpected_stdout"));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > limits.max_stderr_bytes) terminate(new Error("isolated_parser_stderr_limit_exceeded"));
      });
      child.on("error", () => terminate(new Error("isolated_parser_spawn_failed")));
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        resolve({ code, signal });
      });
    });
    if (terminalError) throw terminalError;
    const allFiles = await filesBelow(root);
    if (allFiles.length > limits.max_files) throw new Error("isolated_parser_file_count_limit_exceeded");
    const scratchFiles = await filesBelow(scratchRoot);
    const outputFiles = await filesBelow(outputRoot);
    if (outputFiles.length === 0 && closed.code !== 0) throw new Error("isolated_parser_failed_without_receipt");
    if (scratchFiles.length !== 0 || outputFiles.length !== 1 || path.resolve(outputFiles[0] ?? "") !== path.resolve(outputPath)) {
      throw new Error("isolated_parser_workspace_policy_violated");
    }
    const outputInfo = await stat(outputPath);
    if (!outputInfo.isFile() || outputInfo.size > limits.max_output_bytes) throw new Error("isolated_parser_output_limit_exceeded");
    const rawReceipt = await readFile(outputPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawReceipt);
    } catch {
      throw new Error("isolated_parser_output_invalid");
    }
    const binding = receiptBindingSchema.parse(parsed);
    if (binding.request_id !== request.request_id
      || binding.request_sha256 !== request.request_sha256
      || binding.input_sha256 !== inputSha256
      || binding.tool_sha256 !== toolSha256
      || binding.config_sha256 !== configSha256) throw new Error("isolated_parser_receipt_binding_invalid");
    const rejected = rejectedReceiptSchema.safeParse(parsed);
    if (closed.code !== 0 || rejected.success) {
      if (rejected.success && closed.code === 23) throw new Error(rejected.data.safe_error_code);
      throw new Error(`isolated_parser_failed_exit_${String(closed.code)}_${String(closed.signal)}`);
    }
    const schema = input.testOnlyBehavior === "network_canary"
      ? networkCanaryReceiptSchema
      : input.testOnlyBehavior === "permission_canaries"
        ? permissionCanaryReceiptSchema
        : screenedReceiptSchema;
    const result = schema.parse(parsed);
    resolvedResult = Object.freeze({
      ...result,
      receipt_sha256: sha256(rawReceipt),
      ...parserIsolationAssurance,
    }) as ParserIsolationPendingResult;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  if (!resolvedResult) throw new Error("isolated_parser_result_missing");
  return Object.freeze({ ...resolvedResult, workspace_cleanup_verified: true as const }) as IsolatedParserResult | ParserIsolationCanaryResult;
}
