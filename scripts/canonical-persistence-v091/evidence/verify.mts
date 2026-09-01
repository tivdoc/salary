import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, opendir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

import { assertCredentialFreeEvidence } from "./credential-scan.mts";
import {
  assertTrustedGitRepository,
  trustedGitText,
} from "../foundation/trusted-git.mts";
import {
  inspectDeterministicStoreZip,
  writeDeterministicStoreZip,
} from "./deterministic-zip.mts";

type Obj = Record<string, unknown>;
type ManifestEntry = Readonly<{ path: string; sha256: string; byte_count: number }>;
type Manifest = Readonly<{
  schema_version: string;
  payload_files: readonly ManifestEntry[];
  payload_file_count: number;
  payload_bytes: number;
  payload_set_sha256: string;
  self_reference_rule: string;
}>;
const PAYLOADS = Object.freeze([
  "acceptance-receipt.json", "atomicity-matrix.json", "backup-restore.json",
  "capability-matrix.json", "clean-migration.json", "concurrency-matrix.json",
  "connection-breakdown.json", "environment.json", "git.json", "migration-chain.json",
  "migration-matrix.json", "migration-portability-amendment.json", "preflight.json", "regressions.json", "restart-replay.json",
  "rls-matrix.json", "role-sessions.json", "shutdown.json", "supabase-compatibility.json",
] as const);
const MIGRATIONS = Object.freeze([
  ["202608220001_salary_mvp.sql", "bd8e8a66ccf583a962c5fe28cb23335c16cda6616ca6ef12d258f2e8aed78141"],
  ["202608220002_invoice4u_verification.sql", "b69cdeb7a6b768408f115487be76af6e69a955f1d10699f06fb9cda68085e56d"],
  ["202608220003_invoice4u_checkout_expiry.sql", "681108245c1b62c79dc330498810be1316405c4842d873109cfb9e7d29e7c212"],
  ["202608220004_payment_return_recovery.sql", "f78c5b32317055c8748ef47a891e58b9b9351547d2f594228a6ccf45e4afe35a"],
  ["202608220005_meta_measurement.sql", "456781cac1d54dc1be1f191ce4232904b56a0b8863bc6dd48faa22fa6a1b9a5c"],
  ["202608270001_reconciliation_attribution.sql", "a3803d56fa0ba9b8e14cfc0420ec858a965537ac47533ac604ee31f2490a01a6"],
  ["202608280001_ga4_measurement_protocol.sql", "8f18399f804b465d796d1828b852738745dc266aa8f202e265f64028e78b4bed"],
  ["202608290001_engine_persistence_foundation.sql", "0dd5d93d113a7c4ed68515af30d9927bd320255f88593fc04e6015a429db36e5"],
  ["202608300001_canonical_upgrade_compatibility.sql", "7ec2cad5d3d6f6890fbf8ec3bfa0916176b515f804d497ee1359c9938b83d304"],
  ["202608310001_engine_platform_persistence.sql", "74e0615c6375b8cb87da5a09c6a8a29d4e27fe503793b14d767a2199d92c4460"],
  ["202608310002_canonical_postgresql_composition.sql", "27e6163ff8e4caf6512925c96bcb8ead398f47da85e152a52beadcbcaad132a2"],
  ["202608310003_canonical_postgresql_dynamic_hardening.sql", "5a270a03e234794213a4c4fd68706c53b86e9e4501688a77bf628f346e2690da"],
  ["202609010001_controlled_import_ledger.sql", "3e51b4c1cd06c4f654566937c486856c78c192c1923fc287da29f8c0a1463e34"],
  ["202609010002_durable_product_boundaries.sql", "455e8789de89bef18fb1041e009ab87d7a7e005a294209df3b83456d42ff3e6f"],
  ["202609010003_durable_product_integrity_hardening.sql", "2882adc09d5faccbee2f96cf9f1c75b1b40b586f206408795bde189914501029"],
  ["202609010004_durable_governance_workflows.sql", "47bdc778e09d66140b6aee997f32461596dacf1213d9515eb0ce32afd66ffd6f"],
] as const);
const CAPABILITIES = Object.freeze([
  ["cases_and_lifecycle_revisions", "intake.case_lifecycle"],
  ["payment_evidence_references", "intake.payment_evidence"],
  ["conversations_and_messages", "intake.conversations"],
  ["documents_and_artifact_references", "intake.documents_and_artifacts"],
  ["extractions", "intake.extractions"],
  ["canonical_facts_and_conflicts", "intake.canonical_facts"],
  ["hypotheses_and_rule_inputs", "intake.investigation"],
  ["corpus_source_parameter_rule_pins", "analysis.legalPins"],
  ["analysis_runs_and_resume_cursors", "analysis.caseAnalysis"],
  ["per_topic_results", "analysis.topicResults"],
  ["traces_findings_confirmations", "analysis.traceFindings"],
  ["reports_approvals_release_state", "analysis.reports"],
  ["idempotency", "runtime.idempotency"],
  ["jobs_fencing_outbox_audit", "runtime.jobs_outbox_audit"],
] as const);
const REGRESSIONS = Object.freeze([
  "focused_v09_v091", "full_unit_integration", "eslint", "typescript_no_emit",
  "nextjs_production_build", "canonical_v09_acceptance",
] as const);
const CONNECTION_COMPONENTS = Object.freeze([
  "capability_matrix", "tenant_b_seed", "rls", "atomicity", "concurrency",
  "restart_replay", "backup_restore",
] as const);
const POSTGRES_BINARY_SHA256 = Object.freeze({
  postgres: "3204f6811b3e1f8bb89ad94ca7dd7bcb38c7f665c50d532bce463650c4e7d2c5",
  initdb: "537a0801bb41d1a560e0bfb2bec0a4e344dc4ad034ed61648fdf542746e3f649",
  pg_ctl: "23f114eaa965f41c65ca5c1c7d147afc87750f80fd9c2386c6658d7be20d7bf7",
  psql: "54ea051e4e57bc2361b5081f522a2a3f51d5ddaf75e83543e70bd62f86be6299",
  createdb: "6d787ea1a15b939cfafa211ae5b864901498dd9e9ff10ba17a95a068667fa76c",
  dropdb: "b44eaa9d67dbbc556f8efb207aa184b0d482a94523f35a0c702f534924d2786c",
  pg_dump: "4c36682e3ad65e3f85e2643690c4209533be7d872e1a977b11a2dcedb3c203f2",
  pg_restore: "06a1af33738f49724342b66183d68837d0eb2c227bce0829c84884db6443d558",
  pg_isready: "6bc65c291aaec9c3762c43dcf06e97921fb12c09a651e8f634cb38ab7d4af2de",
});
const RLS_TABLES = Object.freeze([
  "analysis_findings", "analysis_hypotheses", "analysis_jobs", "analysis_runs",
  "case_confirmations", "case_conversations", "case_messages", "cases",
  "controlled_import_publication_markers",
  "document_extractions", "documents", "employment_snapshots", "engine_analysis_stage_versions",
  "engine_calculation_trace_versions", "engine_canonical_fact_versions", "engine_case_identity",
  "engine_case_lifecycle_revisions", "engine_case_state", "engine_durable_jobs",
  "engine_idempotency_records", "engine_job_history", "engine_legal_version_pins",
  "engine_logical_effect_receipts", "engine_object_write_sagas", "engine_outbox_events",
  "engine_payment_evidence_refs", "engine_platform_audit_events", "engine_report_versions",
  "engine_review_task_versions", "engine_rule_input_versions", "engine_topic_result_versions",
  "funnel_events", "funnel_sessions", "payments", "product_case_owners",
  "product_identity_sessions", "product_privacy_request_versions",
  "product_private_report_objects", "questionnaire_responses",
] as const);
const TENANT_POLICY_TABLES = Object.freeze([
  "public.analysis_findings", "public.analysis_hypotheses", "public.analysis_runs",
  "public.case_confirmations", "public.case_conversations", "public.case_messages",
  "public.document_extractions", "public.documents", "public.engine_analysis_stage_versions",
  "public.engine_calculation_trace_versions", "public.engine_canonical_fact_versions",
  "public.engine_case_identity", "public.engine_case_lifecycle_revisions", "public.engine_case_state",
  "public.engine_durable_jobs", "public.engine_idempotency_records", "public.engine_job_history",
  "public.engine_legal_version_pins", "public.engine_logical_effect_receipts",
  "public.engine_object_write_sagas", "public.engine_outbox_events", "public.engine_payment_evidence_refs",
  "public.engine_platform_audit_events", "public.engine_report_versions", "public.engine_review_task_versions",
  "public.engine_rule_input_versions", "public.engine_topic_result_versions",
  "public.product_case_owners", "public.product_identity_sessions",
  "public.product_privacy_request_versions", "public.product_private_report_objects",
] as const);
const BASE_HEAD = "43f3e63a5cef75b24e95d1bce4383e9249a2d866";
const BASE_TREE = "16aea86ef3251ec92e52ebf0e4757902459cf987";
const CANONICAL_HASH = "27e6163ff8e4caf6512925c96bcb8ead398f47da85e152a52beadcbcaad132a2";
const POSTGRES_ARCHIVE_SHA256 = "2f868d77832f5cbc62182a0ca57f02df14d33d85ce0d0bbaaeb0de3a7029bd2b";
const POSTGRES_ARCHIVE_URL = "https://get.enterprisedb.com/postgresql/postgresql-17.11-2-windows-x64-binaries.zip";
const POSTGRES_DISTRIBUTION_TREE_SHA256 = "1fabdc14b0bad1f57191a42bcd0c6ddc30a6ac7997540c81bca4b0793285fb66";
const DEPENDENCY_AGGREGATE_SHA256 = "972fa0fa7dc31e41e0bc9374f3138d1e05d7daed1e21ba643577d61a1661ea33";
const DEPENDENCY_PINS = Object.freeze([
  ["pg", "8.23.0", "sha512-Ip2EQCngowJLGOfCwkFhPXU7/ljlhn6Rxlmy4XYfL2Y+vyRM59+8uR2xqRWKdYmbXmxCFOAmKxBuSUCdF34qLg==", 20, 100044, "d646057eb7d79aa93f66a004596bd10754eddfb8dda7432bc8dc799c6a30c607"],
  ["pg-cloudflare", "1.4.0", "sha512-Vo7z/6rrQYxpNRylp4Tlob2elzbh+N/MOQbxFVWCxS7oEx6jF53GTJFxK2WWpKuBRkmiin4Mt+xofFDjx09R0A==", 13, 23542, "452e0c040bf24cddcf89ed354117e8515ad2ca7ae41e3f03d6ce1f8416a49632"],
  ["pg-connection-string", "2.14.0", "sha512-XwWDGcLRGCXAR8F/AM5bG7Q+A3Wm2s6QeEjlOKZLlH3UYcguiqCWKyWXVag5TLTIjR7oOJUY8kcADaZgWPyLeg==", 6, 16144, "a3653ffefdd2ec57840b7e7755063e80c4f235f5db7284341bf90ec25d45458d"],
  ["pg-int8", "1.0.1", "sha512-WCtabS6t3c8SkpDBUlb1kjOs7l66xsGdKpIPZsg4wR+B3+u9UAum2odSsF9tnvxg80h4ZxLWMy4pRjOsFIqQpw==", 4, 3186, "c97304d61c60aebd2e56232109de22651f9fa531843e89f17e69f4e309e9b9c6"],
  ["pg-pool", "3.14.0", "sha512-gKtPkFdQPU3DksooVLi9LsjZxrsBUZIpa+7aVx+LV5pNh0KzP4Zleud2po+ConrxbuXGBJ6Hfer6hdgpIBpBaw==", 5, 29835, "7bed63cd11c613f0786956307443e725813ff28e56c44379fbbe674f201e1fae"],
  ["pg-protocol", "1.16.0", "sha512-sILXutLVjCLjcDuOmvhX5e2Z4cS5qG/6Bu3VkpFwdf/633ElGLpEh9bgmuI5I4sqKqkifQiGyiCcx1HdtrK7tg==", 42, 200886, "8443ca59728a93b7320cee5d1e28cb6280accadd82f19dfe0c131c65bc0a1c3d"],
  ["pg-types", "2.2.0", "sha512-qTAAlrEsl8s4OiEQY69wDvcMIdQN6wdz5ojQiOy6YRMuynxenON0O5oCpJI6lshc6scgAY8qvJ2On/p+CXY0GA==", 13, 35296, "19930dbbd9e0a6da931879c20620b2300701f04976e83db75e47a452a6d6d380"],
  ["pgpass", "1.0.5", "sha512-FdW9r/jQZhSeohs1Z3sI1yxFQNFvMcnmfuj4WBMUTxOrAyLMaTcE1aAMBiTlbMNaXvBCQuVi0R7hd8udDSP7ug==", 4, 10323, "ca1a1270959f79d36755aea2c1332848c3b25da441f52a7689a31deb88d00ef8"],
  ["postgres-array", "2.0.0", "sha512-VpZrUqU5A69eQyW2c5CA1jtLecCsN2U/bD6VilrFDWq5+5UIEVO7nazS3TEcHf1zuPYO/sqGvUvW62g86RXZuA==", 5, 4903, "d793d71d3e82795794dc7dc632435fee0b57413d0abc690b434e15fceee3ff3f"],
  ["postgres-bytea", "1.0.1", "sha512-5+5HqXnsZPE65IJZSMkZtURARZelel2oXUEO8rH83VS/hxH5vv1uHquPg5wZs8yMAfdv971IU+kcPUczi7NVBQ==", 4, 3095, "a463f3fcdd93c988cbf80a7aeedbc8e87c8bd01f7322cd0b535cd9a832c25c63"],
  ["postgres-date", "1.0.7", "sha512-suDmjLVQg78nMK2UZ454hAG+OAW+HQPZ6n++TNDUX+L0+uUlLywnoxJKDou51Zm+zTCjrCl0Nq6J9C5hP9vK/Q==", 4, 5915, "46c4fe0a77aa0bd577d4de5c3af69353a76c99f5e097dee3714d264ada46f9b3"],
  ["postgres-interval", "1.2.0", "sha512-9ZhXKM/rw350N1ovuWHbGxnGh/SNJ4cnxHiM0rxE4VN41wsg8P8zWn9hv/buK00RP4WvlOyr/RBDiptyxVbkZQ==", 5, 6727, "db5bd1f96cb54c02c25ad0e79a1c79009290ce9c47bd94e0286ac4c9240c2d8a"],
  ["split2", "4.2.0", "sha512-UcjcJOWknrNkF6PLX83qcHM6KHgVKNkV62Y8a5uYDVv9ydGQVwAHMKqHdJje1VTWpljG0WYpCDhrCdAOYH4TWg==", 6, 17419, "34bd812130b3808f505ad4d75a57d606cccea6dcc5586a89f69cea24361002ca"],
  ["xtend", "4.0.2", "sha512-LKYU1iAXJXUgAXn9URjiu+MWhyUXHsvfp7mcuYm9dSUKK0/CjtrUwFAxD82/mCWbtLsGjFIad0wIsod4zrTAEQ==", 7, 6465, "74690abb546f790cfd84b299be1ba122e6ee8687d78c6db7fd867c5bfb779d78"],
] as const);
const ZIP_NAME = "tivdoc-canonical-postgresql-dynamic-v0.9.1.zip";
const bootstrapWrapper = process.argv.includes("--bootstrap-wrapper");
const liveTrustedGit = assertTrustedGitRepository(process.cwd());

const finalRoot = path.resolve(process.argv[2] ?? path.join(
  process.cwd(), "output", "canonical-postgresql-dynamic-v0.9.1", "final",
));
await verifyFinalDirectoryShape(finalRoot, bootstrapWrapper);
const manifestBytes = await readFile(path.join(finalRoot, "evidence-manifest.json"));
const wrapperBytes = await readFile(path.join(finalRoot, "evidence-wrapper-receipt.json"));
const manifest = parseJson<Manifest>(manifestBytes, "DYNAMIC_MANIFEST_INVALID");
const wrapper = object(parseJson<unknown>(wrapperBytes, "DYNAMIC_WRAPPER_INVALID"), "DYNAMIC_WRAPPER_INVALID");
exactKeys(manifest as unknown as Obj, [
  "schema_version", "payload_files", "payload_file_count", "payload_bytes",
  "payload_set_sha256", "self_reference_rule",
], "DYNAMIC_MANIFEST_KEYS_INVALID");
exactKeys(wrapper, [
  "schema_version", "manifest_path", "manifest_sha256", "zip_path", "zip_sha256",
  "zip_byte_count", "repeat_build_zip_sha256", "repeat_build_match",
  "wrapper_excluded_from_manifest_and_zip", "independent_verifier_output_excluded_from_manifest_and_zip",
  "independent_verifier_output_path", "independent_verifier_output_sha256",
  "independent_verifier_output_byte_count", "outer_receipt_complete",
], "DYNAMIC_WRAPPER_KEYS_INVALID");
assert(Array.isArray(manifest.payload_files), "DYNAMIC_MANIFEST_PAYLOAD_FILES_INVALID");
for (const entry of manifest.payload_files) {
  exactKeys(object(entry, "DYNAMIC_MANIFEST_ENTRY_INVALID"), ["path", "sha256", "byte_count"],
    "DYNAMIC_MANIFEST_ENTRY_KEYS_INVALID");
}
  assertCredentialFreeEvidence(Buffer.from(manifestBytes).toString("utf8"));
  assertCredentialFreeEvidence(Buffer.from(wrapperBytes).toString("utf8"));
assert(manifest.schema_version === "tivdoc-canonical-postgresql-dynamic-evidence-manifest-v0.9.1", "DYNAMIC_MANIFEST_SCHEMA_INVALID");
assert(manifest.self_reference_rule
  === "manifest, wrapper, ZIP and verifier output are excluded from payload hashes; manifest is included in ZIP",
"DYNAMIC_MANIFEST_SELF_REFERENCE_RULE_INVALID");
assert(wrapper.schema_version === "tivdoc-canonical-postgresql-dynamic-evidence-wrapper-v0.9.1"
  && wrapper.manifest_path === "evidence-manifest.json", "DYNAMIC_WRAPPER_SCHEMA_INVALID");
assert(wrapper.wrapper_excluded_from_manifest_and_zip === true
  && wrapper.independent_verifier_output_excluded_from_manifest_and_zip === true, "DYNAMIC_SELF_REFERENCE_INVALID");
assert(wrapper.manifest_sha256 === sha256(manifestBytes), "DYNAMIC_MANIFEST_HASH_MISMATCH");
assert(wrapper.repeat_build_match === true && wrapper.repeat_build_zip_sha256 === wrapper.zip_sha256, "DYNAMIC_REPEAT_BUILD_INVALID");
let storedVerifierOutputBytes: Buffer | undefined;
if (bootstrapWrapper) {
  assert(wrapper.outer_receipt_complete === false
    && wrapper.independent_verifier_output_path === "independent-verifier-output.json"
    && wrapper.independent_verifier_output_sha256 === null
    && wrapper.independent_verifier_output_byte_count === null,
  "DYNAMIC_BOOTSTRAP_WRAPPER_INVALID");
} else {
  assert(wrapper.outer_receipt_complete === true
    && wrapper.independent_verifier_output_path === "independent-verifier-output.json",
  "DYNAMIC_OUTER_RECEIPT_INVALID");
  digest(wrapper.independent_verifier_output_sha256, "DYNAMIC_VERIFIER_OUTPUT_HASH_INVALID");
  storedVerifierOutputBytes = await readFile(path.join(finalRoot, "independent-verifier-output.json"));
  assert(wrapper.independent_verifier_output_byte_count === storedVerifierOutputBytes.byteLength
    && wrapper.independent_verifier_output_sha256 === sha256(storedVerifierOutputBytes),
  "DYNAMIC_VERIFIER_OUTPUT_INTEGRITY_INVALID");
  assertCredentialFreeEvidence(Buffer.from(storedVerifierOutputBytes).toString("utf8"));
}

const paths = manifest.payload_files.map(({ path: value }) => value);
assert(JSON.stringify(paths) === JSON.stringify(PAYLOADS)
  && manifest.payload_file_count === PAYLOADS.length, "DYNAMIC_REQUIRED_PAYLOAD_SET_INVALID");
let payloadBytes = 0;
for (const entry of manifest.payload_files) {
  safeRelative(entry.path);
  digest(entry.sha256, `DYNAMIC_PAYLOAD_HASH_FORMAT_INVALID:${entry.path}`);
  integer(entry.byte_count, 1, `DYNAMIC_PAYLOAD_SIZE_INVALID:${entry.path}`);
  const bytes = await readFile(path.join(finalRoot, entry.path));
  assert(bytes.byteLength === entry.byte_count && sha256(bytes) === entry.sha256, `DYNAMIC_PAYLOAD_INTEGRITY_INVALID:${entry.path}`);
  assertCredentialFreeEvidence(Buffer.from(bytes).toString("utf8"));
  parseJson(bytes, `DYNAMIC_PAYLOAD_JSON_INVALID:${entry.path}`);
  payloadBytes += bytes.byteLength;
}
assert(payloadBytes === manifest.payload_bytes, "DYNAMIC_PAYLOAD_TOTAL_INVALID");
const payloadSet = Buffer.from(manifest.payload_files.map(({ path: name, sha256: hash, byte_count: size }) =>
  `${name}\0${hash}\0${size}\n`).join(""), "utf8");
assert(sha256(payloadSet) === manifest.payload_set_sha256, "DYNAMIC_PAYLOAD_SET_HASH_INVALID");

assert(wrapper.zip_path === ZIP_NAME, "DYNAMIC_ZIP_NAME_INVALID");
const zipPath = path.join(finalRoot, ZIP_NAME);
const zipBytes = await readFile(zipPath);
assert((await stat(zipPath)).isFile() && wrapper.zip_sha256 === sha256(zipBytes)
  && wrapper.zip_byte_count === zipBytes.byteLength, "DYNAMIC_ZIP_HASH_INVALID");
const zipInspection = await inspectDeterministicStoreZip(zipPath);
assert(zipInspection.schema_version === "tivdoc-canonical-postgresql-dynamic-zip-inspection-v0.9.1"
  && zipInspection.entry_count === zipInspection.entries.length, "DYNAMIC_ZIP_INSPECTION_INVALID");
const zipEntries = zipInspection.entries;
const archiveNames = Object.freeze([...paths, "evidence-manifest.json"]);
assert(JSON.stringify(zipEntries.map(({ path: name }) => name)) === JSON.stringify(archiveNames), "DYNAMIC_ZIP_CONTENT_INVALID");
const archived = new Map<string, Readonly<{ sha256: string; byte_count: number }>>([
  ...manifest.payload_files.map((entry) => [entry.path, entry] as const),
  ["evidence-manifest.json", { sha256: sha256(manifestBytes), byte_count: manifestBytes.byteLength }],
]);
for (const entry of zipEntries) {
  const expected = archived.get(entry.path);
  assert(expected !== undefined && entry.sha256 === expected.sha256
    && entry.byte_count === expected.byte_count, `DYNAMIC_ZIP_ENTRY_BYTES_INVALID:${entry.path}`);
  assert(entry.compression === 0 && JSON.stringify(entry.date_time) === "[1980,1,1,0,0,0]"
    && entry.create_system === 3 && entry.external_attr === 0o100644 * 65_536,
  `DYNAMIC_ZIP_ENTRY_METADATA_INVALID:${entry.path}`);
}
await deterministicRebuild(finalRoot, zipPath, archiveNames);

const acceptance = await payload("acceptance-receipt.json");
const atomicity = await payload("atomicity-matrix.json");
const backup = await payload("backup-restore.json");
const capability = await payload("capability-matrix.json");
const clean = await payload("clean-migration.json");
const concurrency = await payload("concurrency-matrix.json");
const connections = await payload("connection-breakdown.json");
const environment = await payload("environment.json");
const git = await payload("git.json");
const chain = await payload("migration-chain.json");
const migration = await payload("migration-matrix.json");
const amendment = await payload("migration-portability-amendment.json");
const preflight = await payload("preflight.json");
const regressions = await payload("regressions.json");
const restart = await payload("restart-replay.json");
const rls = await payload("rls-matrix.json");
const roles = await payload("role-sessions.json");
const shutdown = await payload("shutdown.json");
const supabase = await payload("supabase-compatibility.json");

verifyPreflight(preflight);
verifyEnvironment(environment);
verifyGit(git, preflight);
verifyChain(chain);
verifyMigrationAmendment(amendment);
verifyClean(clean, chain, environment);
verifyMigration(migration, chain);
verifyCapabilities(capability, environment);
verifyRestart(restart);
verifyRoles(roles);
verifyRls(rls);
verifyAtomicity(atomicity);
verifyConcurrency(concurrency);
verifyBackup(backup);
verifyRegressions(regressions, git);
verifyShutdown(shutdown);
verifySupabase(supabase);
const observedConnections = verifyConnections(connections, {
  capability_matrix: count(object(capability.driver_metrics, "DYNAMIC_DRIVER_METRICS_INVALID").connection_attempts, "DYNAMIC_CAPABILITY_CONNECTIONS_INVALID"),
  tenant_b_seed: count(rls.tenant_b_seed_connection_attempts, "DYNAMIC_TENANT_B_CONNECTIONS_INVALID"),
  rls: count(rls.connection_attempts, "DYNAMIC_RLS_CONNECTIONS_INVALID"),
  atomicity: count(atomicity.connection_attempts, "DYNAMIC_ATOMICITY_CONNECTIONS_INVALID"),
  concurrency: count(concurrency.connection_attempts, "DYNAMIC_CONCURRENCY_CONNECTIONS_INVALID"),
  restart_replay: count(restart.connection_attempts, "DYNAMIC_RESTART_CONNECTIONS_INVALID"),
  backup_restore: count(backup.connection_attempts, "DYNAMIC_BACKUP_CONNECTIONS_INVALID"),
});
verifyAcceptance(acceptance, observedConnections);

const verifierResult = Object.freeze({
  schema_version: "tivdoc-canonical-postgresql-dynamic-independent-verifier-v0.9.1",
  verification_mode: bootstrapWrapper ? "BOOTSTRAP" : "FINAL",
  status: bootstrapWrapper ? "BOOTSTRAP_PASS" : "PASS",
  payload_file_count: manifest.payload_file_count,
  payload_bytes: manifest.payload_bytes,
  payload_set_sha256: manifest.payload_set_sha256,
  manifest_sha256: wrapper.manifest_sha256,
  zip_sha256: wrapper.zip_sha256,
  zip_entry_bytes_verified: zipEntries.length,
  deterministic_rebuild_match: true,
  repeat_build_match: true,
  real_postgresql_connection_attempts: observedConnections,
  capability_count: 14,
  atomicity_boundary_count: 8,
  concurrency_case_count: 7,
  regression_command_count: 6,
  credentials_detected: 0,
});
const canonicalVerifierOutput = Buffer.from(`${JSON.stringify(verifierResult, null, 2)}\n`, "utf8");
if (!bootstrapWrapper) {
  assert(storedVerifierOutputBytes !== undefined
    && storedVerifierOutputBytes.equals(canonicalVerifierOutput),
  "DYNAMIC_VERIFIER_OUTPUT_SEMANTIC_MISMATCH");
}
process.stdout.write(`${JSON.stringify(verifierResult)}\n`);

function verifyPreflight(value: Obj): void {
  assert(value.schema_version === "tivdoc-canonical-postgresql-dynamic-preflight-v0.9.1"
    && value.branch === "codex/tivdoc-engine-foundation" && value.base_head === BASE_HEAD
    && value.base_tree === BASE_TREE && value.source_worktree === "CLEAN", "DYNAMIC_PREFLIGHT_INVALID");
  integer(value.tracked_text_files_scanned, 1, "DYNAMIC_PREFLIGHT_TRACKED_SCAN_INVALID");
  integer(value.untracked_text_files_scanned, 0, "DYNAMIC_PREFLIGHT_UNTRACKED_SCAN_INVALID");
  assert(value.secrets_detected === 0 && value.local_environment_files_detected === 0
    && value.customer_artifacts_tracked === 0
    && value.supabase_temp_present === false, "DYNAMIC_PREFLIGHT_SAFETY_INVALID");
  const prior = object(value.prior_static_package, "DYNAMIC_PREFLIGHT_STATIC_INVALID");
  assert(prior.present_and_verified === true && prior.acceptance_result === "23/24 PASS"
    && prior.verified_branch === "codex/tivdoc-engine-foundation"
    && prior.verified_head === BASE_HEAD && prior.verified_tree === BASE_TREE
    && prior.pc_22_status === "SKIPPED_BLOCKED"
    && prior.pc_22_blocker === "SKIPPED_ENVIRONMENT_DEPENDENCY"
    && prior.ordered_acceptance_items_verified === 24 && prior.truth_counters_verified === true
    && prior.verifier_status === "PASS" && prior.preserved_unchanged === true
    && prior.initial_manifest_sha256 === prior.manifest_sha256
    && prior.postflight_manifest_sha256 === prior.manifest_sha256
    && prior.initial_zip_sha256 === prior.zip_sha256
    && prior.postflight_zip_sha256 === prior.zip_sha256, "DYNAMIC_PREFLIGHT_STATIC_INVALID");
  digest(prior.manifest_sha256, "DYNAMIC_PREFLIGHT_STATIC_MANIFEST_INVALID");
  digest(prior.zip_sha256, "DYNAMIC_PREFLIGHT_STATIC_ZIP_INVALID");
  safePass(value, "DYNAMIC_PREFLIGHT_INVALID");
}

function verifyEnvironment(value: Obj): void {
  assert(value.schema_version === "tivdoc-real-postgresql-environment-v0.9.1"
    && value.proof_class === "REAL_POSTGRESQL_DYNAMIC_PROOF" && value.postgres_version === "17.11"
    && text(value.client_version, "DYNAMIC_CLIENT_VERSION_INVALID").includes("17.11")
    && value.node_version === "v22.22.2" && value.node_runtime_requirement === "v22.22.2"
    && value.os === "win32" && value.architecture === "x64"
    && value.source_kind === "edb_official_windows_binaries_zip", "DYNAMIC_ENVIRONMENT_INVALID");
  assert(value.source_url === POSTGRES_ARCHIVE_URL && value.source_sha256 === POSTGRES_ARCHIVE_SHA256
    && value.source_integrity === "PINNED_SHA256_OFFICIAL_HTTPS", "DYNAMIC_PROVENANCE_INVALID");
  const provisioning = object(value.provisioning, "DYNAMIC_PROVISIONING_INVALID");
  assert(provisioning.schema_version === "tivdoc-pinned-postgresql-provisioning-v0.9.1"
    && (provisioning.action === "REUSED_VERIFIED_DISTRIBUTION"
      || provisioning.action === "REEXTRACTED_VERIFIED_DISTRIBUTION"
      || provisioning.action === "DOWNLOADED_AND_REEXTRACTED_VERIFIED_DISTRIBUTION")
    && provisioning.final_source_url === POSTGRES_ARCHIVE_URL
    && provisioning.archive_size_bytes === 340_722_468
    && (((provisioning.action === "REUSED_VERIFIED_DISTRIBUTION"
        || provisioning.action === "REEXTRACTED_VERIFIED_DISTRIBUTION") && provisioning.downloaded_bytes === 0)
      || (provisioning.action === "DOWNLOADED_AND_REEXTRACTED_VERIFIED_DISTRIBUTION"
        && provisioning.downloaded_bytes === 340_722_468))
    && provisioning.archive_sha256 === POSTGRES_ARCHIVE_SHA256
    && provisioning.archive_sha256 === value.source_sha256
    && provisioning.source_integrity === "PINNED_SHA256_OFFICIAL_HTTPS"
    && provisioning.extract_only === true && provisioning.extraction_launcher === "DOTNET_VALIDATED_ZIP_ARCHIVE"
    && ((provisioning.action === "REUSED_VERIFIED_DISTRIBUTION"
      && provisioning.fresh_extract === false && provisioning.distribution_reused === true)
      || (provisioning.action !== "REUSED_VERIFIED_DISTRIBUTION"
        && provisioning.fresh_extract === true && provisioning.distribution_reused === false))
    && provisioning.reparse_points_detected === 0
    && provisioning.archive_root === "pgsql"
    && integer(provisioning.archive_entries, 1, "DYNAMIC_PROVISIONING_INVALID") <= 30_000
    && count(provisioning.extracted_files, "DYNAMIC_PROVISIONING_INVALID") > 0
    && count(provisioning.uncompressed_bytes, "DYNAMIC_PROVISIONING_INVALID") <= 1_500_000_000
    && provisioning.distribution_file_count === 20_383
    && provisioning.distribution_bytes === 904_941_738
    && provisioning.distribution_tree_sha256 === POSTGRES_DISTRIBUTION_TREE_SHA256
    && provisioning.windows_token_elevated === false
    && provisioning.administrator_privileges_used === false
    && provisioning.system_install_performed === false && provisioning.credentials_emitted === 0
    && provisioning.status === "PASS", "DYNAMIC_PROVISIONING_INVALID");
  digest(value.configuration_sha256, "DYNAMIC_CONFIG_HASH_INVALID");
  digest(value.cluster_identity_sha256, "DYNAMIC_CLUSTER_HASH_INVALID");
  const hashes = object(value.binary_sha256, "DYNAMIC_BINARY_HASHES_INVALID");
  exactKeys(hashes, Object.keys(POSTGRES_BINARY_SHA256), "DYNAMIC_BINARY_SET_INVALID");
  assert(Object.entries(POSTGRES_BINARY_SHA256).every(([name, hash]) => hashes[name] === hash), "DYNAMIC_BINARY_HASH_INVALID");
  const dependency = object(value.critical_dependency_integrity, "DYNAMIC_DEPENDENCY_INTEGRITY_INVALID");
  verifyDependencyIntegrity(dependency);
  assert(dependency.schema_version === "tivdoc-critical-postgresql-dependency-integrity-v0.9.1"
    && dependency.package_count === 14
    && dependency.aggregate_sha256 === DEPENDENCY_AGGREGATE_SHA256
    && dependency.package_lock_verified === true && dependency.ignored_runtime_bytes_verified_before_load === true
    && dependency.credentials_recorded === 0 && dependency.status === "PASS", "DYNAMIC_DEPENDENCY_INTEGRITY_INVALID");
  assert(JSON.stringify(value.trusted_git) === JSON.stringify(liveTrustedGit), "DYNAMIC_TRUSTED_GIT_RECEIPT_INVALID");
  const target = object(value.target, "DYNAMIC_TARGET_INVALID");
  assert(target.kind === "owned_local_loopback" && target.host === "127.0.0.1"
    && target.destructive_control_authorized === true, "DYNAMIC_TARGET_INVALID");
  const port = integer(target.port, 40_000, "DYNAMIC_PORT_INVALID");
  assert(port <= 49_151 && /^tivdoc_v09_[a-z0-9_]{8,48}$/u.test(text(target.database, "DYNAMIC_DATABASE_INVALID")), "DYNAMIC_TARGET_INVALID");
  const selection = object(value.target_selection, "DYNAMIC_TARGET_SELECTION_INVALID");
  assert(selection.explicit_target_supplied === false && selection.explicit_target_approved === false
    && selection.selected_target_kind === "owned_local_loopback"
    && selection.fallback_after_rejected_explicit_target === false
    && selection.credentials_recorded === 0 && selection.status === "PASS", "DYNAMIC_TARGET_SELECTION_INVALID");
  const server = object(value.server, "DYNAMIC_SERVER_SETTINGS_INVALID");
  assert(server.version === "17.11" && server.encoding === "UTF8" && server.timezone === "UTC"
    && server.standard_conforming_strings === "on"
    && server.default_transaction_isolation === "read committed", "DYNAMIC_SERVER_SETTINGS_INVALID");
  assert(value.loopback_only === true && value.owned_user_space_server === true
    && value.admin_privileges_used === false && value.windows_token_elevated === false
    && value.system_service_installed === false, "DYNAMIC_ISOLATION_INVALID");
  safePass(value, "DYNAMIC_ENVIRONMENT_INVALID");
}

function verifyDependencyIntegrity(value: Obj): void {
  exactKeys(value, [
    "schema_version", "package_count", "packages", "aggregate_sha256",
    "package_lock_verified", "ignored_runtime_bytes_verified_before_load",
    "credentials_recorded", "status",
  ], "DYNAMIC_DEPENDENCY_INTEGRITY_KEYS_INVALID");
  const packages = values(value.packages, "DYNAMIC_DEPENDENCY_INTEGRITY_INVALID")
    .map((entry) => object(entry, "DYNAMIC_DEPENDENCY_PIN_INVALID"));
  assert(packages.length === DEPENDENCY_PINS.length, "DYNAMIC_DEPENDENCY_PIN_COUNT_INVALID");
  const material: string[] = [];
  for (const [index, expected] of DEPENDENCY_PINS.entries()) {
    const actual = packages[index]!;
    exactKeys(actual, ["name", "version", "integrity", "files", "bytes", "tree_sha256"],
      "DYNAMIC_DEPENDENCY_PIN_KEYS_INVALID");
    const fields = [
      text(actual.name, "DYNAMIC_DEPENDENCY_PIN_INVALID"),
      text(actual.version, "DYNAMIC_DEPENDENCY_PIN_INVALID"),
      text(actual.integrity, "DYNAMIC_DEPENDENCY_PIN_INVALID"),
      integer(actual.files, 1, "DYNAMIC_DEPENDENCY_PIN_INVALID"),
      integer(actual.bytes, 1, "DYNAMIC_DEPENDENCY_PIN_INVALID"),
      text(actual.tree_sha256, "DYNAMIC_DEPENDENCY_PIN_INVALID"),
    ] as const;
    digest(fields[5], "DYNAMIC_DEPENDENCY_PIN_HASH_INVALID");
    assert(fields.every((field, fieldIndex) => field === expected[fieldIndex]),
      "DYNAMIC_DEPENDENCY_PIN_MISMATCH");
    material.push(`${fields.join("\0")}\n`);
  }
  assert(sha256(Buffer.from(material.join(""), "utf8")) === DEPENDENCY_AGGREGATE_SHA256
    && value.aggregate_sha256 === DEPENDENCY_AGGREGATE_SHA256,
  "DYNAMIC_DEPENDENCY_AGGREGATE_INVALID");
}

function verifyGit(value: Obj, preflight: Obj): void {
  assert(value.schema_version === "tivdoc-canonical-postgresql-dynamic-git-v0.9.1"
    && value.branch === preflight.branch && value.required_base_head === BASE_HEAD
    && value.required_base_tree === BASE_TREE, "DYNAMIC_GIT_INVALID");
  gitSha(value.head, "DYNAMIC_GIT_HEAD_INVALID");
  gitSha(value.tree, "DYNAMIC_GIT_TREE_INVALID");
  const post = object(value.post_regression, "DYNAMIC_GIT_POST_REGRESSION_INVALID");
  assert(post.branch === value.branch && post.head === value.head && post.tree === value.tree
    && value.head_tree_cross_check === true, "DYNAMIC_GIT_POST_REGRESSION_INVALID");
  assert(gitOutput(["cat-file", "-t", `${String(value.head)}^{commit}`]) === "commit"
    && gitOutput(["show", "-s", "--format=%T", String(value.head)]) === value.tree
    && gitOutput(["merge-base", BASE_HEAD, String(value.head)]) === BASE_HEAD
    && gitOutput(["branch", "--show-current"]) === value.branch
    && gitOutput(["rev-parse", "HEAD"]) === value.head
    && gitOutput(["rev-parse", "HEAD^{tree}"]) === value.tree
    && gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]) === "",
  "DYNAMIC_GIT_REPOSITORY_CROSS_CHECK_INVALID");
  assert(value.worktree === "CLEAN" && value.supabase_temp_touched === false, "DYNAMIC_GIT_WORKTREE_INVALID");
  safePass(value, "DYNAMIC_GIT_INVALID");
}

function verifyChain(value: Obj): void {
  assert(value.schema_version === "tivdoc-postgres-migration-chain-v0.9.1"
    && value.migration_count === MIGRATIONS.length && value.canonical_migration_sha256 === CANONICAL_HASH,
  "DYNAMIC_MIGRATION_CHAIN_INVALID");
  const rows = objects(value.migrations, "DYNAMIC_MIGRATION_CHAIN_INVALID");
  assert(JSON.stringify(rows.map((row) => [row.name, row.sha256])) === JSON.stringify(MIGRATIONS),
    "DYNAMIC_MIGRATION_ORDER_OR_HASH_INVALID");
  for (const row of rows) { digest(row.sha256, "DYNAMIC_MIGRATION_HASH_INVALID"); integer(row.bytes, 1, "DYNAMIC_MIGRATION_SIZE_INVALID"); }
  assert(rows[10]?.sha256 === CANONICAL_HASH, "DYNAMIC_CANONICAL_MIGRATION_HASH_INVALID");
  safePass(value, "DYNAMIC_MIGRATION_CHAIN_INVALID");
}

function verifyClean(value: Obj, chain: Obj, environment: Obj): void {
  assert(value.schema_version === "tivdoc-postgres-migration-apply-v0.9.1" && value.mode === "clean_chain", "DYNAMIC_CLEAN_MIGRATION_INVALID");
  const applied = objects(value.applied, "DYNAMIC_CLEAN_MIGRATION_INVALID");
  const expected = objects(chain.migrations, "DYNAMIC_MIGRATION_CHAIN_INVALID");
  assert(value.applied_count === expected.length && applied.length === expected.length, "DYNAMIC_CLEAN_MIGRATION_COUNT_INVALID");
  applied.forEach((row, index) => {
    assert(row.name === expected[index]?.name && row.sha256 === expected[index]?.sha256
      && row.exit_code === 0, "DYNAMIC_CLEAN_MIGRATION_RECONCILIATION_INVALID");
    integer(row.duration_ms, 0, "DYNAMIC_CLEAN_MIGRATION_DURATION_INVALID");
  });
  assert(value.database === object(environment.target, "DYNAMIC_TARGET_INVALID").database
    && value.credentials_emitted === 0, "DYNAMIC_CLEAN_MIGRATION_TARGET_INVALID");
}

function verifyMigrationAmendment(value: Obj): void {
  assert(value.schema_version === "tivdoc-postgresql-migration-portability-amendment-v0.9.1"
    && value.migration === "supabase/migrations/202608290001_engine_persistence_foundation.sql"
    && value.baseline_sha256_normalized_lf === "cc1b809a012563ca1bc0214ccbd478af988300439e54f0b70968623e2dc4abc1"
    && value.amended_sha256_normalized_lf === "e4e036fd3c01134a7e449cf50d586d4bf6790c0e00a4f62ad0a898acfec31373"
    && value.postgresql_error_code === "42710"
    && value.defect === "EXPLICIT_CHECK_CONSTRAINT_COLLIDES_WITH_POSTGRESQL_GENERATED_INLINE_CHECK_NAME"
    && value.amendment === "RENAME_EXPLICIT_COMPLETION_PAYLOAD_CHECK_CONSTRAINT_ONLY"
    && value.sql_semantics_changed === false
    && value.authorized_scope === "V0.9.1_REAL_POSTGRESQL_PORTABILITY_DEFECT_REMEDIATION"
    && value.status === "PINNED_ONE_TIME_AMENDMENT",
  "DYNAMIC_MIGRATION_AMENDMENT_INVALID");
}

function verifyMigration(value: Obj, chain: Obj): void {
  assert(value.schema_version === "tivdoc-real-postgresql-migration-matrix-v0.9.1"
    && value.proof_class === "REAL_POSTGRESQL_DYNAMIC_PROOF", "DYNAMIC_MIGRATION_MATRIX_INVALID");
  const clean = object(value.clean, "DYNAMIC_MIGRATION_CLEAN_INVALID");
  assert(clean.status === "PASS" && clean.migration_count === chain.migration_count, "DYNAMIC_MIGRATION_CLEAN_INVALID");
  const upgrade = object(value.upgrade, "DYNAMIC_MIGRATION_UPGRADE_INVALID");
  assert(upgrade.status === "PASS" && upgrade.pre_upgrade_rows === 3 && upgrade.post_upgrade_rows === 3
    && upgrade.pre_upgrade_state_sha256 === upgrade.post_upgrade_state_sha256
    && upgrade.application_root_reachable === true && upgrade.analysis_run_metadata_enrichment === true
    && upgrade.document_metadata_enrichment === true && upgrade.schema_inventory_reconciled === true
    && upgrade.terminal_history_immutability === true && upgrade.canonical_capability_count === 14
    && upgrade.canonical_capabilities_passed === 14, "DYNAMIC_MIGRATION_UPGRADE_INVALID");
  digest(upgrade.pre_upgrade_state_sha256, "DYNAMIC_MIGRATION_UPGRADE_HASH_INVALID");
  digest(upgrade.upgraded_inventory_sha256, "DYNAMIC_MIGRATION_UPGRADE_INVENTORY_INVALID");
  const failed = object(value.failed_partial, "DYNAMIC_MIGRATION_FAILURE_INVALID");
  assert(failed.status === "PASS" && failed.controlled_failure_observed === true
    && failed.canonical_metadata_after_failure === 0 && failed.recovery_rerun === "PASS"
    && failed.recovery_schema_inventory_reconciled === true, "DYNAMIC_MIGRATION_FAILURE_INVALID");
  digest(failed.recovery_inventory_sha256, "DYNAMIC_MIGRATION_RECOVERY_INVENTORY_INVALID");
  assert(failed.recovery_inventory_sha256 === upgrade.upgraded_inventory_sha256,
    "DYNAMIC_MIGRATION_INVENTORY_RECONCILIATION_INVALID");
  safePass(value, "DYNAMIC_MIGRATION_MATRIX_INVALID");
}

function verifyCapabilities(value: Obj, environment: Obj): void {
  assert(value.schema_version === "tivdoc-canonical-persistence-v091-capability-matrix-v1"
    && value.proof_class === "REAL_NODE_POSTGRES_EXECUTION", "DYNAMIC_CAPABILITY_MATRIX_INVALID");
  const rows = objects(value.matrix, "DYNAMIC_CAPABILITY_MATRIX_INVALID");
  assert(JSON.stringify(rows.map((row) => [row.capability, row.binding])) === JSON.stringify(CAPABILITIES), "DYNAMIC_CAPABILITY_BINDINGS_INVALID");
  rows.forEach((row) => {
    assert(row.status === "PASS" && row.proof_class === "REAL_NODE_POSTGRES_PARAMETERIZED_SQL", "DYNAMIC_CAPABILITY_STATUS_INVALID");
    integer(row.persisted_rows, 0, "DYNAMIC_CAPABILITY_ROWS_INVALID"); digest(row.evidence_sha256, "DYNAMIC_CAPABILITY_EVIDENCE_INVALID");
  });
  assert(value.idempotency_replay_verified === true && value.report_export_eligibility_verified === true
    && value.findings_persisted === 0 && value.customer_documents_used === 0
    && value.real_legal_activations === 0, "DYNAMIC_CAPABILITY_SAFETY_INVALID");
  const metrics = object(value.driver_metrics, "DYNAMIC_DRIVER_METRICS_INVALID");
  assert(metrics.driver === "node-postgres" && count(metrics.connection_attempts, "DYNAMIC_DRIVER_CONNECTIONS_INVALID") === metrics.acquisitions
    && count(metrics.queries, "DYNAMIC_DRIVER_QUERIES_INVALID") > 0 && metrics.releases === metrics.acquisitions
    && metrics.active_clients === 0 && metrics.closed === true, "DYNAMIC_DRIVER_METRICS_INVALID");
  const target = object(metrics.target, "DYNAMIC_DRIVER_TARGET_INVALID");
  assert(target.host === "127.0.0.1" && target.disposable === true
    && target.validation === "LOOPBACK_DISPOSABLE_VALIDATED"
    && target.database === object(environment.target, "DYNAMIC_TARGET_INVALID").database, "DYNAMIC_DRIVER_TARGET_INVALID");
}

function verifyRestart(value: Obj): void {
  assert(value.schema_version === "tivdoc-real-postgresql-fresh-process-replay-v0.9.1"
    && value.proof_class === "REAL_POSTGRESQL_DYNAMIC_PROOF" && value.fresh_node_process === true
    && value.capability_count === 14 && value.genuine_server_stop_start === true
    && value.same_cluster_restarted === true && value.pool_closed_before_restart === true, "DYNAMIC_RESTART_INVALID");
  const replay = object(value.adapter_replay, "DYNAMIC_RESTART_ADAPTER_REPLAY_INVALID");
  assert(replay.schema_version === "tivdoc-canonical-persistence-v091-adapter-replay-v1"
    && replay.case_state_reloaded === true && replay.completed_analysis_reloaded === true
    && replay.approval_reloaded === true && replay.idempotency_replayed === true
    && replay.audit_chain_verified === true && replay.terminal_job_not_reclaimed === true
    && replay.published_outbox_not_reclaimed === true && replay.durable_effects_unchanged === true
    && replay.status === "PASS", "DYNAMIC_RESTART_ADAPTER_REPLAY_INVALID");
  count(value.connection_attempts, "DYNAMIC_RESTART_CONNECTIONS_INVALID"); safePass(value, "DYNAMIC_RESTART_INVALID");
}

function verifyRoles(value: Obj): void {
  assert(value.schema_version === "tivdoc-real-postgresql-role-sessions-v0.9.1"
    && value.scram_passwords_configured === 4 && value.credentials_emitted === 0, "DYNAMIC_ROLE_SESSIONS_INVALID");
  const rows = objects(value.roles, "DYNAMIC_ROLE_SESSIONS_INVALID");
  assert(JSON.stringify(rows.map((row) => row.role)) === JSON.stringify(["anon", "authenticated", "service_role", "tivdoc_policy_probe"]), "DYNAMIC_ROLE_SET_INVALID");
  rows.forEach((row) => assert(row.login === true && row.superuser === false
    && row.bypass_rls === (row.role === "service_role"), "DYNAMIC_ROLE_ATTRIBUTES_INVALID"));
  assert(value.status === "PASS", "DYNAMIC_ROLE_SESSIONS_INVALID");
}

function verifyRls(value: Obj): void {
  assert(value.schema_version === "tivdoc-real-postgresql-rls-matrix-v0.9.1"
    && value.proof_class === "REAL_POSTGRESQL_DYNAMIC_PROOF", "DYNAMIC_RLS_INVALID");
  const tables = values(value.sensitive_tables, "DYNAMIC_RLS_TABLES_INVALID");
  assert(JSON.stringify(tables) === JSON.stringify(RLS_TABLES) && value.rls_enabled === 39
    && value.rls_enabled === tables.length && value.rls_forced === 0, "DYNAMIC_RLS_TABLES_INVALID");
  assert(value.security_definer_functions === 74 && value.unsafe_security_definer_functions === 0
    && value.security_definer_acl_mismatches === 0 && value.tenant_policy_tables === 31
    && value.cross_tenant_rows_visible === 0
    && value.cross_tenant_write_rejections === 31
    && value.cross_tenant_write_rejected === true
    && value.distinct_tenant_controls === true
    && value.synthetic_control_rows_inserted === 12
    && value.synthetic_findings_inserted === 2 && value.synthetic_findings_removed === 2
    && value.persistent_job_history_controls === 2 && value.real_findings_generated === false
    && value.legal_sources_activated === 0 && value.customer_data_used === false,
  "DYNAMIC_RLS_SECURITY_INVALID");
  const denominators = object(value.tenant_policy_denominators, "DYNAMIC_RLS_DENOMINATORS_INVALID");
  assert(denominators.expected_tables === 31 && denominators.tested_tables === 31
    && denominators.tables_with_seeded_own_tenant_rows === 31
    && denominators.tables_with_seeded_cross_tenant_control_rows === 31
    && denominators.tables_with_expected_own_tenant_visibility === 31
    && denominators.tables_with_zero_cross_tenant_visibility === 31
    && denominators.tables_with_cross_tenant_write_rejection === 31, "DYNAMIC_RLS_DENOMINATORS_INVALID");
  const policyRows = objects(value.tenant_policy_table_results, "DYNAMIC_RLS_POLICY_RESULTS_INVALID");
  assert(JSON.stringify(policyRows.map((row) => row.table)) === JSON.stringify(TENANT_POLICY_TABLES), "DYNAMIC_RLS_POLICY_TABLE_SET_INVALID");
  policyRows.forEach((row) => {
    assert(row.status === "PASS"
      && count(row.seeded_own_tenant_rows, "DYNAMIC_RLS_POLICY_OWN_SEED_INVALID") === row.own_tenant_rows_visible
      && count(row.seeded_cross_tenant_control_rows, "DYNAMIC_RLS_POLICY_CROSS_SEED_INVALID") > 0
      && row.cross_tenant_rows_visible === 0 && row.cross_tenant_write_rejected === true,
    "DYNAMIC_RLS_POLICY_RESULT_INVALID");
  });
  const seededOwn = policyRows.reduce((sum, row) => sum + count(row.seeded_own_tenant_rows, "DYNAMIC_RLS_POLICY_OWN_SEED_INVALID"), 0);
  const seededCross = policyRows.reduce((sum, row) => sum + count(row.seeded_cross_tenant_control_rows, "DYNAMIC_RLS_POLICY_CROSS_SEED_INVALID"), 0);
  assert(value.seeded_own_tenant_rows === seededOwn && value.own_tenant_rows_visible === seededOwn
    && value.seeded_cross_tenant_control_rows === seededCross, "DYNAMIC_RLS_POLICY_TOTALS_INVALID");
  const roleRows = objects(value.roles, "DYNAMIC_RLS_ROLES_INVALID");
  assert(JSON.stringify(roleRows.map((row) => row.role)) === JSON.stringify(["anon", "authenticated", "service_role", "tenant_policy_probe"]), "DYNAMIC_RLS_ROLE_SET_INVALID");
  roleRows.forEach((row) => {
    assert(row.status === "PASS" && row.unexpected_results === 0, "DYNAMIC_RLS_ROLE_STATUS_INVALID");
    if (row.role === "anon" || row.role === "authenticated") assert(row.tables_checked === tables.length
      && row.reads_allowed === 0 && row.reads_denied === tables.length && row.writes_allowed === 0
      && row.writes_denied === tables.length * 3, "DYNAMIC_RLS_DENIAL_INVALID");
    else if (row.role === "service_role") assert(row.tables_checked === tables.length
      && row.reads_allowed === tables.length - 1 && row.reads_denied === 1
      && integer(row.writes_allowed, 0, "DYNAMIC_RLS_SERVICE_WRITES_INVALID")
        + integer(row.writes_denied, 0, "DYNAMIC_RLS_SERVICE_WRITES_INVALID") === tables.length * 3,
    "DYNAMIC_RLS_SERVICE_INVALID");
    else assert(row.tables_checked === 31 && row.reads_allowed === 31 && row.reads_denied === 0
      && row.writes_allowed === 0 && row.writes_denied === 31, "DYNAMIC_RLS_PROBE_INVALID");
  });
  count(value.tenant_b_seed_connection_attempts, "DYNAMIC_TENANT_B_CONNECTIONS_INVALID");
  assert(value.connection_attempts === 5, "DYNAMIC_RLS_CONNECTIONS_INVALID"); safePass(value, "DYNAMIC_RLS_INVALID");
}

function verifyAtomicity(value: Obj): void {
  assert(value.schema_version === "tivdoc-real-postgresql-atomicity-matrix-v0.9.1"
    && value.proof_class === "REAL_POSTGRESQL_DYNAMIC_PROOF"
    && value.application_root === "startCanonicalApplicationPostgres" && value.driver === "node-postgres", "DYNAMIC_ATOMICITY_INVALID");
  const boundaries = objects(value.boundaries, "DYNAMIC_ATOMICITY_BOUNDARIES_INVALID");
  assert(JSON.stringify(boundaries.map((row) => row.boundary_id)) === JSON.stringify(["TX-01", "TX-02", "TX-03", "TX-04", "TX-05", "TX-06", "TX-07", "TX-08"]), "DYNAMIC_ATOMICITY_BOUNDARY_SET_INVALID");
  boundaries.forEach((row) => {
    assert(row.status === "PASS" && row.semantic_coverage === "EXACT" && row.coverage_gap === null
      && row.injection_matches === 1 && row.injection_count === 1 && row.failure_rejected === true
      && row.rollback_snapshot_unchanged === true && row.retry_succeeded === true
      && row.retry_changed_state === true && row.retry_expected_deltas_valid === true, "DYNAMIC_ATOMICITY_BOUNDARY_INVALID");
    if (row.post_commit_replay_required === true) assert(row.post_commit_replay_succeeded === true
      && row.post_commit_replay_result_stable === true && row.post_commit_replay_snapshot_unchanged === true, "DYNAMIC_ATOMICITY_REPLAY_INVALID");
  });
  assert(value.boundary_count === 8 && value.passed_boundary_count === 8 && value.exact_boundary_count === 8
    && value.complete_contract_coverage === true && count(value.snapshot_table_count, "DYNAMIC_ATOMICITY_SNAPSHOT_INVALID") > 0
    && value.customer_data_used === false && value.legal_activation_used === false
    && value.findings_written === false, "DYNAMIC_ATOMICITY_SUMMARY_INVALID");
  count(value.connection_attempts, "DYNAMIC_ATOMICITY_CONNECTIONS_INVALID"); safePass(value, "DYNAMIC_ATOMICITY_INVALID");
}

function verifyConcurrency(value: Obj): void {
  assert(value.schema_version === "tivdoc-real-postgresql-concurrency-matrix-v0.9.1"
    && value.proof_class === "REAL_POSTGRESQL_DYNAMIC_PROOF"
    && value.application_root === "startCanonicalApplicationPostgres" && value.driver === "node-postgres", "DYNAMIC_CONCURRENCY_INVALID");
  const cases = objects(value.cases, "DYNAMIC_CONCURRENCY_CASES_INVALID");
  assert(JSON.stringify(cases.map((row) => row.case_id)) === JSON.stringify(["CC-01", "CC-02", "CC-03", "CC-04", "CC-05", "CC-06", "CC-07"]), "DYNAMIC_CONCURRENCY_CASE_SET_INVALID");
  const expected = Object.freeze([
    { accepted: 1, rejected: 1, codes: ["ANALYSIS_RUN_ID_COLLISION"], observations: { durable_run_count: 1, duplicate_prevented: true } },
    { accepted: 2, rejected: 1, codes: ["STALE_FENCING_TOKEN"], observations: { claimed_job_count: 1, empty_claim_count: 1, stale_fence_rejected: true, final_job_state: "retry_wait" } },
    { accepted: 2, rejected: 2, codes: ["REPORT_REVIEW_NOT_ELIGIBLE", "STALE_REPORT_REVISION"], observations: { approval_winner_count: 1, approval_rejection_count: 1, invalidation_winner_count: 1, stale_revision_rejection_count: 1, durable_review_version_count: 2 } },
    { accepted: 1, rejected: 1, codes: ["IDEMPOTENCY_KEY_COMMAND_MISMATCH"], observations: { durable_idempotency_record_count: 1, single_command_won: true, conflicting_command_rejected: true } },
    { accepted: 4, rejected: 1, codes: ["STALE_FENCING_TOKEN"], observations: { claimed_event_count: 1, empty_claim_count: 1, expired_lease_reclaimed: true, stale_publish_rejected: true, published: true, logical_effect_receipt_count: 1 } },
    { accepted: 1, rejected: 1, codes: ["INTAKE_REVISION_CONFLICT"], observations: { final_case_revision: 2, one_update_won: true, stale_update_rejected: true } },
    { accepted: 1, rejected: 1, codes: [], observations: { injected_failure_count: 1, rollback_snapshot_unchanged: true, retry_succeeded: true, final_case_revision: 2 } },
  ] as const);
  cases.forEach((row, index) => {
    const semantic = expected[index]!;
    assert(row.status === "PASS" && integer(row.independent_transactions, 2, "DYNAMIC_CONCURRENCY_TRANSACTIONS_INVALID") >= 2
      && row.barrier_timed_out === false && row.accepted_count === semantic.accepted
      && row.rejected_count === semantic.rejected && row.expected_rejection_semantics === true
      && JSON.stringify(row.rejected_domain_codes) === JSON.stringify(semantic.codes)
      && JSON.stringify(row.observations) === JSON.stringify(semantic.observations)
      && values(row.rejected_errors, "DYNAMIC_CONCURRENCY_ERRORS_INVALID").length === semantic.rejected,
    "DYNAMIC_CONCURRENCY_CASE_INVALID");
    if (index < 6) assert(row.barrier_release_reason === "participants"
      && integer(row.barrier_arrivals, 2, "DYNAMIC_CONCURRENCY_BARRIER_INVALID") >= 2, "DYNAMIC_CONCURRENCY_BARRIER_INVALID");
  });
  assert(value.case_count === 7 && value.passed_case_count === 7 && value.independent_connection_proof === true
    && integer(value.connection_attempts, 2, "DYNAMIC_CONCURRENCY_CONNECTIONS_INVALID") === value.acquisitions
    && value.customer_data_used === false && value.legal_activation_used === false
    && value.findings_written === false, "DYNAMIC_CONCURRENCY_SUMMARY_INVALID");
  safePass(value, "DYNAMIC_CONCURRENCY_INVALID");
}

function verifyBackup(value: Obj): void {
  assert(value.schema_version === "tivdoc-real-postgresql-backup-restore-v0.9.1"
    && value.proof_class === "REAL_POSTGRESQL_DYNAMIC_PROOF" && value.backup_format === "POSTGRESQL_CUSTOM", "DYNAMIC_BACKUP_INVALID");
  digest(value.backup_sha256, "DYNAMIC_BACKUP_HASH_INVALID"); integer(value.backup_byte_count, 1, "DYNAMIC_BACKUP_SIZE_INVALID");
  assert(/^tivdoc_v09_[a-z0-9_]{8,48}$/u.test(text(value.source_database, "DYNAMIC_BACKUP_SOURCE_INVALID"))
    && /^tivdoc_v09_[a-z0-9_]{8,48}$/u.test(text(value.restored_database, "DYNAMIC_BACKUP_TARGET_INVALID"))
    && value.source_database !== value.restored_database, "DYNAMIC_BACKUP_DATABASE_INVALID");
  assert(count(value.source_table_count, "DYNAMIC_BACKUP_TABLES_INVALID") === value.restored_table_count, "DYNAMIC_BACKUP_TABLES_INVALID");
  digest(value.source_record_set_sha256, "DYNAMIC_BACKUP_RECORD_HASH_INVALID");
  digest(value.source_inventory_sha256, "DYNAMIC_BACKUP_INVENTORY_HASH_INVALID");
  assert(value.source_record_set_sha256 === value.restored_record_set_sha256
    && value.source_inventory_sha256 === value.restored_inventory_sha256
    && value.migration_state_equal === true && value.capability_replay === "PASS"
    && value.focused_rls_matrix === "PASS" && value.backup_in_evidence_bundle === false, "DYNAMIC_BACKUP_RECONCILIATION_INVALID");
  count(value.connection_attempts, "DYNAMIC_BACKUP_CONNECTIONS_INVALID"); safePass(value, "DYNAMIC_BACKUP_INVALID");
}

function verifyRegressions(value: Obj, git: Obj): void {
  assert(value.schema_version === "tivdoc-canonical-postgresql-dynamic-regressions-v0.9.1", "DYNAMIC_REGRESSIONS_INVALID");
  const commands = objects(value.commands, "DYNAMIC_REGRESSION_COMMANDS_INVALID");
  assert(JSON.stringify(commands.map((row) => row.command_id)) === JSON.stringify(REGRESSIONS), "DYNAMIC_REGRESSION_COMMAND_SET_INVALID");
  commands.forEach((row) => {
    assert(row.exit_code === 0 && row.status === "PASS", "DYNAMIC_REGRESSION_COMMAND_INVALID");
    integer(row.duration_ms, 0, "DYNAMIC_REGRESSION_DURATION_INVALID");
    digest(row.stdout_sha256, "DYNAMIC_REGRESSION_STDOUT_HASH_INVALID");
    digest(row.stderr_sha256, "DYNAMIC_REGRESSION_STDERR_HASH_INVALID");
    integer(row.output_byte_count, 0, "DYNAMIC_REGRESSION_OUTPUT_SIZE_INVALID");
    assert(values(row.arguments, "DYNAMIC_REGRESSION_ARGUMENTS_INVALID").every((item) => typeof item === "string"), "DYNAMIC_REGRESSION_ARGUMENTS_INVALID");
    const summary = object(row.safe_summary, "DYNAMIC_REGRESSION_SUMMARY_INVALID");
    assert(typeof summary.output_present === "boolean", "DYNAMIC_REGRESSION_SUMMARY_INVALID");
    if (row.command_id === "focused_v09_v091" || row.command_id === "full_unit_integration") {
      count(summary.test_files_passed, "DYNAMIC_REGRESSION_TEST_FILES_INVALID");
      count(summary.tests_passed, "DYNAMIC_REGRESSION_TESTS_INVALID");
      integer(summary.tests_skipped, 0, "DYNAMIC_REGRESSION_SKIPS_INVALID");
    }
    if (row.command_id === "canonical_v09_acceptance") assert(summary.acceptance_status === "PASS"
      && summary.acceptance_passed === 23 && summary.acceptance_failed === 0
      && summary.acceptance_skipped_blocked === 1
      && summary.verified_branch === git.branch && summary.verified_head === git.head
      && summary.verified_tree === git.tree, "DYNAMIC_REGRESSION_STATIC_ACCEPTANCE_INVALID");
  });
  assert(value.command_count === commands.length && value.passed === commands.length && value.failed === 0
    && value.live_provider_calls === 0 && value.external_credentials_available === 0
    && value.environment_mode === "ALLOWLISTED_OFFLINE_NO_PROVIDER_CREDENTIALS"
    && value.customer_data_used === false, "DYNAMIC_REGRESSION_SUMMARY_INVALID");
  safePass(value, "DYNAMIC_REGRESSIONS_INVALID");
}

function verifyShutdown(value: Obj): void {
  assert(value.schema_version === "tivdoc-canonical-postgresql-dynamic-shutdown-v0.9.1"
    && value.owned_server === true && value.ownership_verified === true
    && value.stop_command === "PASS" && value.server_stopped === true, "DYNAMIC_SHUTDOWN_INVALID");
  safePass(value, "DYNAMIC_SHUTDOWN_INVALID");
}

function verifySupabase(value: Obj): void {
  assert(value.proof_class === "REAL_POSTGRESQL_DYNAMIC_PROOF"
    && value.isolated_supabase_platform_proof === "NOT_PERFORMED"
    && value.blocker === "ISOLATED_SUPABASE_MIGRATION_RLS_VERIFICATION_REQUIRED"
    && value.credentials_recorded === 0, "DYNAMIC_SUPABASE_BOUNDARY_INVALID");
  const bootstrap = object(value.bootstrap, "DYNAMIC_SUPABASE_BOOTSTRAP_INVALID");
  assert(bootstrap.schema_version === "tivdoc-postgres-migration-apply-v0.9.1"
    && bootstrap.mode === "compatibility_bootstrap" && bootstrap.applied_count === 1
    && values(bootstrap.applied, "DYNAMIC_SUPABASE_BOOTSTRAP_INVALID").length === 1
    && bootstrap.credentials_emitted === 0, "DYNAMIC_SUPABASE_BOOTSTRAP_INVALID");
}

function verifyConnections(value: Obj, expected: Readonly<Record<string, number>>): number {
  assert(value.schema_version === "tivdoc-canonical-postgresql-dynamic-connection-breakdown-v0.9.1"
    && text(value.definition, "DYNAMIC_CONNECTION_DEFINITION_INVALID").length > 0, "DYNAMIC_CONNECTION_BREAKDOWN_INVALID");
  const components = object(value.components, "DYNAMIC_CONNECTION_COMPONENTS_INVALID");
  exactKeys(components, CONNECTION_COMPONENTS, "DYNAMIC_CONNECTION_COMPONENT_SET_INVALID");
  let total = 0;
  for (const name of CONNECTION_COMPONENTS) {
    const component = count(components[name], `DYNAMIC_CONNECTION_COMPONENT_INVALID:${name}`);
    if (expected[name] !== undefined) assert(component === expected[name], `DYNAMIC_CONNECTION_COMPONENT_MISMATCH:${name}`);
    total += component;
  }
  assert(value.observed_total === total && value.credentials_recorded === 0, "DYNAMIC_CONNECTION_TOTAL_INVALID");
  safePass(value, "DYNAMIC_CONNECTION_BREAKDOWN_INVALID");
  return total;
}

function verifyAcceptance(value: Obj, connectionTotal: number): void {
  assert(value.schema_version === "tivdoc-canonical-postgresql-dynamic-acceptance-v0.9.1"
    && value.acceptance_result === "ACCEPTANCE_24_OF_24_PASS" && value.pc_22 === "PC-22_PASS", "DYNAMIC_ACCEPTANCE_INVALID");
  const counts = object(value.counts, "DYNAMIC_ACCEPTANCE_COUNTS_INVALID");
  assert(counts.total === 24 && counts.pass === 24 && counts.fail === 0 && counts.skipped === 0, "DYNAMIC_ACCEPTANCE_COUNTS_INVALID");
  const baseline = object(value.static_baseline, "DYNAMIC_STATIC_BASELINE_INVALID");
  const extension = object(value.dynamic_extension, "DYNAMIC_EXTENSION_INVALID");
  assert(baseline.result === "23/24 PASS" && baseline.failures === 0
    && baseline.pc_22 === "SKIPPED_ENVIRONMENT_DEPENDENCY", "DYNAMIC_STATIC_BASELINE_INVALID");
  assert(extension.item === "PC-22" && extension.result === "PASS"
    && extension.proof_class === "REAL_POSTGRESQL_DYNAMIC_PROOF", "DYNAMIC_EXTENSION_INVALID");
  const truth = object(value.truth_counters, "DYNAMIC_TRUTH_COUNTERS_INVALID");
  assert(truth.REAL_POSTGRESQL_SERVER_USED === "YES" && truth.REAL_POSTGRESQL_CONNECTION_ATTEMPTS === connectionTotal
    && truth.REAL_POSTGRESQL_MIGRATION_CLEAN === "PASS" && truth.REAL_POSTGRESQL_MIGRATION_UPGRADE === "PASS"
    && truth.REAL_POSTGRESQL_COMPOSITION_ROOT === "PASS" && truth.REAL_POSTGRESQL_RESTART_REPLAY === "PASS"
    && truth.REAL_POSTGRESQL_RLS_MATRIX === "PASS" && truth.REAL_POSTGRESQL_FAILURE_ATOMICITY === "PASS"
    && truth.REAL_POSTGRESQL_APPROVAL_RACES === "PASS" && truth.REAL_POSTGRESQL_BACKUP_RESTORE === "PASS"
    && truth.PRODUCT_REACHABLE_MEMORY_FALLBACKS === 0, "DYNAMIC_TRUTH_COUNTERS_INVALID");
  assert(JSON.stringify(value.final_status_constants) === JSON.stringify([
    "DYNAMIC_POSTGRESQL_VERIFICATION_COMPLETE", "CASE_ANALYSIS_DURABILITY_DYNAMICALLY_PROVEN",
    "PC-22_PASS", "ACCEPTANCE_24_OF_24_PASS",
  ]) && JSON.stringify(value.remaining_blockers) === JSON.stringify([
    "ISOLATED_SUPABASE_MIGRATION_RLS_VERIFICATION_REQUIRED",
  ]), "DYNAMIC_FINAL_STATUS_INVALID");
  safePass(value, "DYNAMIC_ACCEPTANCE_INVALID");
}

async function deterministicRebuild(root: string, original: string, entries: readonly string[]): Promise<void> {
  const temporaryParent = path.resolve(process.cwd(), ".tmp", "postgresql-dynamic-v0.9.1");
  await mkdir(temporaryParent, { recursive: true });
  const temporary = await mkdtemp(path.join(temporaryParent, "verifier-"));
  try {
    const rebuilt = path.join(temporary, "rebuilt.zip");
    await writeDeterministicStoreZip({ root, output: rebuilt, entries });
    assert(sha256(await readFile(rebuilt)) === sha256(await readFile(original)), "DYNAMIC_ZIP_REBUILD_MISMATCH");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function gitOutput(args: readonly string[]): string {
  return trustedGitText(process.cwd(), args);
}

async function payload(name: (typeof PAYLOADS)[number]): Promise<Obj> {
  return object(parseJson<unknown>(await readFile(path.join(finalRoot, name)), `DYNAMIC_PAYLOAD_INVALID:${name}`), `DYNAMIC_PAYLOAD_INVALID:${name}`);
}

function parseJson<T>(bytes: Uint8Array, code: string): T {
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")) as T; } catch { throw new Error(code); }
}
function object(value: unknown, code: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(code);
  return value as Obj;
}
function values(value: unknown, code: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
}
function objects(value: unknown, code: string): readonly Obj[] { return values(value, code).map((item) => object(item, code)); }
function text(value: unknown, code: string): string { if (typeof value !== "string") throw new Error(code); return value; }
function integer(value: unknown, minimum: number, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error(code);
  return value;
}
function count(value: unknown, code: string): number { return integer(value, 1, code); }
function digest(value: unknown, code: string): asserts value is string { assert(typeof value === "string" && /^[0-9a-f]{64}$/u.test(value), code); }
function gitSha(value: unknown, code: string): asserts value is string { assert(typeof value === "string" && /^[0-9a-f]{40}$/u.test(value), code); }
function exactKeys(value: Obj, expected: readonly string[], code: string): void {
  assert(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()), code);
}
async function verifyFinalDirectoryShape(root: string, bootstrap: boolean): Promise<void> {
  const maximumJsonBytes = 16 * 1024 * 1024;
  const maximumZipBytes = 64 * 1024 * 1024;
  const maximumPackageBytes = 96 * 1024 * 1024;
  const resolvedRoot = path.resolve(root);
  const rootMetadata = await lstat(resolvedRoot);
  assert(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), "DYNAMIC_FINAL_DIRECTORY_INVALID");
  assert(sameResolvedPath(await realpath(resolvedRoot), resolvedRoot), "DYNAMIC_FINAL_DIRECTORY_REPARSE_FORBIDDEN");
  const expected = [
    ...PAYLOADS,
    "evidence-manifest.json",
    "evidence-wrapper-receipt.json",
    ZIP_NAME,
    ...(bootstrap ? [] : ["independent-verifier-output.json"]),
  ].sort();
  const entryNames: string[] = [];
  let packageBytes = 0;
  const directory = await opendir(resolvedRoot);
  for await (const entry of directory) {
    entryNames.push(entry.name);
    assert(entryNames.length <= expected.length, "DYNAMIC_FINAL_DIRECTORY_SET_INVALID");
    const absolute = path.join(resolvedRoot, entry.name);
    const metadata = await lstat(absolute);
    assert(entry.isFile() && metadata.isFile() && !metadata.isSymbolicLink(),
      `DYNAMIC_FINAL_DIRECTORY_ENTRY_INVALID:${entry.name}`);
    assert(metadata.nlink === 1, `DYNAMIC_FINAL_DIRECTORY_HARDLINK_FORBIDDEN:${entry.name}`);
    const maximumBytes = entry.name === ZIP_NAME ? maximumZipBytes : maximumJsonBytes;
    assert(metadata.size <= maximumBytes, `DYNAMIC_FINAL_DIRECTORY_ENTRY_TOO_LARGE:${entry.name}`);
    packageBytes += metadata.size;
    assert(packageBytes <= maximumPackageBytes, "DYNAMIC_FINAL_DIRECTORY_TOO_LARGE");
    assert(sameResolvedPath(await realpath(absolute), absolute),
      `DYNAMIC_FINAL_DIRECTORY_REPARSE_FORBIDDEN:${entry.name}`);
  }
  assert(JSON.stringify(entryNames.sort()) === JSON.stringify(expected),
    "DYNAMIC_FINAL_DIRECTORY_SET_INVALID");
}
function sameResolvedPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
function safePass(value: Obj, code: string): void { assert(value.credentials_recorded === 0 && value.status === "PASS", code); }
function safeRelative(value: string): void {
  assert(value === path.posix.normalize(value.replaceAll("\\", "/")) && !path.isAbsolute(value)
    && !value.includes("\\") && !value.split("/").includes(".."), "DYNAMIC_PAYLOAD_PATH_UNSAFE");
  assert(!["evidence-manifest.json", "evidence-wrapper-receipt.json", ZIP_NAME,
    "independent-verifier-output.json"].includes(value), "DYNAMIC_PAYLOAD_SELF_REFERENCE_FORBIDDEN");
}
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function assert(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
