import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parserIsolationAssurance, screenUntrustedPdfIsolated } from "./index.ts";

function validPdf(marker = "isolated-screen") {
  return Buffer.from(`%PDF-1.7
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>
endobj
${`% bounded parser isolation padding ${marker}\n`.repeat(20)}
xref
0 4
0000000000 65535 f
trailer
<< /Size 4 /Root 1 0 R >>
startxref
0
%%EOF
`);
}

function compressedPdf(decoded: Buffer) {
  const encoded = deflateSync(decoded);
  return Buffer.concat([Buffer.from(`%PDF-1.7
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>
endobj
4 0 obj
<< /Length ${encoded.byteLength} /Filter /FlateDecode >>
stream
`, "latin1"), encoded, Buffer.from(`
endstream
endobj
${"% bounded compressed padding\n".repeat(20)}
xref
0 5
0000000000 65535 f
trailer
<< /Size 5 /Root 1 0 R >>
startxref
0
%%EOF
`, "latin1")]);
}

describe("separate-process untrusted PDF screening", () => {
  it("returns only a complete bounded result from a permission-restricted child", async () => {
    const result = await screenUntrustedPdfIsolated({ bytes: validPdf() });
    expect(result).toMatchObject({
      status: "screened",
      media_type: "application/pdf",
      page_count: 1,
      object_count: 3,
      network_disabled: true,
      published: false,
      application_isolation: "PARSER_APPLICATION_ISOLATION_VERIFIED",
      os_sandbox: "PARSER_OS_SANDBOX_NOT_VERIFIED",
      persistent_owner_import_enabled: false,
      workspace_cleanup_verified: true,
    });
    expect(result.request_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.receipt_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ["encryption", "/Encrypt", "isolated_parser_encrypted"],
    ["JavaScript/action", "/JavaScript /OpenAction", "isolated_parser_active_content"],
    ["AcroForm", "/AcroForm", "isolated_parser_interactive_content"],
    ["annotation", "/Annots [4 0 R]", "isolated_parser_interactive_content"],
    ["embedded file", "/EmbeddedFile /Filespec", "isolated_parser_embedded_content"],
    ["external reference", "/URI (https://example.invalid)", "isolated_parser_external_reference"],
    ["page bomb", "/Count 999999", "isolated_parser_page_limit_exceeded"],
    ["declared stream bomb", "/Length 999999999", "isolated_parser_declared_stream_limit_exceeded"],
  ])("rejects hostile %s", async (_label, marker, code) => {
    await expect(screenUntrustedPdfIsolated({ bytes: validPdf(marker) })).rejects.toThrow(code);
  });

  it("rejects polyglot trailing bytes and ZIP signatures", async () => {
    await expect(screenUntrustedPdfIsolated({ bytes: Buffer.concat([validPdf(), Buffer.from("PK\x03\x04")]) })).rejects.toThrow();
    await expect(screenUntrustedPdfIsolated({ bytes: Buffer.from(validPdf().toString("latin1").replace("bounded", "PK\x03\x04"), "latin1") })).rejects.toThrow("isolated_parser_executable_or_polyglot");
  });

  it("enforces actual decompression and ratio limits", async () => {
    const bomb = compressedPdf(Buffer.alloc(1024 * 1024, 0x41));
    await expect(screenUntrustedPdfIsolated({
      bytes: bomb,
      limits: { max_decompressed_bytes: 2 * 1024 * 1024, max_decompression_ratio: 10 },
    })).rejects.toThrow("isolated_parser_decompression_limit_exceeded");
  });

  it("enforces input, output, timeout and cancellation without returning partial output", async () => {
    await expect(screenUntrustedPdfIsolated({ bytes: validPdf(), limits: { max_input_bytes: 512 } })).rejects.toThrow("isolated_parser_input_limit_exceeded");
    await expect(screenUntrustedPdfIsolated({ bytes: validPdf(), limits: { max_output_bytes: 256, timeout_ms: 30_000 }, testOnlyBehavior: "oversize_output" })).rejects.toThrow("isolated_parser_output_limit_exceeded");
    await expect(screenUntrustedPdfIsolated({ bytes: validPdf(), limits: { timeout_ms: 50 }, testOnlyBehavior: "partial_then_hang" })).rejects.toThrow("isolated_parser_timeout");
    const controller = new AbortController();
    const pending = screenUntrustedPdfIsolated({ bytes: validPdf(), signal: controller.signal, testOnlyBehavior: "hang" });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow("isolated_parser_cancelled");
  });

  it("denies the child network canary before any connection can be created", async () => {
    await expect(screenUntrustedPdfIsolated({ bytes: validPdf(), testOnlyBehavior: "network_canary" })).resolves.toMatchObject({
      status: "network_canary",
      network_disabled: true,
      application_isolation: "PARSER_APPLICATION_ISOLATION_VERIFIED",
      os_sandbox: "PARSER_OS_SANDBOX_NOT_VERIFIED",
    });
    expect(parserIsolationAssurance.os_sandbox).toBe("PARSER_OS_SANDBOX_NOT_VERIFIED");
  });

  it("proves exact filesystem and process permission denials without claiming a kernel network boundary", async () => {
    await expect(screenUntrustedPdfIsolated({ bytes: validPdf(), testOnlyBehavior: "permission_canaries" })).resolves.toMatchObject({
      status: "permission_canaries",
      filesystem_read_denied: true,
      child_process_denied: true,
      network_kernel_denial: false,
      workspace_cleanup_verified: true,
    });
  });
});
