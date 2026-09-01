import { createHash } from "node:crypto";

import type { DeterministicReportArtifacts } from "../../../engine/wave3/contracts.ts";
import { canonicalSha256 } from "../../../engine/rule-runtime/canonical.ts";

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^\S(?:[\s\S]{0,238}\S)?$/u;
const KEYS = Object.freeze([
  "report_id", "report_revision", "analysis_result_sha256", "json_base64", "html_base64",
  "pdf_base64", "manifest_base64", "json_sha256", "html_sha256", "pdf_sha256",
  "manifest_sha256", "report_sha256",
] as const);

/**
 * Worker-safe exact decoder for the immutable report payload. This module has
 * no schema-registry or path-alias imports so the fresh raw Node process can
 * load it directly, while retaining the canonical byte/hash validation used
 * by the application repository.
 */
export function decodeDurableReportArtifacts(value: unknown): DeterministicReportArtifacts {
  const row = exactRecord(value);
  const report = Object.freeze({
    report_id: identifier(row.report_id),
    report_revision: positiveInteger(row.report_revision),
    analysis_result_sha256: hash(row.analysis_result_sha256),
    json: bytes(row.json_base64),
    html: bytes(row.html_base64),
    pdf: bytes(row.pdf_base64),
    manifest: bytes(row.manifest_base64),
    json_sha256: hash(row.json_sha256),
    html_sha256: hash(row.html_sha256),
    pdf_sha256: hash(row.pdf_sha256),
    manifest_sha256: hash(row.manifest_sha256),
    report_sha256: hash(row.report_sha256),
  }) satisfies DeterministicReportArtifacts;
  if (sha256(report.json) !== report.json_sha256
      || sha256(report.html) !== report.html_sha256
      || sha256(report.pdf) !== report.pdf_sha256
      || sha256(report.manifest) !== report.manifest_sha256) {
    invalid();
  }
  const fixtureHash = canonicalSha256({
    report_id: report.report_id,
    json_sha256: report.json_sha256,
    html_sha256: report.html_sha256,
    pdf_sha256: report.pdf_sha256,
    manifest_sha256: report.manifest_sha256,
  });
  const revisionHash = canonicalSha256({
    report_id: report.report_id,
    report_revision: report.report_revision,
    analysis_result_sha256: report.analysis_result_sha256,
    json_sha256: report.json_sha256,
    html_sha256: report.html_sha256,
    pdf_sha256: report.pdf_sha256,
    manifest_sha256: report.manifest_sha256,
  });
  if (report.report_sha256 !== fixtureHash && report.report_sha256 !== revisionHash) invalid();
  return report;
}

function exactRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Readonly<Record<string, unknown>>;
  const actual = Object.keys(record).sort();
  const expected = [...KEYS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid();
  return record;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value) || value.includes("\0")) invalid();
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) invalid();
  return value;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}

function bytes(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length < 1 || value.length > 32 * 1024 * 1024
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    invalid();
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) invalid();
  return new Uint8Array(decoded);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function invalid(): never {
  throw new Error("DURABLE_REPORT_ARTIFACT_BINDING_INVALID");
}
