import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";

const [requestPath, inputPath, scratchRoot, outputPath] = process.argv.slice(2);
if (!requestPath || !inputPath || !scratchRoot || !outputPath) throw new Error("parser_worker_arguments_invalid");

const denyNetwork = () => {
  throw new Error("parser_network_disabled");
};

for (const [moduleName, methods] of [
  ["node:net", ["connect", "createConnection"]],
  ["node:http", ["request", "get"]],
  ["node:https", ["request", "get"]],
  ["node:tls", ["connect"]],
  ["node:dgram", ["createSocket"]],
  ["node:dns", ["lookup", "resolve", "resolve4", "resolve6"]],
] as const) {
  const networkModule = process.getBuiltinModule(moduleName) as Record<string, unknown>;
  for (const method of methods) Object.defineProperty(networkModule, method, { value: denyNetwork, configurable: false, writable: false });
}
Object.defineProperty(globalThis, "fetch", { value: denyNetwork, configurable: false, writable: false });
if ("WebSocket" in globalThis) Object.defineProperty(globalThis, "WebSocket", { value: denyNetwork, configurable: false, writable: false });
if ("EventSource" in globalThis) Object.defineProperty(globalThis, "EventSource", { value: denyNetwork, configurable: false, writable: false });

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

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

type WorkerRequest = Readonly<{
  schema_version: "tivdoc-parser-sandbox-request-v0.10.0";
  request_id: string;
  request_sha256: string;
  input_sha256: string;
  tool_sha256: string;
  config_sha256: string;
  expected_environment_keys: readonly string[];
  limits: Readonly<{
    max_input_bytes: number;
    max_output_bytes: number;
    max_pages: number;
    max_objects: number;
    max_declared_stream_bytes: number;
    max_decompressed_bytes: number;
    max_decompression_ratio: number;
    max_cpu_ms: number;
  }>;
}>;

const rawRequest = await readFile(requestPath, "utf8");
const request = JSON.parse(rawRequest) as WorkerRequest;
const requestForHash = { ...request, request_sha256: "0".repeat(64) };
if (request.schema_version !== "tivdoc-parser-sandbox-request-v0.10.0"
  || request.request_sha256 !== sha256(stableJson(requestForHash))
  || request.request_sha256 !== process.env.TIVDOC_PARSER_REQUEST_SHA256
  || request.input_sha256 !== process.env.TIVDOC_PARSER_INPUT_SHA256
  || request.tool_sha256 !== process.env.TIVDOC_PARSER_TOOL_SHA256
  || request.config_sha256 !== process.env.TIVDOC_PARSER_CONFIG_SHA256) {
  throw new Error("parser_worker_request_binding_invalid");
}

const environmentKeys = Object.keys(process.env).sort();
const expectedEnvironmentKeys = [...request.expected_environment_keys].sort();
if (JSON.stringify(environmentKeys) !== JSON.stringify(expectedEnvironmentKeys)) throw new Error("parser_worker_environment_allowlist_invalid");
if (process.env.TIVDOC_PARSER_NETWORK_DISABLED !== "1") throw new Error("parser_worker_network_policy_missing");

const startedCpu = process.cpuUsage();
let receiptWritten = false;
async function writeReceipt(value: Readonly<Record<string, unknown>>) {
  if (receiptWritten) throw new Error("parser_worker_receipt_already_written");
  const body = stableJson({
    schema_version: "tivdoc-parser-sandbox-receipt-v0.10.0",
    request_id: request.request_id,
    request_sha256: request.request_sha256,
    input_sha256: request.input_sha256,
    tool_sha256: request.tool_sha256,
    config_sha256: request.config_sha256,
    environment_allowlist_verified: true,
    scratch_root_used: false,
    ...value,
  });
  if (Buffer.byteLength(body) > request.limits.max_output_bytes) throw new Error("isolated_parser_output_limit_exceeded");
  await writeFile(outputPath, body, { flag: "wx", mode: 0o600 });
  receiptWritten = true;
}

async function fail(safeErrorCode: string): Promise<never> {
  await writeReceipt({ status: "rejected", safe_error_code: safeErrorCode });
  process.exitCode = 23;
  // The caller needs a rejected receipt and a non-zero exit without an
  // unhandled stack trace that could contain private paths.
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.exit(23);
}

const testBehavior = process.env.TIVDOC_PARSER_TEST_BEHAVIOR;
if (testBehavior === "hang" || testBehavior === "partial_then_hang") {
  if (testBehavior === "partial_then_hang") await writeFile(outputPath, '{"schema_version":"partial"', { flag: "wx", mode: 0o600 });
  setInterval(() => undefined, 1_000);
} else if (testBehavior === "oversize_output") {
  await writeFile(outputPath, "x".repeat(request.limits.max_output_bytes + 1), { flag: "wx", mode: 0o600 });
} else {
  const inputHandle = await open(inputPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let buffer: Buffer;
  try {
    const before = await inputHandle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > request.limits.max_input_bytes) await fail("isolated_parser_input_identity_invalid");
    buffer = await inputHandle.readFile();
    const after = await inputHandle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || buffer.byteLength !== after.size) {
      await fail("isolated_parser_input_changed_during_read");
    }
  } finally {
    await inputHandle.close();
  }
  if (sha256(buffer) !== request.input_sha256) await fail("isolated_parser_input_hash_mismatch");

  if (testBehavior === "network_canary") {
    let blocked = false;
    try {
      (globalThis.fetch as unknown as () => never)();
    } catch (error) {
      blocked = (error as Error).message === "parser_network_disabled";
    }
    await writeReceipt({ status: "network_canary", network_disabled: blocked });
    process.exit(blocked ? 0 : 24);
  }

  if (testBehavior === "permission_canaries") {
    let filesystemReadDenied = false;
    try {
      await readFile(process.env.TIVDOC_PARSER_DENIED_READ_CANARY!);
    } catch (error) {
      filesystemReadDenied = (error as NodeJS.ErrnoException).code === "ERR_ACCESS_DENIED";
    }
    let childProcessDenied = false;
    try {
      const processAttempt = spawnSync(process.execPath, ["--version"], { stdio: "ignore" });
      childProcessDenied = processAttempt.error instanceof Error
        && (processAttempt.error as NodeJS.ErrnoException).code === "ERR_ACCESS_DENIED";
    } catch (error) {
      childProcessDenied = (error as NodeJS.ErrnoException).code === "ERR_ACCESS_DENIED";
    }
    await writeReceipt({
      status: "permission_canaries",
      filesystem_read_denied: filesystemReadDenied,
      child_process_denied: childProcessDenied,
      network_kernel_denial: false,
    });
    process.exit(filesystemReadDenied && childProcessDenied ? 0 : 24);
  }

  if (buffer.byteLength < 512) await fail("isolated_parser_truncated");
  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) await fail("isolated_parser_pdf_magic_mismatch");
  const ascii = buffer.toString("latin1");
  const eof = ascii.lastIndexOf("%%EOF");
  if (eof < 0 || eof < ascii.length - 2048) await fail("isolated_parser_pdf_eof_missing");
  if (ascii.slice(eof + 5).trim().length > 0) await fail("isolated_parser_polyglot_trailing_payload");
  if (buffer.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])) >= 0 || buffer.subarray(0, 2).equals(Buffer.from("MZ"))) await fail("isolated_parser_executable_or_polyglot");
  if (/\/(?:Encrypt)\b/u.test(ascii)) await fail("isolated_parser_encrypted");
  if (/\/(?:JavaScript|JS|Launch|RichMedia|OpenAction|AA|SubmitForm|ImportData)\b/u.test(ascii)) await fail("isolated_parser_active_content");
  if (/\/(?:AcroForm|Annots|Widget)\b/u.test(ascii)) await fail("isolated_parser_interactive_content");
  if (/\/(?:EmbeddedFile|EmbeddedFiles|Filespec|XFA)\b/u.test(ascii)) await fail("isolated_parser_embedded_content");
  if (/\/(?:URI|GoToR)\b/u.test(ascii)) await fail("isolated_parser_external_reference");
  if (!/(?:\bxref\b|\/Type\s*\/XRef\b)/u.test(ascii) || !/\bstartxref\b/u.test(ascii)) await fail("isolated_parser_xref_missing_or_corrupt");
  const pageCount = (ascii.match(/\/Type\s*\/Page\b/gu) ?? []).length;
  const declaredPageCounts = [...ascii.matchAll(/\/Count\s+(\d+)/gu)].map((match) => Number(match[1]));
  if (pageCount === 0) await fail("isolated_parser_page_tree_missing");
  if (pageCount > request.limits.max_pages || declaredPageCounts.some((count) => count > request.limits.max_pages)) await fail("isolated_parser_page_limit_exceeded");
  const objectCount = (ascii.match(/\b\d+\s+\d+\s+obj\b/gu) ?? []).length;
  const objectEnds = (ascii.match(/\bendobj\b/gu) ?? []).length;
  if (objectCount === 0 || objectCount !== objectEnds || objectCount > request.limits.max_objects) await fail("isolated_parser_object_limit_or_structure_invalid");
  const declaredLengths = [...ascii.matchAll(/\/Length\s+(\d+)/gu)].map((match) => Number(match[1]));
  if (declaredLengths.some((length) => length > request.limits.max_declared_stream_bytes)) await fail("isolated_parser_declared_stream_limit_exceeded");

  const zlib = process.getBuiltinModule("node:zlib") as typeof import("node:zlib");
  let decompressedBytes = 0;
  for (const stream of ascii.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/gu)) {
    const encoded = Buffer.from(stream[1], "latin1");
    const dictionaryStart = Math.max(0, (stream.index ?? 0) - 2_048);
    const dictionary = ascii.slice(dictionaryStart, stream.index);
    if (!/\/Filter\s*(?:\/FlateDecode|\[[^\]]*\/FlateDecode)/u.test(dictionary)) continue;
    let decoded: Buffer;
    try {
      decoded = zlib.inflateSync(encoded, { maxOutputLength: Math.max(1, request.limits.max_decompressed_bytes - decompressedBytes) });
    } catch {
      await fail("isolated_parser_decompression_failed_or_limit_exceeded");
    }
    decompressedBytes += decoded.byteLength;
    if (decompressedBytes > request.limits.max_decompressed_bytes || decoded.byteLength / Math.max(encoded.byteLength, 1) > request.limits.max_decompression_ratio) {
      await fail("isolated_parser_decompression_limit_exceeded");
    }
  }
  const cpu = process.cpuUsage(startedCpu);
  if ((cpu.user + cpu.system) / 1_000 > request.limits.max_cpu_ms) await fail("isolated_parser_cooperative_cpu_limit_exceeded");
  await writeReceipt({
    status: "screened",
    media_type: "application/pdf",
    input_bytes: buffer.byteLength,
    page_count: pageCount,
    object_count: objectCount,
    decompressed_bytes: decompressedBytes,
    network_disabled: true,
    published: false,
    cpu_time_ms: Math.ceil((cpu.user + cpu.system) / 1_000),
  });
}
