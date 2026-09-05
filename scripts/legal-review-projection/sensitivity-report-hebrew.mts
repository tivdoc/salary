// L4-8. The sensitivity report in Hebrew, for the lawyer who has to read it.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/sensitivity-report-hebrew.mts
//
// Generated from `decision-sensitivity-report-v5.json` and from nothing else.
// (L5-10: re-pointed from v3 to v4. L6-8 / D5: re-pointed to v5, and the
// provenance grade of every bound parameter is shown — in the decision tables
// and in a section of its own — with one sentence saying what inferred_visual
// means: the figure was read from the page image and awaits visual
// confirmation. A reader sees the grade before the number.)
// Every number in it comes out of that file; no figure is retyped, no figure is
// rounded here, and nothing is added that the JSON does not say.
//
// What this document is NOT: it does not answer either open question, it does
// not recommend an answer, and it does not weigh one branch against the other.
// It states, for each scenario, what each branch computes and what the
// difference between them is — which is exactly the scope note the JSON carries
// and the only thing a differences report is entitled to say.
//
// Two renderings of the same content, both hashed: Markdown for reading and
// commenting, and a PDF through the same deterministic RTL machinery the case
// report uses — the same pinned font, the same glyph subset, the same
// byte serialiser — so the document a lawyer is handed can be checked against
// its hash rather than trusted.
import "../production-refusal.mjs";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderDeterministicRtlDocument, type RtlBlock } from "../../src/server/reports/deterministic-hebrew-pdf.ts";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { TENANT } from "./pool-p-parameter-import.mts";

const REPORT = path.join("output", "next", "pool-q", "decision-sensitivity-report-v6.json");
const DOCS_ROOT = path.join("docs", "legal");
const RECEIPT_ROOT = path.join("output", "next", "pool-q");
const MARKDOWN = path.join(DOCS_ROOT, "sensitivity-report.he.md");
const PDF = path.join(RECEIPT_ROOT, "sensitivity-report.he.pdf");
const SYSTEM_SESSION = { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import" };

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

const TOPIC_HEBREW: Readonly<Record<string, string>> = Object.freeze({
  minimum_wage: "שכר מינימום", working_time: "שעות עבודה ומנוחה", pension: "פנסיה",
  travel: "נסיעות", convalescence: "דמי הבראה", vacation: "חופשה שנתית", sick_leave: "דמי מחלה",
});
const NOT_RUN_HEBREW: Readonly<Record<string, string>> = Object.freeze({
  slot_unbound: "משבצת פרמטר לא קשורה",
  slot_unbound_corpus_defect: "משבצת פרמטר לא קשורה — המספר אינו קיים בקורפוס",
  slot_unbound_source_quarantined: "משבצת פרמטר לא קשורה — המקור בהסגר עד להכרעת אדם",
  no_definitional_computation_available: "אין חישוב הגדרתי זמין",
});
const SCENARIO_HEBREW: Readonly<Record<string, string>> = Object.freeze({
  current: "מצב רגיל",
  effective_date_boundary: "גבול תחולה",
  sector_population: "ענף ואוכלוסייה",
  missing_conflicted_facts: "עובדה חסרה או סותרת",
  precedence_overlap: "חפיפת מקורות",
  parameter_rounding_boundary: "גבול עיגול או גבול הטבלה",
});

type PerScenario = Readonly<{
  scenario: string; ran: boolean; differs: boolean; comparable?: boolean;
  by_branch?: readonly Readonly<{ branch: string; output: string }>[];
  difference?: string; reason?: string;
}>;
type OpenDecision = Readonly<{
  provenance_grade?: string;
  unbound_branches?: ReadonlyArray<Readonly<{ branch: string; reason: string }>>;
  decision_id: string; topic: string; rule_spec_id: string; branches: readonly string[];
  narrower_than_draft: string | null; scenarios_run: number; scenarios_differing: number;
  per_scenario: readonly PerScenario[];
}>;
type TopicNotRun = Readonly<{ topic: string; not_run: string; slots: readonly string[]; detail: string }>;
type Report = Readonly<{
  report_sha256: string; scope_note: string; tenant_id: string;
  scenarios_attempted: number; scenarios_run: number; scenarios_refused: number;
  traces_included: number; traces_replayed_from_database: number;
  topics_run: readonly string[]; topics_run_count: number; topics_total: number;
  topics_not_run: readonly TopicNotRun[]; open_decisions: readonly OpenDecision[];
  provenance: Readonly<{
    grades: readonly string[]; counts: Readonly<Record<string, number>>;
    bound_parameter_versions: ReadonlyArray<Readonly<{ parameter_version_id: string; provenance_grade: string; visual_bindings: ReadonlyArray<Readonly<{ page_pdf_sha256: string; visual_reading: string }>> }>>;
  }>;
  executions: readonly Readonly<{ topic: string; scenario: string; branch: string; ran: boolean; output: string | null; refusal: string | null }>[];
  // L7-10: the offline shadow beside the sensitivity — counts and hashes, no content.
  shadow: Readonly<{
    run_id: string; receipt_sha256: string; execution_mode: string; envelope_sha256: string; corpus_sha256: string;
    draft_input_pin: Readonly<{ draft_parameter_versions: number; synthetic_inputs: number; active_real_parameter_count: number; extraction_used: boolean; tenant_id: string }>;
    counts: Readonly<Record<string, number>>; refusals_by_reason: Readonly<Record<string, number>>; grades: Readonly<Record<string, number>>;
    traces_included: number; traces_replayed_from_database: number;
    decisions: ReadonlyArray<Readonly<{ decision_id: string; branches: readonly string[]; unbound_branches: ReadonlyArray<Readonly<{ branch: string; reason: string }>>; cases_compared: number; cases_differing: number; cases_not_comparable: number }>>;
  }>;
}>;

const EXECUTION_GRADE_HEBREW: Readonly<Record<string, string>> = Object.freeze({
  verified: "מאומת — עובדות מתועדות ופרמטרים מאומתים בטקסט",
  lexicon: "פרמטר שנקרא דרך הלקסיקון",
  declared: "עובדה מוצהרת, או פרמטר בתוך בחירת מסמך",
  derived: "עובדה נגזרת מעובדות אחרות",
  inferred: "עובדה שהפיק סוכן, או פרמטר שנקרא מתמונת העמוד",
  administrative: "פרמטר ממקור מנהלי",
});
const executionGradeLabel = (grade: string) => EXECUTION_GRADE_HEBREW[grade] ?? grade;
const REFUSAL_HEBREW: Readonly<Record<string, string>> = Object.freeze({
  "preparation:fact.missing": "עובדה חסרה",
  "preparation:fact.conflicted": "עובדה סותרת — לא הוכרעה",
  "preparation:fact.unconfirmed": "עובדה שלא אושרה",
  "preparation:fact.rejected": "עובדה שנדחתה",
  "preparation:fact.stale": "עובדה ישנה מדי",
  "preparation:fact.timestamp_after_preparation": "עובדה מאוחרת להכנה",
  "preparation:fact.below_confidence_threshold": "ביטחון נמוך מהסף",
  "preparation:transformation.unsupported": "טרנספורמציה לא נתמכת",
  "preparation:transformation.failed": "העובדה אינה בצורה שהמשבצת צורכת",
  "executor:RULESPEC_BAND_LOOKUP_INPUT_OUT_OF_RANGE": "מחוץ לטבלת המדרגות (שנה אפס / יום ראשון)",
});
const refusalLabel = (reason: string) => REFUSAL_HEBREW[reason] ?? reason;

const GRADE_HEBREW: Readonly<Record<string, string>> = Object.freeze({
  text_verified: "אומת בטקסט",
  lexicon: "מילה שנקראה דרך הלקסיקון",
  selection: "בתוך בחירת מסמך",
  inferred_visual: "נקרא מתמונת העמוד — ממתין לאימות חזותי",
  administrative: "מקור מנהלי",
});
const INFERRED_VISUAL_SENTENCE = "inferred_visual: המספר נקרא מתמונת העמוד הסרוק, משום ששכבת הטקסט של המסמך מעורפלת או חסרה; הוא ממתין לאימות חזותי של אדם מול אותו עמוד, ולא ניתן לאשרו בלי אימות כזה.";
const gradeLabel = (grade: string) => GRADE_HEBREW[grade] ?? grade;
const scenarioLabel = (name: string) => SCENARIO_HEBREW[name] ?? name;
const topicLabel = (name: string) => TOPIC_HEBREW[name] ?? name;

/**
 * A cell value, safe to put in a Markdown table.
 *
 * A pipe in a `detail` string would split the row and shift every column to its
 * right — in a document whose whole claim is that no figure was retyped or
 * moved. A newline would break the table outright. Neither is in the data
 * today; both are one edit away.
 */
const cell = (value: string) => value.replaceAll("|", "\\|").replaceAll(/\s*\n\s*/gu, " ");

/** Withdrawn decisions, listed separately because they are no longer questions. */
async function withdrawnDecisions(): Promise<Array<Record<string, string>>> {
  const env = readDevEnvFile();
  const url = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!url) throw new Error("L48_ENV_MISSING");
  const parsed = new URL(url);
  const factory = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: url, max_connections: 2, connection_timeout_ms: 20_000,
    application_name: "tivdoc_l48_hebrew_report",
    remote_dev_target: {
      host: parsed.hostname, port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//u, ""), project_ref: env.get("TIVDOC_DEV_PROJECT_REF") ?? "",
    },
  });
  const client = await factory.acquire();
  try {
    await client.query(statement("l48_begin", "begin", []));
    await client.query(statement("l48_context", "select * from private.runtime_context_install($1,$2,$3)",
      [SYSTEM_SESSION.sid, SYSTEM_SESSION.jti, `l48:${randomUUID().slice(0, 8)}`]));
    const rows = await client.query(statement("l48_decisions",
      "select * from private.legal_open_decision_read($1)", [TENANT]));
    await client.query(statement("l48_rollback", "rollback", []));
    // `synthetic` is the column E3-3 added: the proof fixtures carry it and the
    // real records do not. Listing seven throwaway "is this decision real?"
    // fixtures beside one real withdrawal is exactly the confusion that column
    // exists to end.
    return (rows.rows as unknown as Array<Record<string, unknown>>)
      .filter((row) => row.resolution_state === "withdrawn" && row.synthetic !== true)
      .map((row) => ({
        decision_id: String(row.decision_id),
        topic: String(row.topic),
        withdrawn_reason: String(row.withdrawn_reason ?? "—"),
      }))
      .sort((left, right) => left.decision_id.localeCompare(right.decision_id));
  } finally {
    client.release();
    await factory.shutdown?.();
  }
}

function markdown(report: Report, withdrawn: ReadonlyArray<Record<string, string>>): string {
  const out: string[] = [];
  out.push("# דוח רגישות — מה כל תשובה משנה");
  out.push("");
  out.push("מסמך זה **אינו מכריע** באף שאלה משפטית ואינו ממליץ על תשובה. הוא מציג, לכל");
  out.push("תרחיש, מה כל אחת מהאפשרויות מחשבת ומה ההפרש ביניהן. שום מספר כאן לא הוקלד");
  out.push("מחדש: כולם נלקחים מקובץ ה־JSON שממנו נוצר המסמך.");
  out.push("");
  out.push(`המסמך נוצר אוטומטית מ־\`decision-sensitivity-report-v6.json\` (\`${report.report_sha256.slice(0, 16)}…\`).`);
  out.push("כל הנתונים הם סביבת DEV. אין כאן נתוני לקוחות, אין מקור מאושר ואין פרמטר פעיל.");
  out.push("");
  out.push("הערות ההנדסה מצוטטות באנגלית כלשונן, בדיוק כפי שהן מופיעות בקובץ המקור.");
  out.push("תרגומן כאן היה כתיבה מחדש של תוכן, ולא העתקה שלו.");
  out.push("");
  out.push("---");
  out.push("");
  out.push("## 1. מה נבדק");
  out.push("");
  out.push("| מדד | ערך |");
  out.push("|---|---|");
  out.push(`| תרחישים שנוסו | ${report.scenarios_attempted} |`);
  out.push(`| תרחישים שרצו | ${report.scenarios_run} |`);
  out.push(`| תרחישים שסורבו סירוב סגור | ${report.scenarios_refused} |`);
  out.push(`| עקבות חישוב שנשמרו | ${report.traces_included} |`);
  out.push(`| עקבות ששוחזרו מהמסד בית־בבית | ${report.traces_replayed_from_database} |`);
  out.push(`| נושאים שרצו | ${report.topics_run_count} מתוך ${report.topics_total} |`);
  out.push("");
  out.push("---");
  out.push("");

  let section = 2;
  for (const decision of report.open_decisions) {
    out.push(`## ${section}. ${topicLabel(decision.topic)} — \`${decision.decision_id}\``);
    out.push("");
    out.push(`השאלה הפתוחה מפרידה בין ${decision.branches.map((branch) => `**${branch}**`).join(" לבין ")}.`);
    for (const unbound of decision.unbound_branches ?? []) {
      out.push("");
      out.push(`ענף שלא נקשר ולא רץ: **${unbound.branch}** — ${cell(unbound.reason)}`);
    }
    out.push(`מתוך ${decision.per_scenario.length} תרחישים רצו ${decision.scenarios_run}, ומהם ${decision.scenarios_differing} מפרידים בין האפשרויות.`);
    if (decision.provenance_grade) {
      out.push("");
      out.push(`דירוג מקור של הפרמטרים בשאלה זו: **${gradeLabel(decision.provenance_grade)}** (\`${decision.provenance_grade}\`).`);
      if (decision.provenance_grade === "inferred_visual") out.push(INFERRED_VISUAL_SENTENCE);
    }
    if (decision.narrower_than_draft) {
      out.push("");
      out.push(`הערת היקף: ${decision.narrower_than_draft}`);
    }
    out.push("");
    out.push(`| תרחיש | ${decision.branches.join(" | ")} | הפרש |`);
    out.push(`|---|${decision.branches.map(() => "---|").join("")}---|`);
    for (const row of decision.per_scenario) {
      if (!row.ran) {
        out.push(`| ${cell(scenarioLabel(row.scenario))} | ${decision.branches.map(() => "לא רץ").join(" | ")} | ${cell(row.reason ?? "לא רץ")} |`);
        continue;
      }
      const byBranch = decision.branches.map((branch) =>
        row.by_branch?.find((entry) => entry.branch === branch)?.output ?? "—");
      out.push(`| ${cell(scenarioLabel(row.scenario))} | ${byBranch.map(cell).join(" | ")} | ${cell(row.difference ?? "לא ניתן להשוואה")} |`);
    }
    out.push("");
    out.push("---");
    out.push("");
    section += 1;
  }

  out.push(`## ${section}. הצל הלא־מקוון — טיוטות על עובדות סינתטיות`);
  out.push("");
  out.push("ריצת הצל מריצה את הטיוטות על ערכי פרמטרים בטיוטה ועל עובדות סינתטיות שהוצהרו לפי תבנית,");
  out.push("דרך מודל העובדות הקנוני ורשמי המיפוי, בתוך המתזמן הלא־מקוון. שום פלט כאן אינו ממצא:");
  out.push("כל תוצאה היא הפרש־צל סינתטי או סירוב; דבר אינו מופעל ודבר אינו נמסר. לא הופעל חילוץ.");
  out.push("");
  out.push("| מדד | ערך |");
  out.push("|---|---|");
  out.push(`| ריצה | \`${report.shadow.run_id}\` |`);
  out.push(`| מצב ריצה | \`${report.shadow.execution_mode}\` |`);
  out.push(`| גרסאות פרמטר בטיוטה שנקשרו | ${report.shadow.draft_input_pin.draft_parameter_versions} |`);
  out.push(`| פרמטרים פעילים | ${report.shadow.draft_input_pin.active_real_parameter_count} |`);
  out.push(`| חודשי תלוש סינתטיים | ${report.shadow.counts.cases} |`);
  out.push(`| הרצות (מקרה × מפרט × ענף) | ${report.shadow.counts.executions} |`);
  out.push(`| רצו | ${report.shadow.counts.ran} |`);
  out.push(`| סורבו בהכנת הקלט | ${report.shadow.counts.preparation_refused} |`);
  out.push(`| סורבו במנוע | ${report.shadow.counts.executor_refused} |`);
  out.push(`| הפרשי־צל שחושבו | ${report.shadow.counts.deltas_computed} |`);
  out.push(`| ללא רכיב תשלום להשוואה | ${report.shadow.counts.deltas_not_applicable} |`);
  out.push(`| עקבות שנשמרו / שוחזרו מהמסד | ${report.shadow.traces_included} / ${report.shadow.traces_replayed_from_database} |`);
  out.push(`| חילוץ בשימוש | ${report.shadow.draft_input_pin.extraction_used ? "כן" : "לא"} |`);
  out.push(`| קורפוס (sha256) | \`${report.shadow.corpus_sha256.slice(0, 16)}…\` |`);
  out.push(`| קבלה (sha256) | \`${report.shadow.receipt_sha256.slice(0, 16)}…\` |`);
  out.push("");
  out.push("סירובים לפי סיבה:");
  out.push("");
  out.push("| סיבה | מספר |");
  out.push("|---|---|");
  for (const [reason, count] of Object.entries(report.shadow.refusals_by_reason)) out.push(`| ${cell(refusalLabel(reason))} (\`${reason}\`) | ${count} |`);
  out.push("");
  out.push("דירוג הריצות — הגרוע מבין דירוגי העובדות והפרמטרים של כל הרצה:");
  out.push("");
  out.push("| דירוג | מספר |");
  out.push("|---|---|");
  for (const [grade, count] of Object.entries(report.shadow.grades)) out.push(`| ${cell(executionGradeLabel(grade))} (\`${grade}\`) | ${count} |`);
  out.push("");
  out.push("השאלות הפתוחות בצל — לכל שאלה, כמה מקרים הושוו בין הענפים וכמה מהם שונים; אף ענף לא התקבל:");
  out.push("");
  out.push("| הכרעה | ענפים | ענף שלא נקשר | הושוו | שונים | לא ניתנים להשוואה |");
  out.push("|---|---|---|---|---|---|");
  for (const decision of report.shadow.decisions) {
    out.push(`| \`${decision.decision_id}\` | ${decision.branches.join(", ")} | ${decision.unbound_branches.map((entry) => entry.branch).join(", ") || "—"} | ${decision.cases_compared} | ${decision.cases_differing} | ${decision.cases_not_comparable} |`);
  }
  out.push("");
  out.push("---");
  out.push("");
  section += 1;

  out.push(`## ${section}. דירוג המקור של כל פרמטר`);
  out.push("");
  out.push("כל פרמטר שנקשר בדוח נושא דירוג מקור. הדירוג אומר מאין הגיע המספר, לא אם הוא נכון.");
  out.push("");
  out.push(INFERRED_VISUAL_SENTENCE);
  out.push("");
  out.push("| פרמטר | דירוג | קריאה חזותית | עמוד (sha256) |");
  out.push("|---|---|---|---|");
  for (const row of report.provenance.bound_parameter_versions) {
    const readings = row.visual_bindings.map((binding) => binding.visual_reading).join(", ") || "—";
    const pages = row.visual_bindings.map((binding) => `${binding.page_pdf_sha256.slice(0, 16)}…`).join(", ") || "—";
    out.push(`| \`${row.parameter_version_id}\` | ${cell(gradeLabel(row.provenance_grade))} (\`${row.provenance_grade}\`) | ${cell(readings)} | ${cell(pages)} |`);
  }
  out.push("");
  out.push(`סיכום: ${Object.entries(report.provenance.counts).map(([grade, count]) => `${gradeLabel(grade)} — ${count}`).join("; ")}.`);
  out.push("");
  out.push("---");
  out.push("");
  section += 1;
  out.push(`## ${section}. נושאים שלא רצו`);
  out.push("");
  if (report.topics_not_run.length === 0) out.push("כל שבעת הנושאים רצו.");
  out.push("");
  out.push("| נושא | סיבה | משבצת | פירוט |");
  out.push("|---|---|---|---|");
  for (const topic of report.topics_not_run) {
    out.push(`| ${cell(topicLabel(topic.topic))} | ${cell(NOT_RUN_HEBREW[topic.not_run] ?? topic.not_run)} | \`${topic.slots.join("`, `")}\` | ${cell(topic.detail)} |`);
  }
  out.push("");
  out.push("---");
  out.push("");
  section += 1;

  out.push(`## ${section}. החלטות שנמשכו`);
  out.push("");
  if (withdrawn.length === 0) {
    out.push("אין החלטות שנמשכו.");
  } else {
    out.push("שאלות אלה אינן פתוחות עוד. הן מופיעות כאן כדי שהרשימה תהיה מלאה, ולא כדי שיוכרעו.");
    out.push("");
    out.push("| מזהה | נושא | סיבת המשיכה |");
    out.push("|---|---|---|");
    for (const row of withdrawn) {
      out.push(`| \`${row.decision_id}\` | ${cell(topicLabel(String(row.topic)))} | ${cell(String(row.withdrawn_reason))} |`);
    }
  }
  out.push("");
  out.push("---");
  out.push("");
  out.push(`## ${section + 1}. היקף`);
  out.push("");
  out.push(report.scope_note);
  out.push("");
  return `${out.join("\n")}\n`;
}

function pdfBlocks(report: Report, withdrawn: ReadonlyArray<Record<string, string>>): readonly RtlBlock[] {
  const blocks: RtlBlock[] = [
    { kind: "heading", text: "דוח רגישות — מה כל תשובה משנה", level: 1 },
    { kind: "paragraph", text: "מסמך זה אינו מכריע באף שאלה משפטית ואינו ממליץ על תשובה. הוא מציג, לכל תרחיש, מה כל אחת מהאפשרויות מחשבת ומה ההפרש ביניהן." },
    { kind: "paragraph", text: "כל הנתונים הם סביבת בדיקה. אין כאן נתוני לקוחות, אין מקור מאושר ואין פרמטר פעיל." },
    { kind: "rule" },
    {
      kind: "table",
      columns: ["מדד", "ערך"],
      rows: [
        ["תרחישים שנוסו", String(report.scenarios_attempted)],
        ["תרחישים שרצו", String(report.scenarios_run)],
        ["תרחישים שסורבו", String(report.scenarios_refused)],
        ["עקבות שנשמרו", String(report.traces_included)],
        ["עקבות ששוחזרו מהמסד", String(report.traces_replayed_from_database)],
        ["נושאים שרצו", `${report.topics_run_count} / ${report.topics_total}`],
      ],
    },
    { kind: "rule" },
  ];
  for (const decision of report.open_decisions) {
    blocks.push({ kind: "heading", text: topicLabel(decision.topic), level: 2 });
    blocks.push({ kind: "hash", label: "decision", value: decision.decision_id });
    for (const unbound of decision.unbound_branches ?? []) blocks.push({ kind: "paragraph", text: `ענף שלא נקשר ולא רץ: ${unbound.branch} — ${unbound.reason}` });
    if (decision.provenance_grade) {
      blocks.push({ kind: "paragraph", text: `דירוג מקור: ${gradeLabel(decision.provenance_grade)} (${decision.provenance_grade})` });
      if (decision.provenance_grade === "inferred_visual") blocks.push({ kind: "paragraph", text: INFERRED_VISUAL_SENTENCE });
    }
    blocks.push({
      kind: "table",
      columns: ["תרחיש", ...decision.branches, "הפרש"],
      rows: decision.per_scenario.map((row) => row.ran
        ? [scenarioLabel(row.scenario), ...decision.branches.map((branch) =>
          row.by_branch?.find((entry) => entry.branch === branch)?.output ?? "—"), row.difference ?? "—"]
        : [scenarioLabel(row.scenario), ...decision.branches.map(() => "לא רץ"), row.reason ?? "לא רץ"]),
    });
    blocks.push({ kind: "rule" });
  }
  blocks.push({ kind: "heading", text: "הצל הלא־מקוון — טיוטות על עובדות סינתטיות", level: 2 });
  blocks.push({ kind: "paragraph", text: "ריצת הצל מריצה את הטיוטות על ערכי פרמטרים בטיוטה ועל עובדות סינתטיות. שום פלט אינו ממצא; דבר אינו מופעל ואינו נמסר; לא הופעל חילוץ." });
  blocks.push({
    kind: "table",
    columns: ["מדד", "ערך"],
    rows: [
      ["ריצה", report.shadow.run_id],
      ["מצב ריצה", report.shadow.execution_mode],
      ["גרסאות פרמטר בטיוטה", String(report.shadow.draft_input_pin.draft_parameter_versions)],
      ["פרמטרים פעילים", String(report.shadow.draft_input_pin.active_real_parameter_count)],
      ["חודשי תלוש סינתטיים", String(report.shadow.counts.cases)],
      ["הרצות", String(report.shadow.counts.executions)],
      ["רצו", String(report.shadow.counts.ran)],
      ["סורבו", String(report.shadow.counts.preparation_refused + report.shadow.counts.executor_refused)],
      ["הפרשי־צל שחושבו", String(report.shadow.counts.deltas_computed)],
      ["עקבות שנשמרו / שוחזרו", `${report.shadow.traces_included} / ${report.shadow.traces_replayed_from_database}`],
    ],
  });
  blocks.push({
    kind: "table",
    columns: ["הכרעה", "ענפים", "ענף שלא נקשר", "הושוו", "שונים"],
    rows: report.shadow.decisions.map((decision) => [decision.decision_id, decision.branches.join(", "), decision.unbound_branches.map((entry) => entry.branch).join(", ") || "—", String(decision.cases_compared), String(decision.cases_differing)]),
  });
  blocks.push({ kind: "hash", label: "shadow receipt sha256", value: report.shadow.receipt_sha256 });
  blocks.push({ kind: "rule" });
  blocks.push({ kind: "heading", text: "דירוג המקור של כל פרמטר", level: 2 });
  blocks.push({ kind: "paragraph", text: INFERRED_VISUAL_SENTENCE });
  blocks.push({
    kind: "table",
    columns: ["פרמטר", "דירוג", "קריאה חזותית"],
    rows: report.provenance.bound_parameter_versions.map((row) => [row.parameter_version_id, gradeLabel(row.provenance_grade), row.visual_bindings.map((binding) => binding.visual_reading).join(", ") || "—"]),
  });
  blocks.push({ kind: "rule" });
  blocks.push({ kind: "heading", text: "נושאים שלא רצו", level: 2 });
  if (report.topics_not_run.length === 0) blocks.push({ kind: "paragraph", text: "כל שבעת הנושאים רצו." });
  blocks.push({
    kind: "table",
    columns: ["נושא", "סיבה"],
    rows: report.topics_not_run.map((topic) => [topicLabel(topic.topic), NOT_RUN_HEBREW[topic.not_run] ?? topic.not_run]),
  });
  for (const topic of report.topics_not_run) {
    blocks.push({ kind: "paragraph", text: `${topicLabel(topic.topic)}: ${topic.detail}` });
  }
  blocks.push({ kind: "rule" });
  blocks.push({ kind: "heading", text: "החלטות שנמשכו", level: 2 });
  if (withdrawn.length === 0) blocks.push({ kind: "paragraph", text: "אין החלטות שנמשכו." });
  else blocks.push({
    kind: "table",
    columns: ["מזהה", "נושא"],
    rows: withdrawn.map((row) => [String(row.decision_id), topicLabel(String(row.topic))]),
  });
  blocks.push({ kind: "rule" });
  blocks.push({ kind: "heading", text: "היקף", level: 2 });
  blocks.push({ kind: "paragraph", text: report.scope_note });
  blocks.push({ kind: "hash", label: "report sha256", value: report.report_sha256 });
  return blocks;
}

async function main(): Promise<void> {
  mkdirSync(DOCS_ROOT, { recursive: true });
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const report = JSON.parse(readFileSync(REPORT, "utf8")) as Report;
  const withdrawn = await withdrawnDecisions();

  const body = markdown(report, withdrawn);
  writeFileSync(MARKDOWN, body, "utf8");

  const document = {
    title: "Tivdoc sensitivity report (Hebrew)",
    subject: `sensitivity=${report.report_sha256};tenant=${report.tenant_id}`,
    // Fixed rather than read off the clock, so the same report renders to the
    // same bytes on every run. What distinguishes one version of this document
    // from another is the report hash, and that is stamped on the last page.
    fixed_date: "20260904",
    blocks: pdfBlocks(report, withdrawn),
  };
  const pdf = renderDeterministicRtlDocument(document);
  const again = renderDeterministicRtlDocument(document);
  if (sha256(pdf) !== sha256(again)) throw new Error("L48_PDF_NOT_DETERMINISTIC");
  writeFileSync(PDF, pdf);

  const receipt = {
    schema_version: "tivdoc-sensitivity-report-hebrew-v0.11.0",
    unit: "L7-10",
    generated_from: REPORT,
    source_report_sha256: report.report_sha256,
    markdown: { path: MARKDOWN, sha256: sha256(body), byte_count: Buffer.byteLength(body) },
    pdf: { path: PDF, sha256: sha256(pdf), byte_count: pdf.byteLength, deterministic: true },
    open_decisions: report.open_decisions.length,
    topics_not_run: report.topics_not_run.length,
    provenance_counts: report.provenance.counts,
    withdrawn_decisions: withdrawn.length,
    shadow_receipt_sha256: report.shadow.receipt_sha256,
    shadow_cases_run: report.shadow.counts.ran,
    interpretation: "none",
    recommendation: "none",
  };
  writeFileSync(path.join(RECEIPT_ROOT, "sensitivity-report-hebrew.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`L4_8_HEBREW ${JSON.stringify({
    markdown_sha256: receipt.markdown.sha256.slice(0, 16),
    pdf_sha256: receipt.pdf.sha256.slice(0, 16),
    pdf_bytes: receipt.pdf.byte_count,
    withdrawn: withdrawn.length,
  })}`);
}

await main();
