import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildWorkingTimePermitOwnerHandoff,
  validateWorkingTimePermitInventories,
} from "../src/server/engine/legal-knowledge/wave1-working-time-permits.ts";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const outputRoot = path.join(repositoryRoot, "output", "legal-knowledge", "wave1-working-time-permits");
const reportPath = path.join(outputRoot, "artifact-acquisition-report.json");
const handoffPath = path.join(outputRoot, "owner-handoff.json");
const publicationsPath = path.join(repositoryRoot, "src", "server", "engine", "legal-knowledge", "wave1-working-time-permits-publications.v0.3.json");
const permitsPath = path.join(repositoryRoot, "src", "server", "engine", "legal-knowledge", "wave1-working-time-permits-catalog.v0.3.json");
const maximumBytes = 50 * 1024 * 1024;
const timeoutMilliseconds = 30_000;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeFilename(id: string, ordinal: number) {
  const normalized = id.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized || normalized.includes("..")) throw new Error("unsafe_artifact_filename");
  return `${String(ordinal).padStart(3, "0")}-${normalized}.pdf`;
}

function validateOfficialUrl(value: string, allowedHost: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== allowedHost || url.username || url.password) throw new Error("official_url_not_allowlisted");
  return url;
}

function validatePdf(bytes: Uint8Array, contentType: string | null) {
  if (bytes.byteLength < 512) throw new Error("pdf_too_small");
  if (bytes.byteLength > maximumBytes) throw new Error("pdf_too_large");
  const prefix = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, 512))).toString("latin1");
  if (!prefix.startsWith("%PDF-")) throw new Error("pdf_magic_mismatch");
  if (/<!doctype\s+html|<html/i.test(prefix)) throw new Error("html_instead_of_pdf");
  const suffix = Buffer.from(bytes.subarray(Math.max(0, bytes.byteLength - 4096))).toString("latin1");
  if (!suffix.includes("%%EOF")) throw new Error("pdf_eof_missing");
  const normalizedContentType = (contentType ?? "").toLowerCase();
  if (normalizedContentType && !normalizedContentType.includes("pdf") && !normalizedContentType.includes("octet-stream")) throw new Error("pdf_content_type_mismatch");
}

async function fetchOfficialPdf(inputUrl: string, allowedHost: string) {
  let current = validateOfficialUrl(inputUrl, allowedHost);
  const redirects: string[] = [];
  for (let step = 0; step <= 3; step += 1) {
    const response = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(timeoutMilliseconds) });
    if (redirectStatuses.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("redirect_location_missing");
      const next = validateOfficialUrl(new URL(location, current).toString(), allowedHost);
      redirects.push(next.toString());
      current = next;
      continue;
    }
    if (response.status !== 200) throw new Error(`http_status_${response.status}`);
    const finalUrl = validateOfficialUrl(response.url || current.toString(), allowedHost).toString();
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new Error("pdf_too_large");
    const bytes = new Uint8Array(await response.arrayBuffer());
    validatePdf(bytes, response.headers.get("content-type"));
    return {
      bytes,
      final_url: finalUrl,
      redirects,
      content_type: response.headers.get("content-type"),
    };
  }
  throw new Error("too_many_redirects");
}

async function writeAtomic(target: string, bytes: Uint8Array | string) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  try {
    await stat(temporary);
    throw new Error("stale_temporary_output_present");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, target);
}

function safeErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "unknown_error";
  if (/^[a-z0-9_]+(?:_\d+)?$/.test(message)) return message;
  if (error instanceof DOMException && error.name === "TimeoutError") return "fetch_timeout";
  return "artifact_acquisition_failed";
}

async function main() {
  const publications = JSON.parse(await readFile(publicationsPath, "utf8")) as unknown;
  const permits = JSON.parse(await readFile(permitsPath, "utf8")) as unknown;
  const validated = validateWorkingTimePermitInventories({ permits, publications });
  const requested = [
    ...validated.publications.entries.map((entry, index) => ({
      ordinal: index + 1,
      collection: "hours_publications" as const,
      artifact_id: entry.publication_identity,
      title: entry.title,
      official_url: entry.official_artifact_url,
      allowed_host: "fs.knesset.gov.il",
    })),
    ...validated.permits.entries.flatMap((entry) => entry.artifact_links).map((artifact, index) => ({
      ordinal: index + 1,
      collection: "work_permits" as const,
      artifact_id: artifact.artifact_id,
      title: artifact.title,
      official_url: artifact.official_url,
      allowed_host: "www.gov.il",
    })),
  ];

  if (process.argv.includes("--validate-only")) {
    process.stdout.write(`${JSON.stringify({ status: "VALID", hours_publications: 20, permit_entries: 58, artifact_requests: requested.length })}\n`);
    return;
  }

  try {
    await stat(reportPath);
    throw new Error("stale_acquisition_report_present");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const results: Array<Record<string, unknown>> = [];
  const failures: Array<{ artifact_id: string; official_url: string; safe_error_code: string }> = [];
  for (const request of requested) {
    const relativePath = path.join("artifacts", request.collection, safeFilename(request.artifact_id, request.ordinal));
    const target = path.join(outputRoot, relativePath);
    try {
      const fetched = await fetchOfficialPdf(request.official_url, request.allowed_host);
      await writeAtomic(target, fetched.bytes);
      results.push({
        ...request,
        acquisition_state: "acquired_raw_unreviewed",
        review_state: "needs_review",
        activation_state: "inactive",
        final_url: fetched.final_url,
        redirects: fetched.redirects,
        content_type: fetched.content_type,
        byte_count: fetched.bytes.byteLength,
        artifact_sha256: sha256(fetched.bytes),
        local_path: relativePath.replaceAll("\\", "/"),
      });
    } catch (error) {
      const safe_error_code = safeErrorCode(error);
      failures.push({ artifact_id: request.artifact_id, official_url: request.official_url, safe_error_code });
      results.push({
        ...request,
        acquisition_state: "unavailable",
        review_state: "needs_review",
        activation_state: "inactive",
        safe_error_code,
      });
    }
  }

  const report = {
    schema_version: "wave1-working-time-permits-artifact-acquisition-v0.3",
    snapshot_cutoff: validated.permits.snapshot.cutoff,
    method: "separate_plain_https_get_of_each_visible_official_link",
    request_headers_customized: false,
    cookies_used: false,
    login_used: false,
    access_control_bypass_used: false,
    requested_count: requested.length,
    acquired_count: results.filter((result) => result.acquisition_state === "acquired_raw_unreviewed").length,
    failed_count: failures.length,
    legal_review_performed: false,
    applicability_inferred: false,
    consolidated_text_created: false,
    results,
  };
  await writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeAtomic(handoffPath, `${JSON.stringify(buildWorkingTimePermitOwnerHandoff({ artifactFailures: failures }), null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ requested: requested.length, acquired: report.acquired_count, failed: failures.length, report: path.relative(repositoryRoot, reportPath).replaceAll("\\", "/") })}\n`);
  if (failures.length > 0) process.exitCode = 2;
}

await main();
