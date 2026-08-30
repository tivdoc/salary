#!/usr/bin/env node
/** Independent TypeScript/Node verifier. It imports no package-builder module. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const epochId = "TIVDOC_EVIDENCE_EPOCH_2_V0.5.0";
const manifestName = "package-manifest.json";
const scannerName = "independent-secret-pii-scan.json";
const zeroKeys = new Set([
  "customer_files_read", "openai_calls", "external_supabase_connections", "migrations",
  "production_preview_deploy_actions", "persistent_owner_imports", "reviewed_sources", "active_sources",
  "real_numeric_candidates", "real_numeric_attestations", "active_parameters", "israeli_rules", "findings", "shadow_runs",
]);
const delegateNames = new Set([
  "diagnostic_cli", "strict_cli", "corpus_topic_gate", "server_resolver_admission",
  "future_activation_adapter", "future_shadow_admission_adapter",
]);
const historicalHashes: Record<string, string> = {
  "V0.4": "77bd9874cddeae848ad1b7cf376ab3e247bca22b455567f75248cfa3eaea096c",
  "V0.4.1": "3926163f825c02fdd7e0fec49ae396ef8fa8ebcc0334961ee1f84e71384570d2",
  "V0.4.2": "c3c7135821097e68e00717b93300939cc84d565932a0dacd6cc239a684db6636",
};

function digest(algorithm: "sha1" | "sha256", value: Uint8Array | string) {
  return createHash(algorithm).update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableReceiptPayload(value: unknown) {
  const parsed = JSON.parse(canonicalJson(value)) as unknown;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function array(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
}

function string(value: unknown, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  return value;
}

function git(repo: string, args: string[], encoding: "utf8" | "buffer" = "utf8") {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: encoding === "utf8" ? "utf8" : null, windowsHide: true });
  if (result.status !== 0) throw new Error("git_command_failed");
  return encoding === "utf8" ? String(result.stdout).trim() : Buffer.from(result.stdout as Buffer);
}

function safeArchivePath(value: string) {
  if (!value || value.includes("\\") || value.includes("\0") || value.normalize("NFC") !== value) throw new Error("archive_path_not_canonical");
  if (value.startsWith("/") || value.startsWith("//") || /^[A-Za-z]:/u.test(value)) throw new Error("archive_absolute_or_drive_path");
  for (const part of value.split("/")) {
    if (!part || part === "." || part === "..") throw new Error("archive_path_traversal");
    if (part.includes(":") || /[ .]$/u.test(part) || [...part].some((character) => character.codePointAt(0)! < 32)) throw new Error("archive_windows_unsafe_path");
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part)) throw new Error("archive_reserved_device_path");
  }
  return value;
}

function crc32(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

type ZipMember = Readonly<{ name: string; bytes: Buffer; mode: number; crc32: number; localOffset: number }>;

export function parseStoredZip(bytes: Buffer): Map<string, ZipMember> {
  let eocd = -1;
  for (let offset = Math.max(0, bytes.length - 65_557); offset <= bytes.length - 22; offset += 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) eocd = offset;
  }
  if (eocd < 0) throw new Error("archive_eocd_missing");
  const commentLength = bytes.readUInt16LE(eocd + 20);
  if (eocd + 22 + commentLength !== bytes.length || commentLength !== 0) throw new Error("archive_trailing_or_comment_bytes");
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const totalEntries = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries || totalEntries > 10_000 || centralOffset + centralSize !== eocd) throw new Error("archive_multidisk_or_central_directory_invalid");
  const members = new Map<string, ZipMember>();
  const folded = new Set<string>();
  let cursor = centralOffset;
  let previousName = "";
  let previousLocalOffset = -1;
  let expectedLocalOffset = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("archive_central_record_invalid");
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const time = bytes.readUInt16LE(cursor + 12);
    const date = bytes.readUInt16LE(cursor + 14);
    const expectedCrc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const memberCommentLength = bytes.readUInt16LE(cursor + 32);
    const diskStart = bytes.readUInt16LE(cursor + 34);
    const creatorSystem = bytes.readUInt16LE(cursor + 4) >>> 8;
    const external = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = safeArchivePath(bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"));
    if ((flags & ~0x800) !== 0 || method !== 0 || compressed !== uncompressed || extraLength !== 0 || memberCommentLength !== 0 || diskStart !== 0) throw new Error("archive_member_policy_invalid");
    if (creatorSystem !== 3 || time !== 0 || date !== 33 || (external >>> 16 & 0o170000) !== 0o100000 || (external >>> 16 & 0o777) !== 0o644) throw new Error("archive_nondeterministic_metadata");
    if (name <= previousName || localOffset <= previousLocalOffset || localOffset !== expectedLocalOffset) throw new Error("archive_nondeterministic_order");
    previousName = name;
    previousLocalOffset = localOffset;
    if (members.has(name)) throw new Error("archive_duplicate_member");
    const caseKey = name.toLocaleLowerCase("en-US");
    if (folded.has(caseKey)) throw new Error("archive_case_collision");
    folded.add(caseKey);
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("archive_local_header_invalid");
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
    if (localFlags !== flags || localMethod !== method || localName !== name || localExtraLength !== 0) throw new Error("archive_local_central_divergence");
    const dataStart = localOffset + 30 + localNameLength;
    const data = bytes.subarray(dataStart, dataStart + uncompressed);
    if (data.byteLength !== uncompressed || crc32(data) !== expectedCrc) throw new Error("archive_crc_or_length_mismatch");
    members.set(name, { name, bytes: Buffer.from(data), mode: external >>> 16, crc32: expectedCrc, localOffset });
    expectedLocalOffset = dataStart + uncompressed;
    cursor += 46 + nameLength;
  }
  if (cursor !== eocd || expectedLocalOffset !== centralOffset) throw new Error("archive_central_size_mismatch");
  return members;
}

function jsonMember(members: Map<string, ZipMember>, name: string) {
  const member = members.get(name);
  if (!member) throw new Error(`required_member_missing:${name}`);
  return object(JSON.parse(member.bytes.toString("utf8")) as unknown, `json_object_required:${name}`);
}

function claimByBasename(members: Map<string, ZipMember>, basename: string) {
  const matches = [...members.keys()].filter((name) => name.startsWith("current-claims/") && path.posix.basename(name) === basename);
  if (matches.length !== 1) throw new Error(`claim_member_count_invalid:${basename}`);
  return jsonMember(members, matches[0]);
}

function walk(value: unknown): unknown[] {
  if (Array.isArray(value)) return [value, ...value.flatMap(walk)];
  if (value !== null && typeof value === "object") return [value, ...Object.values(value as Record<string, unknown>).flatMap(walk)];
  return [value];
}

function stableIds(records: unknown[], prefix: string) {
  const expression = new RegExp(`^${prefix}[0-9]{3}(?:_[A-Z0-9_]+)?$`, "u");
  const found = records.map((record) => {
    const matches = [...new Set(walk(record).filter((value): value is string => typeof value === "string" && expression.test(value)))];
    if (matches.length !== 1) throw new Error(`stable_case_id_missing_or_ambiguous:${prefix}`);
    return matches[0];
  });
  if (new Set(found).size !== found.length) throw new Error(`stable_case_id_duplicate:${prefix}`);
  return found;
}

function validateCases(value: unknown, label: string) {
  const cases = array(value, `case_matrix_invalid:${label}`);
  if (cases.length === 0) throw new Error(`case_matrix_empty:${label}`);
  for (const raw of cases) {
    const item = object(raw, `case_not_object:${label}`);
    if (item.passed !== true && item.reconciled !== true && !("expected" in item && "actual" in item && canonicalJson(item.expected) === canonicalJson(item.actual))) throw new Error(`case_failed:${label}`);
  }
  return cases.length;
}

function validateClaims(members: Map<string, ZipMember>) {
  const incident = claimByBasename(members, "cross-package-incident-registry.json");
  const references = array(incident.references, "incident_references_invalid");
  const uniqueIncidents = array(incident.unique_incidents, "incident_unique_invalid");
  const summary = object(incident.summary, "incident_summary_invalid");
  if (references.length !== 15 || summary.reference_count !== 15 || summary.unique_path_hash_incident_count !== uniqueIncidents.length || incident.historical_roots_repaired !== false) throw new Error("incident_registry_counts_or_authority_invalid");
  const incidentIds = new Set(uniqueIncidents.map((value) => object(value, "incident_not_object").incident_id));
  const referenceIds = references.map((value) => object(value, "reference_not_object").reference_id);
  if (new Set(referenceIds).size !== 15 || references.some((value) => !incidentIds.has(object(value, "reference_not_object").incident_id))) throw new Error("incident_crosswalk_incomplete");

  const disposition = claimByBasename(members, "evidence-root-disposition-registry.json");
  if (disposition.append_only !== true || disposition.hash_bound !== true || disposition.historical_roots_can_satisfy_current_admission !== false) throw new Error("disposition_registry_policy_invalid");
  const dispositionRecords = array(disposition.records, "disposition_records_invalid").map((value) => object(value, "disposition_record_invalid"));
  const dispositionPackageId = (row: Record<string, unknown>) => row.package_identity !== null && typeof row.package_identity === "object" && !Array.isArray(row.package_identity)
    ? object(row.package_identity, "disposition_package_identity_invalid").package_id
    : row.root_id;
  for (const rootId of ["V0.4", "V0.4.1"]) {
    const states = new Set(dispositionRecords.filter((row) => dispositionPackageId(row) === rootId).map((row) => row.state));
    if (!states.has("quarantined_failed") || !states.has("forensic_only") || states.has("trusted_current")) throw new Error(`historical_disposition_invalid:${rootId}`);
  }
  for (const row of dispositionRecords.filter((item) => ["V0.4", "V0.4.1", "V0.4.2"].includes(String(dispositionPackageId(item))))) {
    if (Object.entries(row).some(([key, value]) => (key.includes("admission") || key.includes("authoritative")) && value === true)) throw new Error("historical_root_admission_true");
  }

  const lifecycle = claimByBasename(members, "lifecycle-reconciliation.json");
  const sources = array(lifecycle.sources, "lifecycle_sources_invalid");
  const totals = object(lifecycle.totals, "lifecycle_totals_invalid");
  if (sources.length !== 17) throw new Error("lifecycle_source_count_invalid");
  stableIds(sources, "SOURCE_LIFECYCLE_");
  for (const key of ["reviewed_sources", "active_sources", "operative_sources"]) if (key in totals && totals[key] !== 0) throw new Error(`real_lifecycle_zero_violated:${key}`);
  const correctedCounts: Record<string, number> = {
    source_count: 17, technical_parsed_sources: 16, technical_failed_sources: 1,
    parsed_but_instrument_quarantined_sources: 2, extracted_chunks: 274,
    instrument_resolved_chunks: 202, quarantined_chunk_cardinality: 72,
    retrievable_review_chunks: 202, canonical_binding_candidate_chunks: 86,
    explanatory_or_corroborative_chunks: 116, needs_review_sources: 17,
    reviewed_sources: 0, inactive_sources: 17, active_sources: 0, operative_sources: 0,
  };
  if (Object.entries(correctedCounts).some(([key, value]) => key in totals && totals[key] !== value)) throw new Error("corrected_lifecycle_count_invalid");
  if (Object.keys(correctedCounts).every((key) => key in totals)
      && (Number(totals.technical_parsed_sources) + Number(totals.technical_failed_sources) !== Number(totals.source_count)
        || Number(totals.extracted_chunks) - Number(totals.quarantined_chunk_cardinality) !== Number(totals.retrievable_review_chunks)
        || Number(totals.canonical_binding_candidate_chunks) + Number(totals.explanatory_or_corroborative_chunks) !== Number(totals.retrievable_review_chunks))) throw new Error("corrected_lifecycle_arithmetic_invalid");
  const invariants = object(lifecycle.invariants ?? {}, "lifecycle_invariants_invalid");
  if (Object.values(invariants).filter((value) => typeof value === "boolean").some((value) => value !== true)) throw new Error("lifecycle_invariant_failed");

  const transitions = claimByBasename(members, "stable-transitions.json");
  const transitionRecords = array(transitions.records, "transition_records_invalid");
  if (transitionRecords.length !== 72) throw new Error("transition_count_invalid");
  stableIds(transitionRecords, "CHUNK_TRANSITION_");
  const transitionTotals = object(transitions.totals ?? {}, "transition_totals_invalid");
  const raw = transitionTotals.raw_chunks ?? transitionTotals.before;
  const retrievable = transitionTotals.retrievable_chunks ?? transitionTotals.after;
  const removed = transitionTotals.transition_count ?? transitionTotals.removed;
  if ([raw, retrievable, removed].every((value) => Number.isInteger(value)) && Number(raw) - Number(retrievable) !== Number(removed)) throw new Error("transition_arithmetic_invalid");
  if (("record_count" in transitionTotals && transitionTotals.record_count !== 72) || ("cardinality_delta" in transitionTotals && transitionTotals.cardinality_delta !== -72)) throw new Error("transition_corrected_totals_invalid");

  const readiness = claimByBasename(members, "readiness-delegate-matrix.json");
  const delegates = array(readiness.delegates, "readiness_delegates_invalid");
  const observedDelegates = new Set(delegates.map((value) => typeof value === "string" ? value : object(value, "delegate_invalid").delegate ?? object(value, "delegate_invalid").delegate_id));
  if (canonicalJson([...observedDelegates].sort()) !== canonicalJson([...delegateNames].sort())) throw new Error("readiness_delegate_set_diverged");
  if (Array.isArray(readiness.synthetic_ready)) {
    validateCases(readiness.synthetic_ready, "synthetic_ready");
    const hashes = new Set(readiness.synthetic_ready.map((value) => {
      const item = object(value, "synthetic_ready_invalid");
      return item.decision_hash ?? item.decision_sha256;
    }));
    if (hashes.size !== 1 || hashes.has(undefined)) throw new Error("synthetic_ready_decision_hash_diverged");
  } else {
    const syntheticReady = object(readiness.synthetic_ready, "synthetic_ready_invalid");
    if (syntheticReady.status !== "READY" || syntheticReady.all_six_identical !== true || !/^[a-f0-9]{64}$/u.test(String(syntheticReady.decision_sha256))) throw new Error("synthetic_ready_failed");
  }
  const staticGuard = object(readiness.static_guard, "readiness_static_guard_invalid");
  if (staticGuard.passed !== true || ![staticGuard.production_manifest_reachable, staticGuard.production_reachable, staticGuard.test_fixture_production_reachable].includes(false)) throw new Error("test_only_ready_fixture_production_reachability_not_denied");
  const realBlocked = array(readiness.real_blocked, "real_blocked_invalid");
  validateCases(realBlocked, "real_blocked");
  if (realBlocked.some((value) => JSON.stringify(value).includes("READY") && !JSON.stringify(value).includes("BLOCKED_NOT_READY"))) throw new Error("real_readiness_case_not_blocked");
  const mutations = claimByBasename(members, "readiness-mutation-matrix.json");
  const mutationCount = validateCases(mutations.cases, "readiness_mutations");
  const temporal = claimByBasename(members, "temporal-sector-population-matrix.json");
  const temporalCases = array(temporal.cases, "temporal_cases_invalid");
  const temporalCount = validateCases(temporalCases, "temporal_sector_population");
  stableIds(temporalCases, "TEMPORAL_CASE_");
  const multi = claimByBasename(members, "multi-instrument-matrix.json");
  const multiCount = validateCases(multi.cases, "multi_instrument");
  const reporting = claimByBasename(members, "reporting-reconciliation.json");
  const reportingRows = array(reporting.reconciliations, "reporting_rows_invalid");
  const reportingCount = validateCases(reportingRows, "reporting_reconciliation");
  stableIds(reportingRows, "REPORT_RECONCILIATION_");
  const commandLedger = claimByBasename(members, "command-ledger.json");
  const commands = array(commandLedger.commands, "command_ledger_invalid").map((value) => object(value, "command_ledger_row_invalid"));
  if (commands.length === 0 || new Set(commands.map((row) => row.command_id)).size !== commands.length) throw new Error("command_ledger_empty_or_duplicate");
  for (const [index, row] of commands.entries()) {
    if (row.command_id !== `COMMAND_${String(index + 1).padStart(3, "0")}` || typeof row.purpose !== "string" || row.purpose.length === 0
        || typeof (row.command ?? row.command_reference) !== "string" || typeof row.subject_status !== "string" || typeof row.subject_reason !== "string"
        || !Number.isInteger(row.expected_exit) || !Number.isInteger(row.actual_exit)
        || row.expectation_matched !== (row.expected_exit === row.actual_exit) || typeof row.subject_passed !== "boolean") throw new Error("command_ledger_result_invalid");
    if ((row.output_artifact_path === undefined) !== (row.output_artifact_sha256 === undefined)
        || row.output_artifact_path !== undefined && (typeof row.output_artifact_path !== "string" || !/^[a-f0-9]{64}$/u.test(String(row.output_artifact_sha256)))) throw new Error("command_ledger_output_binding_invalid");
  }
  const zeros = claimByBasename(members, "zero-invariants.json");
  const counters = object(zeros.counters, "zero_counters_invalid");
  if (canonicalJson([...Object.keys(counters)].sort()) !== canonicalJson([...zeroKeys].sort()) || Object.values(counters).some((value) => value !== 0) || zeros.all_zero !== true) throw new Error("zero_invariants_invalid");
  return { incident_reference_count: 15, unique_incident_count: uniqueIncidents.length, lifecycle_source_count: 17, transition_count: 72, delegate_count: delegates.length, real_blocked_count: realBlocked.length, readiness_mutation_count: mutationCount, temporal_case_count: temporalCount, multi_instrument_count: multiCount, reporting_reconciliation_count: reportingCount, command_count: commands.length, zero_invariant_count: Object.keys(counters).length, passed: true };
}

export function verifyEpochPackage(packageBytes: Buffer, repo: string) {
  const members = parseStoredZip(packageBytes);
  const manifest = jsonMember(members, manifestName);
  if (manifest.schema_version !== "tivdoc-evidence-epoch-package-manifest-v0.5.0" || manifest.epoch_id !== epochId || manifest.manifest_self_excluded !== true) throw new Error("manifest_identity_invalid");
  const declared = array(manifest.files, "manifest_files_invalid").map((value) => object(value, "manifest_record_invalid"));
  if (manifest.file_count !== declared.length) throw new Error("manifest_count_invalid");
  const expectedNames = [...members.keys()].filter((name) => name !== manifestName).sort();
  const declaredNames = declared.map((row) => string(row.path, "manifest_path_invalid")).sort();
  if (canonicalJson(expectedNames) !== canonicalJson(declaredNames) || new Set(declaredNames).size !== declaredNames.length) throw new Error("manifest_membership_invalid");
  for (const row of declared) {
    const bytes = members.get(String(row.path))!.bytes;
    if (row.byte_length !== bytes.byteLength || row.content_sha256 !== digest("sha256", bytes) || row.file_mode !== "100644") throw new Error("manifest_member_binding_invalid");
  }
  const epoch = jsonMember(members, "evidence-epoch-2.json");
  if (epoch.schema_version !== "tivdoc-evidence-epoch-v2" || epoch.epoch_id !== epochId || epoch.parent_trust_root !== null || epoch.authoritative_bytes_source !== "git_object_database" || epoch.historical_packages_are_incident_references_only !== true) throw new Error("epoch_no_parent_trust_invalid");
  const historical = array(epoch.historical_disposition_references, "historical_references_invalid").map((value) => object(value, "historical_reference_invalid"));
  if (new Set(historical.map((row) => row.package_id)).size !== 3) throw new Error("historical_references_incomplete");
  for (const row of historical) {
    const packageId = string(row.package_id, "historical_package_id_invalid");
    if (row.package_sha256 !== historicalHashes[packageId] || row.authority === "trusted" || row.authority === "trusted_current") throw new Error("historical_fallback_or_identity_invalid");
    const dispositions = new Set(array(row.disposition, "historical_disposition_invalid"));
    if (["V0.4", "V0.4.1"].includes(packageId) && (!dispositions.has("quarantined_failed") || !dispositions.has("forensic_only"))) throw new Error("historical_quarantine_missing");
  }
  const head = string(epoch.final_head, "epoch_head_invalid");
  const tree = string(epoch.final_tree, "epoch_tree_invalid");
  if (git(repo, ["rev-parse", head]) !== head || git(repo, ["rev-parse", `${head}^{tree}`]) !== tree) throw new Error("epoch_head_or_tree_unreachable");
  const inventory = jsonMember(members, "git-object-inventory.json");
  const entries = array(inventory.entries, "git_inventory_invalid").map((value) => object(value, "git_entry_invalid"));
  if (inventory.entry_count !== entries.length || inventory.unreachable_count !== 0) throw new Error("git_inventory_counts_invalid");
  const paths = entries.map((row) => safeArchivePath(string(row.path, "git_path_invalid")));
  if (new Set(paths).size !== paths.length || new Set(paths.map((value) => value.toLocaleLowerCase("en-US"))).size !== paths.length) throw new Error("git_inventory_path_identity_invalid");
  const contentHashes = new Map<string, string>();
  for (const row of entries) {
    const sourcePath = String(row.path);
    const packagePath = `git-object-bytes/${sourcePath}`;
    if (row.package_path !== packagePath || !members.has(packagePath)) throw new Error("git_inventory_package_path_swapped");
    const data = members.get(packagePath)!.bytes;
    const calculatedOid = digest("sha1", Buffer.concat([Buffer.from(`blob ${data.byteLength}\0`), data]));
    if (row.git_blob_oid_sha1 !== calculatedOid || row.content_sha256 !== digest("sha256", data) || row.byte_length !== data.byteLength) throw new Error("git_inventory_byte_binding_invalid");
    if (git(repo, ["rev-parse", `${head}:${sourcePath}`]) !== calculatedOid || !git(repo, ["ls-tree", head, "--", sourcePath]).startsWith(`${row.file_mode} blob ${calculatedOid}\t`)) throw new Error("git_inventory_object_or_mode_unreachable");
    if (!git(repo, ["cat-file", "blob", calculatedOid], "buffer").equals(data)) throw new Error("git_inventory_git_bytes_mismatch");
    contentHashes.set(sourcePath, String(row.content_sha256));
  }
  const verifierSources = object(epoch.verifier_sources, "verifier_sources_invalid");
  const generatorSources = object(epoch.generator_sources, "generator_sources_invalid");
  if (epoch.generator_version !== "v0.5.0" || generatorSources["scripts/wave23-evidence-epoch/epoch_builder.py"] !== contentHashes.get("scripts/wave23-evidence-epoch/epoch_builder.py")) throw new Error("generator_source_or_version_binding_invalid");
  if (verifierSources.python !== contentHashes.get("scripts/wave23-evidence-epoch/verify_epoch_python.py") || verifierSources.typescript !== contentHashes.get("scripts/wave23-evidence-epoch/verify_epoch_ts.mts")) throw new Error("verifier_source_hash_binding_invalid");
  const verifierRules = object(epoch.verifier_rules, "verifier_rules_invalid");
  if (verifierRules.schema_version !== "tivdoc-evidence-epoch-independent-rules-v0.5.0"
      || verifierRules.python !== contentHashes.get("scripts/wave23-evidence-epoch/verify_epoch_python.py")
      || verifierRules.typescript !== contentHashes.get("scripts/wave23-evidence-epoch/verify_epoch_ts.mts")) throw new Error("verifier_rules_hash_binding_invalid");
  const claimInventory = jsonMember(members, "current-claim-inventory.json");
  const claimRows = array(claimInventory.claims, "claim_inventory_invalid").map((value) => object(value, "claim_row_invalid"));
  if (claimInventory.claim_count !== claimRows.length) throw new Error("claim_inventory_count_invalid");
  for (const row of claimRows) {
    const member = members.get(String(row.package_path));
    if (!member || row.byte_length !== member.bytes.byteLength || row.content_sha256 !== digest("sha256", member.bytes) || row.authority_class !== "derived_post_commit_evidence") throw new Error("claim_inventory_binding_invalid");
  }
  const claimValidation = validateClaims(members);
  const scanner = jsonMember(members, scannerName);
  const expectedScope = [...members.keys()].filter((name) => name !== scannerName && name !== manifestName).sort();
  if (canonicalJson(scanner.scope) !== canonicalJson(expectedScope) || scanner.scope_count !== expectedScope.length || scanner.findings_count !== 0 || array(scanner.raw_findings, "scanner_findings_invalid").length !== 0 || scanner.passed !== true || !/^[a-f0-9]{64}$/u.test(String(scanner.rules_sha256))) throw new Error("scanner_scope_or_findings_invalid");
  return {
    schema_version: "tivdoc-evidence-epoch-typescript-verification-v0.5.0",
    implementation: "typescript",
    implementation_runtime: "node_buffer_manual_zip_parser",
    implementation_source_sha256: verifierSources.typescript,
    rules_sha256: verifierRules.typescript,
    package_sha256: digest("sha256", packageBytes),
    package_byte_length: packageBytes.byteLength,
    manifest_sha256: digest("sha256", members.get(manifestName)!.bytes),
    zip_member_count: members.size,
    manifest_entry_count: declared.length,
    head,
    tree,
    git_object_count: entries.length,
    unreachable_current_references: 0,
    claim_validation: claimValidation,
    scanner_scope_count: expectedScope.length,
    scanner_rules_sha256: scanner.rules_sha256,
    passed: true,
  };
}

function verifyReceipt(receiptBytes: Buffer, packageBytes: Buffer, pythonReport: Buffer, tsReport: Buffer) {
  const receipt = object(JSON.parse(receiptBytes.toString("utf8")) as unknown, "receipt_invalid");
  const payloadHash = receipt.receipt_payload_sha256;
  delete receipt.receipt_payload_sha256;
  if (payloadHash !== digest("sha256", stableReceiptPayload(receipt))) throw new Error("receipt_payload_hash_invalid");
  const members = parseStoredZip(packageBytes);
  const epoch = jsonMember(members, "evidence-epoch-2.json");
  if (object(receipt.package, "receipt_package_invalid").package_sha256 !== digest("sha256", packageBytes)
      || object(receipt.package, "receipt_package_invalid").byte_length !== packageBytes.byteLength
      || receipt.manifest_sha256 !== digest("sha256", members.get(manifestName)!.bytes)
      || receipt.epoch_id !== epochId || receipt.parent_trust_root !== null
      || receipt.final_head !== epoch.final_head || receipt.final_tree !== epoch.final_tree
      || canonicalJson(receipt.verifier_sources) !== canonicalJson(epoch.verifier_sources)
      || canonicalJson(receipt.verifier_rules) !== canonicalJson(epoch.verifier_rules)) throw new Error("receipt_package_epoch_or_git_binding_invalid");
  const results = object(receipt.verifier_results, "receipt_results_invalid");
  if (object(results.python, "receipt_python_invalid").report_sha256 !== digest("sha256", pythonReport)
      || object(results.typescript, "receipt_typescript_invalid").report_sha256 !== digest("sha256", tsReport)) throw new Error("receipt_verifier_report_swapped");
  return { receipt_sha256: digest("sha256", receiptBytes), package_sha256: digest("sha256", packageBytes), passed: true };
}

function parseArgs(values: string[]) {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    if (!values[index]?.startsWith("--") || values[index + 1] === undefined) throw new Error("arguments_invalid");
    result.set(values[index].slice(2), values[index + 1]);
  }
  return result;
}

function required(args: Map<string, string>, key: string) {
  const value = args.get(key);
  if (!value) throw new Error(`argument_missing:${key}`);
  return value;
}

const [command, ...rawArgs] = process.argv.slice(2);
let result: Record<string, unknown>;
let exitCode = 0;
try {
  const args = parseArgs(rawArgs);
  if (command === "verify") {
    result = verifyEpochPackage(await readFile(required(args, "package")), path.resolve(required(args, "repo")));
  } else if (command === "verify-receipt") {
    result = verifyReceipt(
      await readFile(required(args, "receipt")), await readFile(required(args, "package")),
      await readFile(required(args, "python-report")), await readFile(required(args, "typescript-report")),
    );
  } else throw new Error("command_invalid");
  const output = args.get("output");
  if (output) {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
} catch (error) {
  exitCode = 7;
  const message = error instanceof Error && /^[a-z0-9_.:,/-]{1,300}$/u.test(error.message) ? error.message : "typescript_independent_verification_failed";
  result = { schema_version: "tivdoc-evidence-epoch-typescript-verification-error-v0.5.0", implementation: "typescript", safe_error_code: message, passed: false };
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = exitCode;
