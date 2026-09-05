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

// L8-8: re-pointed to v7. L11-7 / D4: re-pointed to v8 — the owner-recorded
// defaults, their alternatives with differences, the gap severity sentence, the
// contribution difference beside the base difference, the retired branch and
// the convalescence rate table; a statement above the tables that no
// attestation occurred.
// L12-4 / D4: re-pointed to v9 — the derived daily norm with its assumption
// slot on the row, the default view of the severity classes, and the
// default-transition table.
const REPORT = path.join("output", "next", "pool-q", "decision-sensitivity-report-v10.json");
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
  by_branch?: readonly Readonly<{ branch: string; output: string; is_default?: boolean; difference_from_default?: string | null }>[];
  difference?: string; reason?: string;
  base_difference?: string; contribution_difference?: string; contribution_rate_sum?: Readonly<{ numerator: string; denominator: string }>;
}>;
type Resolution = Readonly<{
  decision_key: string; selected_branch: string; opinion_branch_label: string; basis: string; evidence_sha256: string;
  approval_record_sha256: string; approved_on: string; status: string; approver_identity: null; mapping_note: string;
}>;
type OpenDecision = Readonly<{
  provenance_grade?: string;
  unbound_branches?: ReadonlyArray<Readonly<{ branch: string; reason: string }>>;
  decision_id: string; topic: string; rule_spec_id: string; branches: readonly string[];
  narrower_than_draft: string | null; scenarios_run: number; scenarios_differing: number;
  per_scenario: readonly PerScenario[];
  default_branch?: string | null; default_branch_source?: string; selected_branch?: string | null; selected_branch_bound?: boolean | null;
  resolution?: Resolution | null;
  gap_severity?: Readonly<{ dimension: string; statutory_figure: string; order_figure: string; default_view_note_he?: string }> | null;
  transition?: Readonly<{ previous_default_branch: string | null; new_default_branch: string | null; default_changed: boolean; cases_outcome_changed: number; one_changed_case_id: string | null; classification: string; band_month: string | null; band_month_outcome_changed: boolean | null }> | null;
  derived_bindings?: ReadonlyArray<Readonly<{ parameter_version_id: string; assumption_slot: string; assumption_statement: string; identity: string; steps: readonly string[]; regular_day: string; short_day: string; invalidated_by: string; competing_reading: string; derivation_sha256: string }>>;
  contribution_rates?: ReadonlyArray<Readonly<{ share: string; parameter_version_id: string; rate: Readonly<{ numerator: string; denominator: string }> }>> | null;
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
    bound_parameter_versions: ReadonlyArray<Readonly<{ parameter_version_id: string; provenance_grade: string; visual_bindings: ReadonlyArray<Readonly<{ page_pdf_sha256: string; visual_reading: string }>>; derivation?: Readonly<{ assumption_slot: string; identity: string; regular_day: string; short_day: string }> | null }>>;
  }>;
  executions: readonly Readonly<{ topic: string; scenario: string; branch: string; ran: boolean; output: string | null; refusal: string | null }>[];
  resolutions?: Readonly<{ recorded: number; attested: number; evidence: Readonly<{ legal_opinion_sha256: string; approval_record_sha256: string; approved_on: string }>; items: readonly Resolution[] }>;
  branches_examined_and_rejected?: ReadonlyArray<Readonly<{ decision_id: string; branch: string; reason: string; retired_in: string }>>;
  convalescence_rate_table?: Readonly<{ rows: ReadonlyArray<Readonly<{ havraa_year: number; rate_minor_units: number; valid_from: string; valid_to: string; known_at: string; retroactive: boolean; parameter_version_id: string }>>; retroactive_example: string }>;
  gap_severity?: Readonly<{ sentence_he: string; not_computed: ReadonlyArray<Readonly<{ dimension: string; statutory_figure: string; order_figure: string; reason: string }>> }>;
  default_transitions?: Readonly<{ previous_run_id: string; current_run_id: string; verdict: string; rows: ReadonlyArray<Readonly<{ decision_id: string; previous_default_branch: string | null; new_default_branch: string | null; default_changed: boolean; cases_outcome_changed: number; one_changed_case_id: string | null; classification: string; band_month: string | null; band_month_outcome_changed: boolean | null }>> }>;
  // L7-10: the offline shadow beside the sensitivity — counts and hashes, no content.
  shadow: Readonly<{
    run_id: string; receipt_sha256: string; execution_mode: string; envelope_sha256: string; corpus_sha256: string;
    draft_input_pin: Readonly<{ draft_parameter_versions: number; synthetic_inputs: number; active_real_parameter_count: number; extraction_used: boolean; tenant_id: string }>;
    counts: Readonly<Record<string, number>>; refusals_by_reason: Readonly<Record<string, number>>; grades: Readonly<Record<string, number>>;
    traces_included: number; traces_replayed_from_database: number;
    decisions: ReadonlyArray<Readonly<{ decision_id: string; branches: readonly string[]; unbound_branches: ReadonlyArray<Readonly<{ branch: string; reason: string }>>; default_branch?: string | null; gap_severity?: Readonly<{ counts: Readonly<Record<string, number>> }> | null; cases_compared: number; cases_differing: number; cases_not_comparable: number }>>;
  }>;
}>;

const EXECUTION_GRADE_HEBREW: Readonly<Record<string, string>> = Object.freeze({
  verified: "מאומת — עובדות מתועדות שלא נקראו במכונה, ופרמטרים מאומתים בטקסט",
  lexicon: "פרמטר שנקרא דרך הלקסיקון",
  declared: "עובדה מוצהרת, או פרמטר בתוך בחירת מסמך",
  derived: "עובדה נגזרת מעובדות אחרות, או פרמטר נגזר — חישוב על טקסט מצוטט בתוספת הנחה מוצהרת (הסף היומי 8.6 / 7.6)",
  inferred: "עובדה שהפיק סוכן, עובדה שהמחלץ קרא מהמסמך ואיש לא אישר, או פרמטר שנקרא מתמונת העמוד",
  administrative: "פרמטר ממקור מנהלי",
  agreement_interpretation: "פרמטר מפרשנות של הסכם או צו הרחבה",
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
  derived: "נגזר — חישוב על טקסט מצוטט בתוספת הנחה מוצהרת; לא לשון המקור",
  administrative: "מקור מנהלי",
  agreement_interpretation: "פרשנות של הסכם או צו הרחבה (ועדת היגוי, כל־זכות) — לא מקור רשמי",
});
const INFERRED_VISUAL_SENTENCE = "inferred_visual: המספר נקרא מתמונת העמוד הסרוק, משום ששכבת הטקסט של המסמך מעורפלת או חסרה; הוא ממתין לאימות חזותי של אדם מול אותו עמוד, ולא ניתן לאשרו בלי אימות כזה.";
const gradeLabel = (grade: string) => GRADE_HEBREW[grade] ?? grade;
const DEFAULT_SOURCE_HEBREW: Readonly<Record<string, string>> = Object.freeze({
  owner_recorded_resolution: "נרשמה על ידי הבעלים על יסוד חוות הדעת המאושרת",
  first_bound_fallback: "הענף שנבחר בהכרעה אינו קשור למקור ולכן אינו רץ; רץ הענף הקשור הראשון",
  first_listed: "ללא הכרעה רשומה — הענף הראשון ברשימה",
  conditional_on_schedule: "מותנה בסידור העבודה (ביקורת חיצונית #1, גרסה 2 של ההכרעה): ימי העבודה בשבוע ואורך היום הרגיל קובעים את הענף — 8 / 8.6–7.6 / 9; ללא העובדות — סירוב. עד לחיבור עובדות התיק רץ הענף שנבחר בגרסה הקודמת",
  single: "ענף יחיד",
});
const money = (minorUnits: number) => `${(minorUnits / 100).toFixed(2)} ILS`;
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
  out.push(`המסמך נוצר אוטומטית מ־\`decision-sensitivity-report-v10.json\` (\`${report.report_sha256.slice(0, 16)}…\`).`);
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

  if (report.resolutions) {
    out.push("## ברירות מחדל שנרשמו על ידי הבעלים — לא אטסטציה");
    out.push("");
    out.push(`שש מן ההכרעות הפתוחות שלהלן נושאות **ברירת מחדל שנרשמה על ידי הבעלים** ביום ${report.resolutions.evidence.approved_on}, על יסוד חוות דעת משפטית שאושרה על ידי עורך/ת דין לדיני עבודה`);
    out.push(`(sha256 \`${report.resolutions.evidence.legal_opinion_sha256.slice(0, 16)}…\`; רשומת האישור \`${report.resolutions.evidence.approval_record_sha256.slice(0, 16)}…\`). מעמד כל רישום: \`owner_recorded\`.`);
    out.push("");
    out.push("**לא בוצעה אטסטציה.** לעורך/ת הדין אין זהות בודק/ת רשומה; אף מקור לא נסקר, אף פרמטר לא יצא ממצב טיוטה, אף כלל לא הופעל, והמונים נותרו 0/7.");
    out.push("רישום ברירת מחדל משנה דבר אחד בלבד: איזה ענף הדוח וריצת הצל מריצים כברירת מחדל. כל ענף אחר ממשיך להיות מחושב ומוצג, וההפרש ממנו לברירת המחדל מצוין בטבלה.");
    out.push(`רישומים: ${report.resolutions.recorded}; אטסטציות: ${report.resolutions.attested}.`);
    out.push("");
    out.push("| הכרעה | הענף שנבחר (בלשון חוות הדעת) | בסיס | מעמד |");
    out.push("|---|---|---|---|");
    for (const item of report.resolutions.items) out.push(`| \`${item.decision_key}\` | **${item.selected_branch}** (${item.opinion_branch_label}) | ${cell(item.basis)} | \`${item.status}\` |`);
    out.push("");
    out.push("---");
    out.push("");
  }

  let section = 2;
  for (const decision of report.open_decisions) {
    out.push(`## ${section}. ${topicLabel(decision.topic)} — \`${decision.decision_id}\``);
    out.push("");
    out.push(`השאלה הפתוחה מפרידה בין ${decision.branches.map((branch) => `**${branch}**`).join(" לבין ")}.`);
    if (decision.default_branch) {
      out.push("");
      const source = DEFAULT_SOURCE_HEBREW[decision.default_branch_source ?? ""] ?? decision.default_branch_source;
      out.push(`ברירת מחדל: **${decision.default_branch}** — ${source}.${decision.resolution ? ` הענף שנבחר בהכרעה: **${decision.resolution.selected_branch}** (\`${decision.resolution.decision_key}\`), מעמד \`${decision.resolution.status}\`, ללא זהות מאשר/ת.` : " אין הכרעה רשומה לשאלה זו; ביטחון נמוך."}`);
    }
    if (decision.gap_severity && report.gap_severity) {
      out.push("");
      out.push(report.gap_severity.sentence_he);
      const shadowDecision = report.shadow.decisions.find((entry) => entry.decision_id === decision.decision_id);
      if (shadowDecision?.gap_severity) out.push(`בריצת הצל: ${Object.entries(shadowDecision.gap_severity.counts).map(([name, count]) => `\`${name}\` — ${count}`).join("; ")}.`);
      if (decision.gap_severity.default_view_note_he) out.push(`תצוגת ברירת המחדל: ${decision.gap_severity.default_view_note_he}`);
    }
    for (const derived of decision.derived_bindings ?? []) {
      out.push("");
      out.push(`**נגזר, לא לשון המקור:** \`${derived.parameter_version_id}\` = ${derived.regular_day} (יום רגיל) / ${derived.short_day} (היום המקוצר). ${derived.steps.join("; ")}. **הנחה מחייבת** \`${derived.assumption_slot}\`: ${cell(derived.assumption_statement)} הקריאה המתחרה: \`${derived.competing_reading}\`. עלול להתבטל על ידי: ${cell(derived.invalidated_by)}. (sha256 \`${derived.derivation_sha256.slice(0, 16)}…\`)`);
    }
    if (decision.transition) {
      out.push("");
      const t = decision.transition;
      out.push(`מעבר ברירת המחדל: ${t.previous_default_branch ?? "—"} ← ${t.new_default_branch ?? "—"}${t.default_changed ? "" : " (ללא שינוי)"}; חודשים סינתטיים שהתוצאה השתנתה בהם: ${t.cases_outcome_changed}${t.one_changed_case_id ? ` (למשל \`${t.one_changed_case_id}\`)` : ""}; סיווג ${t.classification}${t.band_month ? `; חודש הרצועה \`${t.band_month}\`${t.band_month_outcome_changed ? " — התוצאה בו השתנתה" : " — התוצאה בו לא השתנתה"}` : ""}.`);
    }
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
    const capDecision = decision.contribution_rates != null;
    out.push("");
    if (capDecision) out.push("ההפרש בטבלה הוא הפרש **בתקרה** (בסיס). הסכום שבו מדובר הוא הפרש **ההפרשות** על התקרה בשיעורי ההפרשה, ומוצג בעמודה נפרדת.");
    out.push(`| תרחיש | ${decision.branches.map((branch) => branch === decision.default_branch ? `${branch} (ברירת מחדל)` : branch).join(" | ")} | הפרש${capDecision ? " (בסיס)" : ""} | הפרש מברירת המחדל${capDecision ? " | הפרש הפרשות" : ""} |`);
    out.push(`|---|${decision.branches.map(() => "---|").join("")}---|---|${capDecision ? "---|" : ""}`);
    for (const row of decision.per_scenario) {
      if (!row.ran) {
        out.push(`| ${cell(scenarioLabel(row.scenario))} | ${decision.branches.map(() => "לא רץ").join(" | ")} | ${cell(row.reason ?? "לא רץ")} | — |${capDecision ? " — |" : ""}`);
        continue;
      }
      const byBranch = decision.branches.map((branch) =>
        row.by_branch?.find((entry) => entry.branch === branch)?.output ?? "—");
      const fromDefault = decision.branches.filter((branch) => branch !== decision.default_branch).map((branch) => {
        const entry = row.by_branch?.find((item) => item.branch === branch);
        return `${branch}: ${entry?.difference_from_default ?? "—"}`;
      }).join("; ") || "—";
      out.push(`| ${cell(scenarioLabel(row.scenario))} | ${byBranch.map(cell).join(" | ")} | ${cell(row.difference ?? "לא ניתן להשוואה")} | ${cell(fromDefault)} |${capDecision ? ` ${cell(row.contribution_difference ?? "—")} |` : ""}`);
    }
    if (capDecision && decision.contribution_rates) {
      out.push("");
      out.push(`שיעורי ההפרשה (ברירת המחדל של הכרעת הקדימות): ${decision.contribution_rates.map((rate) => `${rate.share} \`${rate.parameter_version_id}\` = ${rate.rate.numerator}/${rate.rate.denominator}`).join("; ")}.`);
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

  if (report.branches_examined_and_rejected && report.branches_examined_and_rejected.length > 0) {
    out.push(`## ${section}. ענפים שנבחנו ונדחו`);
    out.push("");
    out.push("| הכרעה | ענף | סיבה | הוצא מהטבלה ב־ |");
    out.push("|---|---|---|---|");
    for (const row of report.branches_examined_and_rejected) out.push(`| \`${row.decision_id}\` | **${row.branch}** | ${cell(row.reason)} | ${cell(row.retired_in)} |`);
    out.push("");
    out.push("---");
    out.push("");
    section += 1;
  }
  if (report.convalescence_rate_table) {
    out.push(`## ${section}. תעריף ההבראה לפי שנת הבראה — זמן תוקף וזמן ידיעה`);
    out.push("");
    out.push("| שנת הבראה | תעריף ליום | בתוקף מ־ | עד | ידוע מ־ | רטרואקטיבי | גרסת פרמטר |");
    out.push("|---|---|---|---|---|---|---|");
    for (const row of report.convalescence_rate_table.rows) out.push(`| ${row.havraa_year} | ${money(row.rate_minor_units)} | ${row.valid_from} | ${row.valid_to} | ${row.known_at} | ${row.retroactive ? "כן" : "לא"} | \`${row.parameter_version_id}\` |`);
    out.push("");
    out.push("תקופה מ־1.7.2026 ואילך: התעריף אינו מפורסם — המנוע מסרב (`rate_not_published`), לא 418 ולא 451.50 כברירת מחדל.");
    out.push(`דוגמה: ${cell(report.convalescence_rate_table.retroactive_example)}`);
    out.push("");
    out.push("---");
    out.push("");
    section += 1;
  }
  if (report.default_transitions) {
    out.push(`## ${section}. מעבר ברירות המחדל — מה השתנה בפועל`);
    out.push("");
    out.push(`לכל הכרעה: הענף שרץ כברירת מחדל לפני רישום ההכרעות (הראשון ברשימה), הענף שרץ עכשיו, כמה חודשים סינתטיים שינו את תוצאתם במעבר, ודוגמה אחת. סיווג: a — ברירת המחדל הקודמת כבר הייתה הענף שנבחר; b — הענף השתנה וחודשים השתנו; c — הענף השתנה ואף חודש לא השתנה, ואז נוסף חודש רצועה כדי שההשוואה לא תהיה ריקה. ריצות: \`${report.default_transitions.previous_run_id}\` ← \`${report.default_transitions.current_run_id}\` (${report.default_transitions.verdict}).`);
    out.push("");
    out.push("| הכרעה | ברירת מחדל קודמת | חדשה | חודשים שהשתנו | דוגמה | סיווג | חודש רצועה |");
    out.push("|---|---|---|---|---|---|---|");
    for (const row of report.default_transitions.rows) {
      out.push(`| \`${row.decision_id.replace(/^.*decision\./u, "")}\` | ${row.previous_default_branch ?? "—"} | **${row.new_default_branch ?? "—"}** | ${row.cases_outcome_changed} | ${row.one_changed_case_id ? `\`${row.one_changed_case_id}\`` : "—"} | ${row.classification} | ${row.band_month ? `\`${row.band_month}\` (${row.band_month_outcome_changed ? "השתנה" : "לא השתנה"})` : "—"} |`);
    }
    out.push("");
    out.push("---");
    out.push("");
    section += 1;
  }
  if (report.gap_severity && report.gap_severity.not_computed.length > 0) {
    out.push(`## ${section}. ממדים שסיווג החומרה מוגדר להם ואינם מחושבים עדיין`);
    out.push("");
    for (const row of report.gap_severity.not_computed) out.push(`- ${cell(row.dimension)}: חוק — ${cell(row.statutory_figure)}; צו — ${cell(row.order_figure)}. ${cell(row.reason)}`);
    out.push("");
    out.push("---");
    out.push("");
    section += 1;
  }
  out.push(`## ${section}. דירוג המקור של כל פרמטר`);
  out.push("");
  out.push("כל פרמטר שנקשר בדוח נושא דירוג מקור. הדירוג אומר מאין הגיע המספר, לא אם הוא נכון.");
  out.push("");
  out.push(INFERRED_VISUAL_SENTENCE);
  out.push("");
  out.push("| פרמטר | דירוג | קריאה חזותית | עמוד (sha256) | הנחה (נגזר) |");
  out.push("|---|---|---|---|---|");
  for (const row of report.provenance.bound_parameter_versions) {
    const readings = row.visual_bindings.map((binding) => binding.visual_reading).join(", ") || "—";
    const pages = row.visual_bindings.map((binding) => `${binding.page_pdf_sha256.slice(0, 16)}…`).join(", ") || "—";
    const assumption = row.derivation ? `\`${row.derivation.assumption_slot}\` — ${row.derivation.identity}` : "—";
    out.push(`| \`${row.parameter_version_id}\` | ${cell(gradeLabel(row.provenance_grade))} (\`${row.provenance_grade}\`) | ${cell(readings)} | ${cell(pages)} | ${cell(assumption)} |`);
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
    ...(report.resolutions ? [
      { kind: "heading", text: "ברירות מחדל שנרשמו על ידי הבעלים — לא אטסטציה", level: 2 } as RtlBlock,
      { kind: "paragraph", text: `שש מן ההכרעות הפתוחות נושאות ברירת מחדל שנרשמה על ידי הבעלים ביום ${report.resolutions.evidence.approved_on} על יסוד חוות דעת משפטית מאושרת. מעמד כל רישום: owner_recorded. לא בוצעה אטסטציה: לעורך/ת הדין אין זהות בודק/ת רשומה; אף מקור לא נסקר, אף פרמטר לא יצא ממצב טיוטה, אף כלל לא הופעל. רישום ברירת מחדל משנה רק איזה ענף רץ כברירת מחדל; כל ענף אחר מחושב ומוצג.` } as RtlBlock,
      { kind: "hash", label: "legal opinion sha256", value: report.resolutions.evidence.legal_opinion_sha256 } as RtlBlock,
      { kind: "hash", label: "approval record sha256", value: report.resolutions.evidence.approval_record_sha256 } as RtlBlock,
      { kind: "table", columns: ["הכרעה", "הענף שנבחר", "מעמד"], rows: report.resolutions.items.map((item) => [item.decision_key, item.selected_branch, item.status]) } as RtlBlock,
    ] : []),
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
    if (decision.default_branch) blocks.push({ kind: "paragraph", text: `ברירת מחדל: ${decision.default_branch} — ${DEFAULT_SOURCE_HEBREW[decision.default_branch_source ?? ""] ?? decision.default_branch_source}${decision.resolution ? ` (${decision.resolution.decision_key}, ${decision.resolution.status})` : " (אין הכרעה רשומה)"}` });
    if (decision.gap_severity && report.gap_severity) blocks.push({ kind: "paragraph", text: report.gap_severity.sentence_he.replaceAll("**", "") });
    if (decision.gap_severity?.default_view_note_he) blocks.push({ kind: "paragraph", text: `תצוגת ברירת המחדל: ${decision.gap_severity.default_view_note_he}` });
    for (const derived of decision.derived_bindings ?? []) blocks.push({ kind: "paragraph", text: `נגזר, לא לשון המקור: ${derived.parameter_version_id} = ${derived.regular_day} / ${derived.short_day}. ${derived.steps.join("; ")}. הנחה מחייבת ${derived.assumption_slot}: ${derived.assumption_statement} עלול להתבטל על ידי: ${derived.invalidated_by}.` });
    if (decision.transition) blocks.push({ kind: "paragraph", text: `מעבר ברירת המחדל: ${decision.transition.previous_default_branch ?? "—"} ← ${decision.transition.new_default_branch ?? "—"}; חודשים שהשתנו: ${decision.transition.cases_outcome_changed}; סיווג ${decision.transition.classification}.` });
    if (decision.contribution_rates) blocks.push({ kind: "paragraph", text: "ההפרש בטבלה הוא הפרש בתקרה; הפרש ההפרשות בשיעורי ההפרשה מוצג בעמודה נפרדת." });
    if (decision.provenance_grade) {
      blocks.push({ kind: "paragraph", text: `דירוג מקור: ${gradeLabel(decision.provenance_grade)} (${decision.provenance_grade})` });
      if (decision.provenance_grade === "inferred_visual") blocks.push({ kind: "paragraph", text: INFERRED_VISUAL_SENTENCE });
    }
    blocks.push({
      kind: "table",
      columns: ["תרחיש", ...decision.branches.map((branch) => branch === decision.default_branch ? `${branch} (ברירת מחדל)` : branch), "הפרש", ...(decision.contribution_rates ? ["הפרש הפרשות"] : [])],
      rows: decision.per_scenario.map((row) => row.ran
        ? [scenarioLabel(row.scenario), ...decision.branches.map((branch) =>
          row.by_branch?.find((entry) => entry.branch === branch)?.output ?? "—"), row.difference ?? "—", ...(decision.contribution_rates ? [row.contribution_difference ?? "—"] : [])]
        : [scenarioLabel(row.scenario), ...decision.branches.map(() => "לא רץ"), row.reason ?? "לא רץ", ...(decision.contribution_rates ? ["—"] : [])]),
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
  if (report.branches_examined_and_rejected && report.branches_examined_and_rejected.length > 0) {
    blocks.push({ kind: "heading", text: "ענפים שנבחנו ונדחו", level: 2 });
    blocks.push({ kind: "table", columns: ["הכרעה", "ענף", "סיבה"], rows: report.branches_examined_and_rejected.map((row) => [row.decision_id, row.branch, row.reason]) });
    blocks.push({ kind: "rule" });
  }
  if (report.convalescence_rate_table) {
    blocks.push({ kind: "heading", text: "תעריף ההבראה לפי שנת הבראה", level: 2 });
    blocks.push({ kind: "table", columns: ["שנת הבראה", "תעריף ליום", "בתוקף", "ידוע מ־", "רטרואקטיבי"], rows: report.convalescence_rate_table.rows.map((row) => [String(row.havraa_year), money(row.rate_minor_units), `${row.valid_from} – ${row.valid_to}`, row.known_at, row.retroactive ? "כן" : "לא"]) });
    blocks.push({ kind: "paragraph", text: "תקופה מ־1.7.2026 ואילך: התעריף אינו מפורסם והמנוע מסרב (rate_not_published)." });
    blocks.push({ kind: "rule" });
  }
  if (report.default_transitions) {
    blocks.push({ kind: "heading", text: "מעבר ברירות המחדל — מה השתנה בפועל", level: 2 });
    blocks.push({ kind: "table", columns: ["הכרעה", "קודמת", "חדשה", "חודשים שהשתנו", "סיווג"], rows: report.default_transitions.rows.map((row) => [row.decision_id.replace(/^.*decision\./u, ""), row.previous_default_branch ?? "—", row.new_default_branch ?? "—", String(row.cases_outcome_changed), row.classification]) });
    blocks.push({ kind: "rule" });
  }
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
    schema_version: "tivdoc-sensitivity-report-hebrew-v0.14.0",
    unit: "L12-4",
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
    resolutions_recorded: report.resolutions?.recorded ?? 0,
    resolutions_attested: report.resolutions?.attested ?? 0,
    attestation_statement_present: body.includes("לא בוצעה אטסטציה"),
    derived_assumption_present: body.includes("five_day_even_distribution"),
    transition_table_present: body.includes("מעבר ברירות המחדל"),
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
