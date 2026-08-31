import { describe, expect, it } from "vitest";
import { ContentAddressedIdPort, Sha256CanonicalHashPort } from "../../engine/case-operations/canonical";
import {
  canonicalReportPdfContentDisposition,
  canonicalReportPdfFilename,
  DeterministicCaseReportBuilder,
  reopenReportPdf,
} from "./deterministic-report-builder";
import { HEBREW_REPORT_FONT, HEBREW_REPORT_PAGE_COUNT, SYNTHETIC_REPORT_WATERMARK } from "./deterministic-hebrew-pdf";
import { syntheticReportBundle } from "./synthetic-report-fixture";

const hash = new Sha256CanonicalHashPort();
const ids = new ContentAddressedIdPort();

const bundle = () => syntheticReportBundle(hash);

describe("deterministic RTL report package", () => {
  it("replays stable JSON, Hebrew HTML, PDF and manifest bytes", async () => {
    const builder = new DeterministicCaseReportBuilder(hash, ids);
    const first = await builder.build(bundle());
    const second = await builder.build(bundle());
    expect(second).toEqual(first);
    expect(first.json_sha256).toBe(hash.hashBytes(first.json));
    expect(first.html_sha256).toBe(hash.hashBytes(first.html));
    expect(first.pdf_sha256).toBe(hash.hashBytes(first.pdf));
    expect(first.manifest_sha256).toBe(hash.hashBytes(first.manifest));
    expect(first.report_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("contains all seven topic slots and labels partial subtotal as non-total", async () => {
    const artifacts = await new DeterministicCaseReportBuilder(hash, ids).build(bundle());
    const json = JSON.parse(Buffer.from(artifacts.json).toString("utf8")) as {
      topics: unknown[];
      coverage_complete: boolean;
      subtotal_label: string;
      review: { monetary_override_permitted: boolean };
    };
    const html = Buffer.from(artifacts.html).toString("utf8");
    expect(json.topics).toHaveLength(7);
    expect(json.coverage_complete).toBe(false);
    expect(json.subtotal_label).toBe("known_subtotal_only_not_total_entitlement");
    expect(json.review.monetary_override_permitted).toBe(false);
    expect(html).toContain('<html lang="he" dir="rtl">');
    expect(html).toContain("סכום ביניים ידוע בלבד. אינו הסכום הכולל המגיע");
    expect(html).toContain("נושאים חסומים או לא ידועים אינם אפס");
    expect(html).toContain(SYNTHETIC_REPORT_WATERMARK);
    expect((html.match(/<section class="topic"/gu) ?? [])).toHaveLength(7);
    expect(html).not.toMatch(/(?:src|href)=["']https?:/u);
  });

  it("reopens a four-page A4 PDF with an embedded Hebrew font and no active content", async () => {
    const artifacts = await new DeterministicCaseReportBuilder(hash, ids).build(bundle());
    const reopened = await reopenReportPdf(artifacts.pdf);
    expect(reopened.page_count).toBe(HEBREW_REPORT_PAGE_COUNT);
    expect(reopened.title).toContain(artifacts.report_id);
    expect(reopened.subject).toContain(bundle().case_id);
    expect(reopened.subject).toContain(bundle().result_sha256);
    expect(reopened.subject).toContain(artifacts.json_sha256);
    expect(reopened.subject).toContain(artifacts.html_sha256);
    const manifest = JSON.parse(Buffer.from(artifacts.manifest).toString("utf8")) as { components: Array<{ path: string; sha256: string }> };
    expect(manifest.components.map((item) => item.path)).toEqual(["report.json", "report.html", "report.pdf"]);
    expect(manifest.components.map((item) => item.sha256)).toEqual([artifacts.json_sha256, artifacts.html_sha256, artifacts.pdf_sha256]);
    const rawPdf = Buffer.from(artifacts.pdf).toString("latin1");
    expect(rawPdf).toContain("/BaseFont /DejaVuSans");
    expect(rawPdf).toContain("/FontFile2");
    expect(rawPdf).toContain("/ToUnicode");
    expect(rawPdf).not.toMatch(/\/(?:JavaScript|JS|Launch|GoToR|SubmitForm|EmbeddedFiles|AcroForm|Annots)\b/u);
  });

  it("binds case, facts, catalog, rules, approval, renderer and pinned font in the manifest", async () => {
    const artifacts = await new DeterministicCaseReportBuilder(hash, ids).build(bundle());
    const manifest = JSON.parse(Buffer.from(artifacts.manifest).toString("utf8")) as {
      bindings: {
        case: { case_id: string };
        facts: { facts_snapshot_sha256: string };
        catalog: { catalog_sha256: string };
        rules_and_parameters: unknown[];
        approval: { binding_field: string; monetary_override_permitted: boolean };
        renderer: { font_sha256: string; implementation_binding_sha256: string };
      };
    };
    expect(manifest.bindings.case.case_id).toBe(bundle().case_id);
    expect(manifest.bindings.facts.facts_snapshot_sha256).toBe(bundle().facts_snapshot_sha256);
    expect(manifest.bindings.catalog.catalog_sha256).toBe(bundle().catalog_sha256);
    expect(manifest.bindings.rules_and_parameters).toHaveLength(7);
    expect(manifest.bindings.approval).toMatchObject({ binding_field: "report_sha256", monetary_override_permitted: false });
    expect(manifest.bindings.renderer.font_sha256).toBe(HEBREW_REPORT_FONT.sha256);
    expect(manifest.bindings.renderer.implementation_binding_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("produces an ASCII-safe filename and injection-resistant content disposition", () => {
    expect(canonicalReportPdfFilename("case-report:abc123")).toBe("tivdoc-synthetic-report-case-report-abc123.pdf");
    const disposition = canonicalReportPdfContentDisposition("case-report:abc123\r\nX-Injected: yes/../../report");
    expect(disposition).toMatch(/^attachment; filename="[a-zA-Z0-9._-]+\.pdf"; filename\*=UTF-8''[a-zA-Z0-9._-]+\.pdf$/u);
    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("\n");
    expect(disposition).not.toContain("/");
  });
});
