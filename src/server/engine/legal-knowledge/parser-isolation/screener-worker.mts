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

const maxInputBytes = Number(process.env.TIVDOC_PARSER_MAX_INPUT_BYTES ?? 20 * 1024 * 1024);
const maxPages = Number(process.env.TIVDOC_PARSER_MAX_PAGES ?? 500);
const maxObjects = Number(process.env.TIVDOC_PARSER_MAX_OBJECTS ?? 100_000);
const maxDeclaredStreamBytes = Number(process.env.TIVDOC_PARSER_MAX_DECLARED_STREAM_BYTES ?? 100 * 1024 * 1024);
const maxDecompressedBytes = Number(process.env.TIVDOC_PARSER_MAX_DECOMPRESSED_BYTES ?? 64 * 1024 * 1024);
const maxDecompressionRatio = Number(process.env.TIVDOC_PARSER_MAX_DECOMPRESSION_RATIO ?? 200);
const testBehavior = process.env.TIVDOC_PARSER_TEST_BEHAVIOR;

function fail(safeErrorCode: string): never {
  process.stdout.write(`${JSON.stringify({ status: "rejected", safe_error_code: safeErrorCode })}\n`);
  process.exit(23);
}

if (testBehavior === "hang" || testBehavior === "partial_then_hang") {
  if (testBehavior === "partial_then_hang") process.stdout.write('{"status":"screened"');
  setInterval(() => undefined, 1_000);
} else if (testBehavior === "oversize_output") {
  process.stdout.write("x".repeat(Number(process.env.TIVDOC_PARSER_MAX_OUTPUT_BYTES ?? 64 * 1024) + 1));
} else if (testBehavior === "network_canary") {
  let blocked = false;
  try {
    const networkCanary = globalThis.fetch as unknown as () => never;
    networkCanary();
  } catch (error) {
    blocked = (error as Error).message === "parser_network_disabled";
  }
  process.stdout.write(`${JSON.stringify({ status: "network_canary", network_disabled: blocked })}\n`);
  process.exit(blocked ? 0 : 24);
} else {
  const chunks: Buffer[] = [];
  let inputBytes = 0;
  process.stdin.on("data", (chunk: Buffer) => {
    inputBytes += chunk.byteLength;
    if (inputBytes > maxInputBytes) fail("isolated_parser_input_limit_exceeded");
    chunks.push(chunk);
  });
  process.stdin.on("end", () => {
    const buffer = Buffer.concat(chunks);
    if (buffer.byteLength < 512) fail("isolated_parser_truncated");
    if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) fail("isolated_parser_pdf_magic_mismatch");
    const ascii = buffer.toString("latin1");
    const eof = ascii.lastIndexOf("%%EOF");
    if (eof < 0 || eof < ascii.length - 2048) fail("isolated_parser_pdf_eof_missing");
    if (ascii.slice(eof + 5).trim().length > 0) fail("isolated_parser_polyglot_trailing_payload");
    if (buffer.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])) >= 0 || buffer.subarray(0, 2).equals(Buffer.from("MZ"))) fail("isolated_parser_executable_or_polyglot");
    if (/\/(?:Encrypt)\b/u.test(ascii)) fail("isolated_parser_encrypted");
    if (/\/(?:JavaScript|JS|Launch|RichMedia|OpenAction|AA|SubmitForm|ImportData)\b/u.test(ascii)) fail("isolated_parser_active_content");
    if (/\/(?:EmbeddedFile|EmbeddedFiles|Filespec|XFA)\b/u.test(ascii)) fail("isolated_parser_embedded_content");
    if (/\/(?:URI|GoToR)\b/u.test(ascii)) fail("isolated_parser_external_reference");
    if (!/(?:\bxref\b|\/Type\s*\/XRef\b)/u.test(ascii) || !/\bstartxref\b/u.test(ascii)) fail("isolated_parser_xref_missing_or_corrupt");
    const pageCount = (ascii.match(/\/Type\s*\/Page\b/gu) ?? []).length;
    const declaredPageCounts = [...ascii.matchAll(/\/Count\s+(\d+)/gu)].map((match) => Number(match[1]));
    if (pageCount === 0) fail("isolated_parser_page_tree_missing");
    if (pageCount > maxPages || declaredPageCounts.some((count) => count > maxPages)) fail("isolated_parser_page_limit_exceeded");
    const objectCount = (ascii.match(/\b\d+\s+\d+\s+obj\b/gu) ?? []).length;
    const objectEnds = (ascii.match(/\bendobj\b/gu) ?? []).length;
    if (objectCount === 0 || objectCount !== objectEnds || objectCount > maxObjects) fail("isolated_parser_object_limit_or_structure_invalid");
    const declaredLengths = [...ascii.matchAll(/\/Length\s+(\d+)/gu)].map((match) => Number(match[1]));
    if (declaredLengths.some((length) => length > maxDeclaredStreamBytes)) fail("isolated_parser_declared_stream_limit_exceeded");

    const zlib = process.getBuiltinModule("node:zlib") as typeof import("node:zlib");
    let decompressedBytes = 0;
    for (const stream of ascii.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/gu)) {
      const encoded = Buffer.from(stream[1], "latin1");
      const dictionaryStart = Math.max(0, (stream.index ?? 0) - 2_048);
      const dictionary = ascii.slice(dictionaryStart, stream.index);
      if (!/\/Filter\s*(?:\/FlateDecode|\[[^\]]*\/FlateDecode)/u.test(dictionary)) continue;
      let decoded: Buffer;
      try {
        decoded = zlib.inflateSync(encoded, { maxOutputLength: Math.max(1, maxDecompressedBytes - decompressedBytes) });
      } catch {
        fail("isolated_parser_decompression_failed_or_limit_exceeded");
      }
      decompressedBytes += decoded.byteLength;
      if (decompressedBytes > maxDecompressedBytes || decoded.byteLength / Math.max(encoded.byteLength, 1) > maxDecompressionRatio) {
        fail("isolated_parser_decompression_limit_exceeded");
      }
    }
    process.stdout.write(`${JSON.stringify({
      status: "screened",
      media_type: "application/pdf",
      input_bytes: buffer.byteLength,
      page_count: pageCount,
      object_count: objectCount,
      decompressed_bytes: decompressedBytes,
      network_disabled: true,
      published: false,
    })}\n`);
  });
}
