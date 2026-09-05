// L7-7. For each open decision: every case the corpus ran through its specs,
// with the output under each branch and the difference between the
// branches — deterministic, sorted, and never a choice. Every row says
// `human_review_required: true` and `automatic_acceptance: false`; nothing
// here accepts a branch, weights one, or hides a case that did not run.
import type { ShadowExecutionRecord } from "./draft-shadow-run.ts";
import { HAVRAA_YEAR_BRANCH, havraaRateFor, havraaYearPaidFor, retroactiveTag } from "../legal-quality/convalescence-rate-table.ts";
import { defaultBranchOf } from "../legal-quality/decision-resolutions.ts";
import { DRAFT_SHADOW_SPECS } from "./draft-shadow-specs.ts";
import { classifyGapFromDeltas, gapSeverityDecision, type GapSeverity } from "./gap-severity.ts";

type Comparable = Readonly<{ amount: bigint; unit: string; kind: string }>;

function comparable(output: Record<string, unknown> | null): Comparable | null {
  if (!output) return null;
  if (output.kind === "money") return { amount: BigInt(String(output.minor_units)), unit: String(output.currency), kind: "money" };
  if (output.kind === "integer") return { amount: BigInt(String(output.value)), unit: String(output.unit), kind: "integer" };
  return null;
}

function retroactiveTagFor(paymentPeriodStart: string): string | null {
  const lookup = havraaRateFor(havraaYearPaidFor(paymentPeriodStart));
  return lookup.status === "known" ? retroactiveTag(paymentPeriodStart, lookup.row) : null;
}

export function compareBranches(executions: readonly ShadowExecutionRecord[]) {
  const decisionIds = [...new Set(executions.map((execution) => execution.decision_id).filter((id): id is string => id !== null))].sort();
  return decisionIds.map((decisionId) => {
    const mine = executions.filter((execution) => execution.decision_id === decisionId);
    const branches = [...new Set(mine.map((execution) => execution.branch ?? "single"))].sort();
    // L8-3: several specs can run under one decision (the three pension
    // contribution specs under the precedence decision), so a case row is one
    // spec's month, keyed by both, and the order is total. A COMPOSITION
    // decision is the exception by design: its branches are different specs
    // over the same month (L6-4 / D2), so its rows are keyed by the month
    // alone and the branches come from the two specs.
    const composition = DRAFT_SHADOW_SPECS.some((spec) => spec.decision_id === decisionId && spec.composition_branch !== null);
    // L11-2 / D2: the default branch — the owner-recorded resolution's selected
    // branch where one exists and is bound, the first listed otherwise. It is
    // named on the decision and every other branch's output is also stated
    // against it; nothing is dropped from the comparison because of it.
    const decisionSpecs = DRAFT_SHADOW_SPECS.filter((spec) => spec.decision_id === decisionId);
    const chosen = defaultBranchOf(decisionSpecs[0] ?? { decision_id: decisionId, branches: [] }, {
      composition_branches: decisionSpecs.map((spec) => spec.composition_branch).filter((name): name is string => name !== null),
    });
    const defaultBranch = chosen.branch ?? "single";
    // L11-3 / D3.2: where the decision separates a statutory figure from an
    // extension-order figure, each case is classed by the sign of its two
    // deltas. The class is a field; every case stays in the comparison.
    const severity = gapSeverityDecision(decisionId);
    const severityOf = (rows: ReadonlyArray<Readonly<{ branch: string; delta: string | null }>>): GapSeverity | null => {
      if (!severity) return null;
      const classed = classifyGapFromDeltas({
        statutory_delta: rows.find((row) => row.branch === severity.statutory_branch)?.delta ?? null,
        order_delta: rows.find((row) => row.branch === severity.order_branch)?.delta ?? null,
        order_bound: branches.includes(severity.order_branch),
      });
      // L12-2 / D2: the default view — a month short under the default branch
      // is a gap in the default view; short under the other reading only, it
      // is not, whatever the class says about the other reading.
      const defaultDelta = rows.find((row) => row.branch === defaultBranch)?.delta ?? null;
      return { ...classed, default_branch: defaultBranch, gap_under_default: defaultDelta === null ? null : BigInt(defaultDelta) > BigInt(0) };
    };
    const keyOf = (execution: ShadowExecutionRecord) => (composition ? `*|${execution.case_id}` : `${execution.shadow_id}|${execution.case_id}`);
    const caseKeys = [...new Set(mine.map(keyOf))].sort();
    const cases = caseKeys.map((caseKey) => {
      const [shadowKey, caseId] = caseKey.split("|");
      const shadowId = shadowKey === "*" ? null : shadowKey;
      const rows = mine.filter((execution) => keyOf(execution) === caseKey);
      const byBranch = branches.map((branch) => {
        const row = rows.find((execution) => (execution.branch ?? "single") === branch);
        return {
          branch,
          shadow_id: row?.shadow_id ?? null,
          status: row?.status ?? "not_run",
          output: row?.output ?? null,
          delta: row?.delta?.status === "computed" ? row.delta.delta : null,
          period: row?.period ?? null,
          // L11-4 / D3.4: a shortfall on the havraa_year branch in a month paid
          // before the rate was known carries the retroactive tag.
          retroactive_tag: row?.branch === HAVRAA_YEAR_BRANCH && row.delta?.status === "computed" && BigInt(row.delta.delta) > BigInt(0) && row.period
            ? retroactiveTagFor(row.period.start)
            : null,
          execution_grade: row?.provenance?.execution_grade ?? null,
          refusal: row ? (row.rejection_codes.length > 0 ? row.rejection_codes.join(",") : row.error_code) : "not_run",
        };
      });
      const ran = byBranch.filter((row) => row.status === "ran");
      const values = ran.map((row) => comparable(row.output));
      // Each branch's output against the default's, when both ran and compare.
      const defaultValue = comparable(byBranch.find((row) => row.branch === defaultBranch && row.status === "ran")?.output ?? null);
      const withDefault = byBranch.map((row) => {
        const value = row.status === "ran" ? comparable(row.output) : null;
        const difference = value && defaultValue && value.unit === defaultValue.unit
          ? { amount: (value.amount - defaultValue.amount).toString(), unit: value.unit }
          : null;
        return { ...row, is_default: row.branch === defaultBranch, difference_from_default: difference };
      });
      if (ran.length !== branches.length || values.some((value) => value === null)) {
        return { case_id: caseId, shadow_id: shadowId, ran: ran.length === branches.length, comparable: false, differs: false, by_branch: withDefault, difference: null, gap_severity: severityOf(withDefault) };
      }
      const amounts = values as Comparable[];
      const low = amounts.reduce((a, b) => (a.amount < b.amount ? a : b));
      const high = amounts.reduce((a, b) => (a.amount > b.amount ? a : b));
      const difference = high.amount - low.amount;
      return { case_id: caseId, shadow_id: shadowId, ran: true, comparable: true, differs: difference !== BigInt(0), by_branch: withDefault, gap_severity: severityOf(withDefault), difference: { amount: difference.toString(), unit: low.unit, kind: low.kind } };
    });
    // L7-9: a branch named on the decision but not bound is listed, with its
    // reason, and counted as not run — never as agreement.
    // L12-2: every spec under the decision may name an unbound branch; the union, once each.
    const unbound = [...new Map(DRAFT_SHADOW_SPECS.filter((spec) => spec.decision_id === decisionId).flatMap((spec) => spec.unbound_branches).map((entry) => [entry.branch, entry] as const)).values()];
    return {
      decision_id: decisionId,
      branches,
      unbound_branches: unbound,
      default_branch: defaultBranch,
      default_branch_source: chosen.source,
      selected_branch: chosen.selected_branch,
      selected_branch_bound: chosen.selected_bound,
      resolution_status: chosen.resolution?.status ?? null,
      gap_severity: severity ? {
        dimension: severity.dimension,
        statutory_branch: severity.statutory_branch, order_branch: severity.order_branch,
        statutory_figure: severity.statutory_figure, order_figure: severity.order_figure,
        counts: Object.fromEntries([...new Set(cases.map((entry) => entry.gap_severity?.class ?? "not_comparable"))].sort().map((name) => [name, cases.filter((entry) => (entry.gap_severity?.class ?? "not_comparable") === name).length])),
      } : null,
      cases_compared: cases.filter((entry) => entry.comparable).length,
      cases_differing: cases.filter((entry) => entry.differs).length,
      cases_not_comparable: cases.filter((entry) => !entry.comparable).length,
      human_review_required: true as const,
      automatic_acceptance: false as const,
      cases,
    };
  });
}

