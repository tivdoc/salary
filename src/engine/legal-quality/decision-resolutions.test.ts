import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APPROVAL_RECORD_SHA256, LEGAL_OPINION_SHA256 } from "../legal-knowledge/owner-evidence.ts";
import { DRAFT_SHADOW_SPECS } from "../shadow/draft-shadow-specs.ts";
import { branchesOf } from "../shadow/draft-shadow-run.ts";
import {
  defaultBranchOf,
  OWNER_RECORDED_RESOLUTIONS,
  REJECTED_BRANCHES,
  resolutionFor,
  resolutionSha256,
  RESOLUTION_STATUS_OWNER_RECORDED,
} from "./decision-resolutions.ts";
import { SENSITIVITY_SPECS } from "./sensitivity-rulespecs.ts";

const decisionIds = [...new Set(SENSITIVITY_SPECS.map((entry) => entry.decision_id).filter((id): id is string => id !== null))];

describe("L11-2 / D2: six owner-recorded resolutions, each a default and nothing more", () => {
  it("names six of the sensitivity set's decisions once each; the seventh (L11-4 / D3.5, rest_day_daily_threshold) is open and unresolved", () => {
    expect(OWNER_RECORDED_RESOLUTIONS).toHaveLength(6);
    expect(new Set(OWNER_RECORDED_RESOLUTIONS.map((entry) => entry.decision_id)).size).toBe(6);
    expect(new Set(OWNER_RECORDED_RESOLUTIONS.map((entry) => entry.decision_key)).size).toBe(6);
    const resolved = new Set(OWNER_RECORDED_RESOLUTIONS.map((entry) => entry.decision_id));
    for (const id of resolved) expect(decisionIds).toContain(id);
    expect(decisionIds.filter((id) => !resolved.has(id))).toEqual(["legal.reference.il.decision.rest_day_daily_threshold"]);
    expect(resolutionFor("legal.reference.il.decision.rest_day_daily_threshold")).toBeNull();
  });

  it("lists the retired multiplicative branch once, with its reason, its regression guard and no place in the sensitivity set", () => {
    expect(REJECTED_BRANCHES).toEqual([expect.objectContaining({ decision_id: "legal.reference.il.decision.rest_day_overtime_composition", branch: "multiplicative", reason: "no source of any grade supports it" })]);
    expect(SENSITIVITY_SPECS.some((entry) => entry.composition_branch === "multiplicative")).toBe(false);
    expect(SENSITIVITY_SPECS.filter((entry) => entry.decision_id?.endsWith("rest_day_overtime_composition")).map((entry) => entry.composition_branch)).toEqual(["additive"]);
  });

  it("selects a branch the decision's specs know — bound, composition, or named unbound — never one they do not", () => {
    for (const resolution of OWNER_RECORDED_RESOLUTIONS) {
      const entries = SENSITIVITY_SPECS.filter((entry) => entry.decision_id === resolution.decision_id);
      const known = new Set(entries.flatMap((entry) => [
        ...entry.branches.map(([branch]) => branch),
        ...(entry.composition_branch ? [entry.composition_branch] : []),
        ...(entry.unbound_branches ?? []).map((entry) => entry.branch),
      ]));
      expect(known.has(resolution.selected_branch), `${resolution.decision_key} → ${resolution.selected_branch}`).toBe(true);
    }
  });

  it("rests on the stored evidence by hash, is owner_recorded, and carries no approver", () => {
    for (const resolution of OWNER_RECORDED_RESOLUTIONS) {
      expect(resolution.basis).toBe("lawyer_approved_opinion");
      expect(resolution.evidence_sha256).toBe(LEGAL_OPINION_SHA256);
      expect(resolution.approval_record_sha256).toBe(APPROVAL_RECORD_SHA256);
      expect(resolution.approved_on).toBe("2026-09-05");
      expect(resolution.status).toBe(RESOLUTION_STATUS_OWNER_RECORDED);
      expect(resolution.approver_identity).toBeNull();
      expect(resolution.recorded_by).toBe("owner_action");
      expect(resolution.mapping_note.length).toBeGreaterThan(40);
      expect(resolutionSha256(resolution)).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("the module cannot produce the status attested: the word appears in prose only, never as a value", () => {
    const source = readFileSync(path.join(process.cwd(), "src", "engine", "legal-quality", "decision-resolutions.ts"), "utf8");
    const code = source.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*")).join("\n");
    expect(code).not.toMatch(/["'`]attested["'`]/u);
    expect(OWNER_RECORDED_RESOLUTIONS.every((entry) => entry.status === "owner_recorded")).toBe(true);
  });

  it("records the brief's mapping where the opinion's name differs from the register's", () => {
    const byKey = Object.fromEntries(OWNER_RECORDED_RESOLUTIONS.map((entry) => [entry.decision_key, entry]));
    expect(byKey.hourly_wage_divisor.decision_id).toBe("legal.reference.il.decision.min_wage_hourly_divisor");
    expect(byKey.hourly_wage_divisor.selected_branch).toBe("182");
    expect(byKey.hourly_wage_divisor.opinion_branch_label).toBe("order_182");
    expect(byKey.pension_wage_cap_source.selected_branch).toBe("section2");
    expect(byKey.pension_2011_2016_precedence.selected_branch).toBe("order_2016_2017_rates");
    expect(byKey.rest_day_overtime_composition.selected_branch).toBe("additive");
    expect(byKey.convalescence_rate_period.decision_id).toBe("legal.reference.il.decision.convalescence_2026_rate_period");
    expect(byKey.convalescence_rate_period.selected_branch).toBe("havraa_year");
    expect(byKey.working_time_daily_threshold.selected_branch).toBe("administrative");
  });
});

describe("L11-2 / D2: the default branch — the one thing a resolution changes", () => {
  it("moves the default to the selected branch when it is bound, and keeps every branch listed", () => {
    const cap = SENSITIVITY_SPECS.find((entry) => entry.decision_id?.endsWith("pension_wage_cap_section"))!;
    const chosen = defaultBranchOf(cap);
    expect(chosen).toMatchObject({ branch: "section2", source: "owner_recorded_resolution", selected_branch: "section2", selected_bound: true });
    expect(cap.branches.map(([branch]) => branch)).toEqual(["section1", "section2"]);
  });

  it("keeps the first listed branch as default where the resolution selects it", () => {
    const hourly = SENSITIVITY_SPECS.find((entry) => entry.decision_id?.endsWith("min_wage_hourly_divisor"))!;
    expect(defaultBranchOf(hourly)).toMatchObject({ branch: "182", source: "owner_recorded_resolution", selected_bound: true });
  });

  it("runs the first bound branch and says so when the selected branch is named but unbound", () => {
    const threshold = SENSITIVITY_SPECS.find((entry) => entry.decision_id?.endsWith("working_time_daily_threshold"))!;
    expect(defaultBranchOf(threshold)).toMatchObject({ branch: "statute", source: "first_bound_fallback", selected_branch: "administrative", selected_bound: false });
  });

  it("falls back to the first listed branch only where no resolution exists, and to nothing where there is no decision", () => {
    expect(defaultBranchOf({ decision_id: "legal.reference.il.decision.nothing_recorded", branches: [["a", "1.0.0"], ["b", "2.0.0"]] }))
      .toMatchObject({ branch: "a", source: "first_listed", resolution: null });
    expect(defaultBranchOf({ decision_id: null, branches: [] })).toMatchObject({ branch: null, source: "single" });
  });

  it("refuses a resolution whose branch the spec does not know at all", () => {
    const hourly = SENSITIVITY_SPECS.find((entry) => entry.decision_id?.endsWith("min_wage_hourly_divisor"))!;
    expect(() => defaultBranchOf({ ...hourly, branches: [["999", "9.9.9"]] })).toThrow(/RESOLUTION_BRANCH_UNKNOWN/u);
  });

  it("the shadow's primary policy runs the default branch, and its all policy still runs every branch", () => {
    for (const spec of DRAFT_SHADOW_SPECS) {
      const all = branchesOf(spec, "all");
      const primary = branchesOf(spec, "primary");
      expect(primary).toHaveLength(1);
      expect(all).toContain(primary[0]);
      if (spec.decision_id !== null && spec.branches.length > 0) {
        expect(primary[0]).toBe(defaultBranchOf(spec).branch);
        expect(all).toEqual(spec.branches.map(([branch]) => branch));
      }
    }
    const cap = DRAFT_SHADOW_SPECS.find((spec) => spec.decision_id?.endsWith("pension_wage_cap_section"))!;
    expect(branchesOf(cap, "primary")).toEqual(["section2"]);
    expect(resolutionFor(cap.decision_id)?.selected_branch).toBe("section2");
  });
});
