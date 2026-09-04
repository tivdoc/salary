// Pool P batch 13 (L6-5 / D1, D7). The 2016 pension increase order, read from
// the page image, and the 2011/2016 precedence made executable.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/pool-p-batch-13-pension-visual.mts
//
// IL_GENERAL_PENSION_INCREASE_EXTENSION_ORDER_2016 is a three-page scan with
// no usable text layer (document_sanity_minimum_content_failed). Page 2, §3,
// states the rates in typeset figures that the image shows plainly:
//
//   1. employee contribution:  from 1.7.16 5.75%, from 1.1.17 6%
//   2. employer contribution:  from 1.7.16 6.25%, from 1.1.17 6.5%
//   3. employer severance:     not less than 6%
//
// The 1.1.2017 figures are P-21..P-23. Each is a visual citation with a
// page_bbox region (there is no stored line to point at), inferred_visual,
// awaiting visual_confirmed at attestation, with page 2 extracted and hashed.
// The interim 1.7.2016 figures are recorded in the receipt and not registered:
// the targets are the 2017 split, and a second version per rate would be a
// choice about periods this run does not need to make.
//
// D7. The 2011 order's last row (employer 6% / employee 5.5% / severance 6%
// at 1.1.2014, batch 8) and the 2016 order's 2017 row are the two branches of
// which instrument governs — an open decision, not a precedence anyone here
// decides. The 2017 rows register on branch order_2016_2017_rates; the 2014
// rows re-register as 2014.2.0 on branch order_2011_2014_row with the very
// citations batch 8 made (same table-aware chunk, same anchors, same figures),
// and 2014.1.0 is superseded naming its replacement — the same mechanism L4-1
// used when a citation moved. Nothing about any figure changes.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { buildCandidate, importPoolPBatch, TABLE_AWARE_CITATIONS, TENANT, VISUAL_CITATIONS, visualCitation, tableAwareCitation } from "./pool-p-parameter-import.mts";

const RECEIPT_ROOT = path.join("output", "next", "pool-p");
const ORDER_2016 = { source_id: "IL_GENERAL_PENSION_INCREASE_EXTENSION_ORDER_2016", source_version: "discovery-v0.2" };
const ORDER_2011 = { source_id: "IL_GENERAL_PENSION_EXTENSION_ORDER_2011", source_version: "discovery-v0" };
const TABLE_2011 = "IL_GENERAL_PENSION_EXTENSION_ORDER_2011@discovery-v0#t0007-b1a272cd922a";
const TABLE_2011_ANCHOR = "ישולמו מדי חודש בחודשו בהתאם לטבלה הזו";
// The 1.1.2014 row as the table-aware chunk carries it, batch 8's needle.
const ROW_2014 = "1.1.2014 %6 %5.5 %6 %17.5";
const DECISION = `${TENANT}.decision.pension_2011_2016_precedence`;
const SYSTEM_SESSION = { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import" };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

// Render pixels on page 2 (1656 × 2329 at the scan's own resolution), boxes
// drawn round the figure and the line it sits on, as read from the render.
const BOX_EMPLOYEE_2017 = { left: 640, top: 760, width: 560, height: 40 };
const BOX_EMPLOYER_2017 = { left: 640, top: 955, width: 560, height: 40 };
const BOX_SEVERANCE = { left: 600, top: 1540, width: 620, height: 45 };

const share = (parameterId: string, version: string, numerator: string, denominator: string, effectiveFrom: string, branch: string, citations: Awaited<ReturnType<typeof visualCitation>>[]) => buildCandidate({
  parameter_id: parameterId,
  parameter_version: version,
  topic: "pension",
  value: { kind: "rational", numerator, denominator, unit: "ratio" },
  unit: "ratio",
  rounding_policy: "exact",
  effective_from: effectiveFrom,
  effective_to: null,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["primary_binding"],
  citations,
  decision_id: DECISION,
  branch,
});

async function supersede2014(): Promise<Array<Record<string, unknown>>> {
  const env = readDevEnvFile();
  const operationsUrl = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!operationsUrl) throw new Error("L65_ENV_MISSING");
  const parsed = new URL(operationsUrl);
  const factory = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: operationsUrl, max_connections: 2, connection_timeout_ms: 20_000,
    application_name: "tivdoc_l65_batch13",
    remote_dev_target: { host: parsed.hostname, port: Number(parsed.port), database: parsed.pathname.replace(/^\//u, ""), project_ref: env.get("TIVDOC_DEV_PROJECT_REF") ?? "" },
  });
  const outcomes: Array<Record<string, unknown>> = [];
  const client = await factory.acquire();
  try {
    for (const parameterId of ["il.pension.employer_contribution_rate", "il.pension.employee_contribution_rate", "il.pension.severance_contribution_rate"]) {
      await client.query(statement("l65_begin", "begin", []));
      await client.query(statement("l65_context", "select * from private.runtime_context_install($1,$2,$3)", [SYSTEM_SESSION.sid, SYSTEM_SESSION.jti, `l65:${randomUUID().slice(0, 8)}`]));
      const current = await client.query(statement("l65_read", "select state, revision from private.governance_aggregate_read($1,$2,$3,$4)", [TENANT, "parameter_approval", parameterId, "2014.1.0"]));
      if (current.row_count !== 1) throw new Error(`L65_PARAMETER_MISSING:${parameterId}@2014.1.0`);
      const state = current.rows[0] as unknown as { state: string; revision: string };
      if (state.state === "superseded") {
        outcomes.push({ parameter_version_id: `${parameterId}@2014.1.0`, outcome: "already_superseded" });
        await client.query(statement("l65_rollback", "rollback", []));
        continue;
      }
      const reason = `Linked to the open decision ${DECISION} as branch order_2011_2014_row: replaced by ${parameterId}@2014.2.0, identical value, identical citations into ${TABLE_2011}, now carrying the decision id so the executor runs it as one branch beside the 2016 order's 2017 row. Nothing about the figure changed.`;
      await client.query(statement("l65_supersede",
        "select * from private.governance_parameter_supersede($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz)",
        [TENANT, parameterId, "2014.1.0", String(state.revision), `${parameterId}@2014.2.0`, reason, `l65.supersede.${parameterId}@2014.1.0`, sha256(`l65:supersede:${parameterId}@2014.1.0`), new Date().toISOString()]));
      await client.query(statement("l65_commit", "commit", []));
      outcomes.push({ parameter_version_id: `${parameterId}@2014.1.0`, outcome: "superseded", superseded_by: `${parameterId}@2014.2.0` });
    }
  } finally {
    client.release();
    await factory.shutdown?.();
  }
  return outcomes;
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const employee2017 = await visualCitation({
    kind: "page_bbox", source: ORDER_2016, page: 2, box_px: BOX_EMPLOYEE_2017, visual_reading: "6%",
    locator: "General pension increase extension order 2016 (registry 7008/2016), page 2 §3(1) ניכוי מהעובד לרכיב תגמולים: 'החל מיום 1.1.17 יוגדלו דמי הגמולים ל-6%'. Image-only scan; read from the page render.",
  });
  const employer2017 = await visualCitation({
    kind: "page_bbox", source: ORDER_2016, page: 2, box_px: BOX_EMPLOYER_2017, visual_reading: "6.5%",
    locator: "General pension increase extension order 2016, page 2 §3(2) תשלום המעסיק לרכיב תגמולים: 'החל מיום 1.1.17 יוגדלו דמי הגמולים ל-6.5%'. Image-only scan; read from the page render.",
  });
  const severance = await visualCitation({
    kind: "page_bbox", source: ORDER_2016, page: 2, box_px: BOX_SEVERANCE, visual_reading: "6%",
    locator: "General pension increase extension order 2016, page 2 §3(3) תשלום המעסיק לרכיב פיצויי פיטורים: 'בכל מקרה לא יפחת מ-6% מהשכר הקובע'. Image-only scan; read from the page render. Effective from the order's commencement, 1.7.2016 or publication, whichever is later; 2016-07-01 is the earlier bound the order itself names.",
  });
  // The 2014 rows again, as batch 8 cited them, now on the decision.
  const table2011 = (needle: string, clause: string) => tableAwareCitation(ORDER_2011, TABLE_2011,
    `General pension extension order 2011, contribution table (table-aware chunk), row 1.1.2014: ${clause}. Re-cited from batch 8 unchanged, on the open decision ${DECISION}.`,
    [needle], TABLE_2011_ANCHOR);
  const candidates = [
    share("il.pension.employee_contribution_rate", "2017.1.0", "3", "50", "2017-01-01", "order_2016_2017_rates", [employee2017]),
    share("il.pension.employer_contribution_rate", "2017.1.0", "13", "200", "2017-01-01", "order_2016_2017_rates", [employer2017]),
    share("il.pension.severance_contribution_rate", "2017.1.0", "3", "50", "2016-07-01", "order_2016_2017_rates", [severance]),
    share("il.pension.employer_contribution_rate", "2014.2.0", "3", "50", "2014-01-01", "order_2011_2014_row", [table2011(ROW_2014, "employer contribution 6% (second column, column reading proven by the row sum in batch 8)")]),
    share("il.pension.employee_contribution_rate", "2014.2.0", "11", "200", "2014-01-01", "order_2011_2014_row", [table2011(ROW_2014, "employee contribution 5.5% (third column)")]),
    share("il.pension.severance_contribution_rate", "2014.2.0", "3", "50", "2014-01-01", "order_2011_2014_row", [table2011(ROW_2014, "severance contribution 6% (fourth column)")]),
  ];
  await importPoolPBatch("batch-13-pension-visual", candidates, [{
    decision_id: DECISION,
    topic: "pension",
    question: "Which instrument governs the mandatory contribution shares today: the 2011 general pension extension order, whose escalation table ends at the 1.1.2014 row (employer 6%, employee 5.5%, severance 6%), or the 2016 increase order, which raises them from 1.1.2017 (employer 6.5%, employee 6%, severance not less than 6%)? Branch order_2011_2014_row reads the 2011 order as still governing; branch order_2016_2017_rates reads the 2016 order as superseding it. The 2016 figures are visual citations of an image-only scan and await visual confirmation.",
    dossier_anchor: "General pension extension order 2011 contribution table (1.1.2014 row) and general pension increase extension order 2016 page 2 §3",
  }]);
  const superseded = await supersede2014();
  const receipt = {
    schema_version: "tivdoc-pool-p-batch-13-v1",
    unit: "L6-5 / D1, D7",
    tenant: TENANT,
    registered: candidates.map((entry) => `${entry.parameter_id}@${entry.parameter_version}`),
    provenance: Object.fromEntries(candidates.map((entry) => [`${entry.parameter_id}@${entry.parameter_version}`, (entry as { provenance_grade?: string }).provenance_grade ?? "text_verified"])),
    open_decisions: [DECISION],
    superseded,
    visual_citations: VISUAL_CITATIONS,
    citations: TABLE_AWARE_CITATIONS,
    not_registered: [
      { figure: "employee 5.75% / employer 6.25% from 1.7.2016", reason: "interim_row_not_targeted", detail: "Page 2 §3 states the 1.7.2016 interim figures beside the 1.1.2017 ones; P-21..P-23 are the 2017 split. Readable in the same render; not registered this run." },
    ],
    image_only: { source_version_id: `${ORDER_2016.source_id}@${ORDER_2016.source_version}`, safe_error_code: "document_sanity_minimum_content_failed", note: "No text layer, no chunks, no anchor: every citation is a page_bbox visual citation and says anchor_absent: no_text_layer." },
  };
  writeFileSync(path.join(RECEIPT_ROOT, "batch-13-pension-visual.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`L6_5_BATCH13 ${JSON.stringify({ registered: candidates.length, decisions: 1, superseded: superseded.length, visual_citations: VISUAL_CITATIONS.length })}`);
}

await main();
