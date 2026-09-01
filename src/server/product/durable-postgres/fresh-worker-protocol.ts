import { createHash, randomBytes } from "node:crypto";

import { canonicalStringify } from "../../../engine/rule-runtime/canonical.ts";

export const FRESH_WORKER_PROTOCOL_SCHEMA_VERSION =
  "tivdoc-durable-fresh-worker-protocol-v0.10.2" as const;

const BOOT_NONCE_SHA256 = sha256(randomBytes(32));
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/u;
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,95}$/u;
const RESULT_STATES = ["SUCCEEDED", "IDEMPOTENT_REPLAY", "RETRY_WAIT", "DEAD_LETTER"] as const;
const REQUEST_KEYS = Object.freeze([
  "schema_version", "request_id", "parent_process_id", "worker_id", "tenant_id",
  "case_id", "correlation_id", "job_id", "now_ms", "lease_ms", "retry_delay_ms",
] as const);
const RESULT_KEYS = Object.freeze([
  "state", "job_revision", "fencing_token", "attempt_count", "report_sha256",
  "artifact_sha256", "logical_effect_sha256", "storage_locator_sha256",
  "worker_process_sha256", "audit_event_sha256",
] as const);

export type FreshWorkerRequest = Readonly<{
  schema_version: typeof FRESH_WORKER_PROTOCOL_SCHEMA_VERSION;
  request_id: string;
  parent_process_id: number;
  worker_id: string;
  tenant_id: string;
  case_id: string;
  correlation_id: string;
  job_id: string;
  now_ms: number;
  lease_ms: number;
  retry_delay_ms: number;
}>;

export type FreshWorkerRunResult = Readonly<{
  state: (typeof RESULT_STATES)[number];
  job_revision: number;
  fencing_token: number;
  attempt_count: number;
  report_sha256: string;
  artifact_sha256: string;
  logical_effect_sha256: string;
  storage_locator_sha256: string;
  worker_process_sha256: string;
  audit_event_sha256: string | null;
}>;

export type FreshWorkerExecutionInput = Omit<
  FreshWorkerRequest,
  "schema_version" | "request_id"
> & Readonly<{
  process_id: number;
  boot_nonce_sha256: string;
}>;

export interface FreshWorkerExecutionPort {
  process(input: FreshWorkerExecutionInput): Promise<FreshWorkerRunResult>;
}

export type FreshWorkerResponse = Readonly<{
  schema_version: typeof FRESH_WORKER_PROTOCOL_SCHEMA_VERSION;
  request_id: string;
  process_id: number;
  parent_process_id: number;
  boot_nonce_sha256: string;
  fresh_process_verified: true;
  result: FreshWorkerRunResult;
}>;

export function encodeFreshWorkerRequest(request: FreshWorkerRequest): string {
  assertRequest(request);
  return `${canonicalStringify(request)}\n`;
}

export function decodeFreshWorkerRequest(serialized: string): FreshWorkerRequest {
  if (Buffer.byteLength(serialized, "utf8") > 16_384 || serialized.includes("\0")) invalid();
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    invalid();
  }
  if (!isRecord(value)) invalid();
  exactKeys(value, REQUEST_KEYS);
  if (value.schema_version !== FRESH_WORKER_PROTOCOL_SCHEMA_VERSION) invalid();
  const request: FreshWorkerRequest = Object.freeze({
    schema_version: FRESH_WORKER_PROTOCOL_SCHEMA_VERSION,
    request_id: exactString(value.request_id),
    parent_process_id: exactNumber(value.parent_process_id),
    worker_id: exactString(value.worker_id),
    tenant_id: exactString(value.tenant_id),
    case_id: exactString(value.case_id),
    correlation_id: exactString(value.correlation_id),
    job_id: exactString(value.job_id),
    now_ms: exactNumber(value.now_ms),
    lease_ms: exactNumber(value.lease_ms),
    retry_delay_ms: exactNumber(value.retry_delay_ms),
  });
  assertRequest(request);
  return request;
}

/** Must be called by a direct child created with shell=false. */
export async function executeFreshWorkerProtocol(
  serializedRequest: string,
  worker: FreshWorkerExecutionPort,
): Promise<string> {
  const request = decodeFreshWorkerRequest(serializedRequest);
  if (process.pid === request.parent_process_id || process.ppid !== request.parent_process_id) {
    throw new Error("FRESH_WORKER_PROCESS_BOUNDARY_INVALID");
  }
  const result = await worker.process(Object.freeze({
    parent_process_id: request.parent_process_id,
    process_id: process.pid,
    boot_nonce_sha256: BOOT_NONCE_SHA256,
    worker_id: request.worker_id,
    tenant_id: request.tenant_id,
    case_id: request.case_id,
    correlation_id: request.correlation_id,
    job_id: request.job_id,
    now_ms: request.now_ms,
    lease_ms: request.lease_ms,
    retry_delay_ms: request.retry_delay_ms,
  }));
  assertResult(result);
  const response: FreshWorkerResponse = Object.freeze({
    schema_version: FRESH_WORKER_PROTOCOL_SCHEMA_VERSION,
    request_id: request.request_id,
    process_id: process.pid,
    parent_process_id: process.ppid,
    boot_nonce_sha256: BOOT_NONCE_SHA256,
    fresh_process_verified: true,
    result,
  });
  return `${canonicalStringify(response)}\n`;
}

export function decodeFreshWorkerResponse(serialized: string, request: FreshWorkerRequest): FreshWorkerResponse {
  if (Buffer.byteLength(serialized, "utf8") > 16_384 || serialized.includes("\0")) invalid();
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    invalid();
  }
  if (!isRecord(value)) invalid();
  exactKeys(value, [
    "schema_version", "request_id", "process_id", "parent_process_id",
    "boot_nonce_sha256", "fresh_process_verified", "result",
  ]);
  if (!isRecord(value.result)) invalid();
  exactKeys(value.result, RESULT_KEYS);
  const result: FreshWorkerRunResult = Object.freeze({
    state: resultState(value.result.state),
    job_revision: exactNumber(value.result.job_revision),
    fencing_token: exactNumber(value.result.fencing_token),
    attempt_count: exactNumber(value.result.attempt_count),
    report_sha256: exactString(value.result.report_sha256),
    artifact_sha256: exactString(value.result.artifact_sha256),
    logical_effect_sha256: exactString(value.result.logical_effect_sha256),
    storage_locator_sha256: exactString(value.result.storage_locator_sha256),
    worker_process_sha256: exactString(value.result.worker_process_sha256),
    audit_event_sha256: value.result.audit_event_sha256 === null
      ? null
      : exactString(value.result.audit_event_sha256),
  });
  if (value.schema_version !== FRESH_WORKER_PROTOCOL_SCHEMA_VERSION
    || value.fresh_process_verified !== true) invalid();
  const response: FreshWorkerResponse = Object.freeze({
    schema_version: FRESH_WORKER_PROTOCOL_SCHEMA_VERSION,
    request_id: exactString(value.request_id),
    process_id: exactNumber(value.process_id),
    parent_process_id: exactNumber(value.parent_process_id),
    boot_nonce_sha256: exactString(value.boot_nonce_sha256),
    fresh_process_verified: true,
    result,
  });
  if (response.schema_version !== FRESH_WORKER_PROTOCOL_SCHEMA_VERSION
    || response.request_id !== request.request_id
    || response.parent_process_id !== request.parent_process_id
    || response.process_id === request.parent_process_id
    || response.fresh_process_verified !== true) invalid();
  assertHash(response.boot_nonce_sha256);
  assertResult(response.result);
  return response;
}

function assertRequest(request: FreshWorkerRequest): void {
  exactKeys(request, REQUEST_KEYS);
  if (request.schema_version !== FRESH_WORKER_PROTOCOL_SCHEMA_VERSION) invalid();
  for (const value of [
    request.request_id,
    request.worker_id,
    request.tenant_id,
    request.case_id,
    request.job_id,
  ]) {
    if (!OPAQUE.test(value)) invalid();
  }
  if (!CORRELATION.test(request.correlation_id)) invalid();
  for (const value of [request.parent_process_id, request.now_ms, request.lease_ms, request.retry_delay_ms]) {
    if (!Number.isSafeInteger(value) || value < 1) invalid();
  }
  if (request.lease_ms < 1_000 || request.lease_ms > 300_000
    || request.retry_delay_ms > 3_600_000) invalid();
}

function assertResult(result: FreshWorkerRunResult): void {
  exactKeys(result, RESULT_KEYS);
  if (!RESULT_STATES.includes(result.state)) invalid();
  for (const value of [result.job_revision, result.attempt_count]) {
    if (!Number.isSafeInteger(value) || value < 1) invalid();
  }
  if (!Number.isSafeInteger(result.fencing_token) || result.fencing_token < 0) invalid();
  for (const value of [
    result.report_sha256,
    result.artifact_sha256,
    result.logical_effect_sha256,
    result.storage_locator_sha256,
    result.worker_process_sha256,
  ]) assertHash(value);
  if (result.audit_event_sha256 !== null) assertHash(result.audit_event_sha256);
}

function resultState(value: unknown): FreshWorkerRunResult["state"] {
  if (value === "SUCCEEDED" || value === "IDEMPOTENT_REPLAY"
    || value === "RETRY_WAIT" || value === "DEAD_LETTER") return value;
  invalid();
}

function assertHash(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) invalid();
}

function exactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) invalid();
}

function exactString(value: unknown): string {
  if (typeof value !== "string") invalid();
  return value;
}

function exactNumber(value: unknown): number {
  if (typeof value !== "number") invalid();
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new Error("FRESH_WORKER_PROTOCOL_INVALID");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
