export type BackupSourceKind = "local_filesystem_fixture" | "local_memory_fixture";

export type BackupObject = Readonly<{
  path: string;
  bytes: Uint8Array;
}>;

export interface BackupSourceAdapter {
  readonly kind: BackupSourceKind;
  list(): Promise<readonly BackupObject[]>;
}

export interface LocalRestoreTargetAdapter {
  readonly kind: "local_filesystem_staging" | "local_memory_staging";
  isEmpty(): Promise<boolean>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  list(): Promise<readonly BackupObject[]>;
}

export type BackupManifestEntry = Readonly<{
  path: string;
  byte_count: number;
  sha256: string;
}>;

export type BackupManifest = Readonly<{
  schema_version: "tivdoc-local-backup-manifest-v0.7.0";
  backup_id: string;
  source_kind: BackupSourceKind;
  created_at: string;
  watermark: string;
  key_version: string;
  entries: readonly BackupManifestEntry[];
  aggregate_sha256: string;
  manifest_sha256: string;
}>;

export type BackupBundle = Readonly<{
  manifest: BackupManifest;
  objects: ReadonlyMap<string, Uint8Array>;
}>;

export type BackupVerification = Readonly<{
  valid: boolean;
  status: "VERIFIED_LOCAL_FIXTURE" | "REJECTED_CORRUPT";
  error_codes: readonly string[];
  object_count: number;
  byte_count: number;
  manifest_sha256: string;
}>;

export type RestorePlan = Readonly<{
  schema_version: "tivdoc-local-restore-plan-v0.7.0";
  backup_id: string;
  manifest_sha256: string;
  target_kind: "local_memory_staging" | "local_filesystem_staging";
  dry_run: true;
  mutation_applied: false;
  object_count: number;
  byte_count: number;
}>;

export type LocalRestoreReceipt = Readonly<{
  schema_version: "tivdoc-local-restore-receipt-v0.7.0";
  backup_id: string;
  manifest_sha256: string;
  target_kind: LocalRestoreTargetAdapter["kind"];
  status: "VERIFIED_LOCAL_FIXTURE_RESTORE";
  object_count: number;
  byte_count: number;
  receipt_sha256: string;
}>;
