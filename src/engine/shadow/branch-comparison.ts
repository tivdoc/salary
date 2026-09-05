// L7-7. For each open decision: every case the corpus ran through its specs,
// with the output under each branch and the difference between the
// branches — deterministic, sorted, and never a choice. Every row says
// `human_review_required: true` and `automatic_acceptance: false`; nothing
// here accepts a branch, weights one, or hides a case that did not run.
import type { ShadowExecutionRecord } from "./draft-shadow-run.ts";
import { DRAFT_SHADOW_SPECS } from "./draft-shadow-specs.ts";

type Comparable = Readonly<{ amount: bigint; unit: string; kind: string }>;

function comparable(output: Record<string, unknown> | null): Comparable | null {
  if (!output) return null;
  if (output.kind === "money") return { amount: BigInt(String(output.minor_units)), unit: String(output.currency), kind: "money" };
  if (output.kind === "integer") return { amount: BigInt(String(output.value)), unit: String(output.unit), kind: "integer" };
  return null;
}

export function compareBranches(executions: readonly ShadowExecutionRecord[]) {
  const decisionIds = [...new Set(executions.map((execution) => execution.decision_id).filter((id): id is string => id !== null))].sort();
  return decisionIds.map((decisionId) => {
    const mine = executions.filter((execution) => execution.decision_id === decisionId);
    const branches = [...new Set(mine.map((execution) => execution.branch ?? "single"))].sort();
    // L8-3: several specs can run under one decision (the three pension
    // contribution specs under the precedence decision), so a case row is one
    // spec's month, keyed by both, and the order is total.
    const caseKeys = [...new Set(mine.map((execution) => `${execution.shadow_id}|${execution.case_id}`))].sort();
    const cases = caseKeys.map((caseKey) => {
      const [shadowId, caseId] = caseKey.split("|");
      const rows = mine.filter((execution) => execution.shadow_id === shadowId && execution.case_id === caseId);
      const byBranch = branches.map((branch) => {
        const row = rows.find((execution) => (execution.branch ?? "single") === branch);
        return {
          branch,
          shadow_id: row?.shadow_id ?? null,
          status: row?.status ?? "not_run",
          output: row?.output ?? null,
          delta: row?.delta?.status === "computed" ? row.delta.delta : null,
          execution_grade: row?.provenance?.execution_grade ?? null,
          refusal: row ? (row.rejection_codes.length > 0 ? row.rejection_codes.join(",") : row.error_code) : "not_run",
        };
      });
      const ran = byBranch.filter((row) => row.status === "ran");
      const values = ran.map((row) => comparable(row.output));
      if (ran.length !== branches.length || values.some((value) => value === null)) {
        return { case_id: caseId, shadow_id: shadowId, ran: ran.length === branches.length, comparable: false, differs: false, by_branch: byBranch, difference: null };
      }
      const amounts = values as Comparable[];
      const low = amounts.reduce((a, b) => (a.amount < b.amount ? a : b));
      const high = amounts.reduce((a, b) => (a.amount > b.amount ? a : b));
      const difference = high.amount - low.amount;
      return { case_id: caseId, shadow_id: shadowId, ran: true, comparable: true, differs: difference !== BigInt(0), by_branch: byBranch, difference: { amount: difference.toString(), unit: low.unit, kind: low.kind } };
    });
    // L7-9: a branch named on the decision but not bound is listed, with its
    // reason, and counted as not run — never as agreement.
    const unbound = DRAFT_SHADOW_SPECS.find((spec) => spec.decision_id === decisionId)?.unbound_branches ?? [];
    return {
      decision_id: decisionId,
      branches,
      unbound_branches: unbound,
      cases_compared: cases.filter((entry) => entry.comparable).length,
      cases_differing: cases.filter((entry) => entry.differs).length,
      cases_not_comparable: cases.filter((entry) => !entry.comparable).length,
      human_review_required: true as const,
      automatic_acceptance: false as const,
      cases,
    };
  });
}

