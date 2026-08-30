import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  acquisitionMethodSchema,
  acquisitionRequestSchema,
  artifactRoleSchema,
  catalogObservationSchema,
  legalInstrumentSchema,
  legalTextVersionSchema,
  type AcquisitionRequest,
} from "../../../engine/legal-knowledge/acquisition-contracts.ts";
import {
  importControlledOfficialArtifact,
  listCommittedControlledArtifactVersions,
  verifyControlledAcquisitionLedger,
} from "./controlled-import-security.ts";
import { parserIsolationAssurance, screenUntrustedPdfIsolated } from "./parser-isolation/index.ts";
import { validateWorkingTimePermitInventories } from "./wave1-working-time-permits.ts";

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

export const defaultAcquisitionTargetPath = path.resolve("src", "server", "engine", "legal-knowledge", "legal-acquisition-targets.v0.2.json");
export const defaultProvenancePath = path.resolve("src", "server", "engine", "legal-knowledge", "legal-provenance.v0.2.json");
export const defaultBrowserObservationPath = path.resolve("src", "server", "engine", "legal-knowledge", "legal-browser-observations.v0.2.json");
export const wave1PermitCatalogPath = path.resolve("src", "server", "engine", "legal-knowledge", "wave1-working-time-permits-catalog.v0.3.json");
export const wave1HoursPublicationsPath = path.resolve("src", "server", "engine", "legal-knowledge", "wave1-working-time-permits-publications.v0.3.json");

export async function loadAcquisitionTargets(filePath = defaultAcquisitionTargetPath) {
  return acquisitionTargetRegistrySchema.parse(JSON.parse(await readFile(filePath, "utf8")));
}

export async function loadProvenanceRegistry(filePath = defaultProvenancePath) {
  return provenanceRegistrySchema.parse(JSON.parse(await readFile(filePath, "utf8")));
}

export async function loadBrowserObservations(filePath = defaultBrowserObservationPath) {
  const schema = z.object({ schema_version: z.literal("legal-browser-observations-v0.2"), observations: z.array(catalogObservationSchema) }).strict();
  const base = schema.parse(JSON.parse(await readFile(filePath, "utf8")));
  if (path.resolve(filePath) !== path.resolve(defaultBrowserObservationPath)) return base;

  const permits = JSON.parse(await readFile(wave1PermitCatalogPath, "utf8"));
  const publications = JSON.parse(await readFile(wave1HoursPublicationsPath, "utf8"));
  const validated = validateWorkingTimePermitInventories({ permits, publications });
  const wave1Observations = [
    catalogObservationSchema.parse({
      catalog_observation_id: "CATOBS:WORK-PERMITS:2026-08-29:WAVE1-COMPLETE",
      catalog_id: "IL_WORK_PERMITS_CATALOG",
      canonical_url: validated.permits.snapshot.canonical_url,
      observed_at: validated.permits.snapshot.observed_at,
      acquisition_method: validated.permits.snapshot.acquisition_method,
      status: "complete",
      query: { filters: "none", pagination: "skip=0,10,20,30,40,50" },
      result_count_reported: validated.permits.snapshot.reported_result_count,
      entries_observed: validated.permits.entries.map((entry) => ({
        entry_id: entry.stable_id,
        title: entry.catalog_title,
        artifact_url: entry.artifact_links[0]?.official_url ?? null,
      })),
      pagination: { pages_observed: 6, pages_reported: 6 },
      safe_error_code: null,
      discovery_only: true,
    }),
    catalogObservationSchema.parse({
      catalog_observation_id: "CATOBS:HOURS-WORK-REST:PUBLICATIONS:2026-08-29:WAVE1-COMPLETE",
      catalog_id: "IL_HOURS_WORK_REST_LAW_PUBLICATIONS",
      canonical_url: validated.publications.snapshot.canonical_url,
      observed_at: validated.publications.snapshot.observed_at,
      acquisition_method: validated.publications.snapshot.acquisition_method,
      status: "complete",
      query: { law_id: "2000019", visible_control: "load_more_once" },
      result_count_reported: validated.publications.snapshot.reported_result_count,
      entries_observed: validated.publications.entries.map((entry) => ({
        entry_id: entry.publication_identity,
        title: entry.title,
        artifact_url: entry.official_artifact_url,
      })),
      pagination: { pages_observed: 2, pages_reported: 2 },
      safe_error_code: null,
      discovery_only: true,
    }),
  ];
  const supersededCatalogIds = new Set(wave1Observations.map((observation) => observation.catalog_id));
  return schema.parse({
    schema_version: "legal-browser-observations-v0.2",
    observations: [
      ...base.observations.filter((observation) => !supersededCatalogIds.has(observation.catalog_id)),
      ...wave1Observations,
    ],
  });
}

export async function validateOwnerPdfBytes(bytes: Uint8Array, maxBytes = 20 * 1024 * 1024) {
  const result = await screenUntrustedPdfIsolated({ bytes, limits: { max_input_bytes: maxBytes } });
  if (result.status !== "screened") throw new Error("owner_artifact_isolated_screening_incomplete");
  return Object.freeze({
    ...result,
    parser_application_isolation: parserIsolationAssurance.application_isolation,
    parser_os_sandbox: parserIsolationAssurance.os_sandbox,
  });
}

export async function loadCommittedOwnerArtifacts(input: Readonly<{
  ledgerRoot: string;
  artifactRoot: string;
}>) {
  return listCommittedControlledArtifactVersions(input);
}

export const canonicalOwnerPdfReachability = Object.freeze({
  import_entrypoint: "scripts/legal-acquisition.mts import",
  import_path: [
    "importOwnerOfficialArtifact",
    "importControlledOfficialArtifact",
    "screenUntrustedPdfIsolated",
    "ledger-bound atomic commit marker",
  ] as const,
  read_entrypoint: "loadCommittedOwnerArtifacts",
  read_path: [
    "listCommittedControlledArtifactVersions",
    "readCommittedControlledArtifact",
    "screenUntrustedPdfIsolated",
  ] as const,
  direct_in_process_owner_pdf_parser_reachable: false as const,
  real_owner_import_status: "disabled_until_parser_os_sandbox_verified" as const,
  application_isolation: "PARSER_APPLICATION_ISOLATION_VERIFIED" as const,
  os_sandbox: "PARSER_OS_SANDBOX_NOT_VERIFIED" as const,
});

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
    allowed_artifact_urls: target.artifact_url ? [target.artifact_url] : [],
    allowed_final_urls: target.artifact_url ? [target.artifact_url] : [],
    expected_media_type: "application/pdf",
    expected_document_identity: {
      title: target.expected_document_title,
      artifact_sha256: null,
      identity_basis: "owner_must_confirm_official_record",
    },
    allowed_attestation_types: ["owner_attestation"],
    expected_document_title: target.expected_document_title,
    recommended_filename: target.recommended_filename,
    failure_evidence: failureEvidence,
    receipt_template: {
      acquisition_request_id: target.target_id,
      source_id: target.source_id,
      landing_url: target.canonical_landing_url,
      expected_media_type: "application/pdf",
      expected_document_title: target.expected_document_title,
      attestation_type: "owner_attestation",
      actor_type: "owner",
      acquisition_method: "owner_attested_official_download",
      unchanged_original: true,
      used_print_to_pdf: false,
    },
  });
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
  const parsedRequest = acquisitionRequestSchema.parse(input.request);
  const requiredAttestationType = parsedRequest.allowed_attestation_types.includes("owner_attestation")
    ? "owner_attestation" as const
    : parsedRequest.allowed_attestation_types.includes("synthetic_test_attestation")
      ? "synthetic_test_attestation" as const
      : null;
  if (!requiredAttestationType) throw new Error("controlled_attestation_not_allowed");
  return importControlledOfficialArtifact({ ...input, requiredAttestationType });
}

export async function verifyOwnerAcquisitionLedger(input: Readonly<{
  ledgerRoot: string;
  artifactRoot: string;
  requiredRequestIds?: readonly string[];
  strictRequiredInstances?: boolean;
}>) {
  return verifyControlledAcquisitionLedger(input);
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
