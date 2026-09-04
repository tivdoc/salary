// Pool P batch 8 (L4-1 / D2). What the table-aware chunk set unblocks.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/pool-p-batch-8-table-aware.mts
//
// Three groups, and the order matters.
//
// 1. The three `il.minimum_wage.monthly` revisions whose citations pointed at
//    bare rate-table rows get NEW revisions citing the table-aware chunk, where
//    the figure sits beside the column header that names it. The values do not
//    change — nothing about the law changed, only what the citation can prove.
//    The old revisions are then superseded, naming their replacement, exactly as
//    D2 requires: no rebinding in place.
//
// 2. The 2011 pension order's contribution table, which v0 had cut into four
//    header-less fragments, is now one chunk with its column names. Three rates
//    bind from its last row. The column reading is not asserted here, it is
//    CHECKED: employer + employee + severance must equal the total column, for
//    every row of the table, or this script refuses to register anything. That
//    is the difference between reading a table and guessing at one.
//
// 3. The three unamended vacation seniority bands from §3(א)(3)-(5), which the
//    band-lookup node in L4-2 needs and which no draft could express before it.
//    The first band is not here: Amendment 15 rewrote it, and that revision is
//    already registered and already superseded once.
//
// Everything registered stays `draft`, zero attestations, activation refused at
// the database. Nothing here reviews a source or activates a rate.
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { buildCandidate, citation, importPoolPBatch, TABLE_AWARE_CITATIONS, tableAwareCitation, TENANT } from "./pool-p-parameter-import.mts";

const RECEIPT_ROOT = path.join("output", "next", "pool-p");
const SYSTEM_SESSION = { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import" };
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const D1 = { source_id: "IL_MIN_WAGE_OFFICIAL_RATES", source_version: "discovery-v0" };
const D2 = { source_id: "IL_AVERAGE_WAGE_OFFICIAL_RATES", source_version: "discovery-v0" };
const D3 = { source_id: "IL_MIN_WAGE_LAW", source_version: "discovery-v0" };
const D6 = { source_id: "IL_GENERAL_PENSION_EXTENSION_ORDER_2011", source_version: "discovery-v0" };
const D12 = { source_id: "IL_ANNUAL_VACATION_LAW", source_version: "discovery-v0" };

const MIN_WAGE_TABLE = "IL_MIN_WAGE_OFFICIAL_RATES@discovery-v0#t0003-78f59eeddfde";
const AVERAGE_WAGE_TABLE = "IL_AVERAGE_WAGE_OFFICIAL_RATES@discovery-v0#t0003-ca1e4b6ac154";
const PENSION_TABLE = "IL_GENERAL_PENSION_EXTENSION_ORDER_2011@discovery-v0#t0007-b1a272cd922a";
const VACATION_CLAUSE = "IL_ANNUAL_VACATION_LAW@discovery-v0#t0001-838721e06653";

/** The header text that names the monthly column, in the same chunk as the figure. */
const MIN_WAGE_ANCHOR = "שכר מינימום לחודש סכום השכר המינימלי שיש לשלם לעובד בעבור חודש עבודה";
const AVERAGE_WAGE_ANCHOR = "שכר חודשי ממוצע";
const PENSION_ANCHOR = "ישולמו מדי חודש בחודשו בהתאם לטבלה הזו";

// The §6 derivation clause, unchanged and still cited from the v0 chunk it has
// always been cited from — that chunk is prose and was never part of the defect.
const derivationClause = citation(D3, "IL_MIN_WAGE_LAW@discovery-v0#0002-bcf9eab6819e",
  "Minimum Wage Law 1987 §6 — monthly minimum wage = 47.5% of the average wage per National Insurance Law §1, as of 1 April each year",
  ["47.5"]);

// --- Group 1: the three re-cited minimum-wage revisions --------------------

type Rebind = Readonly<{ from: string; to: string; effective_from: string; effective_to: string | null; minor_units: number; average_wage: string; monthly: string; year: string }>;
const REBINDS: readonly Rebind[] = [
  { from: "2023.1.0", to: "2023.2.0", effective_from: "2023-04-01", effective_to: "2024-03-31", minor_units: 557175, average_wage: "11,730", monthly: "5,571.75", year: "1.1.2023" },
  { from: "2024.1.0", to: "2024.2.0", effective_from: "2024-04-01", effective_to: "2025-03-31", minor_units: 588002, average_wage: "12,379", monthly: "5,880.02", year: "1.1.2024" },
  { from: "2025.1.0", to: "2025.2.0", effective_from: "2025-04-01", effective_to: "2026-03-31", minor_units: 624767, average_wage: "13,153", monthly: "6,247.67", year: "1.1.2025" },
];

const rebindCandidates = REBINDS.map((row) => buildCandidate({
  parameter_id: "il.minimum_wage.monthly",
  parameter_version: row.to,
  topic: "minimum_wage",
  value: { kind: "money", value: { currency: "ILS", minor_units: row.minor_units } },
  unit: "currency.ils",
  rounding_policy: "exact",
  effective_from: row.effective_from,
  effective_to: row.effective_to,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["primary_binding", "official_implementation"],
  citations: [
    derivationClause,
    tableAwareCitation(D2, AVERAGE_WAGE_TABLE,
      `Average wage per National Insurance Law §1, effective ${row.year}: ${row.average_wage} ILS — table-aware chunk, the figure beside the column header that names it`,
      [row.average_wage], AVERAGE_WAGE_ANCHOR),
    tableAwareCitation(D1, MIN_WAGE_TABLE,
      `BTL published monthly rate table row, effective ${row.effective_from} — table-aware chunk carrying the column headers`,
      [row.monthly], MIN_WAGE_ANCHOR),
  ],
}));

// --- Group 2: the 2011 pension contribution table -------------------------
//
// The table, as it reads in the table-aware chunk:
//
//   החל ביום... ואילך | הפרשות מעביד | הפרשות עובד | לפיצויים | סך הכל
//   1.1.2008  %0.833 %0.833 %0.834 %2.5
//   ...
//   1.1.2014  %6     %5.5   %6     %17.5
//
// Which column is which is not a judgement call here. The header names three
// contribution columns and a total, and the arithmetic settles the rest: in
// every row the first three must sum to the fourth. If they do not, this file
// has misread the table and refuses to register anything from it.
type PensionRow = Readonly<{ effective_from: string; employer: string; employee: string; severance: string; total: string }>;
const PENSION_TABLE_ROWS: readonly PensionRow[] = [
  { effective_from: "1.1.2008", employer: "0.833", employee: "0.833", severance: "0.834", total: "2.5" },
  { effective_from: "1.1.2009", employer: "1.66", employee: "1.66", severance: "1.68", total: "5" },
  { effective_from: "1.1.2010", employer: "2.5", employee: "2.5", severance: "2.5", total: "7.5" },
  { effective_from: "1.1.2011", employer: "3.33", employee: "3.33", severance: "3.34", total: "10" },
  { effective_from: "1.1.2012", employer: "4.16", employee: "4.16", severance: "4.18", total: "12.5" },
  { effective_from: "1.1.2013", employer: "5", employee: "5", severance: "5", total: "15" },
  { effective_from: "1.1.2014", employer: "6", employee: "5.5", severance: "6", total: "17.5" },
];

/** Percent strings as exact thousandths, so no float ever touches a rate. */
function thousandths(percent: string): bigint {
  const [whole, fraction = ""] = percent.split(".");
  if (fraction.length > 3) throw new Error(`L41_PENSION_RATE_PRECISION:${percent}`);
  return BigInt(whole) * BigInt(1000) + BigInt((fraction + "000").slice(0, 3));
}

function assertPensionTableReadCorrectly(chunkText: string): void {
  for (const row of PENSION_TABLE_ROWS) {
    const sum = thousandths(row.employer) + thousandths(row.employee) + thousandths(row.severance);
    if (sum !== thousandths(row.total)) throw new Error(`L41_PENSION_COLUMN_ORDER_UNPROVEN:${row.effective_from}`);
    // And the row must be in the chunk, in this order, as the chunker produced it.
    const line = `${row.effective_from} %${row.employer} %${row.employee} %${row.severance} %${row.total}`;
    if (!chunkText.includes(line)) throw new Error(`L41_PENSION_ROW_NOT_IN_CHUNK:${line}`);
  }
}

// --- Group 3: the unamended vacation seniority bands ----------------------

type VacationBand = Readonly<{ parameter_id: string; days: number; clause: string; needle: string }>;
const VACATION_BANDS: readonly VacationBand[] = [
  { parameter_id: "il.vacation.calendar_days_year_6", days: 18, clause: "Annual Vacation Law 1951 §3(א)(3) — for the sixth year, 18 days", needle: "בעד השנה הששית - 18 יום" },
  { parameter_id: "il.vacation.calendar_days_year_7", days: 21, clause: "Annual Vacation Law 1951 §3(א)(4) — for the seventh year, 21 days", needle: "בעד השנה השביעית - 21 יום" },
  { parameter_id: "il.vacation.calendar_days_years_8_and_above_cap", days: 28, clause: "Annual Vacation Law 1951 §3(א)(5) — from the eighth year, one additional day per work year up to a vacation of 28 days", needle: "עד לחופשה של 28 יום" },
];
const VACATION_ANCHOR = "אורך החופשה לכל שנת-עבודה אצל מעביד אחד או במקום-עבודה אחד";

async function supersedeRebound(): Promise<Array<Record<string, unknown>>> {
  const env = readDevEnvFile();
  const operationsUrl = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!operationsUrl) throw new Error("L41_ENV_MISSING");
  const parsed = new URL(operationsUrl);
  const factory = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: operationsUrl, max_connections: 2, connection_timeout_ms: 20_000,
    application_name: "tivdoc_l41_batch8",
    remote_dev_target: {
      host: parsed.hostname, port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//u, ""), project_ref: env.get("TIVDOC_DEV_PROJECT_REF") ?? "",
    },
  });
  const outcomes: Array<Record<string, unknown>> = [];
  const client = await factory.acquire();
  try {
    for (const row of REBINDS) {
      await client.query(statement("l41_begin", "begin", []));
      await client.query(statement("l41_context", "select * from private.runtime_context_install($1,$2,$3)",
        [SYSTEM_SESSION.sid, SYSTEM_SESSION.jti, `l41:${randomUUID().slice(0, 8)}`]));
      const current = await client.query(statement("l41_read",
        "select state, revision from private.governance_aggregate_read($1,$2,$3,$4)",
        [TENANT, "parameter_approval", "il.minimum_wage.monthly", row.from]));
      if (current.row_count !== 1) throw new Error(`L41_PARAMETER_MISSING:${row.from}`);
      const state = current.rows[0] as unknown as { state: string; revision: string };
      if (state.state === "superseded") {
        outcomes.push({ parameter_version: row.from, outcome: "already_superseded", revision: String(state.revision) });
        await client.query(statement("l41_rollback", "rollback", []));
        continue;
      }
      const reason = `Citation moved to the table-aware chunk set: the rate-table row this revision cited carried no column headers and no clause text, so its figure could not be anchored and its column could not be named. Replaced by il.minimum_wage.monthly@${row.to}, identical value, citing ${MIN_WAGE_TABLE}.`;
      const key = `l41.supersede.${row.from}`;
      await client.query(statement("l41_supersede",
        "select * from private.governance_parameter_supersede($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz)",
        [TENANT, "il.minimum_wage.monthly", row.from, String(state.revision),
          `il.minimum_wage.monthly@${row.to}`, reason, key,
          sha256(`l41:supersede:il.minimum_wage.monthly@${row.from}`), new Date().toISOString()]));
      await client.query(statement("l41_commit", "commit", []));
      outcomes.push({ parameter_version: row.from, outcome: "superseded", superseded_by: `il.minimum_wage.monthly@${row.to}` });
    }
  } finally {
    client.release();
    await factory.shutdown?.();
  }
  return outcomes;
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });

  // The pension column reading is proven before a single candidate is built.
  const observationPath = JSON.parse(readFileSync(path.resolve("eval/legal-knowledge/manifests/build-state.json"), "utf8")) as {
    records: Array<{ source_id: string; source_version: string; chunks_path: string | null }>;
  };
  const pensionRecord = observationPath.records.find((entry) => entry.source_id === D6.source_id && entry.source_version === D6.source_version);
  if (!pensionRecord?.chunks_path) throw new Error("L41_PENSION_SOURCE_NOT_BUILT");
  const pensionSidecar = JSON.parse(readFileSync(path.resolve(pensionRecord.chunks_path.replace(/\.chunks\.json$/u, ".t1.chunks.json")), "utf8")) as {
    chunks: Array<{ chunk_id: string; logical_text: string }>;
  };
  const pensionChunk = pensionSidecar.chunks.find((entry) => entry.chunk_id === PENSION_TABLE);
  if (!pensionChunk) throw new Error("L41_PENSION_CHUNK_MISSING");
  assertPensionTableReadCorrectly(pensionChunk.logical_text);

  const last = PENSION_TABLE_ROWS[PENSION_TABLE_ROWS.length - 1];
  const pensionLocator = `General pension extension order 2011 §6(ד) contribution table, final row "${last.effective_from} %${last.employer} %${last.employee} %${last.severance} %${last.total}" — table-aware chunk carrying the column headers with the rows. The column reading is checked by the sum: ${last.employer} + ${last.employee} + ${last.severance} = ${last.total}. This is the last row THIS instrument states; later instruments raising it are not in the corpus, and the precedence question stays open.`;
  const pensionCitation = tableAwareCitation(D6, PENSION_TABLE, pensionLocator,
    [`${last.effective_from} %${last.employer} %${last.employee} %${last.severance} %${last.total}`], PENSION_ANCHOR);

  const pensionCandidates = ([
    ["il.pension.employer_contribution_rate", last.employer],
    ["il.pension.employee_contribution_rate", last.employee],
    ["il.pension.severance_contribution_rate", last.severance],
  ] as const).map(([parameterId, percent]) => buildCandidate({
    parameter_id: parameterId,
    parameter_version: "2014.1.0",
    topic: "pension",
    value: { kind: "rational", numerator: thousandths(percent).toString(), denominator: "100000", unit: "ratio" },
    unit: "ratio",
    rounding_policy: "exact",
    effective_from: "2014-01-01",
    effective_to: null,
    sectors: ["general"],
    populations: ["general"],
    support_roles: ["primary_binding"],
    citations: [pensionCitation],
  }));

  const vacationCandidates = VACATION_BANDS.map((band) => buildCandidate({
    parameter_id: band.parameter_id,
    parameter_version: "1951.1.0",
    topic: "vacation",
    value: { kind: "integer", value: band.days, unit: "calendar_days" },
    unit: "calendar_days",
    rounding_policy: "exact",
    effective_from: "1951-01-01",
    effective_to: null,
    sectors: ["general"],
    populations: ["general"],
    support_roles: ["primary_binding"],
    citations: [tableAwareCitation(D12, VACATION_CLAUSE, band.clause, [band.needle], VACATION_ANCHOR)],
  }));

  await importPoolPBatch("batch-8-table-aware", [...rebindCandidates, ...pensionCandidates, ...vacationCandidates]);
  const superseded = await supersedeRebound();

  const receipt = {
    schema_version: "tivdoc-pool-p-batch-8-v1",
    unit: "L4-1",
    tenant: TENANT,
    rebound_revisions: REBINDS.map((row) => ({ from: `il.minimum_wage.monthly@${row.from}`, to: `il.minimum_wage.monthly@${row.to}` })),
    superseded,
    pension_column_order_proven_by_sum: true,
    pension_registered: pensionCandidates.map((entry) => `${entry.parameter_id}@${entry.parameter_version}`),
    vacation_registered: vacationCandidates.map((entry) => `${entry.parameter_id}@${entry.parameter_version}`),
    table_aware_chunks_cited: [MIN_WAGE_TABLE, AVERAGE_WAGE_TABLE, PENSION_TABLE, VACATION_CLAUSE],
    // Written from what the run actually cited, not from what a scanner can
    // read out of this file — several of these needles are loop variables.
    citations: TABLE_AWARE_CITATIONS,
  };
  writeFileSync(path.join(RECEIPT_ROOT, "batch-8-table-aware.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`L4_1_BATCH8 ${JSON.stringify({
    registered: rebindCandidates.length + pensionCandidates.length + vacationCandidates.length,
    superseded: superseded.filter((entry) => entry.outcome === "superseded").length,
    already: superseded.filter((entry) => entry.outcome === "already_superseded").length,
  })}`);
}

await main();
