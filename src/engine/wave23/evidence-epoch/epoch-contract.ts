export type GitBlobOidSha1 = string & { readonly __namespace: "git_blob_oid_sha1" };
export type ContentSha256 = string & { readonly __namespace: "content_sha256" };
export type PackageSha256 = string & { readonly __namespace: "package_sha256" };
export type DecisionSha256 = string & { readonly __namespace: "decision_sha256" };

const sha1Pattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

export const evidenceEpoch2Contract = Object.freeze({
  schema_version: "tivdoc-evidence-epoch-v2",
  epoch_id: "TIVDOC_EVIDENCE_EPOCH_2_V0.5.0",
  parent_trust_root: null,
  authoritative_bytes_source: "git_object_database",
  historical_packages_are_incident_references_only: true,
  hash_namespaces: Object.freeze([
    "git_blob_oid_sha1",
    "content_sha256",
    "package_sha256",
    "decision_sha256",
  ]),
});

export function parseGitBlobOidSha1(value: string): GitBlobOidSha1 {
  if (!sha1Pattern.test(value)) throw new Error("git_blob_oid_sha1_invalid");
  return value as GitBlobOidSha1;
}

export function parseContentSha256(value: string): ContentSha256 {
  if (!sha256Pattern.test(value)) throw new Error("content_sha256_invalid");
  return value as ContentSha256;
}

export function parsePackageSha256(value: string): PackageSha256 {
  if (!sha256Pattern.test(value)) throw new Error("package_sha256_invalid");
  return value as PackageSha256;
}

export function parseDecisionSha256(value: string): DecisionSha256 {
  if (!sha256Pattern.test(value)) throw new Error("decision_sha256_invalid");
  return value as DecisionSha256;
}

export type AuthoritativeGitObject = Readonly<{
  path: string;
  file_mode: "100644" | "100755";
  git_blob_oid_sha1: GitBlobOidSha1;
  byte_length: number;
  content_sha256: ContentSha256;
}>;

export function assertNoInheritedTrust(value: Readonly<{
  schema_version: string;
  epoch_id: string;
  parent_trust_root: unknown;
  authoritative_bytes_source: string;
  historical_packages_are_incident_references_only: boolean;
}>) {
  if (value.schema_version !== evidenceEpoch2Contract.schema_version
    || value.epoch_id !== evidenceEpoch2Contract.epoch_id
    || value.parent_trust_root !== null
    || value.authoritative_bytes_source !== "git_object_database"
    || value.historical_packages_are_incident_references_only !== true) {
    throw new Error("evidence_epoch_2_inherited_or_invalid_trust");
  }
  return true as const;
}
