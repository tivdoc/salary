import { link, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type AdversarialProofClass = "native_executed" | "native_blocked" | "simulated_fixture";

export type AdversarialMatrixRow = Readonly<{
  id: string;
  threat: string;
  expected: "reject" | "fail_closed";
  proof_class: AdversarialProofClass;
  reason: string;
}>;

export function validateControlledImportEntryName(value: string) {
  if (!value || value.length > 180) throw new Error("IMPORT_ENTRY_NAME_INVALID");
  if (value.normalize("NFC") !== value) throw new Error("IMPORT_ENTRY_UNICODE_NOT_NFC");
  if (value !== value.trim() || /[. ]$/u.test(value)) throw new Error("IMPORT_ENTRY_TRAILING_DOT_OR_SPACE");
  if (/^(?:\\\\|\\\\[?.]\\|\/|[A-Za-z]:[\\/])/u.test(value)) throw new Error("IMPORT_ENTRY_ABSOLUTE_DEVICE_OR_UNC_PATH");
  if (/[\\/]/u.test(value) || value === "." || value === "..") throw new Error("IMPORT_ENTRY_TRAVERSAL_OR_SEPARATOR");
  if (/:/u.test(value)) throw new Error("IMPORT_ENTRY_NTFS_ADS_FORBIDDEN");
  if (/\0/u.test(value)) throw new Error("IMPORT_ENTRY_NUL_FORBIDDEN");
  const stem = value.split(".")[0].toUpperCase();
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)) throw new Error("IMPORT_ENTRY_WINDOWS_DEVICE_NAME");
  return Object.freeze({ original: value, collision_key: value.normalize("NFC").toLocaleLowerCase("en-US") });
}

export function validateSyntheticArchiveManifest(input: Readonly<{
  entries: readonly Readonly<{ path: string; compressed_bytes: number; decompressed_bytes: number }>[];
  max_entries: number;
  max_decompressed_bytes: number;
  max_ratio: number;
}>) {
  if (input.entries.length === 0 || input.entries.length > input.max_entries) throw new Error("IMPORT_ARCHIVE_ENTRY_LIMIT");
  const collisionKeys = new Set<string>();
  let compressed = 0;
  let decompressed = 0;
  for (const entry of input.entries) {
    const normalized = validateControlledImportEntryName(entry.path);
    if (collisionKeys.has(normalized.collision_key)) throw new Error("IMPORT_ARCHIVE_NORMALIZED_PATH_COLLISION");
    collisionKeys.add(normalized.collision_key);
    if (!Number.isSafeInteger(entry.compressed_bytes) || entry.compressed_bytes < 1
      || !Number.isSafeInteger(entry.decompressed_bytes) || entry.decompressed_bytes < 0) throw new Error("IMPORT_ARCHIVE_SIZE_INVALID");
    compressed += entry.compressed_bytes;
    decompressed += entry.decompressed_bytes;
    if (entry.decompressed_bytes / entry.compressed_bytes > input.max_ratio) throw new Error("IMPORT_ARCHIVE_RATIO_LIMIT");
  }
  if (decompressed > input.max_decompressed_bytes || decompressed / Math.max(compressed, 1) > input.max_ratio) {
    throw new Error("IMPORT_ARCHIVE_DECOMPRESSION_LIMIT");
  }
  return Object.freeze({ entry_count: input.entries.length, compressed_bytes: compressed, decompressed_bytes: decompressed });
}

function safeNativeCode(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && /^[A-Z0-9_]+$/u.test(code) ? code : "NATIVE_OPERATION_UNAVAILABLE";
}

export async function probeNativeWindowsImportFilesystem(): Promise<readonly AdversarialMatrixRow[]> {
  if (process.platform !== "win32") {
    return Object.freeze([
      { id: "MC12-WIN-ADS", threat: "ntfs_ads", expected: "reject", proof_class: "simulated_fixture", reason: "HOST_NOT_WINDOWS" },
      { id: "MC12-WIN-REPARSE", threat: "reparse_point", expected: "reject", proof_class: "simulated_fixture", reason: "HOST_NOT_WINDOWS" },
      { id: "MC12-WIN-HARDLINK", threat: "hardlink", expected: "reject", proof_class: "simulated_fixture", reason: "HOST_NOT_WINDOWS" },
    ]);
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-mc12-native-"));
  const rows: AdversarialMatrixRow[] = [];
  try {
    const base = path.join(root, "base.txt");
    await writeFile(base, "synthetic\n", { flag: "wx" });
    try {
      const ads = `${base}:synthetic_stream`;
      await writeFile(ads, "synthetic ads\n", { flag: "wx" });
      rows.push({ id: "MC12-WIN-ADS", threat: "ntfs_ads", expected: "reject", proof_class: "native_executed", reason: "NTFS_ADS_CREATED_AND_POLICY_REJECTS_COLON" });
    } catch (error) {
      rows.push({ id: "MC12-WIN-ADS", threat: "ntfs_ads", expected: "reject", proof_class: "native_blocked", reason: safeNativeCode(error) });
    }
    try {
      const hardlink = path.join(root, "hardlink.txt");
      await link(base, hardlink);
      const info = await lstat(base);
      rows.push({ id: "MC12-WIN-HARDLINK", threat: "hardlink", expected: "reject", proof_class: "native_executed", reason: info.nlink > 1 ? "NLINK_GT_ONE_NATIVE" : "NLINK_UNEXPECTED" });
    } catch (error) {
      rows.push({ id: "MC12-WIN-HARDLINK", threat: "hardlink", expected: "reject", proof_class: "native_blocked", reason: safeNativeCode(error) });
    }
    try {
      const outside = await mkdtemp(path.join(os.tmpdir(), "tivdoc-mc12-target-"));
      try {
        const junction = path.join(root, "reparse-junction");
        await symlink(outside, junction, "junction");
        const info = await lstat(junction);
        rows.push({ id: "MC12-WIN-REPARSE", threat: "reparse_point", expected: "reject", proof_class: "native_executed", reason: info.isSymbolicLink() ? "NATIVE_JUNCTION_LSTAT_SYMLINK" : "NATIVE_REPARSE_CREATED" });
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    } catch (error) {
      rows.push({ id: "MC12-WIN-REPARSE", threat: "reparse_point", expected: "reject", proof_class: "native_blocked", reason: safeNativeCode(error) });
    }
    const collisionRoot = path.join(root, "collisions");
    await mkdir(collisionRoot);
    await writeFile(path.join(collisionRoot, "Case.txt"), "A", { flag: "wx" });
    let caseReason = "CASE_SENSITIVE_VOLUME";
    try {
      await writeFile(path.join(collisionRoot, "case.txt"), "B", { flag: "wx" });
    } catch (error) {
      caseReason = safeNativeCode(error) === "EEXIST" ? "CASE_INSENSITIVE_COLLISION_NATIVE" : safeNativeCode(error);
    }
    rows.push({ id: "MC12-WIN-CASE", threat: "case_normalization_collision", expected: "reject", proof_class: "native_executed", reason: caseReason });
    const names = await readdir(collisionRoot);
    if (names.length < 1) throw new Error("native_collision_probe_invalid");
    return Object.freeze(rows.sort((left, right) => left.id.localeCompare(right.id)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function buildControlledImportAdversarialMatrix(nativeRows: readonly AdversarialMatrixRow[] = []) {
  const hostClass: AdversarialProofClass = process.platform === "win32" ? "native_executed" : "simulated_fixture";
  const rows: AdversarialMatrixRow[] = [
    { id: "MC12-PATH-TRAVERSAL", threat: "path_traversal_and_absolute_paths", expected: "reject", proof_class: hostClass, reason: "PORTABLE_PATH_POLICY" },
    { id: "MC12-PATH-UNC-DEVICE", threat: "unc_device_and_ntfs_ads", expected: "reject", proof_class: hostClass, reason: "WINDOWS_PATH_POLICY" },
    { id: "MC12-NORMALIZATION", threat: "case_and_unicode_normalization_collision", expected: "reject", proof_class: hostClass, reason: "NFC_CASEFOLD_COLLISION_KEY" },
    { id: "MC12-TOCTOU", threat: "toctou_replacement", expected: "reject", proof_class: "simulated_fixture", reason: "DETERMINISTIC_REOPEN_MUTATION_FIXTURE" },
    { id: "MC12-DOCUMENT", threat: "encrypted_executable_polyglot_malformed_pdf", expected: "reject", proof_class: "simulated_fixture", reason: "SYNTHETIC_BYTES_ONLY" },
    { id: "MC12-PDF-ACTIVE", threat: "pdf_active_content_forms_annotations_javascript", expected: "reject", proof_class: "simulated_fixture", reason: "SYNTHETIC_PDF_TOKENS_ONLY" },
    { id: "MC12-ARCHIVE", threat: "archive_collisions_bombs_and_output_limits", expected: "reject", proof_class: "simulated_fixture", reason: "SYNTHETIC_ARCHIVE_MANIFEST_ONLY" },
    { id: "MC12-CRASH", threat: "crash_truncated_journal_and_power_loss", expected: "fail_closed", proof_class: "simulated_fixture", reason: "POWER_LOSS_CANNOT_BE_NATIVE_PROOF" },
    ...nativeRows,
  ];
  return Object.freeze(rows.sort((left, right) => left.id.localeCompare(right.id)));
}
