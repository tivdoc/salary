import { describe, expect, it } from "vitest";
import { executeRuleSpec } from "../legal-operations/rulespec.ts";
import { SYNTHETIC_SEVEN_TOPIC_FIXTURES } from "../legal-operations/synthetic-fixtures.ts";
import { canonicalSha256 } from "../rule-runtime/canonical.ts";
import { WAVE3_TOPICS } from "../wave3/contracts.ts";
import { buildSevenRuleSpecAuthoringSkeletons } from "./rulespec-authoring.ts";
import {
  OPEN_DECISION_MIN_WAGE_HOURLY_DIVISOR,
  OPEN_DECISION_PENSION_WAGE_CAP_SECTION,
  OPEN_DECISION_CONVALESCENCE_2026_RATE_PERIOD,
  OPEN_DECISION_PENSION_2011_2016_PRECEDENCE,
  assertRuleSpecTemplateBindable,
  buildRuleSpecTemplate,
  buildSevenRuleSpecTemplates,
  ruleSpecTemplateBindingRefusals,
} from "./rulespec-templates.ts";

// R-2 acceptance. Seven templates, hash-pinned, non-operative, carrying no
// legal content — and an executor that genuinely refuses to run one.

// The repository's own definition of a direct legal literal, from the
// activation linter: a number, or a string that is entirely a number or a
// fraction. Reused rather than reinvented so "no numeric literal" means here
// exactly what it already means one module over.
function isDirectLiteral(value: unknown): boolean {
  return typeof value === "number" || (typeof value === "string" && /^(?:-?\d+(?:\.\d+)?|\d+\/\d+)$/u.test(value));
}

function walk(value: unknown, path: string, hits: string[]) {
  if (isDirectLiteral(value)) { hits.push(`${path}=${String(value)}`); return; }
  if (Array.isArray(value)) { value.forEach((entry, index) => walk(entry, `${path}[${index}]`, hits)); return; }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`, hits);
  }
}

describe("R-2 blank RuleSpec templates", () => {
  it("builds exactly one template per topic, non-operative and hash-pinned", () => {
    const templates = buildSevenRuleSpecTemplates();
    expect(templates).toHaveLength(7);
    expect(templates.map((template) => template.topic)).toEqual(WAVE3_TOPICS);
    for (const template of templates) {
      expect(template.state).toBe("non_operative");
      expect(template.catalog_boundary).toBe("real_inactive");
      const { content_sha256: pinned, ...content } = template;
      expect(canonicalSha256(content)).toBe(pinned);
    }
    expect(new Set(templates.map((template) => template.content_sha256)).size).toBe(7);
  });

  it("extends the seven authoring skeletons rather than sitting beside them", () => {
    // Provenance is the skeleton's own content hash, so the two cannot drift:
    // change a skeleton and every template built on it changes with it.
    const skeletons = buildSevenRuleSpecAuthoringSkeletons();
    for (const template of buildSevenRuleSpecTemplates()) {
      const skeleton = skeletons.find((entry) => entry.topic === template.topic)!;
      expect(template.derived_from).toEqual({
        skeleton_id: skeleton.skeleton_id,
        skeleton_content_sha256: skeleton.content_sha256,
      });
      expect(template.inputs.map((input) => input.fact_path)).toEqual([...skeleton.available_fact_paths]);
    }
  });

  it("any edit changes the content hash — the pin is over the whole template, not a prefix of it", () => {
    const template = buildRuleSpecTemplate("minimum_wage");
    const { content_sha256: original, ...content } = template;
    const mutations: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["parameter slot unit", { ...content, parameter_slots: content.parameter_slots.map((slot, index) => index === 0 ? { ...slot, unit: "ratio" } : slot) }],
      ["decision id dropped", { ...content, parameter_slots: content.parameter_slots.map((slot) => ({ ...slot, decision_id: null })) }],
      ["input provenance widened", { ...content, inputs: content.inputs.map((input, index) => index === 0 ? { ...input, provenance_allowed: ["documented", "declared", "derived"] } : input) }],
      ["citation slot re-pointed", { ...content, citation_slots: content.citation_slots.map((slot, index) => index === 0 ? { ...slot, supports_step: "step.minimum_wage.other" } : slot) }],
      ["output unit", { ...content, outputs: content.outputs.map((output) => ({ ...output, unit: "days" })) }],
      ["precedence slot renamed", { ...content, precedence_slot: { ...content.precedence_slot, slot_id: "slot.minimum_wage.precedence_v2" } }],
    ];
    for (const [name, mutated] of mutations) {
      expect(canonicalSha256(mutated), name).not.toBe(original);
    }
    // And the refusal path notices a template whose hash no longer covers it.
    const tampered = { ...template, parameter_slots: template.parameter_slots.map((slot) => ({ ...slot, decision_id: null })) } as typeof template;
    expect(ruleSpecTemplateBindingRefusals(tampered).map((refusal) => refusal.code))
      .toContain("RULESPEC_TEMPLATE_CONTENT_HASH_MISMATCH");
  });

  it("contains no numeric literal and no legal citation body", () => {
    for (const template of buildSevenRuleSpecTemplates()) {
      const hits: string[] = [];
      // Every legal-content-bearing region. There is no resource policy or
      // other engineering-bound block on this schema to carve out — the whole
      // template is walked.
      walk(template, template.template_id, hits);
      expect(hits, template.topic).toEqual([]);
      // A citation slot names the step it must support and nothing else: no
      // source, no pinpoint, and never pre-marked verified.
      for (const slot of template.citation_slots) {
        expect(slot.source_version_id).toBeNull();
        expect(slot.pinpoint).toBeNull();
        expect(slot.verified).toBe(false);
      }
    }
  });

  it("names only open decisions that actually exist, on the slots that actually carry them", () => {
    const byTopic = new Map(buildSevenRuleSpecTemplates().map((template) => [template.topic, template]));
    const decisions = [...byTopic.values()]
      .flatMap((template) => template.parameter_slots)
      .map((slot) => slot.decision_id)
      .filter((id): id is string => id !== null);
    expect(new Set(decisions)).toEqual(new Set([
      OPEN_DECISION_MIN_WAGE_HOURLY_DIVISOR,
      OPEN_DECISION_PENSION_WAGE_CAP_SECTION,
      OPEN_DECISION_CONVALESCENCE_2026_RATE_PERIOD,
      OPEN_DECISION_PENSION_2011_2016_PRECEDENCE,
    ]));
    expect(byTopic.get("minimum_wage")!.parameter_slots.find((slot) => slot.slot_id.endsWith("hourly_floor"))!.decision_id)
      .toBe(OPEN_DECISION_MIN_WAGE_HOURLY_DIVISOR);
    expect(byTopic.get("pension")!.parameter_slots.find((slot) => slot.slot_id.endsWith("mandatory_wage_cap"))!.decision_id)
      .toBe(OPEN_DECISION_PENSION_WAGE_CAP_SECTION);
    expect(byTopic.get("convalescence")!.parameter_slots.find((slot) => slot.slot_id.endsWith("daily_rate"))!.decision_id)
      .toBe(OPEN_DECISION_CONVALESCENCE_2026_RATE_PERIOD);
    expect(byTopic.get("pension")!.parameter_slots.find((slot) => slot.slot_id.endsWith("employee_contribution_rate"))!.decision_id)
      .toBe(OPEN_DECISION_PENSION_2011_2016_PRECEDENCE);
  });

  it("forbids inferred provenance on every input of every template, and derived on all of them", () => {
    for (const template of buildSevenRuleSpecTemplates()) {
      for (const input of template.inputs) {
        expect(input.provenance_allowed, input.input_id).not.toContain("inferred");
        expect(input.provenance_allowed, input.input_id).not.toContain("derived");
        expect(input.provenance_forbidden, input.input_id).toContain("inferred");
        expect(input.missing_blocker_code).toBe("BLOCKED_MISSING_FACT");
        expect(input.conflicted_blocker_code).toBe("BLOCKED_CONFLICTED_FACT");
        // Allowed and forbidden are disjoint: a template cannot say both.
        for (const provenance of input.provenance_allowed) {
          expect(input.provenance_forbidden, input.input_id).not.toContain(provenance);
        }
      }
    }
  });

  it("refuses every template as unbound — all seven, every slot, listed not first-one-wins", () => {
    for (const template of buildSevenRuleSpecTemplates()) {
      const refusals = ruleSpecTemplateBindingRefusals(template);
      expect(refusals.filter((refusal) => refusal.code === "RULESPEC_TEMPLATE_PARAMETER_SLOT_UNBOUND"))
        .toHaveLength(template.parameter_slots.length);
      expect(refusals.filter((refusal) => refusal.code === "RULESPEC_TEMPLATE_CITATION_SLOT_UNBOUND"))
        .toHaveLength(template.citation_slots.length);
      expect(refusals.map((refusal) => refusal.code)).toEqual(expect.arrayContaining([
        "RULESPEC_TEMPLATE_ROUNDING_UNBOUND",
        "RULESPEC_TEMPLATE_PERIOD_UNBOUND",
        "RULESPEC_TEMPLATE_SECTOR_POPULATION_UNBOUND",
        "RULESPEC_TEMPLATE_PRECEDENCE_UNBOUND",
      ]));
      expect(() => assertRuleSpecTemplateBindable(template)).toThrow("RULESPEC_TEMPLATE_PARAMETER_SLOT_UNBOUND");
    }
  });

  it("the executor itself refuses a package whose parameter slots are unbound — the refusal is machinery, not a label", () => {
    // The template checker above is a convenience. The property that matters
    // is that the thing which actually computes money will not run without
    // every declared parameter supplied, so a half-filled template cannot
    // produce a number by any route.
    const fixture = SYNTHETIC_SEVEN_TOPIC_FIXTURES[0];
    expect(() => executeRuleSpec({ rule: fixture.rule, facts: fixture.facts, parameters: fixture.parameters }))
      .not.toThrow();
    expect(() => executeRuleSpec({ rule: fixture.rule, facts: fixture.facts, parameters: [] }))
      .toThrow("RULESPEC_INPUT_MISSING");
    expect(() => executeRuleSpec({ rule: fixture.rule, facts: [], parameters: fixture.parameters }))
      .toThrow("RULESPEC_INPUT_MISSING");
    // Every topic's fixture, not just the first: an unbound parameter set
    // refuses for all seven.
    for (const entry of SYNTHETIC_SEVEN_TOPIC_FIXTURES) {
      expect(() => executeRuleSpec({ rule: entry.rule, facts: entry.facts, parameters: [] }), entry.topic)
        .toThrow("RULESPEC_INPUT_MISSING");
    }
  });
});
