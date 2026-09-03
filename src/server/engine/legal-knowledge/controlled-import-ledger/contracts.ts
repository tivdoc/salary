import { createHash } from "node:crypto";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{2,127}$/u);
const timestampSchema = z.string().datetime({ offset: true });

export const controlledImportStates = ["received", "leased", "validated", "rejected", "published"] as const;

export const controlledImportCommandSchema = z.object({
  schema_version: z.literal("tivdoc-controlled-import-command-v0.10.0"),
  operation_id: sha256Schema,
  idempotency_key: identifierSchema,
  source_id: identifierSchema,
  actor_id: identifierSchema,
  request_sha256: sha256Schema,
  request_payload: z.record(z.string(), z.unknown()),
  expected_artifact_sha256: sha256Schema.nullable(),
  expected_media_type: z.literal("application/pdf"),
  requested_at: timestampSchema,
}).strict();

export type ControlledImportCommand = z.infer<typeof controlledImportCommandSchema>;

export const controlledImportLeaseSchema = z.object({
  operation_id: sha256Schema,
  worker_id: identifierSchema,
  fencing_token: z.number().int().positive(),
  lease_expires_at: timestampSchema,
  state: z.enum(["leased", "validated"]),
}).strict();

export type ControlledImportLease = z.infer<typeof controlledImportLeaseSchema>;

export const controlledImportStatusSchema = z.object({
  operation_id: sha256Schema,
  source_id: identifierSchema,
  actor_id: identifierSchema,
  request_sha256: sha256Schema,
  expected_artifact_sha256: sha256Schema.nullable(),
  artifact_sha256: sha256Schema.nullable(),
  byte_count: z.number().int().nonnegative().nullable(),
  state: z.enum(controlledImportStates),
  fencing_token: z.number().int().nonnegative(),
  publication_id: sha256Schema.nullable(),
  publication_receipt_sha256: sha256Schema.nullable(),
  visible: z.boolean(),
  rejection_reason: z.string().regex(/^[A-Z0-9_]{3,96}$/u).nullable(),
}).strict();

export type ControlledImportStatus = z.infer<typeof controlledImportStatusSchema>;

export type ExactByteObservation = Readonly<{
  bytes: Uint8Array;
  identity_token: string;
}>;

export interface ExactByteReopenSource {
  reopenExact(): Promise<ExactByteObservation>;
}

export type CapturedExactBytes = Readonly<{
  bytes: Uint8Array;
  artifact_sha256: string;
  byte_count: number;
  identity_token_sha256: string;
}>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

export function controlledImportCanonicalJson(value: unknown) {
  return `${JSON.stringify(stableValue(value))}\n`;
}

export function controlledImportSha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

export function createControlledImportCommand(input: Readonly<{
  idempotency_key: string;
  source_id: string;
  actor_id: string;
  request_payload: Readonly<Record<string, unknown>>;
  expected_artifact_sha256: string | null;
  requested_at: string;
}>) {
  const requestSha256 = controlledImportSha256(controlledImportCanonicalJson(input.request_payload));
  const operationId = controlledImportSha256(controlledImportCanonicalJson({
    idempotency_key: input.idempotency_key,
    source_id: input.source_id,
    actor_id: input.actor_id,
    request_sha256: requestSha256,
    expected_artifact_sha256: input.expected_artifact_sha256,
    expected_media_type: "application/pdf",
  }));
  return controlledImportCommandSchema.parse({
    schema_version: "tivdoc-controlled-import-command-v0.10.0",
    operation_id: operationId,
    idempotency_key: input.idempotency_key,
    source_id: input.source_id,
    actor_id: input.actor_id,
    request_sha256: requestSha256,
    request_payload: input.request_payload,
    expected_artifact_sha256: input.expected_artifact_sha256,
    expected_media_type: "application/pdf",
    requested_at: input.requested_at,
  });
}

export async function captureExactBytesForImport(
  source: ExactByteReopenSource,
  limits: Readonly<{ max_bytes: number }>,
): Promise<CapturedExactBytes> {
  const first = await source.reopenExact();
  const second = await source.reopenExact();
  const firstBytes = Buffer.from(first.bytes);
  const secondBytes = Buffer.from(second.bytes);
  if (!first.identity_token || !second.identity_token) throw new ControlledImportLedgerError("IMPORT_SOURCE_IDENTITY_MISSING");
  if (firstBytes.byteLength === 0 || firstBytes.byteLength > limits.max_bytes) throw new ControlledImportLedgerError("IMPORT_ARTIFACT_SIZE_INVALID");
  if (first.identity_token !== second.identity_token
    || firstBytes.byteLength !== secondBytes.byteLength
    || !firstBytes.equals(secondBytes)) throw new ControlledImportLedgerError("IMPORT_TOCTOU_REOPEN_MISMATCH");
  return Object.freeze({
    bytes: Uint8Array.from(firstBytes),
    artifact_sha256: controlledImportSha256(firstBytes),
    byte_count: firstBytes.byteLength,
    identity_token_sha256: controlledImportSha256(first.identity_token),
  });
}

export type ControlledImportLedgerErrorCode =
  | "IMPORT_ARTIFACT_HASH_MISMATCH"
  | "IMPORT_ARTIFACT_SIZE_INVALID"
  | "IMPORT_DATABASE_CONTRACT_MISSING"
  | "IMPORT_EXECUTE_PERMISSION_DENIED"
  | "IMPORT_IDEMPOTENCY_BINDING_MISMATCH"
  | "IMPORT_INVALID_STATE"
  | "IMPORT_LEASE_FENCED"
  | "IMPORT_PUBLICATION_INVISIBLE"
  | "IMPORT_ROW_MALFORMED"
  | "IMPORT_SOURCE_IDENTITY_MISSING"
  | "IMPORT_TOCTOU_REOPEN_MISMATCH";

export class ControlledImportLedgerError extends Error {
  readonly code: ControlledImportLedgerErrorCode;

  constructor(code: ControlledImportLedgerErrorCode) {
    super(code);
    this.name = "ControlledImportLedgerError";
    this.code = code;
  }
}
