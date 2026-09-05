// L11-5 / D3.6 (run 11). BL-24's attribution, corrected on the record.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/bl24-attribution-annotation.mts
//
// The decision row working_time_daily_threshold (batch 16) says its
// administrative branch — 8.6 hours on a five-day week, 7.6 on its short day
// — rests on the Labour Ministry directive of 10.6.2018 and would bind at the
// administrative grade. The lawyer-approved opinion (5.9.2026, question 6)
// corrects both: the 10.6.2018 directive is about the 182-hour divisor of the
// hourly minimum wage; the daily figures come from the steering committee's
// interpretation of the 42-hour extension order (24.4.2018) as reported by
// kolzchut, and P-15/P-16 are graded agreement_interpretation, not
// administrative. The row is append-only and its question is one of the
// columns the guard refuses to move — correctly, because the row is evidence
// of what was asked. So the correction is an annotation appended against the
// decision through the sanctioned path, exactly as E3-3 corrected a topic.
//
// Nothing else changes on the row: it stays open, its branch stays unbound,
// BL-24 stays open (no official artifact carries the figures).
import "../production-refusal.mjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { WORKING_TIME_DAILY_THRESHOLD_DECISION } from "../../src/engine/legal-quality/sensitivity-rulespecs.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { TENANT } from "./pool-p-parameter-import.mts";
import { seedSessions } from "./reviewer-registration.mts";

const RECEIPT_ROOT = path.join("output", "next", "pool-q");
const SYSTEM_SESSION = { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import" };
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export const BL24_ANNOTATION =
  "Correction of attribution (run 11, L11-5 / D3.6, on the lawyer-approved opinion of 5.9.2026, question 6): the administrative branch's figures — 8.6 hours on four days and 7.6 on the short day of a five-day week, 8 / 7 on a six-day week — do not come from the Labour Ministry directive of 10.6.2018, which concerns the 182-hour divisor of the hourly minimum wage. They come from the steering committee's interpretation of the 42-hour extension order (24.4.2018), as reported by kolzchut. The branch's grade, if bound, is agreement_interpretation, not administrative; P-15/P-16 carry the same grade. No official artifact carries the figures, so the branch stays unbound and BL-24 stays open with this attribution. The owner-recorded resolution selects this branch as the default; it does not run until bound.";

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const url = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!url) throw new Error("L115_ENV_MISSING");
  await seedSessions(TENANT, `${TENANT}.no-attestation-placeholder`, [{ ...SYSTEM_SESSION, subject: "system_import" }]);
  const ops = new pg.Client({ connectionString: url, connectionTimeoutMillis: 20_000, application_name: "tivdoc_l115_bl24_annotation" });
  await ops.connect();
  let receipt: Record<string, unknown>;
  try {
    await ops.query("begin");
    await ops.query("select * from private.runtime_context_install($1,$2,$3)", [SYSTEM_SESSION.sid, SYSTEM_SESSION.jti, `l115:${randomUUID().slice(0, 8)}`]);
    const result = await ops.query(
      "select * from private.governance_legal_open_decision_annotate($1,$2,$3,$4,$5,$6::timestamptz)",
      [TENANT, WORKING_TIME_DAILY_THRESHOLD_DECISION, BL24_ANNOTATION, "l115.bl24.attribution", sha256(`annotate:bl24:${BL24_ANNOTATION}`), new Date().toISOString()],
    );
    const decisions = await ops.query("select * from private.legal_open_decision_read($1)", [TENANT]);
    await ops.query("commit");
    const row = result.rows[0] as { state?: string; idempotent_replay?: boolean; audit_event_sha256?: string; content_sha256?: string };
    const decision = (decisions.rows as Array<Record<string, unknown>>).find((entry) => entry.decision_id === WORKING_TIME_DAILY_THRESHOLD_DECISION);
    receipt = {
      schema_version: "tivdoc-bl24-attribution-annotation-v1",
      unit: "L11-5 / D3.6",
      tenant: TENANT,
      decision_id: WORKING_TIME_DAILY_THRESHOLD_DECISION,
      annotation: BL24_ANNOTATION,
      annotation_sha256: sha256(BL24_ANNOTATION),
      receipt: { state: row?.state, idempotent_replay: row?.idempotent_replay, audit_event_sha256: row?.audit_event_sha256, content_sha256: row?.content_sha256 },
      row_after: { resolution_state: decision?.resolution_state, resolved_branch: decision?.resolved_branch, synthetic: decision?.synthetic },
      row_unchanged: decision?.resolution_state === "open" && decision?.resolved_branch === null,
      grade_correction: { from: "administrative", to: "agreement_interpretation", targets: ["P-15", "P-16", "working_time_daily_threshold/administrative"] },
      sources: ["steering_committee_2018-04-24", "kolzchut"],
      directive_10_6_2018: "concerns the 182-hour divisor of the hourly minimum wage; not the source of 8.6 / 7.6",
      blocked_ledger: "BL-24 stays open with the corrected attribution; no official artifact carries the figures; no fetch",
    };
  } catch (error) {
    await ops.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await ops.end().catch(() => undefined);
  }
  writeFileSync(path.join(RECEIPT_ROOT, "bl24-attribution-annotation.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`L11_5_BL24 ${JSON.stringify({ state: (receipt.receipt as { state?: string }).state, replay: (receipt.receipt as { idempotent_replay?: boolean }).idempotent_replay, row_unchanged: receipt.row_unchanged })}`);
}

await main();
