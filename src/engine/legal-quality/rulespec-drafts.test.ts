import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "../rule-runtime/canonical.ts";
import { WAVE3_TOPICS } from "../wave3/contracts.ts";
import {
  REGISTERED_DRAFT_PARAMETERS,
  buildRuleSpecDraft,
  buildSevenRuleSpecDrafts,
  draftBoundParameterVersionIds,
} from "./rulespec-drafts.ts";
import {
  OPEN_DECISION_MIN_WAGE_HOURLY_DIVISOR,
  OPEN_DECISION_PENSION_WAGE_CAP_SECTION,
  buildRuleSpecTemplate,
} from "./rulespec-templates.ts";

// Q-1 … Q-7 acceptance. The DEV half — that every bound parameter really is a
// `draft` row in the governance database and every unbound one really is not —
// is proven by execution in
// scripts/legal-review-projection/rulespec-draft-binding-proof.mts.

describe("Q-1..Q-7 draft RuleSpecs", () => {
  it("builds one draft per topic, all non-operative, none attested", () => {
    const drafts = buildSevenRuleSpecDrafts();
    expect(drafts).toHaveLength(7);
    expect(drafts.map((draft) => draft.topic)).toEqual(WAVE3_TOPICS);
    for (const draft of drafts) {
      expect(draft.state).toBe("draft");
      expect(draft.operative).toBe(false);
      expect(draft.catalog_boundary).toBe("real_inactive");
      expect(draft.attestations).toBe(0);
      expect(draft.tenant_id).toBe("legal.reference.il");
      const { content_sha256: pinned, ...content } = draft;
      expect(canonicalSha256(content)).toBe(pinned);
    }
  });

  it("pins the template it fills, so a template edit cannot silently change what a draft meant", () => {
    for (const draft of buildSevenRuleSpecDrafts()) {
      const template = buildRuleSpecTemplate(draft.topic);
      expect(draft.template).toEqual({
        template_id: template.template_id,
        template_content_sha256: template.content_sha256,
      });
      expect(draft.parameter_slots.map((slot) => slot.slot_id))
        .toEqual(template.parameter_slots.map((slot) => slot.slot_id));
    }
  });

  it("carries both branches of every open decision — never one, never a chosen winner", () => {
    const slots = buildSevenRuleSpecDrafts().flatMap((draft) => draft.parameter_slots);
    const decisionSlots = slots.filter((slot) => slot.decision_id !== null);
    expect(decisionSlots).toHaveLength(2);
    for (const slot of decisionSlots) {
      expect(slot.bound, slot.slot_id).toBe(true);
      if (!slot.bound) continue;
      expect(slot.decision_branches, slot.slot_id).toHaveLength(2);
      // Two distinct branches, two distinct parameter versions. One branch, or
      // two branches pointing at the same version, would be a decision made.
      expect(new Set(slot.decision_branches.map((entry) => entry.branch)).size).toBe(2);
      expect(new Set(slot.decision_branches.map((entry) => entry.parameter_version_id)).size).toBe(2);
      // Every branch's version is one this slot actually binds.
      for (const entry of slot.decision_branches) {
        expect(slot.parameter_version_ids, entry.branch).toContain(entry.parameter_version_id);
      }
    }
    expect(new Set(decisionSlots.map((slot) => slot.decision_id))).toEqual(new Set([
      OPEN_DECISION_MIN_WAGE_HOURLY_DIVISOR, OPEN_DECISION_PENSION_WAGE_CAP_SECTION,
    ]));
  });

  it("every unbound slot says why, in terms of a specific recorded block", () => {
    const unbound = buildSevenRuleSpecDrafts()
      .flatMap((draft) => draft.parameter_slots)
      .filter((slot) => !slot.bound);
    expect(unbound.length).toBeGreaterThan(0);
    for (const slot of unbound) {
      if (slot.bound) continue;
      // A reason, not a shrug: it has to name the Pool P unit and the concrete
      // artifact-level block, so a later reader can act on it rather than
      // re-derive it.
      expect(slot.slot_unbound, slot.slot_id).toMatch(/Pool P P-\d/u);
      expect(slot.slot_unbound.length, slot.slot_id).toBeGreaterThan(60);
    }
  });

  it("binds nothing that Pool P did not register, and every binding is a real version id", () => {
    const registered = new Set(REGISTERED_DRAFT_PARAMETERS
      .flatMap((entry) => entry.versions.map((version) => `${entry.parameter_id}@${version}`)));
    for (const id of draftBoundParameterVersionIds()) {
      expect(registered, id).toContain(id);
      expect(id).toMatch(/^[a-z][a-z0-9._]*@[0-9]+(\.[0-9]+){0,2}$/u);
    }
    // And no duplicate registrations, which would make "which version applies"
    // ambiguous in a way the effective period could not resolve.
    const ids = REGISTERED_DRAFT_PARAMETERS.map((entry) => entry.parameter_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("leaves every judgement slot unbound: citations, rounding, period, sector, precedence", () => {
    for (const draft of buildSevenRuleSpecDrafts()) {
      expect(draft.citation_slots_bound, draft.topic).toBe(0);
      expect(draft.rounding_policy_bound, draft.topic).toBe(false);
      expect(draft.effective_period_bound, draft.topic).toBe(false);
      expect(draft.sector_population_bound, draft.topic).toBe(false);
      expect(draft.precedence_bound, draft.topic).toBe(false);
    }
  });

  it("contains no value: a draft names parameters, it does not carry numbers", () => {
    // Version identifiers are the only digits a draft may contain, and they are
    // part of a compound id rather than a standalone quantity.
    const isBareNumber = (value: unknown) =>
      typeof value === "number" || (typeof value === "string" && /^(?:-?\d+(?:\.\d+)?|\d+\/\d+)$/u.test(value));
    const walk = (value: unknown, at: string, hits: string[]) => {
      if (isBareNumber(value)) { hits.push(`${at}=${String(value)}`); return; }
      if (Array.isArray(value)) { value.forEach((entry, index) => walk(entry, `${at}[${index}]`, hits)); return; }
      if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) walk(entry, `${at}.${key}`, hits);
    };
    for (const draft of buildSevenRuleSpecDrafts()) {
      const hits: string[] = [];
      // The two structural counters are excluded by name and checked
      // separately below: `citation_slots_bound` and `attestations` are counts
      // of this draft's own emptiness, not quantities from the law. Every other
      // field is walked.
      const { citation_slots_bound: bound, attestations, ...rest } = draft;
      expect(bound, draft.topic).toBe(0);
      expect(attestations, draft.topic).toBe(0);
      walk(rest, draft.draft_id, hits);
      // `branch` is the one place a bare numeral legitimately appears: the two
      // divisors are literally what the open question is called. Naming the
      // branch is not asserting a value — the value lives in the governance
      // database, behind two attestations.
      const unexpected = hits.filter((hit) => !/\.decision_branches\[\d+\]\.branch=/u.test(hit));
      expect(unexpected, draft.topic).toEqual([]);
    }
  });

  it("refuses to build a draft for a slot whose parameter is neither registered nor explained", () => {
    // Guarded at build time, not review time: an unregistered slot with no
    // recorded reason throws rather than quietly producing a draft with a
    // silent hole.
    expect(() => buildRuleSpecDraft("minimum_wage")).not.toThrow();
    const reasons = buildSevenRuleSpecDrafts()
      .flatMap((draft) => draft.parameter_slots)
      .filter((slot) => !slot.bound);
    expect(reasons.map((slot) => slot.parameter_id).sort()).toEqual([
      "il.convalescence.daily_rate",
      "il.pension.employee_contribution_rate",
      "il.working_time.overtime_rate_first_tier",
    ]);
  });
});
