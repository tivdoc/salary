import { describe, expect, it } from "vitest";
import { ContentAddressedIdPort, Sha256CanonicalHashPort } from "../../engine/case-operations/canonical";
import { DeterministicCaseReportBuilder, reopenReportPdf } from "./deterministic-report-builder";
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
    expect(html).toContain("סכום ביניים ידוע בלבד — אינו הסכום הכולל המגיע");
    expect(html).toContain("נושאים חסומים או לא ידועים אינם אפס");
  });

  it("reopens the PDF and recovers required identifiers and component hashes", async () => {
    const artifacts = await new DeterministicCaseReportBuilder(hash, ids).build(bundle());
    const reopened = await reopenReportPdf(artifacts.pdf);
    expect(reopened.page_count).toBe(1);
    expect(reopened.title).toContain(artifacts.report_id);
    expect(reopened.subject).toContain(bundle().case_id);
    expect(reopened.subject).toContain(bundle().result_sha256);
    expect(reopened.subject).toContain(artifacts.json_sha256);
    expect(reopened.subject).toContain(artifacts.html_sha256);
    const manifest = JSON.parse(Buffer.from(artifacts.manifest).toString("utf8")) as { components: Array<{ path: string; sha256: string }> };
    expect(manifest.components.map((item) => item.path)).toEqual(["report.json", "report.html", "report.pdf"]);
    expect(manifest.components.map((item) => item.sha256)).toEqual([artifacts.json_sha256, artifacts.html_sha256, artifacts.pdf_sha256]);
  });
});
