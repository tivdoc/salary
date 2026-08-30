import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "../rule-runtime/canonical.ts";
import { WAVE3_TOPICS } from "../wave3/contracts.ts";
import { BlankGoldenImportLedger, assertGoldenTemplateCannotApprove, buildBlankGoldenCaseTemplates, diffGoldenTemplateVersions, validateBlankGoldenCaseTemplate } from "./golden-case-templates.ts";

describe("V07-P4-GOLDEN blank legal workflow", () => {
  it("generates exactly 42 hash-bound blank templates, six per topic", () => {
    const templates = buildBlankGoldenCaseTemplates();
    expect(templates).toHaveLength(42);
    for (const topic of WAVE3_TOPICS) expect(templates.filter((item) => item.topic === topic)).toHaveLength(6);
    expect(templates.every((item) => item.approval_state === "blank_not_approvable" && !item.legal_ground_truth)).toBe(true);
    expect(() => assertGoldenTemplateCannotApprove(templates[0])).toThrow("BLANK_GOLDEN_TEMPLATE_CANNOT_BE_APPROVED");
  });

  it("imports strictly, idempotently and append-only, then invalidates dependencies", () => {
    const template = buildBlankGoldenCaseTemplates()[0];
    const ledger = new BlankGoldenImportLedger();
    const first = ledger.importBlank({ template, idempotency_key: "golden-import-0001", reason_code: "BLANK_TEMPLATE_GENERATED" });
    const replay = ledger.importBlank({ template, idempotency_key: "golden-import-0001", reason_code: "BLANK_TEMPLATE_GENERATED" });
    expect(first.idempotent_replay).toBe(false);
    expect(replay.idempotent_replay).toBe(true);
    expect(ledger.events()).toHaveLength(1);
    const invalidated = ledger.invalidateDependency({ template_id: template.template_id, expected_template_sha256: template.content_sha256, dependency_sha256: "d".repeat(64), idempotency_key: "golden-invalidate-0001", reason_code: "DEPENDENCY_MUTATED" });
    expect(invalidated).toMatchObject({ revision: 2, state: "invalidated" });
    expect(ledger.events()).toHaveLength(2);
    expect(ledger.events()[1].prior_event_sha256).toBe(ledger.events()[0].event_sha256);
  });

  it("rejects byte mutation, idempotency conflicts and same-id replacement", () => {
    const template = buildBlankGoldenCaseTemplates()[0];
    expect(() => validateBlankGoldenCaseTemplate({ ...template, topic: "travel" })).toThrow("GOLDEN_TEMPLATE_CONTENT_HASH_MISMATCH");
    const ledger = new BlankGoldenImportLedger();
    ledger.importBlank({ template, idempotency_key: "golden-import-0002", reason_code: "BLANK_TEMPLATE_GENERATED" });
    expect(() => ledger.importBlank({ template, idempotency_key: "golden-import-0002", reason_code: "DIFFERENT_REASON" })).toThrow("GOLDEN_IDEMPOTENCY_CONFLICT");
    const { content_sha256: omittedTemplateSha256, ...content } = template;
    void omittedTemplateSha256;
    const replacementContent = { ...content, topic: "travel" as const };
    const replacement = { ...replacementContent, content_sha256: canonicalSha256(replacementContent) };
    expect(() => ledger.importBlank({ template: replacement, idempotency_key: "golden-import-0003", reason_code: "BLANK_TEMPLATE_GENERATED" })).toThrow("GOLDEN_TEMPLATE_APPEND_ONLY_VERSION_REQUIRED");
  });

  it("produces deterministic version diffs without converting blanks into approvals", () => {
    const templates = buildBlankGoldenCaseTemplates();
    const { content_sha256: omittedTemplateSha256, ...content } = templates[0];
    void omittedTemplateSha256;
    const changedContent = { ...content, topic: "travel" as const };
    const changed = validateBlankGoldenCaseTemplate({ ...changedContent, content_sha256: canonicalSha256(changedContent) });
    const right = [changed, ...templates.slice(1, -1)];
    const first = diffGoldenTemplateVersions(templates, right);
    const replay = diffGoldenTemplateVersions([...templates].reverse(), [...right].reverse());
    expect(first).toEqual(replay);
    expect(first.rows.some((row) => row.status === "changed")).toBe(true);
    expect(first.rows.some((row) => row.status === "removed")).toBe(true);
  });
});
