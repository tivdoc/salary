import { PDFDocument } from "pdf-lib";
import type {
  AnalysisResultBundle,
  CanonicalHashPort,
  DeterministicIdPort,
  DeterministicReportArtifacts,
  ReportBuilderPort,
  TopicAnalysisResult,
  Wave3Topic,
} from "../../engine/wave3/contracts";
import { WAVE3_TOPICS } from "../../engine/wave3/contracts.ts";
import { canonicalJson, immutable } from "../../engine/case-operations/canonical.ts";
import {
  HEBREW_REPORT_FONT,
  hebrewTopicLabel,
  renderCanonicalHebrewPdf,
  SYNTHETIC_REPORT_WATERMARK,
} from "./deterministic-hebrew-pdf.ts";

export const REPORT_SCHEMA = "tivdoc-case-report-v0.6.0" as const;
export const REPORT_TEMPLATE_VERSION = "tivdoc-rtl-hebrew-report-template-v0.8.0" as const;
export const REPORT_RENDERER_VERSION = "tivdoc-canonical-hebrew-pdf-renderer-v0.8.0" as const;

type ReportTopic = Readonly<{
  topic: Wave3Topic;
  status: TopicAnalysisResult["status"];
  blockers: readonly string[];
  amount: TopicAnalysisResult["amount"];
  rule_input_sha256: string | null;
  legal_basis: Readonly<{
    readiness_decision_sha256: string | null;
    readiness_status: string | null;
    source_version_ids: readonly string[];
    instrument_ids: readonly string[];
    effective_interval: null;
    pinpoint_citations: readonly string[];
    parameter_version_ids: readonly string[];
    rule_id: string | null;
    rule_version: string | null;
  }>;
  calculation_trace: TopicAnalysisResult["trace"];
}>;

export type CanonicalCaseReport = Readonly<{
  schema_version: typeof REPORT_SCHEMA;
  template_version: typeof REPORT_TEMPLATE_VERSION;
  report_id: string;
  report_revision: number;
  case_id: string;
  analysis_run_id: string;
  analysis_result_sha256: string;
  period: AnalysisResultBundle["period"];
  as_of: string;
  requested_scope: readonly Wave3Topic[];
  facts_snapshot_sha256: string;
  facts: AnalysisResultBundle["facts"];
  unresolved_facts: readonly Readonly<{ fact_id: string; path: string; status: string; conflicting_fact_ids: readonly string[] }>[];
  catalog_sha256: string;
  topics: readonly ReportTopic[];
  coverage_complete: boolean;
  known_subtotal: AnalysisResultBundle["known_subtotal"];
  subtotal_label: "known_subtotal_only_not_total_entitlement" | "complete_coverage_known_subtotal";
  limitations: readonly string[];
  blockers: readonly string[];
  review: Readonly<{
    status: "awaiting_exact_hash_human_approval";
    decision_schema_version: "tivdoc-case-review-decision-v0.6.0";
    reviewer_decision_metadata: null;
    decision_metadata_location: "detached_hash_bound_review_receipt";
    approval_binding_field: "report_sha256";
    monetary_override_permitted: false;
  }>;
}>;

export class DeterministicCaseReportBuilder implements ReportBuilderPort {
  readonly #hash: CanonicalHashPort;
  readonly #ids: DeterministicIdPort;

  constructor(hash: CanonicalHashPort, ids: DeterministicIdPort) {
    this.#hash = hash;
    this.#ids = ids;
  }

  async build(bundle: AnalysisResultBundle): Promise<DeterministicReportArtifacts> {
    const reportIdentityHash = this.#hash.hashCanonical({
      schema_version: REPORT_SCHEMA,
      case_id: bundle.case_id,
      case_revision: bundle.case_revision,
      analysis_run_id: bundle.analysis_run_id,
      analysis_result_sha256: bundle.result_sha256,
      template_version: REPORT_TEMPLATE_VERSION,
    });
    const reportId = this.#ids.derive("case-report", reportIdentityHash);
    const report = buildCanonicalReport(bundle, reportId);
    const json = Buffer.from(canonicalJson(report), "utf8");
    const jsonSha = this.#hash.hashBytes(json);
    const html = Buffer.from(renderHebrewHtml(report, jsonSha), "utf8");
    const htmlSha = this.#hash.hashBytes(html);
    const pdf = await renderDeterministicPdf(report, jsonSha, htmlSha);
    const pdfSha = this.#hash.hashBytes(pdf);
    const manifestPayload = {
      schema_version: "tivdoc-case-report-manifest-v0.8.0",
      report_id: reportId,
      report_revision: report.report_revision,
      case_id: report.case_id,
      analysis_result_sha256: bundle.result_sha256,
      template_version: REPORT_TEMPLATE_VERSION,
      bindings: {
        case: {
          case_id: report.case_id,
          case_revision: report.report_revision,
          analysis_run_id: report.analysis_run_id,
        },
        facts: { facts_snapshot_sha256: report.facts_snapshot_sha256 },
        catalog: { catalog_sha256: report.catalog_sha256 },
        rules_and_parameters: report.topics.map((topic) => ({
          topic: topic.topic,
          rule_input_sha256: topic.rule_input_sha256,
          readiness_decision_sha256: topic.legal_basis.readiness_decision_sha256,
          source_version_ids: topic.legal_basis.source_version_ids,
          parameter_version_ids: topic.legal_basis.parameter_version_ids,
          rule_id: topic.legal_basis.rule_id,
          rule_version: topic.legal_basis.rule_version,
        })),
        approval: {
          decision_schema_version: report.review.decision_schema_version,
          binding_field: report.review.approval_binding_field,
          decision_metadata_location: report.review.decision_metadata_location,
          monetary_override_permitted: report.review.monetary_override_permitted,
        },
        renderer: {
          renderer_version: REPORT_RENDERER_VERSION,
          template_version: REPORT_TEMPLATE_VERSION,
          font_family: HEBREW_REPORT_FONT.family,
          font_version: HEBREW_REPORT_FONT.version,
          font_sha256: HEBREW_REPORT_FONT.sha256,
          implementation_binding_sha256: this.#hash.hashCanonical({
            renderer_version: REPORT_RENDERER_VERSION,
            template_version: REPORT_TEMPLATE_VERSION,
            font_sha256: HEBREW_REPORT_FONT.sha256,
          }),
        },
      },
      components: [
        { path: "report.json", media_type: "application/json", sha256: jsonSha, byte_count: json.byteLength },
        { path: "report.html", media_type: "text/html; charset=utf-8", sha256: htmlSha, byte_count: html.byteLength },
        { path: "report.pdf", media_type: "application/pdf", sha256: pdfSha, byte_count: pdf.byteLength },
      ],
      manifest_self_excluded_from_components: true,
    };
    const manifest = Buffer.from(canonicalJson(manifestPayload), "utf8");
    const manifestSha = this.#hash.hashBytes(manifest);
    const reportSha = this.#hash.hashCanonical({
      report_id: reportId,
      report_revision: report.report_revision,
      analysis_result_sha256: bundle.result_sha256,
      json_sha256: jsonSha,
      html_sha256: htmlSha,
      pdf_sha256: pdfSha,
      manifest_sha256: manifestSha,
    });
    return immutable({
      report_id: reportId,
      report_revision: report.report_revision,
      analysis_result_sha256: bundle.result_sha256,
      json: new Uint8Array(json),
      html: new Uint8Array(html),
      pdf: new Uint8Array(pdf),
      manifest: new Uint8Array(manifest),
      json_sha256: jsonSha,
      html_sha256: htmlSha,
      pdf_sha256: pdfSha,
      manifest_sha256: manifestSha,
      report_sha256: reportSha,
    });
  }
}

export function buildCanonicalReport(bundle: AnalysisResultBundle, reportId: string): CanonicalCaseReport {
  const byTopic = new Map(bundle.topic_results.map((result) => [result.topic, result]));
  const topics = WAVE3_TOPICS.map((topic) => reportTopic(topic, byTopic.get(topic)));
  const blockers = [...new Set(topics.flatMap((topic) => topic.blockers))].sort();
  const unresolved = bundle.facts
    .filter((fact) => fact.status === "missing" || fact.status === "conflicted" || fact.status === "needs_confirmation")
    .map((fact) => ({ fact_id: fact.fact_id, path: fact.path, status: fact.status, conflicting_fact_ids: [...fact.conflicting_fact_ids].sort() }))
    .sort((a, b) => a.path.localeCompare(b.path, "en") || a.fact_id.localeCompare(b.fact_id, "en"));
  return immutable({
    schema_version: REPORT_SCHEMA,
    template_version: REPORT_TEMPLATE_VERSION,
    report_id: reportId,
    report_revision: bundle.case_revision,
    case_id: bundle.case_id,
    analysis_run_id: bundle.analysis_run_id,
    analysis_result_sha256: bundle.result_sha256,
    period: bundle.period,
    as_of: bundle.as_of,
    requested_scope: [...WAVE3_TOPICS],
    facts_snapshot_sha256: bundle.facts_snapshot_sha256,
    facts: [...bundle.facts].sort((a, b) => a.path.localeCompare(b.path, "en") || a.fact_id.localeCompare(b.fact_id, "en")),
    unresolved_facts: unresolved,
    catalog_sha256: bundle.catalog_sha256,
    topics,
    coverage_complete: bundle.coverage_complete,
    known_subtotal: bundle.known_subtotal,
    subtotal_label: bundle.coverage_complete ? "complete_coverage_known_subtotal" : "known_subtotal_only_not_total_entitlement",
    limitations: [
      "deterministic_engine_output_requires_exact_hash_human_report_approval",
      "case_report_approval_does_not_replace_source_parameter_or_rule_approval",
      ...(bundle.coverage_complete ? [] : ["blocked_or_unknown_topics_are_not_zero_and_are_excluded_from_known_subtotal"]),
    ],
    blockers,
    review: {
      status: "awaiting_exact_hash_human_approval",
      decision_schema_version: "tivdoc-case-review-decision-v0.6.0",
      reviewer_decision_metadata: null,
      decision_metadata_location: "detached_hash_bound_review_receipt",
      approval_binding_field: "report_sha256",
      monetary_override_permitted: false,
    },
  });
}

function reportTopic(topic: Wave3Topic, result: TopicAnalysisResult | undefined): ReportTopic {
  if (!result) {
    return immutable({
      topic,
      status: "error",
      blockers: ["TOPIC_RESULT_MISSING"],
      amount: null,
      rule_input_sha256: null,
      legal_basis: emptyLegalBasis(),
      calculation_trace: null,
    });
  }
  return immutable({
    topic,
    status: result.status,
    blockers: [...result.blockers].sort(),
    amount: result.amount,
    rule_input_sha256: result.rule_input_sha256,
    legal_basis: {
      readiness_decision_sha256: result.legal_readiness?.decision_sha256 ?? null,
      readiness_status: result.legal_readiness?.status ?? null,
      source_version_ids: [...(result.legal_readiness?.operative_candidate_source_version_ids ?? [])].sort(),
      instrument_ids: [],
      effective_interval: null,
      pinpoint_citations: [],
      parameter_version_ids: [],
      rule_id: result.trace?.rule.rule_id ?? null,
      rule_version: result.trace?.rule.rule_version ?? null,
    },
    calculation_trace: result.trace,
  });
}

function emptyLegalBasis(): ReportTopic["legal_basis"] {
  return immutable({
    readiness_decision_sha256: null,
    readiness_status: null,
    source_version_ids: [],
    instrument_ids: [],
    effective_interval: null,
    pinpoint_citations: [],
    parameter_version_ids: [],
    rule_id: null,
    rule_version: null,
  });
}

export function renderHebrewHtml(report: CanonicalCaseReport, jsonSha256: string): string {
  const subtotal = report.known_subtotal === null
    ? "לא קיים סכום ביניים ידוע"
    : `${escapeHtml(report.known_subtotal.currency)} ${report.known_subtotal.minor_units} יחידות משנה`;
  const subtotalWarning = report.coverage_complete
    ? "כיסוי כל הנושאים הושלם עבור הקלט המקובע."
    : "סכום ביניים ידוע בלבד. אינו הסכום הכולל המגיע. נושאים חסומים או לא ידועים אינם אפס.";
  const topics = report.topics.map((topic) => `<section class="topic" data-topic="${escapeHtml(topic.topic)}"><h3>${escapeHtml(hebrewTopicLabel(topic.topic))}</h3><dl><dt>מצב</dt><dd><bdi dir="ltr">${escapeHtml(topic.status)}</bdi></dd><dt>חסמים</dt><dd><bdi dir="ltr">${escapeHtml(topic.blockers.join(", ") || "NONE")}</bdi></dd><dt>סכום</dt><dd><bdi dir="ltr">${topic.amount ? `${escapeHtml(topic.amount.currency)} ${topic.amount.minor_units}` : "NOT_CALCULATED"}</bdi></dd><dt>אסמכתאות</dt><dd><bdi dir="ltr">${escapeHtml(topic.legal_basis.source_version_ids.join(", ") || "NO_ACTIVE_SOURCE")}</bdi></dd></dl></section>`).join("");
  return `<!doctype html>\n<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><title>דוח Tivdoc ${escapeHtml(report.report_id)}</title><style>html{background:#f3f5f4}body{font-family:"DejaVu Sans",Arial,sans-serif;direction:rtl;max-width:920px;margin:24px auto;padding:32px;background:#fff;color:#142a30}table{border-collapse:collapse;width:100%}th,td{border:1px solid #9aa4b2;padding:8px;text-align:right}.warning{border:2px solid #9b2c2c;padding:12px;background:#fff5f5}.watermark{border:2px dashed #a64f3d;color:#a64f3d;text-align:center;font-weight:700;padding:12px}bdi,code{direction:ltr;unicode-bidi:isolate;font-family:"DejaVu Sans",monospace}.topics{display:grid;gap:12px}.topic{border:1px solid #afbbb8;padding:12px;break-inside:avoid}.topic h3{margin:0 0 8px}.topic dl{display:grid;grid-template-columns:8rem 1fr;margin:0}.topic dt,.topic dd{padding:4px;margin:0;border-bottom:1px solid #e4e8e7}</style></head><body><p class="watermark">${SYNTHETIC_REPORT_WATERMARK}</p><h1>דוח בדיקה דטרמיניסטי</h1><p>מזהה תיק: <code>${escapeHtml(report.case_id)}</code></p><p>מזהה דוח: <code>${escapeHtml(report.report_id)}</code></p><p>תקופה: <bdi dir="ltr">${escapeHtml(report.period.start_date)} - ${escapeHtml(report.period.end_date)}</bdi></p><p>נכון ליום: <bdi dir="ltr">${escapeHtml(report.as_of)}</bdi></p><p>SHA-256 של JSON: <code>${jsonSha256}</code></p><h2>כיסוי שבעה נושאים</h2><div class="topics">${topics}</div><h2>סכום ביניים</h2><p><bdi dir="ltr">${subtotal}</bdi></p><p class="warning">${subtotalWarning}</p><h2>מגבלות</h2><ul>${report.limitations.map((item) => `<li><bdi dir="ltr">${escapeHtml(item)}</bdi></li>`).join("")}</ul><p>נדרשת החלטת בודק אנושי הקשורה ל-hash המדויק. אין אפשרות לעקוף סכום מנוע באופן ידני.</p></body></html>\n`;
}

async function renderDeterministicPdf(report: CanonicalCaseReport, jsonSha256: string, htmlSha256: string): Promise<Uint8Array> {
  return renderCanonicalHebrewPdf(report, jsonSha256, htmlSha256);
}

export function canonicalReportPdfFilename(reportId: string): string {
  const safeId = reportId.normalize("NFKC").replace(/[^a-zA-Z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 96);
  if (safeId.length === 0) throw new TypeError("canonical_report_filename_identifier_invalid");
  return `tivdoc-synthetic-report-${safeId}.pdf`;
}

export function canonicalReportPdfContentDisposition(reportId: string): string {
  const filename = canonicalReportPdfFilename(reportId);
  return `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export async function reopenReportPdf(bytes: Uint8Array): Promise<Readonly<{ page_count: number; title: string; subject: string }>> {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  return immutable({ page_count: pdf.getPageCount(), title: pdf.getTitle() ?? "", subject: pdf.getSubject() ?? "" });
}
