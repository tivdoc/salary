import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { legalSourceSchema, type LegalSource } from "../src/engine/legal-knowledge/contracts.ts";
import { legalTopics } from "../src/engine/legal-knowledge/taxonomy.ts";
import {
  acquisitionRequestForTarget,
  determineAcquisitionReadinessOutcome,
  importOwnerOfficialArtifact,
  loadCommittedOwnerArtifacts,
  loadAcquisitionTargets,
  loadBrowserObservations,
  loadProvenanceRegistry,
  verifyOwnerAcquisitionLedger,
} from "../src/server/engine/legal-knowledge/acquisition.ts";
import { loadLegalCoverageMatrix } from "../src/server/engine/legal-knowledge/coverage.ts";
import {
  controlledImportInstanceReadiness,
  controlledImportStrictOperationalReadiness,
  hashFileStreaming,
  importControlledOfficialArtifact,
  scanControlledImportMetadata,
} from "../src/server/engine/legal-knowledge/controlled-import-security.ts";
import { legalSourceManifestSchema } from "../src/server/engine/legal-knowledge/manifest.ts";
import { validateLegalSourceUrl } from "../src/server/engine/legal-knowledge/security.ts";
import { LEGAL_READINESS_CASES } from "../src/engine/legal-knowledge/canonical-readiness/case-registry.ts";
import { legalReadinessDiagnostic } from "../src/engine/legal-knowledge/canonical-readiness/delegates.ts";
import { classifyRegisteredSourceRole } from "../src/engine/legal-knowledge/corpus-hardening/source-roles.ts";

const repoRoot = process.cwd();
const legalRoot = path.resolve(repoRoot, "src", "server", "engine", "legal-knowledge");
const manifestPath = path.join(legalRoot, "legal-sources.v0.json");
const evaluationRoot = path.resolve(repoRoot, "eval", "legal-knowledge");
const acquisitionRoot = path.join(evaluationRoot, "acquisition");
const incomingRoot = path.join(acquisitionRoot, "incoming");
const ownerArtifactRoot = path.join(acquisitionRoot, "artifacts");
const acquisitionLedgerRoot = path.join(acquisitionRoot, "ledger");
const fetchStatePath = path.join(evaluationRoot, "manifests", "fetch-state.json");
const buildStatePath = path.join(evaluationRoot, "manifests", "build-state.json");
const outputRoot = path.resolve(repoRoot, "output", "legal-knowledge");
const handoffRoot = path.join(outputRoot, "acquisition-handoff-v0.2");
const reviewPackageRoot = path.join(outputRoot, "review-package-v0.2");
const reviewZipPath = path.join(outputRoot, "review-package-v0.2.zip");

type FetchObservation = Readonly<{
  source_id: string;
  source_version: string;
  artifact_sha256: string;
  final_url: string;
  content_type: string;
  byte_count: number;
  retrieved_at: string;
  artifact_path: string;
  status: "fetched" | "content_change_review_required";
  parse_status: "not_built" | "parsed" | "parse_failed" | "unsupported";
  safe_error_code: string | null;
  parser_version: string | null;
  normalized_text_sha256: string | null;
  chunks_path: string | null;
  normalized_path: string | null;
  chunk_count: number;
}>;
type FetchFailure = Readonly<{ source_id: string; source_version: string; failed_at: string; safe_error_code: string }>;
type FetchState = Readonly<{ observations: readonly FetchObservation[]; failures: readonly FetchFailure[] }>;
type BuildRecord = Readonly<{
  source_id: string;
  source_version: string;
  artifact_sha256: string;
  normalized_text_sha256: string | null;
  parsed_version_id: string | null;
  normalized_output_sha256: string | null;
  chunks_output_sha256: string | null;
  chunk_count: number;
  parser_version: string;
  normalizer_version: string;
  chunker_version: string;
  parse_status: "parsed" | "parse_failed" | "unsupported";
  safe_error_code: string | null;
}>;
type BuildState = Readonly<{ records: readonly BuildRecord[] }>;

function hash(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function stableJson(value: unknown) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function parseOptions(args: string[]) {
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (!args[index].startsWith("--")) continue;
    const key = args[index].slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else options[key] = true;
  }
  return options;
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, stableJson(value), { flag: "wx" });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeTextAtomic(filePath: string, value: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, value, { flag: "wx" });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function loadState() {
  const manifest = legalSourceManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  const fetchState = await readJson<FetchState>(fetchStatePath, { observations: [], failures: [] });
  const buildState = await readJson<BuildState>(buildStatePath, { records: [] });
  const targets = await loadAcquisitionTargets();
  const provenance = await loadProvenanceRegistry();
  const browser = await loadBrowserObservations();
  const ownerArtifacts = await loadCommittedOwnerArtifacts({
    ledgerRoot: acquisitionLedgerRoot,
    artifactRoot: ownerArtifactRoot,
  });
  return { manifest, fetchState, buildState, targets, provenance, browser, ownerArtifacts };
}

function observationAcquisitionErrorCode(observation: FetchObservation) {
  if (observation.content_type.toLowerCase().includes("text/html") && observation.byte_count <= 4096 && observation.parse_status !== "parsed") {
    return "html_challenge_or_error_page";
  }
  if (["html_challenge_or_error_page", "unexpected_content_type", "artifact_too_large", "redirect_host_not_allowlisted"].includes(observation.safe_error_code ?? "")) {
    return observation.safe_error_code;
  }
  return null;
}

function validObservation(observation: FetchObservation) {
  return observationAcquisitionErrorCode(observation) === null;
}

function selectedValidObservation(fetchState: FetchState, source: LegalSource) {
  const matching = [...fetchState.observations].reverse().filter((entry) => entry.source_id === source.source_id && entry.source_version === source.source_version);
  const baseline = source.content_sha256 ? matching.find((entry) => entry.artifact_sha256 === source.content_sha256) : matching.find((entry) => entry.status === "fetched");
  return baseline && validObservation(baseline) && baseline.parse_status === "parsed" ? baseline : null;
}

function observationId(observation: FetchObservation) {
  return `fetch:${observation.source_id}@${observation.source_version}#${observation.artifact_sha256}`;
}

function failureId(failure: FetchFailure) {
  return `fetch-failure:${failure.source_id}@${failure.source_version}#${failure.failed_at}`;
}

function targetAcquired(target: Awaited<ReturnType<typeof loadAcquisitionTargets>>["targets"][number], state: Awaited<ReturnType<typeof loadState>>) {
  if (target.target_kind === "catalog") {
    return state.browser.observations.some((observation) => observation.catalog_id === "IL_WORK_PERMITS_CATALOG" && observation.status === "complete");
  }
  if (state.ownerArtifacts.some((artifact) => artifact.acquisition_request_id === target.target_id && artifact.source_id === target.source_id)) return true;
  if (!target.existing_source_version) return false;
  if (!target.artifact_url) return false;
  return state.fetchState.observations.some((observation) =>
    observation.source_id === target.source_id
      && observation.source_version === target.existing_source_version
      && observation.final_url === target.artifact_url
      && validObservation(observation),
  );
}

function failureEvidence(target: Awaited<ReturnType<typeof loadAcquisitionTargets>>["targets"][number], state: Awaited<ReturnType<typeof loadState>>) {
  const evidence: Array<{ stage: "fetch" | "browser"; safe_error_code: string }> = [];
  for (const failure of state.fetchState.failures.filter((entry) => entry.source_id === target.source_id)) {
    evidence.push({ stage: "fetch", safe_error_code: failure.safe_error_code });
  }
  if (!target.artifact_url) evidence.push({ stage: "fetch", safe_error_code: "official_artifact_url_unresolved" });
  if (target.browser_safe_error_code) evidence.push({ stage: "browser", safe_error_code: target.browser_safe_error_code });
  return evidence.length > 0 ? evidence : [{ stage: "fetch" as const, safe_error_code: "required_target_not_acquired" }];
}

function requestReadme(request: ReturnType<typeof acquisitionRequestForTarget>, targetKind: "artifact" | "catalog") {
  if (targetKind === "catalog") {
    return `# Controlled owner catalog observation\n\nRequest: \`${request.acquisition_request_id}\`\n\nExpected catalog: ${request.expected_document_title}\n\n1. Open ${request.canonical_landing_url} in the normal local browser.\n2. Confirm HTTPS and one of these exact hosts: ${request.allowlisted_hosts.join(", ")}.\n3. Record the exact filters/query and the reported result count.\n4. Traverse every visible pagination page or the complete infinite-scroll result set once; record every visible entry and its official artifact URL in \`${request.recommended_filename}\`.\n5. The entry list must contain exactly the reported result count. A partial list remains unresolved and must not be marked complete.\n6. Complete \`receipt.json\` with the final official catalog URL and observation time.\n7. A screenshot of the catalog and address bar may be retained as discovery evidence only; remove personal and session data.\n8. Do not log in, solve a CAPTCHA, replay an internal API, reuse cookies/session tokens, print to PDF, or infer which entries apply.\n9. Keep the files unchanged in \`eval/legal-knowledge/acquisition/incoming/${request.acquisition_request_id}/\` for owner/legal review. Catalog entries are discovery evidence only; each required permit must be acquired separately as an official artifact.\n`;
  }
  return `# Controlled owner acquisition\n\nRequest: \`${request.acquisition_request_id}\`\n\nExpected record/document: ${request.expected_document_title}\n\n1. Open ${request.canonical_landing_url} in the normal local browser.\n2. Confirm HTTPS and one of these exact hosts: ${request.allowlisted_hosts.join(", ")}.\n3. Download the original file through the exact allowlisted artifact URL recorded in the request. If the URL is still unbound, stop and update the request through review; do not use an ad-hoc \`--artifact-url\` override.\n4. Do not use Print to PDF, copy/paste, conversion software, email, WhatsApp, mirrors, caches or Internet Archive.\n5. Save the unchanged original as \`${request.recommended_filename}\` inside \`eval/legal-knowledge/acquisition/incoming/${request.acquisition_request_id}/\`.\n6. Compute SHA-256 locally and complete \`receipt.json\` with the exact artifact/final URLs, hash, media type, document title and acquisition time.\n7. A screenshot of the record and address bar may be retained as discovery evidence only; remove personal, EXIF and session data. Screenshots are never import inputs.\n8. Run import, strict verification for this request, instance readiness and corpus acquisition readiness. Import performs no network request and does not parse, review or activate the artifact.\n`;
}

async function generateRequests() {
  const state = await loadState();
  const requests = [];
  const retired = [];
  for (const target of state.targets.targets) {
    const requestRoot = path.join(handoffRoot, target.target_id);
    // L6-1 / D3: a target the official record itself says cannot be fulfilled
    // is retired, not re-requested. Its finding travels in retired.json beside
    // the requests so no future run asks a person for a text that does not
    // exist.
    if (target.browser_outcome === "unavailable" && target.browser_safe_error_code) {
      await rm(requestRoot, { recursive: true, force: true });
      retired.push({ target_id: target.target_id, source_id: target.source_id, finding: target.browser_safe_error_code, expected_document_title: target.expected_document_title, canonical_landing_url: target.canonical_landing_url });
      continue;
    }
    const requestRelative = path.relative(handoffRoot, requestRoot);
    if (!requestRelative || requestRelative.startsWith("..") || path.isAbsolute(requestRelative)) throw new Error("handoff_request_path_escape");
    if (targetAcquired(target, state)) {
      await rm(requestRoot, { recursive: true, force: true });
      continue;
    }
    const request = acquisitionRequestForTarget(target, failureEvidence(target, state));
    await writeJsonAtomic(path.join(requestRoot, "request.json"), request);
    await writeJsonAtomic(path.join(requestRoot, "receipt-template.json"), request.receipt_template);
    await writeTextAtomic(path.join(requestRoot, "README.md"), requestReadme(request, target.target_kind));
    if (target.target_kind === "catalog") {
      await writeJsonAtomic(path.join(requestRoot, "catalog-snapshot-template.json"), {
        schema_version: "owner-catalog-snapshot-v0.2",
        acquisition_request_id: request.acquisition_request_id,
        source_id: request.source_id,
        canonical_url: request.canonical_landing_url,
        observed_at: null,
        status: "partial",
        query: {},
        result_count_reported: null,
        entries_observed: [],
        pagination: { pages_observed: 0, pages_reported: null },
        discovery_only: true,
      });
    }
    await mkdir(path.join(incomingRoot, request.acquisition_request_id), { recursive: true });
    requests.push(request);
  }
  await writeJsonAtomic(path.join(handoffRoot, "retired.json"), { schema_version: "owner-acquisition-retired-targets-v0.1", retired });
  return { requests_created: requests.length, request_ids: requests.map((request) => request.acquisition_request_id).sort(), retired: retired.map((entry) => entry.target_id), handoff_path: path.relative(repoRoot, handoffRoot).replaceAll("\\", "/") };
}

async function findRequest(requestId: string) {
  await generateRequests();
  const filePath = path.join(handoffRoot, requestId, "request.json");
  if (!existsSync(filePath)) throw new Error("acquisition_request_not_found_or_already_satisfied");
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function importCommand(args: string[]) {
  if (process.env.TIVDOC_LEGAL_NETWORK_DISABLED !== "1") throw new Error("owner_import_requires_network_disabled_canary");
  const options = parseOptions(args);
  const requestId = String(options["request-id"] ?? "");
  const originalFilename = String(options.file ?? "");
  const receiptFilename = String(options.receipt ?? "receipt.json");
  if (!requestId || !originalFilename) throw new Error("owner_import_arguments_required");
  const request = await findRequest(requestId);
  return importOwnerOfficialArtifact({ request, incomingRoot, artifactRoot: ownerArtifactRoot, ledgerRoot: acquisitionLedgerRoot, originalFilename, receiptFilename });
}

async function verifyCommand(args: string[]) {
  if (process.env.TIVDOC_LEGAL_NETWORK_DISABLED !== "1") throw new Error("owner_verify_requires_network_disabled_canary");
  const options = parseOptions(args);
  const requiredRequestId = String(options["require-request-id"] ?? "");
  const strict = options["strict-required-instance"] === true;
  if (strict && !requiredRequestId) throw new Error("strict_verify_requires_request_id");
  return verifyOwnerAcquisitionLedger({
    ledgerRoot: acquisitionLedgerRoot,
    artifactRoot: ownerArtifactRoot,
    requiredRequestIds: requiredRequestId ? [requiredRequestId] : [],
    strictRequiredInstances: strict,
  });
}

async function strictOperationalReadinessCommand() {
  if (process.env.TIVDOC_LEGAL_NETWORK_DISABLED !== "1") throw new Error("operational_readiness_must_run_offline");
  const verification = await verifyOwnerAcquisitionLedger({
    ledgerRoot: acquisitionLedgerRoot,
    artifactRoot: ownerArtifactRoot,
  });
  return controlledImportStrictOperationalReadiness({
    verification,
    durableStorageVerified: false,
    persistentLedgerVerified: false,
    osSandboxVerified: false,
    persistenceEvidenceVerified: false,
  });
}

async function toolingSelfTestCommand() {
  if (process.env.TIVDOC_LEGAL_NETWORK_DISABLED !== "1") throw new Error("self_test_requires_network_disabled_canary");
  const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-controlled-import-self-test-"));
  try {
    const empty = await verifyOwnerAcquisitionLedger({ ledgerRoot: path.join(root, "ledger"), artifactRoot: path.join(root, "artifacts") });
    const strict = await verifyOwnerAcquisitionLedger({
      ledgerRoot: path.join(root, "ledger"),
      artifactRoot: path.join(root, "artifacts"),
      requiredRequestIds: ["ACQ-V031-SELF-TEST"],
      strictRequiredInstances: true,
    });
    const metadataScan = scanControlledImportMetadata({ safe_error_code: "synthetic_self_test", contains_no_user_data: true });
    if (empty.status !== "NO_IMPORTS_TO_VERIFY" || strict.exit_code === 0 || !metadataScan.safe) throw new Error("controlled_import_self_test_failed");
    return {
      status: "CONTROLLED_IMPORT_TOOLING_SELF_TEST_PASSED",
      exit_code: 0,
      tooling_self_test_only: true,
      acquisition_instance_claimed: false,
      empty_ledger_status: empty.status,
      strict_required_instance_status: strict.status,
      strict_required_instance_exit_code: strict.exit_code,
      metadata_scan_safe: metadataScan.safe,
      network_used: false,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testAcquisitionInstanceCommand(args: string[]) {
  if (process.env.TIVDOC_LEGAL_NETWORK_DISABLED !== "1") throw new Error("test_instance_requires_network_disabled_canary");
  const options = parseOptions(args);
  const publicTestCopy = String(options["public-test-copy"] ?? "");
  const artifactUrl = String(options["artifact-url"] ?? "");
  const landingUrl = String(options["landing-url"] ?? artifactUrl);
  const expectedSha256 = String(options["expected-sha256"] ?? "");
  if (!publicTestCopy || !path.isAbsolute(publicTestCopy) || !artifactUrl || !expectedSha256.match(/^[a-f0-9]{64}$/u)) {
    throw new Error("test_instance_arguments_invalid");
  }
  for (const url of [landingUrl, artifactUrl]) {
    const validated = validateLegalSourceUrl(url);
    if (!validated.passed) throw new Error(`test_instance_${validated.code}`);
  }
  const publicCopyInfo = await lstat(publicTestCopy);
  if (!publicCopyInfo.isFile() || publicCopyInfo.isSymbolicLink()) throw new Error("test_instance_copy_must_be_regular_file");
  if (await hashFileStreaming(publicTestCopy) !== expectedSha256) throw new Error("test_instance_public_copy_hash_mismatch");
  const requestId = "ACQ-V031-SYNTHETIC-PUBLIC-OFFICIAL-COPY";
  const sourceId = "IL_SYNTHETIC_TEST_PUBLIC_ARTIFACT";
  const filename = "existing-public-official-artifact-test-copy.pdf";
  const title = "Existing public official artifact test copy";
  type OfficialHost = "www.gov.il" | "gov.il" | "main.knesset.gov.il" | "fs.knesset.gov.il" | "www.btl.gov.il" | "btl.gov.il";
  const allowlistedHosts = [...new Set([new URL(landingUrl).hostname, new URL(artifactUrl).hostname])] as OfficialHost[];
  const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-controlled-import-e2e-"));
  try {
    const inbox = path.join(root, "incoming", requestId);
    await mkdir(inbox, { recursive: true });
    await copyFile(publicTestCopy, path.join(inbox, filename));
    const request = {
      acquisition_request_id: requestId,
      source_id: sourceId,
      instrument_id: "INSTRUMENT:IL:SYNTHETIC_TEST_PUBLIC_ARTIFACT",
      canonical_landing_url: landingUrl,
      artifact_url: artifactUrl,
      allowlisted_hosts: allowlistedHosts,
      allowed_artifact_urls: [artifactUrl],
      allowed_final_urls: [artifactUrl],
      expected_media_type: "application/pdf",
      expected_document_identity: { title, artifact_sha256: expectedSha256, identity_basis: "known_existing_public_official_artifact_test_copy" },
      allowed_attestation_types: ["synthetic_test_attestation"],
      expected_document_title: title,
      recommended_filename: filename,
      failure_evidence: [],
      receipt_template: {
        acquisition_request_id: requestId,
        source_id: sourceId,
        landing_url: landingUrl,
        artifact_url: artifactUrl,
        final_url: artifactUrl,
        artifact_sha256: expectedSha256,
        expected_media_type: "application/pdf",
        expected_document_title: title,
        attestation_type: "synthetic_test_attestation",
        actor_type: "system_test",
        acquisition_method: "synthetic_test_copy_existing_public_official_artifact",
        unchanged_original: true,
        used_print_to_pdf: false,
        test_only_notice: "TEST COPY OF EXISTING PUBLIC OFFICIAL ARTIFACT; NOT AN OWNER IMPORT",
      },
    } as const;
    const receipt = {
      ...request.receipt_template,
      original_filename: filename,
      acquired_at: "2026-08-29T00:00:00Z",
    };
    await writeFile(path.join(inbox, "receipt.json"), stableJson(receipt), { flag: "wx" });
    const importInput = {
      request,
      incomingRoot: path.join(root, "incoming"),
      artifactRoot: path.join(root, "artifacts"),
      ledgerRoot: path.join(root, "ledger"),
      originalFilename: filename,
      receiptFilename: "receipt.json",
    };
    const imported = await importControlledOfficialArtifact(importInput);
    const replay = await importControlledOfficialArtifact(importInput);
    const verification = await verifyOwnerAcquisitionLedger({
      ledgerRoot: path.join(root, "ledger"),
      artifactRoot: path.join(root, "artifacts"),
      requiredRequestIds: [requestId],
      strictRequiredInstances: true,
    });
    const readiness = controlledImportInstanceReadiness(verification, requestId);
    if (!readiness.ready || !replay.idempotent) throw new Error("test_acquisition_instance_verification_failed");
    return {
      status: readiness.status,
      exit_code: 0,
      test_only_notice: "TEST COPY OF EXISTING PUBLIC OFFICIAL ARTIFACT; NOT AN OWNER IMPORT",
      source_id: sourceId,
      request_id: requestId,
      original_public_artifact_sha256: expectedSha256,
      private_copy_sha256: imported.private_copy_sha256,
      published_sha256: imported.published_sha256,
      ledger_entries: verification.ledger_entries,
      duplicate_replay_idempotent: replay.idempotent,
      request_receipt_media_identity_binding: true,
      immutable_atomic_publish: true,
      append_only_ledger_commit_marker: true,
      usable_for_legal_rules: false,
      activates_source: false,
      network_used: false,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function acquisitionInstanceReadinessCommand(args: string[]) {
  if (process.env.TIVDOC_LEGAL_NETWORK_DISABLED !== "1") throw new Error("instance_readiness_requires_network_disabled_canary");
  const options = parseOptions(args);
  const requestId = String(options["require-request-id"] ?? "");
  if (!requestId) throw new Error("instance_readiness_requires_request_id");
  const verification = await verifyOwnerAcquisitionLedger({
    ledgerRoot: acquisitionLedgerRoot,
    artifactRoot: ownerArtifactRoot,
    requiredRequestIds: [requestId],
    strictRequiredInstances: true,
  });
  const readiness = controlledImportInstanceReadiness(verification, requestId);
  return { ...readiness, exit_code: readiness.ready ? 0 : 4, verification };
}

async function inventories() {
  const state = await loadState();
  const registryIds = state.manifest.sources.map((source) => `${source.source_id}@${source.source_version}`).sort();
  const observations = [
    ...state.fetchState.observations.map((observation) => ({
      observation_id: observationId(observation),
      observation_type: "fetch_observation",
      source_id: observation.source_id,
      requested_revision: observation.source_version,
      final_url: observation.final_url,
      observed_at: observation.retrieved_at,
      media_type: observation.content_type,
      byte_count: observation.byte_count,
      response_sha256: observation.artifact_sha256,
      acquisition_state: validObservation(observation) ? "acquired" : "quarantined",
      parse_state: observation.parse_status === "parsed" ? "parsed" : observation.parse_status === "parse_failed" ? "failed" : "not_attempted",
      evidence_state: "incomplete",
      disposition: validObservation(observation) ? "legal_artifact_candidate" : "not_a_legal_source_version",
      safe_error_code: observationAcquisitionErrorCode(observation) ?? observation.safe_error_code,
    })),
    ...state.fetchState.failures.map((failure) => ({
      observation_id: failureId(failure),
      observation_type: "fetch_failure",
      source_id: failure.source_id,
      requested_revision: failure.source_version,
      final_url: null,
      observed_at: failure.failed_at,
      media_type: null,
      byte_count: null,
      response_sha256: null,
      acquisition_state: "unavailable",
      parse_state: "not_attempted",
      evidence_state: "incomplete",
      disposition: "not_a_legal_source_version",
      safe_error_code: failure.safe_error_code,
    })),
    ...state.browser.observations.map((observation) => ({ ...observation, observation_type: "catalog_observation" })),
  ].sort((left, right) => String(left.observation_id ?? left.catalog_observation_id).localeCompare(String(right.observation_id ?? right.catalog_observation_id)));
  const validArtifactObservations = state.fetchState.observations.filter(validObservation);
  const uniqueArtifactObservations = [...new Map(validArtifactObservations.map((entry) => [`${entry.source_id}:${entry.artifact_sha256}`, entry])).values()];
  const provenanceBySource = new Map(state.provenance.provenance.map((entry) => [entry.source_id, entry]));
  const legalTextByInstrument = new Map(state.provenance.legal_text_versions.map((entry) => [entry.instrument_id, entry]));
  const instrumentBySource = new Map(state.provenance.instruments.map((entry) => [entry.source_id, entry]));
  const fetchedArtifactVersions = uniqueArtifactObservations.map((observation) => {
    const instrument = instrumentBySource.get(observation.source_id);
    const legalText = instrument ? legalTextByInstrument.get(instrument.instrument_id) : null;
    const provenance = provenanceBySource.get(observation.source_id);
    return {
      artifact_version_id: `artifact:${observation.source_id}:${observation.artifact_sha256}`,
      source_id: observation.source_id,
      legal_text_version_id: legalText?.legal_text_version_id ?? null,
      artifact_sha256: observation.artifact_sha256,
      byte_count: observation.byte_count,
      media_type: observation.content_type,
      final_url: observation.final_url,
      acquired_at: observation.retrieved_at,
      parse_state: observation.parse_status === "parsed" ? "parsed" : observation.parse_status === "parse_failed" ? "failed" : "not_attempted",
      evidence_state: "incomplete",
      review_state: "needs_review",
      activation_state: "inactive",
      provenance: provenance ?? null,
    };
  });
  const artifactVersions = [...fetchedArtifactVersions, ...state.ownerArtifacts].sort((left, right) => left.artifact_version_id.localeCompare(right.artifact_version_id));
  const selected = state.manifest.sources.flatMap((source) => {
    const observation = selectedValidObservation(state.fetchState, legalSourceSchema.parse(source));
    return observation ? [{ source_id: source.source_id, source_version_id: `${source.source_id}@${source.source_version}`, artifact_sha256: observation.artifact_sha256 }] : [];
  });
  const legalVersions = state.provenance.legal_text_versions.filter((legalVersion) => {
    const instrument = state.provenance.instruments.find((entry) => entry.instrument_id === legalVersion.instrument_id);
    return instrument && (validArtifactObservations.some((entry) => entry.source_id === instrument.source_id) || state.ownerArtifacts.some((entry) => entry.source_id === instrument.source_id));
  });
  const parsedVersions = state.buildState.records.filter((record) => record.parse_status === "parsed").map((record) => ({
    parsed_version_id: record.parsed_version_id,
    source_version_id: `${record.source_id}@${record.source_version}`,
    artifact_sha256: record.artifact_sha256,
    normalized_text_sha256: record.normalized_text_sha256,
    normalized_output_sha256: record.normalized_output_sha256,
    chunks_output_sha256: record.chunks_output_sha256,
    parser_version: record.parser_version,
    normalizer_version: record.normalizer_version,
    chunker_version: record.chunker_version,
    chunk_count: record.chunk_count,
  }));
  const quarantined = observations.filter((entry) => "disposition" in entry && entry.disposition === "not_a_legal_source_version");
  const changeReport = await readJson<{ records?: Array<{ candidates?: unknown[] }> }>(path.join(outputRoot, "source-byte-diff-report.json"), { records: [] });
  const changeCandidates = (changeReport.records ?? []).flatMap((record) => record.candidates ?? []);
  const coverage = await loadLegalCoverageMatrix();
  const counts = {
    registry_records: registryIds.length,
    source_locators: state.manifest.sources.length,
    fetch_observations: state.fetchState.observations.length + state.fetchState.failures.length,
    catalog_observations: state.browser.observations.length,
    valid_raw_artifact_versions: artifactVersions.length,
    quarantined_or_unavailable_observations: quarantined.length,
    legal_text_versions: legalVersions.length,
    parsed_versions: parsedVersions.length,
    selected_review_candidates: selected.length,
    reviewed_sources: 0,
    active_sources: 0,
    change_candidates: changeCandidates.length,
    chunks: parsedVersions.reduce((sum, entry) => sum + entry.chunk_count, 0),
    product_topic_groups: 7,
    taxonomy_tags: legalTopics.length,
    coverage_rows: coverage.rows.length,
  };
  return {
    state,
    counts,
    count_reconciliation: {
      registry_record_ids: registryIds,
      selected_review_candidate_ids: selected.map((entry) => entry.source_version_id).sort(),
      valid_artifact_version_ids: artifactVersions.map((entry) => entry.artifact_version_id),
      quarantined_observation_ids: quarantined.map((entry) => String(entry.observation_id)).sort(),
      overlapping_categories: [
        "selected_review_candidates are a subset of valid_raw_artifact_versions",
        "parsed_versions are outputs derived from artifact versions",
        "change_candidates overlap fetch observations and are not added to registry_records",
        "coverage_rows are evidence rows, not product topic groups",
      ],
    },
    observations,
    artifactVersions,
    legalVersions,
    parsedVersions,
    selected,
    quarantined,
    changeCandidates,
    coverage,
  };
}

async function statusCommand() {
  const inventory = await inventories();
  const targetStatus = inventory.state.targets.targets.map((target) => ({
    target_id: target.target_id,
    source_id: target.source_id,
    acquired: targetAcquired(target, inventory.state),
    browser_outcome: target.browser_outcome,
  }));
  return { schema_version: "legal-acquisition-status-v0.2", counts: inventory.counts, count_reconciliation: inventory.count_reconciliation, targets: targetStatus, active_sources: 0, numeric_candidates: 0, active_numeric_parameters: 0 };
}

async function acquisitionReadiness(generateHandoff = true) {
  if (process.env.TIVDOC_LEGAL_NETWORK_DISABLED !== "1") throw new Error("acquisition_readiness_must_run_offline");
  const requestResult = generateHandoff ? await generateRequests() : null;
  const state = await loadState();
  const missingTargets = state.targets.targets.filter((target) => !targetAcquired(target, state));
  const missingGates = missingTargets.map((target) => ({ target_id: target.target_id, reason_codes: failureEvidence(target, state).map((entry) => entry.safe_error_code) }));
  const handoffComplete = missingTargets.every((target) => existsSync(path.join(handoffRoot, target.target_id, "request.json")) && existsSync(path.join(handoffRoot, target.target_id, "README.md")));
  const outcome = determineAcquisitionReadinessOutcome({ missingTargetIds: missingTargets.map((target) => target.target_id), implementationComplete: true, ownerHandoffComplete: handoffComplete, environmentBlocked: false });
  return {
    ...outcome,
    ready: outcome.exit_code === 0,
    missing_gates: missingGates,
    request_ids: requestResult?.request_ids ?? [],
    deterministic: true,
    offline: true,
  };
}

async function corpusReadiness(args: string[]) {
  if (process.env.TIVDOC_LEGAL_NETWORK_DISABLED !== "1") throw new Error("corpus_readiness_must_run_offline");
  const options = parseOptions(args);
  const expected = { from: "2019-01-01", "as-of": "2026-08-29", sector: "general" };
  for (const [name, value] of Object.entries(expected)) if (options[name] !== value) throw new Error(`corpus_readiness_argument_invalid:${name}`);
  const inventory = await inventories();
  const buildByVersion = new Map(inventory.state.buildState.records.map((record) => [`${record.source_id}@${record.source_version}`, record]));
  const canonicalCandidates = inventory.state.manifest.sources.map((rawSource) => {
    const source = legalSourceSchema.parse(rawSource);
    const sourceVersionId = `${source.source_id}@${source.source_version}`;
    return {
      source_version_id: sourceVersionId,
      topics: source.topics,
      parse_succeeded: buildByVersion.get(sourceVersionId)?.parse_status === "parsed",
      citation_verified: false,
      operative_role_eligible: classifyRegisteredSourceRole(source).eligible_for_operative_resolution,
      human_reviewed: false,
      effective_interval_verified: false,
      verified_sectors: [] as string[],
      verified_populations: [] as string[],
      active: false,
    };
  });
  const canonicalDecisions = LEGAL_READINESS_CASES
    .filter((readinessCase) => readinessCase.kind === "current" && readinessCase.sector === "general")
    .map((readinessCase) => legalReadinessDiagnostic(readinessCase, canonicalCandidates).decision);
  return {
    exit_code: canonicalDecisions.every((decision) => decision.status === "READY") ? 0 : 1,
    status: canonicalDecisions.every((decision) => decision.status === "READY") ? "READY" : "LEGAL_SOURCE_CORPUS_INCOMPLETE",
    reason_codes: [...new Set(canonicalDecisions.flatMap((decision) => decision.reason_codes))],
    decision_source: "evaluateLegalReadiness",
    canonical_decisions: canonicalDecisions,
    ready: canonicalDecisions.every((decision) => decision.status === "READY"),
    query: { from: expected.from, as_of: expected["as-of"], sector: expected.sector },
    missing_gates: inventory.coverage.rows.filter((row) => row.coverage_status !== "covered").map((row) => `${row.topic}:${row.source_version_id}:${row.coverage_status}`),
    active_sources: 0,
    numeric_candidates: 0,
    active_numeric_parameters: 0,
    deterministic: true,
    offline: true,
  };
}

async function scopeScan() {
  const paths = [
    "scripts/legal-acquisition.mts",
    "src/engine/legal-knowledge/acquisition-contracts.ts",
    "src/server/engine/legal-knowledge/acquisition.ts",
  ];
  const patterns = [
    "LLM SDK import or client construction",
    "supabase client or production database access",
    "customer evaluation/case/document pipeline import",
    "migration or deploy invocation",
    "Findings or eligibility calculation call",
  ];
  const forbidden = [/from\s+["']openai["']/u, /new\s+OpenAI\b/u, /createClient\s*\(/u, /customer-eval|cases\/|documents\//u, /\b(?:migrate|deploy)\s*\(/u, /\b(?:createFinding|calculateEligibility)\s*\(/u];
  const findings: Array<{ path: string; line: number; text: string }> = [];
  for (const relative of paths) {
    const lines = (await readFile(path.resolve(repoRoot, relative), "utf8")).split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (relative === "scripts/legal-acquisition.mts" && (line.includes("const forbidden") || line.includes("customer-eval|cases") || line.includes("createFinding|calculateEligibility"))) return;
      if (forbidden.some((pattern) => pattern.test(line))) findings.push({ path: relative, line: index + 1, text: line.trim().slice(0, 160) });
    });
  }
  return {
    command: "npm run legal:sources:review-package:v0.2 (built-in scopeScan over the listed paths and patterns)",
    paths,
    patterns,
    exclusions: ["tests", "documentation", "generated evidence", "scope scanner pattern declaration"],
    findings_count: findings.length,
    findings,
    runtime_canaries: {
      network_disabled_canary_for_import_verify_readiness_and_packaging: true,
      status_has_no_network_code_path: true,
      no_runtime_llm_connector: true,
      no_runtime_customer_connector: true,
      no_runtime_production_connector: true,
    },
  };
}

async function listFilesRecursive(root: string) {
  const result: string[] = [];
  async function visit(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      const target = path.join(directory, name);
      const info = await stat(target);
      if (info.isDirectory()) await visit(target);
      else if (info.isFile()) result.push(path.relative(root, target).replaceAll("\\", "/"));
    }
  }
  await visit(root);
  return result;
}

function pythonExecutable() {
  const bundled = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe") : "";
  return bundled && existsSync(bundled) ? bundled : "python";
}

async function reviewPackageCommand() {
  if (process.env.TIVDOC_LEGAL_NETWORK_DISABLED !== "1") throw new Error("review_package_must_run_offline");
  const inventory = await inventories();
  const requests = await generateRequests();
  const acquisition = await acquisitionReadiness(false);
  const corpus = await corpusReadiness(["--from", "2019-01-01", "--as-of", "2026-08-29", "--sector", "general"]);
  const temporal = await readJson<{ queries?: Array<{ label: string; review: unknown; active_only: unknown }> }>(path.join(outputRoot, "temporal-coverage-report.json"), { queries: [] });
  const catalogDirect = await readJson(path.join(outputRoot, "catalog-discovery-report.json"), {});
  const citation = await readJson(path.join(outputRoot, "citation-round-trip-report.json"), {});
  const reproducibilityBase = await readJson(path.join(outputRoot, "clean-room-reproducibility-report.json"), {});
  const sourceDiff = await readJson(path.join(outputRoot, "source-byte-diff-report.json"), {});
  const scope = await scopeScan();
  if (scope.findings_count !== 0) throw new Error("scope_scan_failed");
  const ledger = await verifyOwnerAcquisitionLedger({ ledgerRoot: acquisitionLedgerRoot, artifactRoot: ownerArtifactRoot });
  const packageParent = path.dirname(reviewPackageRoot);
  if (path.resolve(packageParent) !== path.resolve(outputRoot)) throw new Error("review_package_path_escape");
  await rm(reviewPackageRoot, { recursive: true, force: true });
  await mkdir(reviewPackageRoot, { recursive: true });
  const files: Array<[string, unknown | string]> = [
    ["index.md", `# Official Legal Source Acquisition and Evidence Hardening V0.2\n\nPackage status: ${acquisition.status}\n\nCorpus status remains LEGAL_SOURCE_CORPUS_INCOMPLETE. No source, parameter or legal rule is active.\n`],
    ["acquisition-readiness.json", acquisition],
    ["corpus-readiness.json", corpus],
    ["source-inventory.json", { counts: inventory.counts, reconciliation: inventory.count_reconciliation, registry: inventory.state.manifest.sources }],
    ["observation-inventory.json", { observations: inventory.observations }],
    ["artifact-version-inventory.json", { artifact_versions: inventory.artifactVersions }],
    ["legal-version-inventory.json", { legal_text_versions: inventory.legalVersions, parsed_versions: inventory.parsedVersions }],
    ["acquisition-ledger.json", ledger],
    ["quarantine-ledger.json", { quarantined_or_unavailable: inventory.quarantined }],
    ["provenance-matrix.json", inventory.state.provenance],
    ["catalog-snapshots-and-diffs.json", { browser_observations: inventory.state.browser.observations, direct_fetch_report: catalogDirect }],
    ["change-candidate-inventory.json", sourceDiff],
    ["coverage-matrix.json", inventory.coverage],
    ["candidate-retrieval-matrix.json", { queries: (temporal.queries ?? []).map((entry) => ({ label: entry.label, result: entry.review })) }],
    ["active-only-retrieval-matrix.json", { queries: (temporal.queries ?? []).map((entry) => ({ label: entry.label, result: entry.active_only })) }],
    ["citation-roundtrip.json", citation],
    ["reproducibility.json", {
      base_report: reproducibilityBase,
      input_inventory: inventory.artifactVersions.map((entry) => ({ artifact_version_id: entry.artifact_version_id, sha256: entry.artifact_sha256 })),
      runtime: { node: process.version, platform: process.platform, arch: process.arch, timezone_runs: ["UTC", "Asia/Jerusalem"], locale: "deterministic JSON code-point ordering" },
      parser_outputs: inventory.parsedVersions,
      clean_room_directories: ["output/legal-knowledge/reproducibility/run-a", "output/legal-knowledge/reproducibility/run-b"],
      required_tests: ["stale_output_cleanup", "hash_mismatch_failure", "atomic_partial_failure_recovery", "path_order_timezone_invariance"],
    }],
    ["scope-scan.json", scope],
    ["owner-legal-review-checklist.md", "# Owner/legal review checklist\n\n- Bind every decision to exact artifact and parsed hashes.\n- Verify instrument identity, publisher, host and artifact role independently.\n- Confirm effective intervals, scope, population, exceptions and relations.\n- Resolve every owner acquisition request using the original official download.\n- Do not activate sources, parameters or legal rules in this package.\n"],
  ];
  for (const [relative, content] of files) {
    const target = path.join(reviewPackageRoot, relative);
    if (typeof content === "string") await writeTextAtomic(target, content);
    else await writeJsonAtomic(target, content);
  }
  const ownerRequestRoot = path.join(reviewPackageRoot, "owner-acquisition-requests");
  for (const requestId of requests.request_ids) {
    const sourceRoot = path.join(handoffRoot, requestId);
    for (const name of (await readdir(sourceRoot)).sort()) {
      const content = await readFile(path.join(sourceRoot, name));
      await mkdir(path.join(ownerRequestRoot, requestId), { recursive: true });
      await writeFile(path.join(ownerRequestRoot, requestId, name), content);
    }
  }
  const packageFiles = (await listFilesRecursive(reviewPackageRoot)).filter((name) => name !== "package-manifest.json");
  const manifestEntries = [];
  for (const relative of packageFiles) {
    const bytes = await readFile(path.join(reviewPackageRoot, relative));
    manifestEntries.push({ path: relative, byte_count: bytes.byteLength, sha256: hash(bytes) });
  }
  await writeJsonAtomic(path.join(reviewPackageRoot, "package-manifest.json"), {
    schema_version: "legal-review-package-manifest-v0.2",
    package_status: acquisition.status,
    corpus_status: "LEGAL_SOURCE_CORPUS_INCOMPLETE",
    deterministic_archive_metadata: true,
    manifest_self_excluded_to_avoid_recursive_hash: true,
    files: manifestEntries,
  });
  const zipResult = spawnSync(pythonExecutable(), [path.resolve(repoRoot, "scripts", "legal-review-package-zip.py"), reviewPackageRoot, reviewZipPath], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (zipResult.status !== 0) throw new Error("review_package_zip_failed");
  const zip = JSON.parse(zipResult.stdout.trim());
  return {
    package_path: path.relative(repoRoot, reviewPackageRoot).replaceAll("\\", "/"),
    zip_path: path.relative(repoRoot, reviewZipPath).replaceAll("\\", "/"),
    zip_sha256: zip.zip_sha256,
    package_contents_count: zip.package_files,
    package_manifest_entries: zip.manifest_entries,
    archive_verified: zip.verified,
    deterministic_archive_timestamp: zip.deterministic_timestamp,
    acquisition_status: acquisition.status,
    corpus_status: "LEGAL_SOURCE_CORPUS_INCOMPLETE",
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  let result: unknown;
  let exitCode = 0;
  if (command === "request") result = await generateRequests();
  else if (command === "import") result = await importCommand(args);
  else if (command === "verify") {
    result = await verifyCommand(args);
    exitCode = (result as { exit_code: number }).exit_code;
  } else if (command === "self-test") result = await toolingSelfTestCommand();
  else if (command === "operational-readiness") {
    result = await strictOperationalReadinessCommand();
    exitCode = (result as { exit_code: number }).exit_code;
  }
  else if (command === "test-acquisition-instance") result = await testAcquisitionInstanceCommand(args);
  else if (command === "instance-readiness") {
    result = await acquisitionInstanceReadinessCommand(args);
    exitCode = (result as { exit_code: number }).exit_code;
  }
  else if (command === "status") result = await statusCommand();
  else if (command === "readiness") {
    result = await acquisitionReadiness();
    exitCode = (result as { exit_code: number }).exit_code;
  } else if (command === "corpus-readiness") {
    result = await corpusReadiness(args);
    exitCode = (result as { exit_code: number }).exit_code;
  } else if (command === "review-package") result = await reviewPackageCommand();
  else throw new Error("unknown_legal_acquisition_command");
  const status = typeof result === "object" && result && "status" in result ? String((result as { status: unknown }).status) : `LEGAL_ACQUISITION_${command.toUpperCase().replaceAll("-", "_")}_COMPLETED`;
  process.stdout.write(`${status}\n${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}

main().catch((error) => {
  const code = error instanceof Error && /^[A-Za-z0-9_:,.-]+$/u.test(error.message) ? error.message : "legal_acquisition_command_failed";
  process.stderr.write(`LEGAL_ACQUISITION_COMMAND_FAILED ${code}\n`);
  process.exitCode = 3;
});
