import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

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
}).strict();

export type IsolatedParserLimits = z.input<typeof isolatedParserLimitsSchema>;

const screenedResultSchema = z.object({
  status: z.literal("screened"),
  media_type: z.literal("application/pdf"),
  input_bytes: z.number().int().nonnegative(),
  page_count: z.number().int().positive(),
  object_count: z.number().int().positive(),
  decompressed_bytes: z.number().int().nonnegative(),
  network_disabled: z.literal(true),
  published: z.literal(false),
}).strict();

const rejectedResultSchema = z.object({
  status: z.literal("rejected"),
  safe_error_code: z.string().min(1),
}).strict();

const networkCanarySchema = z.object({
  status: z.literal("network_canary"),
  network_disabled: z.literal(true),
}).strict();

export type IsolatedParserResult = z.infer<typeof screenedResultSchema>;

export async function screenUntrustedPdfIsolated(input: Readonly<{
  bytes: Uint8Array;
  limits?: IsolatedParserLimits;
  signal?: AbortSignal;
  testOnlyBehavior?: "hang" | "partial_then_hang" | "oversize_output" | "network_canary";
}>) {
  const limits = isolatedParserLimitsSchema.parse(input.limits ?? {});
  const bytes = Buffer.from(input.bytes);
  if (bytes.byteLength > limits.max_input_bytes) throw new Error("isolated_parser_input_limit_exceeded");
  if (input.signal?.aborted) throw new Error("isolated_parser_cancelled");
  const workerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "screener-worker.mts");
  return await new Promise<IsolatedParserResult | { status: "network_canary"; network_disabled: true }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--permission",
      `--allow-fs-read=${workerPath}`,
      `--max-old-space-size=${limits.max_old_space_mb}`,
      "--experimental-strip-types",
      workerPath,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        NODE_ENV: "production",
        SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
        TIVDOC_PARSER_NETWORK_DISABLED: "1",
        TIVDOC_PARSER_MAX_INPUT_BYTES: String(limits.max_input_bytes),
        TIVDOC_PARSER_MAX_OUTPUT_BYTES: String(limits.max_output_bytes),
        TIVDOC_PARSER_MAX_PAGES: String(limits.max_pages),
        TIVDOC_PARSER_MAX_OBJECTS: String(limits.max_objects),
        TIVDOC_PARSER_MAX_DECLARED_STREAM_BYTES: String(limits.max_declared_stream_bytes),
        TIVDOC_PARSER_MAX_DECOMPRESSED_BYTES: String(limits.max_decompressed_bytes),
        TIVDOC_PARSER_MAX_DECOMPRESSION_RATIO: String(limits.max_decompression_ratio),
        ...(input.testOnlyBehavior ? { TIVDOC_PARSER_TEST_BEHAVIOR: input.testOnlyBehavior } : {}),
      } as NodeJS.ProcessEnv,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      child.kill("SIGKILL");
      reject(error);
    };
    const onAbort = () => finishReject(new Error("isolated_parser_cancelled"));
    const timer = setTimeout(() => finishReject(new Error("isolated_parser_timeout")), limits.timeout_ms);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > limits.max_output_bytes) {
        finishReject(new Error("isolated_parser_output_limit_exceeded"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.reduce((sum, item) => sum + item.byteLength, 0) < 8_192) stderr.push(chunk);
    });
    child.on("error", (error) => finishReject(new Error(`isolated_parser_spawn_failed:${error.message}`)));
    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      const raw = Buffer.concat(stdout).toString("utf8").trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        settled = true;
        reject(new Error(code === 0 ? "isolated_parser_output_invalid" : "isolated_parser_failed_without_valid_output"));
        return;
      }
      const rejected = rejectedResultSchema.safeParse(parsed);
      if (code !== 0 || rejected.success) {
        settled = true;
        reject(new Error(rejected.success ? rejected.data.safe_error_code : `isolated_parser_failed_exit_${String(code)}`));
        return;
      }
      try {
        const result = input.testOnlyBehavior === "network_canary" ? networkCanarySchema.parse(parsed) : screenedResultSchema.parse(parsed);
        settled = true;
        resolve(result);
      } catch {
        settled = true;
        reject(new Error("isolated_parser_output_schema_invalid"));
      }
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") finishReject(new Error(`isolated_parser_stdin_failed:${error.message}`));
    });
    child.stdin.end(bytes);
  });
}
