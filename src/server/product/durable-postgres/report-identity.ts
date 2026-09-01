import { canonicalSha256, canonicalStringify } from "../../../engine/rule-runtime/canonical.ts";

export const CANONICAL_REPORT_IDENTITY_SCHEMA_VERSION =
  "tivdoc-canonical-report-identity-v0.10.1" as const;
export const CANONICAL_REPORT_DEPENDENCY_SCHEMA_VERSION =
  "tivdoc-canonical-report-dependency-v0.10.1" as const;
export const CANONICAL_REPORT_MODEL_SCHEMA_VERSION =
  "tivdoc-canonical-report-model-v0.10.1" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,255}$/u;

export type CanonicalReportIdentitySeed = Readonly<{
  schema_version: typeof CANONICAL_REPORT_IDENTITY_SCHEMA_VERSION;
  tenant_id: string;
  owner_binding_revision: number;
  owner_binding_sha256: string;
  case_id: string;
  case_revision: number;
  analysis_run_id: string;
  analysis_run_revision: number;
  rule_input_dependency_sha256: string;
  report_model_sha256: string;
  report_id: string;
  report_revision: number;
  report_sha256: string;
  pdf_sha256: string;
  storage_object_id: string;
  storage_object_version_id: string;
  approval_task_id: string;
  approval_revision: number;
  approval_decision_sha256: string;
  download_grant_revision: number;
}>;

export type CanonicalReportIdentity = CanonicalReportIdentitySeed & Readonly<{
  identity_sha256: string;
}>;

export type CanonicalReportIdentityErrorCode =
  | "CANONICAL_REPORT_IDENTITY_INVALID"
  | "CANONICAL_REPORT_IDENTITY_STALE"
  | "CANONICAL_REPORT_DEPENDENCY_MISMATCH"
  | "CANONICAL_REPORT_MODEL_MISMATCH"
  | "CANONICAL_REPORT_DIGEST_MISMATCH"
  | "CANONICAL_REPORT_STORAGE_MISMATCH"
  | "CANONICAL_REPORT_APPROVAL_MISMATCH"
  | "CANONICAL_REPORT_GRANT_MISMATCH";

export class CanonicalReportIdentityError extends Error {
  readonly code: CanonicalReportIdentityErrorCode;

  constructor(code: CanonicalReportIdentityErrorCode) {
    super(code);
    this.name = "CanonicalReportIdentityError";
    this.code = code;
  }
}

export function canonicalReportDependencySha256(input: Readonly<{
  rule_inputs: unknown;
  dependencies: unknown;
}>): string {
  if (!Array.isArray(input.rule_inputs) || !isRecord(input.dependencies)) invalid();
  const dependencies = Object.fromEntries(Object.entries(input.dependencies).map(([key, value]) => [
    key,
    ["source_version_ids", "parameter_version_ids", "rule_spec_versions"].includes(key)
      ? canonicalArray(value)
      : value,
  ]));
  return canonicalSha256({
    schema_version: CANONICAL_REPORT_DEPENDENCY_SCHEMA_VERSION,
    rule_inputs: canonicalArray(input.rule_inputs),
    dependencies,
  });
}

export function canonicalReportModelSha256(input: Readonly<{
  analysis_result_sha256: string;
  json_sha256: string;
  html_sha256: string;
  manifest_sha256: string;
}>): string {
  for (const value of Object.values(input)) assertHash(value);
  return canonicalSha256({
    schema_version: CANONICAL_REPORT_MODEL_SCHEMA_VERSION,
    ...input,
  });
}

export function canonicalReportStorageObjectId(input: Pick<CanonicalReportIdentitySeed,
  "tenant_id" | "case_id" | "case_revision" | "analysis_run_id" | "analysis_run_revision"
  | "rule_input_dependency_sha256" | "report_model_sha256" | "report_id" | "report_revision"
  | "report_sha256" | "pdf_sha256"
>): string {
  return `report-object:${canonicalSha256({
    schema_version: "tivdoc-canonical-report-storage-object-v0.10.1",
    ...input,
  }).slice(0, 48)}`;
}

export function canonicalReportStorageObjectVersionId(input: Pick<CanonicalReportIdentitySeed,
  "tenant_id" | "case_id" | "case_revision" | "analysis_run_id" | "analysis_run_revision"
  | "rule_input_dependency_sha256" | "report_model_sha256" | "report_id" | "report_revision"
  | "report_sha256" | "pdf_sha256"
>): string {
  return `object_${canonicalSha256({
    schema_version: "tivdoc-canonical-report-storage-object-version-v0.10.1",
    ...input,
  }).slice(0, 48)}`;
}

export function createCanonicalReportIdentity(
  seed: CanonicalReportIdentitySeed,
): CanonicalReportIdentity {
  assertSeed(seed);
  return Object.freeze({ ...seed, identity_sha256: canonicalSha256(seed) });
}

export function withCanonicalReportGrantRevision(
  identity: CanonicalReportIdentity,
  downloadGrantRevision: number,
): CanonicalReportIdentity {
  assertCanonicalReportIdentity(identity);
  assertCounter(downloadGrantRevision);
  const { identity_sha256: _priorSha256, ...seed } = identity;
  assertHash(_priorSha256);
  return createCanonicalReportIdentity(Object.freeze({
    ...seed,
    download_grant_revision: downloadGrantRevision,
  }));
}

export function assertCanonicalReportIdentity(identity: CanonicalReportIdentity): void {
  const { identity_sha256: identitySha256, ...seed } = identity;
  assertHash(identitySha256);
  assertSeed(seed);
  if (canonicalSha256(seed) !== identitySha256) invalid();
}

export function assertCanonicalReportIdentityMatches(
  expected: CanonicalReportIdentity,
  actual: CanonicalReportIdentity,
): void {
  assertCanonicalReportIdentity(expected);
  assertCanonicalReportIdentity(actual);
  requireSame(expected, actual, [
    "tenant_id", "owner_binding_revision", "owner_binding_sha256", "case_id", "case_revision",
    "analysis_run_id", "analysis_run_revision", "report_id", "report_revision",
  ], "CANONICAL_REPORT_IDENTITY_STALE");
  requireSame(expected, actual, ["rule_input_dependency_sha256"], "CANONICAL_REPORT_DEPENDENCY_MISMATCH");
  requireSame(expected, actual, ["report_model_sha256"], "CANONICAL_REPORT_MODEL_MISMATCH");
  requireSame(expected, actual, ["report_sha256", "pdf_sha256"], "CANONICAL_REPORT_DIGEST_MISMATCH");
  requireSame(expected, actual, ["storage_object_id", "storage_object_version_id"],
    "CANONICAL_REPORT_STORAGE_MISMATCH");
  requireSame(expected, actual, ["approval_task_id", "approval_revision", "approval_decision_sha256"],
    "CANONICAL_REPORT_APPROVAL_MISMATCH");
  requireSame(expected, actual, ["download_grant_revision"], "CANONICAL_REPORT_GRANT_MISMATCH");
  if (expected.identity_sha256 !== actual.identity_sha256) invalid();
}

function assertSeed(seed: CanonicalReportIdentitySeed): void {
  if (seed.schema_version !== CANONICAL_REPORT_IDENTITY_SCHEMA_VERSION) invalid();
  for (const value of [
    seed.tenant_id,
    seed.case_id,
    seed.analysis_run_id,
    seed.report_id,
    seed.storage_object_id,
    seed.storage_object_version_id,
    seed.approval_task_id,
  ]) assertOpaque(value);
  for (const value of [
    seed.owner_binding_sha256,
    seed.rule_input_dependency_sha256,
    seed.report_model_sha256,
    seed.report_sha256,
    seed.pdf_sha256,
    seed.approval_decision_sha256,
  ]) assertHash(value);
  for (const value of [
    seed.owner_binding_revision,
    seed.case_revision,
    seed.analysis_run_revision,
    seed.report_revision,
    seed.approval_revision,
  ]) assertRevision(value);
  assertCounter(seed.download_grant_revision);
  const storageSeed = storageSeedFromIdentity(seed);
  if (seed.storage_object_id !== canonicalReportStorageObjectId(storageSeed)
    || seed.storage_object_version_id !== canonicalReportStorageObjectVersionId(storageSeed)) {
    throw new CanonicalReportIdentityError("CANONICAL_REPORT_STORAGE_MISMATCH");
  }
}

function storageSeedFromIdentity(identity: CanonicalReportIdentitySeed) {
  return Object.freeze({
    tenant_id: identity.tenant_id,
    case_id: identity.case_id,
    case_revision: identity.case_revision,
    analysis_run_id: identity.analysis_run_id,
    analysis_run_revision: identity.analysis_run_revision,
    rule_input_dependency_sha256: identity.rule_input_dependency_sha256,
    report_model_sha256: identity.report_model_sha256,
    report_id: identity.report_id,
    report_revision: identity.report_revision,
    report_sha256: identity.report_sha256,
    pdf_sha256: identity.pdf_sha256,
  });
}

function requireSame(
  expected: CanonicalReportIdentity,
  actual: CanonicalReportIdentity,
  keys: readonly (keyof CanonicalReportIdentitySeed)[],
  code: CanonicalReportIdentityErrorCode,
): void {
  if (keys.some((key) => expected[key] !== actual[key])) {
    throw new CanonicalReportIdentityError(code);
  }
}

function assertOpaque(value: string): void {
  if (typeof value !== "string" || !OPAQUE.test(value)) invalid();
}

function assertHash(value: string): void {
  if (typeof value !== "string" || !SHA256.test(value)) invalid();
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) invalid();
}

function assertCounter(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) invalid();
  return Object.freeze([...value].sort((left, right) => {
    const leftCanonical = canonicalStringify(left);
    const rightCanonical = canonicalStringify(right);
    return leftCanonical < rightCanonical ? -1 : leftCanonical > rightCanonical ? 1 : 0;
  }));
}

function invalid(): never {
  throw new CanonicalReportIdentityError("CANONICAL_REPORT_IDENTITY_INVALID");
}
