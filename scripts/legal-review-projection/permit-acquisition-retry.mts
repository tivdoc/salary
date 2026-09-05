// E2-6 (B-06). Retry the sixteen official permit URLs that failed acquisition —
// fifteen 403s and one 404 — exactly once, through the repository's own fetch
// tool, and record what happened.
//
// No alternative hosts, no bypass, no second attempt. Every URL is on
// www.gov.il, already allowlisted; nothing here widens anything. The expected
// outcome is that most stay blocked, and that is fine: the value of this unit
// is dated evidence that the block is still real on this date, rather than an
// assumption carried forward from a run months ago.
//
// If one does succeed, it is recorded as a succeeded observation with the
// bytes' hash — and NOT registered as a source. Registration is an acquisition
// unit with its own rules; this is a probe.
import "../production-refusal.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fetchLegalSourceBytes } from "../../src/server/engine/legal-knowledge/security.ts";

const RECEIPT_ROOT = path.join("output", "next", "permit-retry");
const HANDOFF = "C:/dev/tivdoc-wave1-working-time-permits/output/legal-knowledge/wave1-working-time-permits/owner-handoff.json";

type Failure = Readonly<{ artifact_id: string; official_url: string; safe_error_code: string }>;

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const handoff = JSON.parse(readFileSync(HANDOFF, "utf8")) as { artifact_failures: Failure[] };
  const failures = [...handoff.artifact_failures].sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
  if (failures.length !== 16) throw new Error(`E26_EXPECTED_16_FAILURES_GOT_${failures.length}`);

  const attemptedAt = new Date().toISOString();
  const observations: Array<Record<string, unknown>> = [];
  for (const failure of failures) {
    const attempt: Record<string, unknown> = {
      artifact_id: failure.artifact_id,
      official_url: failure.official_url,
      previous_safe_error_code: failure.safe_error_code,
      attempted_at: attemptedAt,
    };
    try {
      const result = await fetchLegalSourceBytes({
        source_id: failure.artifact_id,
        source_version: "e2-6-retry",
        canonical_url: failure.official_url,
        artifact_format: "pdf",
      } as never, { timeoutMs: 20_000 });
      const bytes = (result as unknown as { bytes?: Uint8Array }).bytes;
      attempt.outcome = "succeeded";
      attempt.safe_error_code = null;
      attempt.byte_count = bytes?.byteLength ?? null;
      attempt.artifact_sha256 = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
      attempt.final_url = (result as unknown as { final_url?: string }).final_url ?? null;
      attempt.registered = false;
      attempt.registration_note = "Probe only. A successful fetch here does not register a source; that is an acquisition unit with its own immutability, media-validation and manifest rules.";
    } catch (error) {
      attempt.outcome = "failed";
      // The fetch tool's own safe error code, never a raw provider message.
      attempt.safe_error_code = String((error as { code?: string }).code ?? (error as Error).message ?? "unknown").slice(0, 120);
      attempt.byte_count = null;
      attempt.artifact_sha256 = null;
    }
    attempt.changed_since_previous = attempt.outcome === "succeeded"
      || attempt.safe_error_code !== failure.safe_error_code;
    observations.push(attempt);
    process.stdout.write(`${String(attempt.outcome).padEnd(9)} ${String(attempt.safe_error_code ?? "-").padEnd(20)} ${failure.artifact_id}\n`);
  }

  const succeeded = observations.filter((entry) => entry.outcome === "succeeded");
  const changed = observations.filter((entry) => entry.changed_since_previous === true);
  const receipt = {
    schema_version: "tivdoc-permit-acquisition-retry-v0.10.14",
    unit: "E2-6 (B-06)",
    attempted_at: attemptedAt,
    attempts: observations.length,
    succeeded: succeeded.length,
    still_blocked: observations.length - succeeded.length,
    changed_since_previous: changed.length,
    hosts_touched: [...new Set(observations.map((entry) => new URL(String(entry.official_url)).hostname))].sort(),
    allowlist_widened: false,
    sources_registered: 0,
    retried_once_only: true,
    observations,
  };
  writeFileSync(path.join(RECEIPT_ROOT, "permit-acquisition-retry.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    attempts: receipt.attempts, succeeded: receipt.succeeded, still_blocked: receipt.still_blocked,
    changed_since_previous: receipt.changed_since_previous, hosts: receipt.hosts_touched,
  }, null, 2)}\n`);
}

await main();
