import { constants, createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  acquisitionReceiptSchema,
  acquisitionRequestSchema,
  artifactVersionSchema,
  type AcquisitionReceipt,
  type AcquisitionRequest,
  type ArtifactVersion,
} from "../../../engine/legal-knowledge/acquisition-contracts.ts";
import { legalTimestampSchema, sha256Schema } from "../../../engine/legal-knowledge/contracts.ts";
import {
  advanceControlledImportJournal,
  controlledImportSha256,
  controlledImportStableJson,
  createControlledImportJournalBinding,
  findRecoverableControlledImportBinding,
  readControlledImportJournal,
  withControlledImportLock,
} from "./controlled-import-recovery/protocol.ts";
import { screenUntrustedPdfIsolated } from "./parser-isolation/index.ts";

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PDF_PAGES = 500;
const MAX_PDF_OBJECTS = 100_000;
const MAX_DECLARED_STREAM_BYTES = 100 * 1024 * 1024;
const TEST_NOTICE = "TEST COPY OF EXISTING PUBLIC OFFICIAL ARTIFACT; NOT AN OWNER IMPORT" as const;

const controlledLedgerEventSchema = z.object({
  event_id: z.string().min(3),
  event_type: z.enum(["owner_imported", "synthetic_test_copy_imported"]),
  acquisition_request_id: z.string().min(3),
  source_id: z.string().min(3),
  artifact_version_id: z.string().min(3),
  artifact_sha256: sha256Schema,
  receipt_sha256: sha256Schema,
  attestation_type: z.enum(["owner_attestation", "synthetic_test_attestation"]),
  occurred_at: legalTimestampSchema,
  actor_type: z.literal("system"),
  reason: z.string().min(1),
  operation_id: sha256Schema,
  request_sha256: sha256Schema,
  expected_filename: z.string().min(1),
  expected_media_type: z.literal("application/pdf"),
  expected_artifact_sha256: sha256Schema.nullable(),
  actual_byte_count: z.number().int().positive(),
  artifact_record_sha256: sha256Schema,
  receipt_input_sha256: sha256Schema,
}).strict();

type ControlledLedgerEvent = z.infer<typeof controlledLedgerEventSchema>;

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function stableJson(value: unknown) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function ensureContained(rootValue: string, candidateValue: string, code: string) {
  const root = path.resolve(rootValue);
  const candidate = path.resolve(candidateValue);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(code);
  return { root, candidate };
}

function validatePortableFilename(filename: string) {
  if (!/^[^\\/:*?"<>|]{1,180}$/u.test(filename) || filename === "." || filename === "..") throw new Error("invalid_inbox_filename");
  if (filename !== filename.trim() || filename.endsWith(".") || filename.normalize("NFC") !== filename) throw new Error("invalid_inbox_filename");
  const stem = filename.split(".")[0].toUpperCase();
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)) throw new Error("windows_device_filename_forbidden");
  return filename;
}

async function assertNoReparseComponents(root: string, target: string) {
  const { candidate } = ensureContained(root, target, "controlled_path_escape");
  const components = path.relative(path.resolve(root), candidate).split(path.sep).filter(Boolean);
  let cursor = path.resolve(root);
  for (const component of components) {
    cursor = path.join(cursor, component);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error("controlled_path_reparse_point_forbidden");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function resolveIncomingRegularFile(inboxRoot: string, filenameValue: string) {
  const filename = validatePortableFilename(filenameValue);
  const root = path.resolve(inboxRoot);
  const candidate = path.resolve(root, filename);
  ensureContained(root, candidate, "inbox_path_escape");
  await assertNoReparseComponents(path.dirname(root), candidate);
  const names = await readdir(root);
  const caseMatches = names.filter((name) => name.toLocaleLowerCase("en-US") === filename.toLocaleLowerCase("en-US"));
  if (caseMatches.length !== 1 || caseMatches[0] !== filename) throw new Error("inbox_filename_case_collision");
  const info = await lstat(candidate);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("inbox_file_not_regular");
  if (info.nlink !== 1) throw new Error("inbox_hardlink_forbidden");
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("inbox_symlink_escape");
  return candidate;
}

async function writeAtomicImmutable(filePath: string, value: Uint8Array | string) {
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.pending-${randomUUID()}`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, filePath);
    return { created: true, path: filePath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let info = await lstat(filePath);
    for (let attempt = 0; info.nlink === 2 && attempt < 20; attempt += 1) {
      await delay(5);
      info = await lstat(filePath);
    }
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error("immutable_target_not_regular");
    if (!(await readFile(filePath)).equals(bytes)) throw new Error("immutable_target_mismatch");
    return { created: false, path: filePath };
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function snapshotToPrivateCopy(sourcePath: string, transactionRoot: string) {
  const handle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) throw new Error("inbox_file_identity_invalid");
    if (before.size > MAX_PDF_BYTES) throw new Error("owner_artifact_too_large");
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.byteLength !== after.size) {
      throw new Error("incoming_file_changed_during_private_copy");
    }
  } finally {
    await handle.close();
  }
  const privatePath = path.join(transactionRoot, "private-artifact.pdf");
  await writeAtomicImmutable(privatePath, bytes);
  const privateBytes = await readFile(privatePath);
  if (sha256(privateBytes) !== sha256(bytes)) throw new Error("private_copy_hash_mismatch");
  return { privatePath, bytes: privateBytes, artifactSha256: sha256(privateBytes) };
}

export function scanControlledImportMetadata(value: unknown) {
  const findings = new Set<string>();
  const forbiddenKey = /^(?:authorization|cookie|set-cookie|password|secret|token|access_token|refresh_token|session|session_id|x-api-key|exif|gps)$/iu;
  const unsafeValuePatterns: ReadonlyArray<readonly [string, RegExp]> = [
    ["authorization_value", /\bBearer\s+[A-Za-z0-9._~-]{12,}/iu],
    ["cookie_value", /\b(?:cookie|set-cookie)\s*[:=]/iu],
    ["jwt_value", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u],
    ["windows_user_path", /[A-Za-z]:\\Users\\[^\\\s]+/iu],
    ["unix_user_path", /\/(?:home|Users)\/[^/\s]+/u],
    ["email_address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu],
    ["credential_query", /[?&](?:token|key|secret|session|auth)=/iu],
  ];
  function visit(item: unknown, location: string) {
    if (Array.isArray(item)) item.forEach((entry, index) => visit(entry, `${location}[${index}]`));
    else if (item && typeof item === "object") {
      for (const [key, entry] of Object.entries(item)) {
        if (forbiddenKey.test(key)) findings.add(`${location}.${key}:forbidden_key`);
        visit(entry, `${location}.${key}`);
      }
    } else if (typeof item === "string") {
      for (const [code, pattern] of unsafeValuePatterns) if (pattern.test(item)) findings.add(`${location}:${code}`);
    }
  }
  visit(value, "$" );
  return { safe: findings.size === 0, findings: [...findings].sort() };
}

function validateExactHttpsUrl(urlValue: string, allowlistedHosts: readonly string[], code: string) {
  const url = new URL(urlValue);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) throw new Error(`${code}_invalid`);
  if (!allowlistedHosts.includes(url.hostname)) throw new Error(`${code}_host_not_allowlisted`);
  return url.toString();
}

export function validateArtifactUrlOverride(requestInput: AcquisitionRequest, artifactUrl: string) {
  const request = acquisitionRequestSchema.parse(requestInput);
  validateExactHttpsUrl(artifactUrl, request.allowlisted_hosts, "artifact_url_override");
  if (!request.allowed_artifact_urls.includes(artifactUrl)) throw new Error("artifact_url_override_not_exactly_allowlisted");
  return artifactUrl;
}

export function validateControlledPdfBytes(bytes: Uint8Array, maxBytes = MAX_PDF_BYTES) {
  const buffer = Buffer.from(bytes);
  if (buffer.byteLength > maxBytes) throw new Error("owner_artifact_too_large");
  if (buffer.byteLength < 512) throw new Error("owner_artifact_truncated");
  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("owner_artifact_pdf_magic_mismatch");
  const ascii = buffer.toString("latin1");
  const eof = ascii.lastIndexOf("%%EOF");
  if (eof < ascii.length - 2048 || eof < 0) throw new Error("owner_artifact_pdf_eof_missing");
  if (ascii.slice(eof + 5).trim().length > 0) throw new Error("owner_artifact_polyglot_trailing_payload");
  const prefix = ascii.slice(0, 4096);
  if (/<(?:!doctype\s+html|html|body)\b/iu.test(prefix)) throw new Error("owner_artifact_html_as_pdf");
  if (buffer.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])) >= 0 || buffer.subarray(0, 2).equals(Buffer.from("MZ"))) throw new Error("owner_artifact_executable_or_polyglot");
  if (/\/Encrypt\b/u.test(ascii)) throw new Error("owner_artifact_encrypted");
  if (/\/(?:JavaScript|JS|Launch|RichMedia|OpenAction|AA|SubmitForm|ImportData)\b/u.test(ascii)) throw new Error("owner_artifact_active_content");
  if (/\/(?:EmbeddedFile|EmbeddedFiles|Filespec|XFA)\b/u.test(ascii)) throw new Error("owner_artifact_embedded_content");
  if (/\/(?:URI|GoToR)\b/u.test(ascii)) throw new Error("owner_artifact_external_reference");
  if (!/(?:\bxref\b|\/Type\s*\/XRef\b)/u.test(ascii) || !/\bstartxref\b/u.test(ascii)) throw new Error("owner_artifact_xref_missing_or_corrupt");
  const pageObjects = ascii.match(/\/Type\s*\/Page\b/gu) ?? [];
  if (pageObjects.length === 0) throw new Error("owner_artifact_page_tree_missing");
  const declaredPageCounts = [...ascii.matchAll(/\/Count\s+(\d+)/gu)].map((match) => Number(match[1]));
  if (pageObjects.length > MAX_PDF_PAGES || declaredPageCounts.some((count) => count > MAX_PDF_PAGES)) throw new Error("owner_artifact_page_limit_exceeded");
  const objectStarts = ascii.match(/\b\d+\s+\d+\s+obj\b/gu) ?? [];
  const objectEnds = ascii.match(/\bendobj\b/gu) ?? [];
  if (objectStarts.length === 0 || objectStarts.length > MAX_PDF_OBJECTS || objectEnds.length !== objectStarts.length) throw new Error("owner_artifact_object_structure_invalid");
  const declaredLengths = [...ascii.matchAll(/\/Length\s+(\d+)/gu)].map((match) => Number(match[1]));
  if (declaredLengths.some((length) => length > MAX_DECLARED_STREAM_BYTES)) throw new Error("owner_artifact_declared_stream_limit_exceeded");
  return {
    media_type: "application/pdf" as const,
    page_count: pageObjects.length,
    object_count: objectStarts.length,
    parser_state: "not_attempted_by_import" as const,
    parser_isolation: "not_applicable_until_post_import_parse" as const,
  };
}

async function publishArtifactAtomically(input: Readonly<{ root: string; sourceId: string; sourceVersion: string; sha256: string; bytes: Uint8Array }>) {
  if (!/^[A-Z0-9][A-Z0-9_-]{2,79}$/u.test(input.sourceId)) throw new Error("invalid_source_id");
  const target = path.resolve(input.root, input.sourceId, input.sourceVersion, `${input.sha256}.pdf`);
  ensureContained(input.root, target, "artifact_path_escape");
  await assertNoReparseComponents(path.resolve(input.root), path.dirname(target));
  await mkdir(path.dirname(target), { recursive: true });
  const [realRoot, realParent] = await Promise.all([realpath(path.resolve(input.root)), realpath(path.dirname(target))]);
  if (path.relative(realRoot, realParent).startsWith("..")) throw new Error("artifact_reparse_escape");
  const result = await writeAtomicImmutable(target, input.bytes);
  if (sha256(await readFile(target)) !== input.sha256) throw new Error("published_artifact_hash_mismatch");
  return result;
}

export type ControlledImportFault =
  | "after_received"
  | "after_private_copy"
  | "after_validation"
  | "after_artifact_publish"
  | "after_event_publish"
  | "after_ledger_append";

export async function importControlledOfficialArtifact(input: Readonly<{
  request: AcquisitionRequest;
  incomingRoot: string;
  artifactRoot: string;
  ledgerRoot: string;
  originalFilename: string;
  receiptFilename: string;
  requiredAttestationType?: "owner_attestation" | "synthetic_test_attestation";
  faultInjection?: ControlledImportFault;
  afterPrivateCopyForTest?: () => Promise<void>;
}>) {
  const request = acquisitionRequestSchema.parse(input.request);
  if (input.originalFilename !== request.recommended_filename) throw new Error("request_original_filename_mismatch");
  if (input.receiptFilename !== "receipt.json") throw new Error("request_receipt_filename_mismatch");
  for (const controlledRoot of [input.ledgerRoot, input.artifactRoot]) {
    const resolvedRoot = path.resolve(controlledRoot);
    await assertNoReparseComponents(path.dirname(resolvedRoot), resolvedRoot);
    await mkdir(resolvedRoot, { recursive: true });
    await assertNoReparseComponents(path.dirname(resolvedRoot), resolvedRoot);
  }
  const requestSha256 = controlledImportSha256(controlledImportStableJson(request));
  let initialRawReceipt: string | null = null;
  let binding;
  try {
    const inbox = path.resolve(input.incomingRoot, request.acquisition_request_id);
    const receiptPath = await resolveIncomingRegularFile(inbox, input.receiptFilename);
    initialRawReceipt = await readFile(receiptPath, "utf8");
    const rawScan = scanControlledImportMetadata({ receipt: initialRawReceipt });
    if (!rawScan.safe) throw new Error("acquisition_metadata_secret_or_pii_detected");
    binding = createControlledImportJournalBinding({
      request,
      acquisitionRequestId: request.acquisition_request_id,
      sourceId: request.source_id,
      expectedFilename: request.recommended_filename,
      expectedMediaType: request.expected_media_type,
      expectedArtifactSha256: request.expected_document_identity.artifact_sha256 ?? null,
      receiptInputSha256: sha256(initialRawReceipt),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    binding = await findRecoverableControlledImportBinding({
      ledgerRoot: input.ledgerRoot,
      requestSha256,
      acquisitionRequestId: request.acquisition_request_id,
      sourceId: request.source_id,
    });
    if (!binding) throw error;
  }
  return await withControlledImportLock({
    ledgerRoot: input.ledgerRoot,
    acquisitionRequestId: request.acquisition_request_id,
    sourceId: request.source_id,
  }, async () => {
    const existingJournal = await readControlledImportJournal(input.ledgerRoot, binding.operation_id);
    if (existingJournal.at(-1)?.stage === "rejected") throw new Error("controlled_import_operation_rejected");
    if (existingJournal.at(-1)?.stage === "ledger_appended") {
      const final = existingJournal.at(-1);
      const artifactSha256 = final?.published_artifact_sha256;
      if (!artifactSha256 || !final.receipt_sha256) throw new Error("controlled_import_committed_journal_incomplete");
      await verifyControlledAcquisitionLedger({ ledgerRoot: input.ledgerRoot, artifactRoot: input.artifactRoot });
      const artifactVersion = await readImmutableLedgerFile(path.resolve(input.ledgerRoot, `${artifactSha256}.json`), artifactVersionSchema);
      const event = await readImmutableLedgerFile(path.resolve(input.ledgerRoot, "events", `${artifactSha256}.json`), controlledLedgerEventSchema);
      const artifactPath = await locateStoredArtifact(input.artifactRoot, artifactVersion);
      const content = validateControlledPdfBytes(await readFile(artifactPath));
      return {
        created: false,
        idempotent: true,
        artifact_created: false,
        event_created: false,
        ledger_committed: true,
        artifact_version: artifactVersion,
        page_count: content.page_count,
        private_copy_sha256: artifactSha256,
        published_sha256: artifactSha256,
        receipt_sha256: final.receipt_sha256,
        attestation_type: event.attestation_type,
        test_only_notice: event.attestation_type === "synthetic_test_attestation" ? TEST_NOTICE : null,
        parser_state: "screened_in_isolated_process" as const,
        parser_isolation: "separate_permission_restricted_process" as const,
        parser_residual_gap: "os_level_network_namespace_and_power_loss_durability_not_proven",
        journal_operation_id: binding.operation_id,
        state_sequence: ["received", "quarantined", "validated", "published", "ledger_appended"] as const,
        no_partial_selection_before_ledger_commit: true,
      };
    }
    const transactionRoot = path.resolve(input.ledgerRoot, ".transactions", binding.operation_id);
    ensureContained(input.ledgerRoot, transactionRoot, "transaction_path_escape");
    await mkdir(transactionRoot, { recursive: true });
    try {
      await advanceControlledImportJournal({ ledgerRoot: input.ledgerRoot, binding, stage: "received" });
      if (input.faultInjection === "after_received") throw new Error("injected_interruption_after_received");

      const privateReceiptPath = path.join(transactionRoot, "private-receipt.json");
      const privateArtifactPath = path.join(transactionRoot, "private-artifact.pdf");
      let rawReceipt: string;
      try {
        rawReceipt = await readFile(privateReceiptPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (initialRawReceipt !== null) rawReceipt = initialRawReceipt;
        else {
          const inbox = path.resolve(input.incomingRoot, request.acquisition_request_id);
          const receiptPath = await resolveIncomingRegularFile(inbox, input.receiptFilename);
          rawReceipt = await readFile(receiptPath, "utf8");
        }
        const rawScan = scanControlledImportMetadata({ receipt: rawReceipt });
        if (!rawScan.safe) throw new Error("acquisition_metadata_secret_or_pii_detected");
        await writeAtomicImmutable(privateReceiptPath, rawReceipt);
      }
      let snapshot: { privatePath: string; bytes: Buffer; artifactSha256: string };
      try {
        const bytes = await readFile(privateArtifactPath);
        snapshot = { privatePath: privateArtifactPath, bytes, artifactSha256: sha256(bytes) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const inbox = path.resolve(input.incomingRoot, request.acquisition_request_id);
        const originalPath = await resolveIncomingRegularFile(inbox, input.originalFilename);
        snapshot = await snapshotToPrivateCopy(originalPath, transactionRoot);
      }
      if (input.afterPrivateCopyForTest) await input.afterPrivateCopyForTest();
      const privateReceiptSha256 = sha256(rawReceipt);
      await advanceControlledImportJournal({
        ledgerRoot: input.ledgerRoot,
        binding,
        stage: "quarantined",
        privateArtifactSha256: snapshot.artifactSha256,
        receiptSha256: privateReceiptSha256,
      });
      if (input.faultInjection === "after_private_copy") throw new Error("injected_interruption_after_private_copy");

      const rawScan = scanControlledImportMetadata({ receipt: rawReceipt });
      if (!rawScan.safe) throw new Error("acquisition_metadata_secret_or_pii_detected");
      const receipt = acquisitionReceiptSchema.parse(JSON.parse(rawReceipt));
      if (input.requiredAttestationType && receipt.attestation_type !== input.requiredAttestationType) throw new Error("receipt_attestation_type_mismatch");
      if (!request.allowed_attestation_types.includes(receipt.attestation_type)) throw new Error("receipt_attestation_type_not_allowed");
      if (receipt.acquisition_request_id !== request.acquisition_request_id || receipt.source_id !== request.source_id) throw new Error("owner_receipt_request_mismatch");
      if (receipt.original_filename !== input.originalFilename) throw new Error("owner_receipt_filename_mismatch");
      if (receipt.expected_media_type !== request.expected_media_type) throw new Error("owner_receipt_media_type_mismatch");
      if (receipt.expected_document_title !== request.expected_document_title) throw new Error("owner_receipt_document_identity_mismatch");
      validateExactHttpsUrl(receipt.landing_url, request.allowlisted_hosts, "owner_receipt_landing_url");
      validateArtifactUrlOverride(request, receipt.artifact_url);
      validateExactHttpsUrl(receipt.final_url, request.allowlisted_hosts, "owner_receipt_final_url");
      if (receipt.landing_url !== request.canonical_landing_url) throw new Error("owner_receipt_landing_url_mismatch");
      if (!request.allowed_final_urls.includes(receipt.final_url)) throw new Error("owner_receipt_final_url_not_exactly_allowlisted");
      if (request.artifact_url && receipt.artifact_url !== request.artifact_url) throw new Error("owner_receipt_artifact_url_mismatch");
      if (receipt.attestation_type === "synthetic_test_attestation" && receipt.test_only_notice !== TEST_NOTICE) throw new Error("synthetic_test_notice_missing");
      if (snapshot.artifactSha256 !== receipt.artifact_sha256) throw new Error("owner_receipt_artifact_hash_mismatch");
      if (request.expected_document_identity.artifact_sha256 && snapshot.artifactSha256 !== request.expected_document_identity.artifact_sha256) throw new Error("request_document_hash_mismatch");

      const content = validateControlledPdfBytes(snapshot.bytes);
      const isolated = await screenUntrustedPdfIsolated({ bytes: snapshot.bytes });
      if (isolated.status !== "screened" || isolated.input_bytes !== snapshot.bytes.byteLength || isolated.page_count !== content.page_count) {
        throw new Error("isolated_parser_binding_mismatch");
      }
      const receiptSha256 = sha256(stableJson(receipt));
      await advanceControlledImportJournal({
        ledgerRoot: input.ledgerRoot,
        binding,
        stage: "validated",
        privateArtifactSha256: snapshot.artifactSha256,
        receiptSha256,
      });
      if (input.faultInjection === "after_validation") throw new Error("injected_interruption_after_validation");

      const sourceVersion = receipt.attestation_type === "synthetic_test_attestation" ? "synthetic-test-v0.3.1" : "owner-v0.3.1";
      const artifactVersion = artifactVersionSchema.parse({
        artifact_version_id: `artifact:${request.source_id}:${snapshot.artifactSha256}`,
        source_id: request.source_id,
        legal_text_version_id: null,
        acquisition_request_id: request.acquisition_request_id,
        artifact_sha256: snapshot.artifactSha256,
        byte_count: snapshot.bytes.byteLength,
        media_type: content.media_type,
        original_filename: input.originalFilename,
        landing_url: receipt.landing_url,
        artifact_url: receipt.artifact_url,
        final_url: receipt.final_url,
        acquired_at: receipt.acquired_at,
        acquisition_state: "acquired",
        parse_state: "not_attempted",
        evidence_state: "incomplete",
        review_state: "needs_review",
        activation_state: "inactive",
        provenance: {
          promulgation_publisher: "unknown_pending_provenance_review",
          artifact_host: new URL(receipt.final_url).hostname,
          artifact_role: "official_institutional_copy",
          canonicality_status: "official_copy_not_primary_promulgation",
          acquisition_method: receipt.acquisition_method,
        },
      });
      const ledgerRecordSha256 = controlledImportSha256(controlledImportStableJson(artifactVersion));
      const existingLedgerPath = path.resolve(input.ledgerRoot, `${snapshot.artifactSha256}.json`);
      try {
        const existing = artifactVersionSchema.parse(JSON.parse(await readFile(existingLedgerPath, "utf8")));
        if (controlledImportStableJson(existing) !== controlledImportStableJson(artifactVersion)) throw new Error("existing_artifact_identity_conflict");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const stored = await publishArtifactAtomically({ root: input.artifactRoot, sourceId: request.source_id, sourceVersion, sha256: snapshot.artifactSha256, bytes: snapshot.bytes });
      await advanceControlledImportJournal({
        ledgerRoot: input.ledgerRoot,
        binding,
        stage: "published",
        privateArtifactSha256: snapshot.artifactSha256,
        receiptSha256,
        publishedArtifactSha256: snapshot.artifactSha256,
      });
      if (input.faultInjection === "after_artifact_publish") throw new Error("injected_interruption_after_artifact_publish");
      const event = controlledLedgerEventSchema.parse({
        event_id: `${receipt.attestation_type === "synthetic_test_attestation" ? "synthetic-test-import" : "owner-import"}:${snapshot.artifactSha256}`,
        event_type: receipt.attestation_type === "synthetic_test_attestation" ? "synthetic_test_copy_imported" : "owner_imported",
        acquisition_request_id: request.acquisition_request_id,
        source_id: request.source_id,
        artifact_version_id: artifactVersion.artifact_version_id,
        artifact_sha256: snapshot.artifactSha256,
        receipt_sha256: receiptSha256,
        attestation_type: receipt.attestation_type,
        occurred_at: receipt.acquired_at,
        actor_type: "system",
        reason: receipt.attestation_type === "synthetic_test_attestation"
          ? "test_copy_of_existing_public_official_artifact_imported_for_tooling_validation_only"
          : "owner_attested_official_download_imported_without_review_or_activation",
        operation_id: binding.operation_id,
        request_sha256: binding.request_sha256,
        expected_filename: binding.expected_filename,
        expected_media_type: binding.expected_media_type,
        expected_artifact_sha256: binding.expected_artifact_sha256,
        actual_byte_count: snapshot.bytes.byteLength,
        artifact_record_sha256: ledgerRecordSha256,
        receipt_input_sha256: binding.receipt_input_sha256,
      });
      // Artifacts and events remain unreachable until the root ledger record is the
      // final commit marker. Journal files are recovery evidence, never selectors.
      const eventStored = await writeAtomicImmutable(path.resolve(input.ledgerRoot, "events", `${snapshot.artifactSha256}.json`), stableJson(event));
      if (input.faultInjection === "after_event_publish") throw new Error("injected_interruption_after_event_publish");
      const ledgerStored = await writeAtomicImmutable(existingLedgerPath, controlledImportStableJson(artifactVersion));
      await advanceControlledImportJournal({
        ledgerRoot: input.ledgerRoot,
        binding,
        stage: "ledger_appended",
        privateArtifactSha256: snapshot.artifactSha256,
        receiptSha256,
        publishedArtifactSha256: snapshot.artifactSha256,
        ledgerRecordSha256,
      });
      if (input.faultInjection === "after_ledger_append") throw new Error("injected_interruption_after_ledger_append");
      return {
        created: ledgerStored.created,
        idempotent: !ledgerStored.created,
        artifact_created: stored.created,
        event_created: eventStored.created,
        ledger_committed: true,
        artifact_version: artifactVersion,
        page_count: isolated.page_count,
        private_copy_sha256: snapshot.artifactSha256,
        published_sha256: snapshot.artifactSha256,
        receipt_sha256: receiptSha256,
        attestation_type: receipt.attestation_type,
        test_only_notice: receipt.attestation_type === "synthetic_test_attestation" ? TEST_NOTICE : null,
        parser_state: "screened_in_isolated_process" as const,
        parser_isolation: "separate_permission_restricted_process" as const,
        parser_residual_gap: "os_level_network_namespace_and_power_loss_durability_not_proven",
        journal_operation_id: binding.operation_id,
        state_sequence: ["received", "quarantined", "validated", "published", "ledger_appended"] as const,
        no_partial_selection_before_ledger_commit: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "controlled_import_unknown_failure";
      if (!message.startsWith("injected_interruption_")) {
        const journal = await readControlledImportJournal(input.ledgerRoot, binding.operation_id).catch(() => []);
        const terminal = journal.at(-1)?.stage;
        if (terminal !== "ledger_appended" && terminal !== "rejected") {
          const code = /^[a-z0-9_]+$/u.test(message) ? message : "controlled_import_validation_failed";
          await advanceControlledImportJournal({ ledgerRoot: input.ledgerRoot, binding, stage: "rejected", safeErrorCode: code }).catch(() => undefined);
        }
      }
      throw error;
    }
  });
}

async function readImmutableLedgerFile<T>(filePath: string, schema: z.ZodType<T>) {
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error("ledger_file_not_immutable_regular_file");
  return schema.parse(JSON.parse(await readFile(filePath, "utf8")));
}

function sourceVersionForRecord(record: ArtifactVersion) {
  if (record.provenance.acquisition_method === "synthetic_test_copy_existing_public_official_artifact") return "synthetic-test-v0.3.1";
  return "owner-v0.3.1";
}

async function locateStoredArtifact(artifactRoot: string, record: ArtifactVersion) {
  const versions = [sourceVersionForRecord(record), "owner-v0.2"];
  for (const version of versions) {
    const candidate = path.resolve(artifactRoot, record.source_id, version, `${record.artifact_sha256}.pdf`);
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("owner_ledger_artifact_missing");
}

export async function verifyControlledAcquisitionLedger(input: Readonly<{
  ledgerRoot: string;
  artifactRoot: string;
  requiredRequestIds?: readonly string[];
  strictRequiredInstances?: boolean;
}>) {
  for (const controlledRoot of [input.ledgerRoot, input.artifactRoot]) {
    const resolvedRoot = path.resolve(controlledRoot);
    try {
      await assertNoReparseComponents(path.dirname(resolvedRoot), resolvedRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  let names: string[] = [];
  try {
    names = (await readdir(input.ledgerRoot)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const verified: string[] = [];
  const importedRequestIds = new Set<string>();
  let persistentOwnerImportEntries = 0;
  let syntheticTestImportEntries = 0;
  for (const name of names) {
    const record = await readImmutableLedgerFile(path.resolve(input.ledgerRoot, name), artifactVersionSchema);
    const event = await readImmutableLedgerFile(path.resolve(input.ledgerRoot, "events", name), controlledLedgerEventSchema);
    if (event.artifact_version_id !== record.artifact_version_id || event.artifact_sha256 !== record.artifact_sha256 || event.source_id !== record.source_id || event.acquisition_request_id !== record.acquisition_request_id) {
      throw new Error("owner_ledger_event_binding_mismatch");
    }
    if (event.expected_filename !== record.original_filename || event.expected_media_type !== record.media_type || event.actual_byte_count !== record.byte_count) throw new Error("owner_ledger_expected_identity_mismatch");
    const recordSha256 = controlledImportSha256(controlledImportStableJson(record));
    if (event.artifact_record_sha256 !== recordSha256) throw new Error("owner_ledger_record_hash_binding_mismatch");
    const journal = await readControlledImportJournal(input.ledgerRoot, event.operation_id);
    const journalFinal = journal.at(-1);
    if (journalFinal?.stage !== "ledger_appended" || journalFinal.binding.request_sha256 !== event.request_sha256 || journalFinal.binding.receipt_input_sha256 !== event.receipt_input_sha256 || journalFinal.ledger_record_sha256 !== recordSha256) {
      throw new Error("owner_ledger_journal_binding_mismatch");
    }
    const artifactPath = await locateStoredArtifact(input.artifactRoot, record);
    const artifactInfo = await lstat(artifactPath);
    if (artifactInfo.isSymbolicLink() || !artifactInfo.isFile() || artifactInfo.nlink !== 1) throw new Error("owner_ledger_artifact_not_immutable_regular_file");
    const bytes = await readFile(artifactPath);
    if (sha256(bytes) !== record.artifact_sha256) throw new Error("owner_ledger_artifact_hash_mismatch");
    validateControlledPdfBytes(bytes);
    verified.push(record.artifact_version_id);
    if (event.event_type === "owner_imported") persistentOwnerImportEntries += 1;
    else syntheticTestImportEntries += 1;
    if (record.acquisition_request_id) importedRequestIds.add(record.acquisition_request_id);
  }
  const required = [...new Set(input.requiredRequestIds ?? [])].sort();
  const missing = required.filter((requestId) => !importedRequestIds.has(requestId));
  if (input.strictRequiredInstances && missing.length > 0) {
    return { status: "REQUIRED_IMPORTS_MISSING" as const, exit_code: 4 as const, ledger_entries: names.length, persistent_owner_import_entries: persistentOwnerImportEntries, synthetic_test_import_entries: syntheticTestImportEntries, verified_artifact_version_ids: verified, missing_required_request_ids: missing };
  }
  if (names.length === 0) {
    return { status: "NO_IMPORTS_TO_VERIFY" as const, exit_code: 0 as const, ledger_entries: 0, persistent_owner_import_entries: 0, synthetic_test_import_entries: 0, verified_artifact_version_ids: [], missing_required_request_ids: missing };
  }
  return { status: "ACQUISITION_IMPORTS_VERIFIED" as const, exit_code: 0 as const, ledger_entries: names.length, persistent_owner_import_entries: persistentOwnerImportEntries, synthetic_test_import_entries: syntheticTestImportEntries, verified_artifact_version_ids: verified, missing_required_request_ids: missing };
}

async function listPdfHashes(root: string) {
  const hashes = new Set<string>();
  async function visit(directory: string) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && /^([a-f0-9]{64})\.pdf$/u.test(entry.name)) hashes.add(entry.name.slice(0, 64));
    }
  }
  await visit(root);
  return hashes;
}

export async function inspectControlledImportRecovery(input: Readonly<{ ledgerRoot: string; artifactRoot: string }>) {
  const records = new Set<string>();
  const events = new Set<string>();
  try {
    for (const name of await readdir(input.ledgerRoot)) if (/^[a-f0-9]{64}\.json$/u.test(name)) records.add(name.slice(0, 64));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    for (const name of await readdir(path.join(input.ledgerRoot, "events"))) if (/^[a-f0-9]{64}\.json$/u.test(name)) events.add(name.slice(0, 64));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const artifacts = await listPdfHashes(input.artifactRoot);
  return {
    committed_record_hashes: [...records].sort(),
    orphan_event_hashes: [...events].filter((hashValue) => !records.has(hashValue)).sort(),
    orphan_artifact_hashes: [...artifacts].filter((hashValue) => !records.has(hashValue)).sort(),
    selectable_hashes: [...records].filter((hashValue) => events.has(hashValue) && artifacts.has(hashValue)).sort(),
    orphan_outputs_are_not_selectable: true,
  };
}

export function controlledImportInstanceReadiness(verification: Awaited<ReturnType<typeof verifyControlledAcquisitionLedger>>, requiredRequestId: string) {
  const ready = verification.exit_code === 0
    && verification.status === "ACQUISITION_IMPORTS_VERIFIED"
    && verification.missing_required_request_ids.length === 0
    && verification.verified_artifact_version_ids.length > 0;
  return {
    status: ready ? "TEST_ACQUISITION_INSTANCE_VERIFIED" as const : "TEST_ACQUISITION_INSTANCE_NOT_VERIFIED" as const,
    ready,
    required_request_id: requiredRequestId,
    usable_for_legal_rules: false,
    activates_source: false,
  };
}

export function controlledImportPersistentReadiness(verification: Awaited<ReturnType<typeof verifyControlledAcquisitionLedger>>) {
  const ready = verification.exit_code === 0
    && verification.status === "ACQUISITION_IMPORTS_VERIFIED"
    && verification.persistent_owner_import_entries > 0;
  return {
    status: ready ? "PERSISTENT_OWNER_IMPORTS_VERIFIED" as const : "PERSISTENT_OWNER_IMPORTS_NOT_VERIFIED" as const,
    ready,
    persistent_owner_import_entries: verification.persistent_owner_import_entries,
    synthetic_test_import_entries_excluded: verification.synthetic_test_import_entries,
    usable_for_legal_rules: false,
    activates_source: false,
  };
}

export async function hashFileStreaming(filePath: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

export type { AcquisitionReceipt, AcquisitionRequest, ControlledLedgerEvent };
