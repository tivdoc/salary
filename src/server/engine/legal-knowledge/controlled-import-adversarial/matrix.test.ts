import { describe, expect, it } from "vitest";
import {
  buildControlledImportAdversarialMatrix,
  probeNativeWindowsImportFilesystem,
  validateControlledImportEntryName,
  validateSyntheticArchiveManifest,
} from "./matrix.ts";

describe("MC-12 native and adversarial controlled-import matrix", () => {
  it.each([
    ["../escape.pdf", "IMPORT_ENTRY_TRAVERSAL_OR_SEPARATOR"],
    ["C:\\absolute.pdf", "IMPORT_ENTRY_ABSOLUTE_DEVICE_OR_UNC_PATH"],
    ["\\\\server\\share\\source.pdf", "IMPORT_ENTRY_ABSOLUTE_DEVICE_OR_UNC_PATH"],
    ["\\\\?\\C:\\device.pdf", "IMPORT_ENTRY_ABSOLUTE_DEVICE_OR_UNC_PATH"],
    ["source.pdf:payload", "IMPORT_ENTRY_NTFS_ADS_FORBIDDEN"],
    ["CON.pdf", "IMPORT_ENTRY_WINDOWS_DEVICE_NAME"],
    ["source.pdf. ", "IMPORT_ENTRY_TRAILING_DOT_OR_SPACE"],
    ["cafe\u0301.pdf", "IMPORT_ENTRY_UNICODE_NOT_NFC"],
  ])("rejects hostile portable/Windows entry %s", (entry, code) => {
    expect(() => validateControlledImportEntryName(entry)).toThrow(code);
  });

  it("rejects case/Unicode archive collisions and decompression bombs", () => {
    expect(() => validateSyntheticArchiveManifest({
      entries: [
        { path: "Source.pdf", compressed_bytes: 100, decompressed_bytes: 100 },
        { path: "source.PDF", compressed_bytes: 100, decompressed_bytes: 100 },
      ],
      max_entries: 10,
      max_decompressed_bytes: 10_000,
      max_ratio: 10,
    })).toThrow("IMPORT_ARCHIVE_NORMALIZED_PATH_COLLISION");
    expect(() => validateSyntheticArchiveManifest({
      entries: [{ path: "bomb.pdf", compressed_bytes: 10, decompressed_bytes: 100_000 }],
      max_entries: 10,
      max_decompressed_bytes: 1_000,
      max_ratio: 10,
    })).toThrow(/IMPORT_ARCHIVE_(?:RATIO|DECOMPRESSION)_LIMIT/u);
  });

  it("runs Windows-native probes where available and labels all other evidence honestly", async () => {
    const native = await probeNativeWindowsImportFilesystem();
    const matrix = buildControlledImportAdversarialMatrix(native);
    const threats = matrix.map((row) => row.threat);
    for (const threat of [
      "path_traversal_and_absolute_paths",
      "case_and_unicode_normalization_collision",
      "toctou_replacement",
      "pdf_active_content_forms_annotations_javascript",
      "archive_collisions_bombs_and_output_limits",
      "crash_truncated_journal_and_power_loss",
    ]) expect(threats).toContain(threat);
    expect(matrix.every((row) => ["native_executed", "native_blocked", "simulated_fixture"].includes(row.proof_class))).toBe(true);
    if (process.platform === "win32") {
      expect(native.every((row) => row.proof_class !== "simulated_fixture")).toBe(true);
    } else {
      expect(native.every((row) => row.proof_class === "simulated_fixture")).toBe(true);
    }
  });
});
