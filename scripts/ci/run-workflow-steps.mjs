// L8-5 / D3. The CI workflow's own steps, run here in order, exactly as the
// workflow file states them — so the claim "CI fails on a real regression"
// can be proven without pushing a branch.
//
// Why not push: the workflow would run on GitHub, but a push to the
// repository can also start a preview deployment on the Vercel integration
// that serves tivdoc.com, and that integration is not visible to the engineer
// (it is on the owner's account). A deploy is not authorized. So the proof is
// this: the steps the workflow runs, run against the checked-out tree, with
// each step's exit code and the tree's commit in a receipt; run once on a
// scratch branch carrying a deliberate regression (the receipt says which
// step failed), once on the real branch (every step passes).
//
// The only step skipped is `npm ci`: the tree already carries its lockfile's
// modules, and installing is not an action this tree takes.
import "../production-refusal.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const WORKFLOW = path.join(ROOT, ".github", "workflows", "ci.yml");
const RECEIPT_ROOT = path.join(ROOT, "output", "next", "ci");

/** The workflow's steps: `- name:` followed by a single-line `run:`; `uses:` steps have no command here. */
export function workflowSteps(text) {
  const steps = [];
  let current = null;
  for (const raw of text.split(/\r?\n/u)) {
    const name = /^\s+- name: (.+)$/u.exec(raw);
    if (name) { current = { name: name[1].trim(), run: null }; steps.push(current); continue; }
    const run = /^\s+run: (.+)$/u.exec(raw);
    if (run && current) current.run = run[1].trim();
  }
  return steps;
}

function git(args) {
  return spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }).stdout.trim();
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function main() {
  const label = process.argv[2] ?? "run";
  const workflowText = readFileSync(WORKFLOW, "utf8");
  const steps = workflowSteps(workflowText).filter((step) => step.run !== null && !step.run.startsWith("npm ci"));
  const results = [];
  let failed = null;
  const startedAt = new Date().toISOString();
  for (const step of steps) {
    const started = Date.now();
    process.stdout.write(`STEP ${step.name}: ${step.run}\n`);
    const result = spawnSync(step.run, { cwd: ROOT, shell: true, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", CI: "true" } });
    const tail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split(/\r?\n/u).slice(-12);
    results.push({ name: step.name, run: step.run, exit: result.status, seconds: Math.round((Date.now() - started) / 1000), tail });
    process.stdout.write(`  exit=${result.status} (${Math.round((Date.now() - started) / 1000)}s)\n`);
    if (result.status !== 0) { failed = step.name; break; }
  }
  const receipt = {
    schema_version: "tivdoc-ci-workflow-local-proof-v1",
    unit: "L8-5",
    label,
    workflow: ".github/workflows/ci.yml",
    workflow_sha256: sha256(workflowText),
    commit: git(["rev-parse", "HEAD"]),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    worktree_clean: git(["status", "--porcelain"]) === "",
    steps_declared: steps.map((step) => step.name),
    steps_skipped: ["Install from the lockfile"],
    status: failed === null ? "PASS" : "FAIL",
    failed_step: failed,
    results,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const file = path.join(RECEIPT_ROOT, `workflow-${label}.json`);
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`CI_WORKFLOW_LOCAL ${JSON.stringify({ label, status: receipt.status, failed_step: failed, commit: receipt.commit, receipt_sha256: sha256(readFileSync(file, "utf8")) })}\n`);
  process.exit(failed === null ? 0 : 1);
}

await main();
