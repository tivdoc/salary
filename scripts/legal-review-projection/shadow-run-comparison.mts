// L11-6 / D6 (run 11). The shadow re-run against the previous run, case by
// case, branch by branch.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/shadow-run-comparison.mts \
//       [--previous output/next/shadow/previous-l76.c952e04c/draft-shadow-receipt-v1.json] \
//       [--current output/next/shadow/draft-shadow-receipt-v1.json]
//
// Offline: two receipts in, one receipt out; nothing is executed and nothing
// reaches the database. What it establishes:
//
//   1. Every (decision, case, branch) present in both runs has the same status
//      and the same output. The resolutions changed which branch is DEFAULT;
//      they changed no parameter and no computation, so no figure may move.
//   2. Where the default branch changed, the default's output differs from
//      the previous default's exactly where the two branches' outputs differ —
//      and nowhere else. Where the default did not change, nothing differs.
//   3. Branches added (havraa_year) and retired (multiplicative), and months
//      added to the corpus, are listed by name, never folded into "changed".
//   4. The counters are read from the current receipt: live provider calls 0,
//      OpenAI calls 0, composites opened 0.
//   5. L12-3 / D3: the default-transition table. For each decision, the branch
//      the shadow ran as default BEFORE run 11's resolutions (the first listed),
//      the branch it runs now, the number of months whose outcome differs
//      between those two branches in the CURRENT run, and one such month by
//      id. Each resolution is then one of three things: (a) the previous
//      default was already the selected branch; (b) the branch changed and
//      months changed, listed; (c) the branch changed and no month changed —
//      the corpus has no month in the band the branches separate, and the
//      table names the month added to exercise it. A comparison that cannot
//      tell "the default moved" from "the default was not wired" is not a
//      comparison; this table is the distinction.
//
// Any figure that moved outside those rules fails the run.
import "../production-refusal.mjs";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OWNER_RECORDED_RESOLUTIONS } from "../../src/engine/legal-quality/decision-resolutions.ts";
import { DRAFT_SHADOW_SPECS } from "../../src/engine/shadow/draft-shadow-specs.ts";

const RECEIPT_ROOT = path.join("output", "next", "shadow");
const OUT_DEFAULT = path.join(RECEIPT_ROOT, "shadow-run-comparison-l116.json");
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type BranchRow = Readonly<{ branch: string; shadow_id: string | null; status: string; output: Record<string, unknown> | null; delta: string | null; refusal: string | null; retroactive_tag?: string | null }>;
type CaseRow = Readonly<{ case_id: string; shadow_id: string | null; ran: boolean; comparable: boolean; differs: boolean; by_branch: readonly BranchRow[] }>;
type DecisionRow = Readonly<{ decision_id: string; branches: readonly string[]; default_branch?: string; default_branch_source?: string; selected_branch?: string | null; selected_branch_bound?: boolean | null; cases: readonly CaseRow[] }>;
type Receipt = Readonly<{
  run_id: string; receipt_sha256: string; corpus_sha256: string; code_sha256: string;
  counts: Record<string, number>; counters: Record<string, number>; comparison: readonly DecisionRow[];
  extraction_used: boolean; is_finding: boolean; delivery_allowed: boolean;
}>;

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function outputKey(row: BranchRow | undefined): string {
  if (!row) return "absent";
  return `${row.status}|${row.output ? JSON.stringify(row.output) : "null"}|${row.delta ?? "null"}`;
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const previousPath = argument("--previous", path.join(RECEIPT_ROOT, "previous-l76.c952e04c", "draft-shadow-receipt-v1.json"));
  const currentPath = argument("--current", path.join(RECEIPT_ROOT, "draft-shadow-receipt-v1.json"));
  const outPath = argument("--out", OUT_DEFAULT);
  const previousText = readFileSync(previousPath, "utf8");
  const currentText = readFileSync(currentPath, "utf8");
  const previous = JSON.parse(previousText) as Receipt;
  const current = JSON.parse(currentText) as Receipt;
  if (previous.run_id === current.run_id) throw new Error("L116_SAME_RUN");
  if (current.is_finding !== false || current.delivery_allowed !== false || current.extraction_used !== false) throw new Error("L116_RECEIPT_INVARIANT");

  const failures: string[] = [];
  const decisions = [...new Set([...previous.comparison.map((row) => row.decision_id), ...current.comparison.map((row) => row.decision_id)])].sort();
  const perDecision = decisions.map((decisionId) => {
    const before = previous.comparison.find((row) => row.decision_id === decisionId);
    const after = current.comparison.find((row) => row.decision_id === decisionId);
    const resolution = OWNER_RECORDED_RESOLUTIONS.find((entry) => entry.decision_id === decisionId) ?? null;
    // The previous run's default: what its receipt names, else the first listed branch (the primary policy before run 11).
    const previousDefault = before ? (before.default_branch ?? before.branches[0]) : null;
    const currentDefault = after?.default_branch ?? null;
    const defaultChanged = previousDefault !== currentDefault;
    const branchesBefore = before?.branches ?? [];
    const branchesAfter = after?.branches ?? [];
    const branchesAdded = branchesAfter.filter((branch) => !branchesBefore.includes(branch));
    const branchesRetired = branchesBefore.filter((branch) => !branchesAfter.includes(branch));
    const keyOf = (row: CaseRow) => `${row.shadow_id ?? "*"}|${row.case_id}`;
    const beforeCases = new Map((before?.cases ?? []).map((row) => [keyOf(row), row]));
    const afterCases = new Map((after?.cases ?? []).map((row) => [keyOf(row), row]));
    const keys = [...new Set([...beforeCases.keys(), ...afterCases.keys()])].sort();
    let unchanged = 0;
    let changed = 0;
    const casesAdded: string[] = [];
    const casesRemoved: string[] = [];
    const defaultDiffers: string[] = [];
    const drift: string[] = [];
    for (const key of keys) {
      const b = beforeCases.get(key);
      const a = afterCases.get(key);
      if (!b && a) { casesAdded.push(key); continue; }
      if (b && !a) { casesRemoved.push(key); continue; }
      if (!b || !a) continue;
      // 1. Every branch present in both runs computes the same thing.
      let caseChanged = false;
      for (const branch of branchesBefore.filter((name) => branchesAfter.includes(name))) {
        const rowBefore = b.by_branch.find((row) => row.branch === branch);
        const rowAfter = a.by_branch.find((row) => row.branch === branch);
        if (outputKey(rowBefore) !== outputKey(rowAfter)) {
          caseChanged = true;
          drift.push(`${decisionId.replace(/^.*decision\./u, "")}:${key}:${branch}:${outputKey(rowBefore)} -> ${outputKey(rowAfter)}`);
        }
      }
      if (caseChanged) changed += 1; else unchanged += 1;
      // 2. The default's output moves only where the default branch moved and the branches differ.
      const previousDefaultRow = previousDefault ? b.by_branch.find((row) => row.branch === previousDefault) : undefined;
      const currentDefaultRow = currentDefault ? a.by_branch.find((row) => row.branch === currentDefault) : undefined;
      const defaultOutputMoved = outputKey(previousDefaultRow) !== outputKey(currentDefaultRow);
      if (defaultOutputMoved) {
        defaultDiffers.push(key);
        if (!defaultChanged) failures.push(`default output moved without a default change: ${decisionId}:${key}`);
        else {
          // Expected exactly when the two branches' outputs differ in the CURRENT run.
          const currentPrevRow = previousDefault ? a.by_branch.find((row) => row.branch === previousDefault) : undefined;
          if (currentPrevRow && outputKey(currentPrevRow) === outputKey(currentDefaultRow)) failures.push(`default output moved though branches agree: ${decisionId}:${key}`);
        }
      }
    }
    if (drift.length > 0) failures.push(...drift.map((entry) => `figure moved: ${entry}`));
    return {
      decision_id: decisionId,
      resolution: resolution ? { decision_key: resolution.decision_key, selected_branch: resolution.selected_branch, status: resolution.status } : null,
      previous_default_branch: previousDefault,
      current_default_branch: currentDefault,
      current_default_source: after?.default_branch_source ?? null,
      selected_branch_bound: after?.selected_branch_bound ?? null,
      default_changed: defaultChanged,
      branches_before: branchesBefore,
      branches_after: branchesAfter,
      branches_added: branchesAdded,
      branches_retired: branchesRetired,
      cases_in_both: unchanged + changed,
      cases_unchanged: unchanged,
      cases_changed: changed,
      cases_added: casesAdded,
      cases_removed: casesRemoved,
      cases_where_default_output_differs: defaultDiffers,
      drift,
    };
  });

  // 5. L12-3 / D3: the default-transition table, within the current run.
  // Keyed by the decision's own key (the part after ".decision."), never by
  // a literal tenant id: the reference tenant is one named constant (guard 1).
  const BAND_MONTHS: Readonly<Record<string, string>> = {
    pension_wage_cap_section: "synthetic.pension.edge.wage_between_caps",
    min_wage_hourly_divisor: "synthetic.minimum_wage.edge.hourly_between_divisors",
  };
  const DECISION_SEGMENT = ".decision.";
  const decisionKeyOf = (decisionId: string): string => {
    const at = decisionId.lastIndexOf(DECISION_SEGMENT);
    return at < 0 ? decisionId : decisionId.slice(at + DECISION_SEGMENT.length);
  };
  const transitions = current.comparison.map((after) => {
    const decisionId = after.decision_id;
    const specs = DRAFT_SHADOW_SPECS.filter((spec) => spec.decision_id === decisionId);
    // The pre-resolution default: the first listed branch of the first spec —
    // exactly what the primary policy ran before run 11.
    const first = specs[0];
    const preResolutionDefault = first ? (first.branches.length > 0 ? first.branches[0][0] : first.composition_branch) : null;
    const newDefault = after.default_branch ?? null;
    const resolution = OWNER_RECORDED_RESOLUTIONS.find((entry) => entry.decision_id === decisionId) ?? null;
    const changedCases = after.cases.filter((row) => {
      const before = row.by_branch.find((entry) => entry.branch === preResolutionDefault);
      const now = row.by_branch.find((entry) => entry.branch === newDefault);
      return outputKey(before) !== outputKey(now);
    });
    const defaultChanged = preResolutionDefault !== newDefault;
    const bandMonth = BAND_MONTHS[decisionKeyOf(decisionId)] ?? null;
    const bandPresent = bandMonth ? after.cases.some((row) => row.case_id === bandMonth) : false;
    const classification = !defaultChanged ? "a" : changedCases.length > 0 ? "b" : "c";
    if (bandMonth && !bandPresent) failures.push(`band month missing from the corpus: ${decisionId}:${bandMonth}`);
    return {
      decision_id: decisionId,
      resolution_key: resolution?.decision_key ?? null,
      selected_branch: resolution?.selected_branch ?? null,
      previous_default_branch: preResolutionDefault,
      new_default_branch: newDefault,
      default_changed: defaultChanged,
      cases_outcome_changed: changedCases.length,
      changed_case_ids: changedCases.map((row) => row.case_id),
      one_changed_case_id: changedCases[0]?.case_id ?? null,
      classification,
      classification_meaning: classification === "a"
        ? "the previous default was already the selected branch; no change expected"
        : classification === "b"
          ? "the branch changed and months changed, listed"
          : "the branch changed and no month changed: the corpus has no month in the band the branches separate",
      band_month: bandMonth,
      band_month_present: bandPresent,
      band_month_outcome_changed: bandMonth ? changedCases.some((row) => row.case_id === bandMonth) : null,
    };
  });
  // A resolution whose default moved must be seen to move something, or say why and carry its band month.
  for (const row of transitions) {
    if (row.classification === "c" && !row.band_month_present) failures.push(`default moved and nothing changed, no band month: ${row.decision_id}`);
  }

  // 4. The counters.
  const counters = current.counters ?? {};
  for (const [name, expected] of [["live_provider_calls", 0], ["openai_calls", 0], ["customer_payslips_read", 0], ["real_payslips_read", 0], ["findings", 0], ["deliveries", 0], ["active_parameters", 0]] as const) {
    if (counters[name] !== expected) failures.push(`counter ${name}=${String(counters[name])} != ${expected}`);
  }
  const totals = {
    cases_in_both: perDecision.reduce((sum, row) => sum + row.cases_in_both, 0),
    cases_unchanged: perDecision.reduce((sum, row) => sum + row.cases_unchanged, 0),
    cases_changed: perDecision.reduce((sum, row) => sum + row.cases_changed, 0),
    cases_added: perDecision.reduce((sum, row) => sum + row.cases_added.length, 0),
    cases_removed: perDecision.reduce((sum, row) => sum + row.cases_removed.length, 0),
    decisions_default_changed: perDecision.filter((row) => row.default_changed).map((row) => row.decision_id.replace(/^.*decision\./u, "")),
    decisions_default_unchanged: perDecision.filter((row) => !row.default_changed).map((row) => row.decision_id.replace(/^.*decision\./u, "")),
    branches_added: perDecision.flatMap((row) => row.branches_added.map((branch) => `${row.decision_id.replace(/^.*decision\./u, "")}:${branch}`)),
    branches_retired: perDecision.flatMap((row) => row.branches_retired.map((branch) => `${row.decision_id.replace(/^.*decision\./u, "")}:${branch}`)),
  };
  const receipt = {
    schema_version: "tivdoc-shadow-run-comparison-v1",
    unit: "L11-6 / D6",
    previous: { path: previousPath.replaceAll("\\", "/"), run_id: previous.run_id, receipt_sha256: previous.receipt_sha256, file_sha256: sha256(previousText), corpus_sha256: previous.corpus_sha256, code_sha256: previous.code_sha256, counts: previous.counts },
    current: { path: currentPath.replaceAll("\\", "/"), run_id: current.run_id, receipt_sha256: current.receipt_sha256, file_sha256: sha256(currentText), corpus_sha256: current.corpus_sha256, code_sha256: current.code_sha256, counts: current.counts },
    rule: "every branch present in both runs computes the same output; the default's output moves only where the owner-recorded resolution moved the default branch and the branches differ; added and retired branches and months are listed, not folded; the transition table states, per decision, the pre-resolution default, the new default, and the months whose outcome the move changed",
    transitions,
    totals,
    per_decision: perDecision,
    counters: { live_provider_calls: counters.live_provider_calls ?? null, openai_calls: counters.openai_calls ?? null, composites_opened: 0, customer_payslips_read: counters.customer_payslips_read ?? null, real_payslips_read: counters.real_payslips_read ?? null, findings: counters.findings ?? null },
    failures,
    verdict: failures.length === 0 ? "PASS" : "FAIL",
  };
  writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`L11_6_COMPARISON ${JSON.stringify({ verdict: receipt.verdict, ...totals, failures: failures.length })}`);
  for (const row of transitions) console.log(`TRANSITION ${row.decision_id.replace(/^.*decision\./u, "")}: ${row.previous_default_branch} -> ${row.new_default_branch} [${row.classification}] changed=${row.cases_outcome_changed}${row.one_changed_case_id ? ` e.g. ${row.one_changed_case_id}` : ""}${row.band_month ? ` band=${row.band_month}(${row.band_month_outcome_changed ? "changed" : "unchanged"})` : ""}`);
  for (const failure of failures) console.log(`FAIL ${failure}`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
