import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  acquisitionMethodSchema,
  acquisitionReceiptSchema,
  acquisitionRequestSchema,
  artifactRoleSchema,
  artifactVersionSchema,
  catalogObservationSchema,
  legalInstrumentSchema,
  legalTextVersionSchema,
  type AcquisitionRequest,
  type ArtifactVersion,
} from "../../../engine/legal-knowledge/acquisition-contracts.ts";
import { legalTimestampSchema, sha256Schema } from "../../../engine/legal-knowledge/contracts.ts";
import { storeImmutableLegalArtifact } from "./artifacts.ts";

const acquisitionTargetSchema = z.object({
  target_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/),
  source_id: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{2,79}$/),
  instrument_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/),
  target_kind: z.enum(["artifact", "catalog"]),
  canonical_landing_url: z.string().url().refine((value) => value.startsWith("https://")),
  artifact_url: z.string().url().refine((value) => value.startsWith("https://")).nullable(),
  allowlisted_hosts: z.array(z.string().min(1)).min(1),
  expected_document_title: z.string().min(1),
  recommended_filename: z.string().regex(/^[^\\/:*?"<>|]{1,180}$/),
  required: z.literal(true),
  existing_source_version: z.string().min(1).nullable(),
  browser_outcome: z.enum(["not_attempted", "discovered", "acquired", "partial", "unavailable"]),
  browser_safe_error_code: z.string().min(1).nullable(),
}).strict();

export const acquisitionTargetRegistrySchema = z.object({
  schema_version: z.literal("legal-acquisition-targets-v0.2"),
  targets: z.array(acquisitionTargetSchema).min(1),
}).strict().superRefine((registry, context) => {
  const ids = new Set<string>();
  for (const target of registry.targets) {
    if (ids.has(target.target_id)) context.addIssue({ code: "custom", message: `duplicate_target:${target.target_id}` });
    ids.add(target.target_id);
    for (const url of [target.canonical_landing_url, target.artifact_url].filter(Boolean) as string[]) {
      if (!target.allowlisted_hosts.includes(new URL(url).hostname)) context.addIssue({ code: "custom", message: `target_host_not_allowlisted:${target.target_id}` });
    }
  }
});

export const provenanceRegistrySchema = z.object({
  schema_version: z.literal("legal-provenance-v0.2"),
  instruments: z.array(legalInstrumentSchema),
  legal_text_versions: z.array(legalTextVersionSchema),
  provenance: z.array(z.object({
    source_id: z.string().min(3),
    legal_force: z.enum(["binding", "non_binding", "unknown"]),
    instrument_type: z.string().min(1),
    instrument_issuer: z.string().min(1),
    promulgation_publisher: z.string().min(1),
    artifact_host: z.string().min(1),
    artifact_role: artifactRoleSchema,
    consolidation_as_of: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("unknown")]),
    canonicality_status: z.enum(["canonical_primary_publication", "official_copy_not_primary_promulgation", "official_consolidation_date_unknown", "discovery_only"]),
    acquisition_method: acquisitionMethodSchema,
    authority_not_inferred_from_host: z.literal(true),
  }).strict()),
}).strict().superRefine((registry, context) => {
  const instrumentIds = new Set<string>();
  const sourceIds = new Set<string>();
  for (const instrument of registry.instruments) {
    if (instrumentIds.has(instrument.instrument_id)) context.addIssue({ code: "custom", message: `duplicate_instrument:${instrument.instrument_id}` });
    if (sourceIds.has(instrument.source_id)) context.addIssue({ code: "custom", message: `duplicate_instrument_source:${instrument.source_id}` });
    instrumentIds.add(instrument.instrument_id);
    sourceIds.add(instrument.source_id);
  }
  const legalVersionIds = new Set<string>();
  for (const version of registry.legal_text_versions) {
    if (legalVersionIds.has(version.legal_text_version_id)) context.addIssue({ code: "custom", message: `duplicate_legal_text_version:${version.legal_text_version_id}` });
    if (!instrumentIds.has(version.instrument_id)) context.addIssue({ code: "custom", message: `unknown_legal_text_instrument:${version.instrument_id}` });
    legalVersionIds.add(version.legal_text_version_id);
  }
  const provenanceSources = new Set<string>();
  for (const provenance of registry.provenance) {
    if (provenanceSources.has(provenance.source_id)) context.addIssue({ code: "custom", message: `duplicate_provenance_source:${provenance.source_id}` });
    if (!sourceIds.has(provenance.source_id)) context.addIssue({ code: "custom", message: `unknown_provenance_source:${provenance.source_id}` });
    provenanceSources.add(provenance.source_id);
  }
});

const acquisitionLedgerEventSchema = z.object({
  event_id: z.string().min(3),
  event_type: z.enum(["owner_imported", "owner_import_verified"]),
  acquisition_request_id: z.string().min(3),
  source_id: z.string().min(3),
  artifact_version_id: z.string().min(3),
  artifact_sha256: sha256Schema,
  occurred_at: legalTimestampSchema,
  actor_type: z.literal("system"),
  reason: z.string().min(1),
}).strict();

export const defaultAcquisitionTargetPath = path.resolve("src", "server", "engine", "legal-knowledge", "legal-acquisition-targets.v0.2.json");
export const defaultProvenancePath = path.resolve("src", "server", "engine", "legal-knowledge", "legal-provenance.v0.2.json");
export const defaultBrowserObservationPath = path.resolve("src", "server", "engine", "legal-knowledge", "legal-browser-observations.v0.2.json");

export async function loadAcquisitionTargets(filePath = defaultAcquisitionTargetPath) {
  return acquisitionTargetRegistrySchema.parse(JSON.parse(await readFile(filePath, "utf8")));
}

export async function loadProvenanceRegistry(filePath = defaultProvenancePath) {
  return provenanceRegistrySchema.parse(JSON.parse(await readFile(filePath, "utf8")));
}

export async function loadBrowserObservations(filePath = defaultBrowserObservationPath) {
  const schema = z.object({ schema_version: z.literal("legal-browser-observations-v0.2"), observations: z.array(catalogObservationSchema) }).strict();
  return schema.parse(JSON.parse(await readFile(filePath, "utf8")));
}

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateHost(urlValue: string, allowlistedHosts: readonly string[]) {
  const url = new URL(urlValue);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("owner_receipt_url_invalid");
  if (!allowlistedHosts.includes(url.hostname)) throw new Error("owner_receipt_host_not_allowlisted");
}

export function validateOwnerPdfBytes(bytes: Uint8Array, maxBytes = 20 * 1024 * 1024) {
  if (bytes.byteLength > maxBytes) throw new Error("owner_artifact_too_large");
  if (bytes.byteLength < 512) throw new Error("owner_artifact_truncated");
  const prefix = Buffer.from(bytes.slice(0, Math.min(bytes.byteLength, 4096)));
  if (!prefix.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("owner_artifact_pdf_magic_mismatch");
  const ascii = Buffer.from(bytes).toString("latin1");
  if (!/%%EOF\s*$/u.test(ascii.slice(-2048))) throw new Error("owner_artifact_pdf_eof_missing");
  if (Buffer.from(bytes).indexOf(Buffer.from("MZ")) >= 0 || Buffer.from(bytes).indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])) >= 0 || /<(?:!doctype\s+html|html|body)\b/iu.test(ascii.slice(0, 4096))) {
    throw new Error("owner_artifact_executable_or_polyglot");
  }
  if (/\/Encrypt\b/u.test(ascii)) throw new Error("owner_artifact_encrypted");
  if (/\/(?:JavaScript|JS|Launch|EmbeddedFile|RichMedia|OpenAction|AA)\b/u.test(ascii)) throw new Error("owner_artifact_active_content");
  const pageCount = (ascii.match(/\/Type\s*\/Page\b/gu) ?? []).length;
  if (pageCount === 0) throw new Error("owner_artifact_page_tree_missing");
  if (pageCount > 500) throw new Error("owner_artifact_page_limit_exceeded");
  return { media_type: "application/pdf" as const, page_count: pageCount };
}

async function containedRegularFile(inboxRoot: string, filename: string) {
  if (!/^[^\\/:*?"<>|]{1,180}$/u.test(filename)) throw new Error("invalid_inbox_filename");
  const root = path.resolve(inboxRoot);
  const candidate = path.resolve(root, filename);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("inbox_path_escape");
  const stat = await lstat(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("inbox_file_not_regular");
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  const realRelative = path.relative(realRoot, realCandidate);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error("inbox_symlink_escape");
  return candidate;
}

export function acquisitionRequestForTarget(
  target: z.infer<typeof acquisitionTargetSchema>,
  failureEvidence: AcquisitionRequest["failure_evidence"],
) {
  return acquisitionRequestSchema.parse({
    acquisition_request_id: target.target_id,
    source_id: target.source_id,
    instrument_id: target.instrument_id,
    canonical_landing_url: target.canonical_landing_url,
    artifact_url: target.artifact_url,
    allowlisted_hosts: target.allowlisted_hosts,
    expected_document_title: target.expected_document_title,
    recommended_filename: target.recommended_filename,
    failure_evidence: failureEvidence,
    receipt_template: {
      acquisition_request_id: target.target_id,
      source_id: target.source_id,
      landing_url: target.canonical_landing_url,
      actor_type: "owner",
      acquisition_method: "owner_attested_official_download",
      unchanged_original: true,
      used_print_to_pdf: false,
    },
  });
}

async function writeImmutableJson(filePath: string, value: unknown) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, content, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(filePath, "utf8") !== content) throw new Error("append_only_ledger_mismatch");
    return false;
  }
}

export async function importOwnerOfficialArtifact(input: Readonly<{
  request: AcquisitionRequest;
  incomingRoot: string;
  artifactRoot: string;
  ledgerRoot: string;
  originalFilename: string;
  receiptFilename: string;
  now?: () => string;
}>) {
  const request = acquisitionRequestSchema.parse(input.request);
  const inbox = path.resolve(input.incomingRoot, request.acquisition_request_id);
  const [originalPath, receiptPath] = await Promise.all([
    containedRegularFile(inbox, input.originalFilename),
    containedRegularFile(inbox, input.receiptFilename),
  ]);
  const receipt = acquisitionReceiptSchema.parse(JSON.parse(await readFile(receiptPath, "utf8")));
  if (receipt.acquisition_request_id !== request.acquisition_request_id || receipt.source_id !== request.source_id) throw new Error("owner_receipt_request_mismatch");
  if (receipt.original_filename !== input.originalFilename) throw new Error("owner_receipt_filename_mismatch");
  for (const url of [receipt.landing_url, receipt.artifact_url, receipt.final_url]) validateHost(url, request.allowlisted_hosts);
  if (receipt.landing_url !== request.canonical_landing_url) throw new Error("owner_receipt_landing_url_mismatch");
  if (request.artifact_url && receipt.artifact_url !== request.artifact_url) throw new Error("owner_receipt_artifact_url_mismatch");
  const bytes = await readFile(originalPath);
  const content = validateOwnerPdfBytes(bytes);
  const artifactSha256 = hash(bytes);
  const stored = await storeImmutableLegalArtifact({
    root: input.artifactRoot,
    sourceId: request.source_id,
    sourceVersion: "owner-v0.2",
    artifactSha256,
    extension: "pdf",
    bytes,
  });
  const artifactVersion = artifactVersionSchema.parse({
    artifact_version_id: `artifact:${request.source_id}:${artifactSha256}`,
    source_id: request.source_id,
    legal_text_version_id: null,
    acquisition_request_id: request.acquisition_request_id,
    artifact_sha256: artifactSha256,
    byte_count: bytes.byteLength,
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
      acquisition_method: "owner_attested_official_download",
    },
  });
  const ledgerPath = path.resolve(input.ledgerRoot, `${artifactSha256}.json`);
  const created = await writeImmutableJson(ledgerPath, artifactVersion);
  const event = acquisitionLedgerEventSchema.parse({
    event_id: `owner-import:${artifactSha256}`,
    event_type: "owner_imported",
    acquisition_request_id: request.acquisition_request_id,
    source_id: request.source_id,
    artifact_version_id: artifactVersion.artifact_version_id,
    artifact_sha256: artifactSha256,
    occurred_at: receipt.acquired_at,
    actor_type: "system",
    reason: "owner_attested_official_download_imported_without_review_or_activation",
  });
  await writeImmutableJson(path.resolve(input.ledgerRoot, "events", `${artifactSha256}.json`), event);
  return { created: created && stored.created, idempotent: !created && !stored.created, artifact_version: artifactVersion, page_count: content.page_count };
}

export async function verifyOwnerAcquisitionLedger(input: Readonly<{ ledgerRoot: string; artifactRoot: string }>) {
  const { readdir } = await import("node:fs/promises");
  let names: string[] = [];
  try {
    names = (await readdir(input.ledgerRoot)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const verified: string[] = [];
  for (const name of names) {
    const record = artifactVersionSchema.parse(JSON.parse(await readFile(path.resolve(input.ledgerRoot, name), "utf8"))) as ArtifactVersion;
    const artifactPath = path.resolve(input.artifactRoot, record.source_id, "owner-v0.2", `${record.artifact_sha256}.pdf`);
    const bytes = await readFile(artifactPath);
    if (hash(bytes) !== record.artifact_sha256) throw new Error("owner_ledger_artifact_hash_mismatch");
    validateOwnerPdfBytes(bytes);
    verified.push(record.artifact_version_id);
  }
  return { ledger_entries: names.length, verified_artifact_version_ids: verified };
}

export function determineAcquisitionReadinessOutcome(input: Readonly<{
  missingTargetIds: readonly string[];
  implementationComplete: boolean;
  ownerHandoffComplete: boolean;
  environmentBlocked: boolean;
}>) {
  if (input.environmentBlocked) return { exit_code: 3 as const, status: "BLOCKED" as const };
  if (!input.implementationComplete) return { exit_code: 1 as const, status: "OFFICIAL_SOURCE_ACQUISITION_INCOMPLETE" as const };
  if (input.missingTargetIds.length > 0) {
    if (!input.ownerHandoffComplete) return { exit_code: 1 as const, status: "OFFICIAL_SOURCE_ACQUISITION_INCOMPLETE" as const };
    return { exit_code: 2 as const, status: "OWNER_OFFICIAL_SOURCE_HANDOFF_REQUIRED" as const };
  }
  return { exit_code: 0 as const, status: "OFFICIAL_SOURCE_ACQUISITION_READY_FOR_OWNER_LEGAL_REVIEW" as const };
}

export function corpusReadinessOutcome() {
  return {
    exit_code: 1 as const,
    status: "LEGAL_SOURCE_CORPUS_INCOMPLETE" as const,
    reason_codes: [
      "owner_legal_review_absent",
      "effective_coverage_incomplete",
      "scope_and_population_unverified",
      "official_source_acquisition_incomplete",
      "active_sources_zero",
    ] as const,
  };
}
