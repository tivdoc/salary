import type { IdentitySessionState } from "../../platform/auth/identity-verification.ts";

export const DURABLE_PRODUCT_BOUNDARY_MIGRATION = "202609010002_durable_product_boundaries" as const;
export const DURABLE_PRODUCT_BOUNDARY_SCHEMA_VERSION = "tivdoc-durable-product-postgresql-v0.10.0" as const;

export const DURABLE_BOUNDARY_CAPABILITIES = Object.freeze({
  W2_DURABLE_IDENTITY_SESSION: "IMPLEMENTED_SCHEMA_INSTALLED_NOT_WIRED",
  W2_DURABLE_CASE_OWNER_BINDING: "IMPLEMENTED_SCHEMA_INSTALLED_NOT_WIRED",
  W2_DURABLE_PRIVACY_WORKFLOW: "IMPLEMENTED_SCHEMA_INSTALLED_NOT_WIRED",
  W2_PRIVATE_REPORT_OBJECT_BINDING: "IMPLEMENTED_SCHEMA_INSTALLED_NOT_WIRED",
  W2_RENDERED_NEXT_COMPOSITION: "BLOCKED_COMPOSITION",
  memory_fallback_count: 0,
  installed_contract_path: "supabase/migrations/202609010002_durable_product_boundaries.sql",
} as const);

export type IdentitySessionRegistration = Readonly<{
  tenant_id: string;
  session_id: string;
  subject: string;
  current_token_id: string;
  rotation_counter: number;
  valid_after: string;
  expires_at: string;
  reviewer_organization_id: string | null;
  created_at: string;
}>;

export type IdentitySessionRecord = IdentitySessionState & Readonly<{
  tenant_id: string;
  session_sha256: string;
  created_at: string;
  revoked_at: string | null;
}>;

export type CaseOwnerRecord = Readonly<{
  tenant_id: string;
  case_id: string;
  subject: string;
  revision: number;
  status: "active" | "revoked";
  binding_sha256: string;
  created_at: string;
  revoked_at: string | null;
}>;

export const PRIVACY_REQUEST_KINDS = ["access", "correction", "deletion", "export", "consent"] as const;
export type PrivacyRequestKind = (typeof PRIVACY_REQUEST_KINDS)[number];
export const PRIVACY_REQUEST_STATES = [
  "requested",
  "acknowledged",
  "restricted_by_legal_hold",
  "completed_by_authorized_operations",
] as const;
export type PrivacyRequestState = (typeof PRIVACY_REQUEST_STATES)[number];

export type PrivacyRequestVersion = Readonly<{
  request_id: string;
  revision: number;
  tenant_id: string;
  case_id: string;
  request_kind: PrivacyRequestKind;
  state: PrivacyRequestState;
  idempotency_key: string;
  command_sha256: string;
  legal_hold_conflict: boolean;
  grant_revocation_receipt_sha256: string | null;
  created_at: string;
}>;

export type PrivateReportObjectRecord = Readonly<{
  tenant_id: string;
  case_id: string;
  report_id: string;
  report_revision: number;
  report_sha256: string;
  object_version_id: string;
  provider_locator: string;
  byte_length: number;
  artifact_sha256: string;
  state: "staged" | "approved" | "revoked";
  grant_epoch: number;
  revocation_receipt_sha256: string | null;
  revoked_at: string | null;
  created_at: string;
}>;

export type ApprovedPrivateReportObject = Readonly<{
  object_version_id: string;
  provider_locator: string;
  byte_length: number;
  artifact_sha256: string;
  grant_epoch: number;
}>;
