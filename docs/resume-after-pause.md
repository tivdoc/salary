# Resume after a pause

*Long run 10, L10-3 / L10-4 (D3). For a session that resumes weeks or months
from now, without reading the run sections of `docs/tivdoc-development-state.md`.
Everything below is at head `677ea92` (2026-09-05).*

*Freshness, last checked at long run 12 (2026-09-06). This document was not
rewritten; its digests and counts are the ones its own head carried. What has
moved since, and would mislead a resuming session if read as current: the
migration chain is **74**, not 53 (tail `202609070004`); the draft parameter
versions are **62**, not 59; the DEV database is `tivdoc_v09_devruntime01` and
not the `postgres` the dashboard shows. Everything else below still holds,
including the central point — nothing unique lives only in DEV. For the current
state read "Where the system stands (after LR12)" in
`docs/tivdoc-development-state.md`, which also carries the nine human-gate items
with their exact click paths.*

## 1. Where everything is

| copy | what | where | digest |
|---|---|---|---|
| the repository | 444 commits, every ref, `main` at `b963844` an ancestor of everything | `origin/claude/v0-10-2b-full-parallel` on GitHub (`tivdoc/salary`, public) | `git rev-parse HEAD` |
| the bundle | the same history as one file: `git clone <bundle>` restores it | `output/next/backup/salary-677ea92-20260905.bundle` and `C:\Users\smart\OneDrive\Рабочий стол\Tivdoc\backup\` | sha256 `bfb6421af3b8cc8d27cbbd2789032182e020c164f5c60586220a56f827604fb3` (restore verified: HEAD `677ea92…`, 444 commits, `fsck` clean) |
| the evidence archive | the git-ignored trees the project's receipts and the lawyer's copy depend on: `eval/legal-knowledge/` (fetched official sources, their normalized text, the manifests), `output/next/` (Pool P, Pool Q and shadow receipts, report v7, the Hebrew rendering, package v12, closure and CI receipts), `output/wave1/audit/` | `output/next/backup/evidence-19ccf7d-20260905.tar.gz` and the same OneDrive folder | sha256 `ee089bf2361dcb24ca720538dcde6c5776cf94d14647c9434db2f9c477fc18e4` (982 members, 14 MB) |
| the lawyer's copy | review package v12: report v7 with v6…v1, the Hebrew rendering (Markdown and PDF), the cited pages, decisions, draft parameters, scenario fixtures, executions and traces, the shadow receipt, summary, comparison and corpus index | `output/next/review-package-v12/` (inside the evidence archive) | manifest `9d96a71a79fc141a7aee6affcd6be62e4471b62a17a4850ffc9910679a9ac4ff`, 33 files, built twice to one hash |
| the credentials | DEV login roles' passwords, connection URLs, the owner's reviewer key pair (if generated) | `~/.tivdoc-dev/credentials.env` — **on this machine only, in no copy above, by design** | none; re-issued, never restored (§3) |

## 2. The DEV Supabase project: what pausing it would lose

Project `cpzrbidxftzqcfeqqusu` (`tivdoc-engine-dev-20260902-a7f3c1`,
eu-central-1, PostgreSQL 17, created 2026-09-01), labelled and guarded as
`DEV / SYNTHETIC ONLY / NO CUSTOMER DATA`; status at this head
`ACTIVE_HEALTHY` (read through the platform's project API, not from a
receipt). It is on the free plan. The platform documents that free-plan
projects are paused after a period of inactivity and resumed from the
dashboard; the exact window and whether it applies to this project were not
verifiable from here and were not changed — a pause is a state the owner
can reverse, not a loss.

What the project holds, and where it comes from if it is paused, reset or
deleted:

| state in DEV | regenerable from | how |
|---|---|---|
| the schema: 53 migrations, roles, RLS, definer functions, grants | the repository | `node output/next/apply-migration.mjs <name>` in filename order (the chain replay pins each file's LF hash; `scripts/supabase-dev-guard` refuses any project but this one) |
| the 59 draft parameter versions (Pool P, batches 1–16), the open decisions, the instrument selections, the batch receipts | the repository + the evidence archive (`eval/legal-knowledge/` for the cited artifacts, chunks and page images) | `scripts/legal-review-projection/pool-p-batch-{1..16}-*.mts` in order, then `instrument-selection.mts`, `legal-open-decision-withdrawal.mts` |
| the synthetic reviewer identity, sessions, ground-truth fixtures, the wave1 projection fixtures | the repository | `reviewer-registration.mts prove`, `project.mts`, `ground-truth-matrix.mts`; every fixture session is re-seeded idempotently by the proofs that need it |
| the R-14 execution traces of the sensitivity runs and the shadow (85 + 106) | the repository + the archive's receipts | `decision-sensitivity-run-v7.mts`, `draft-shadow-run-v1.mts` — new run ids and timestamps, the same figures |
| a real reviewer identity, a real attestation, an active parameter or rule | **nothing — none exists.** 0 real identities, 0 attestations, 0 active parameters, 0 active rules, 0 findings | if the owner registers a real identity before a pause, the governance ledger is append-only and that row cannot be recreated under the same id: register after resuming, not before pausing |

So the answer is: **nothing unique lives only in DEV today.** Everything it
holds is regenerated from the repository and the evidence archive, both of
which are in the bundle's folder on OneDrive. The one thing that is only on
this machine is the credentials file, and it is meant to be re-issued.

## 3. Resuming — in order

1. **Get the tree.** `git clone https://github.com/tivdoc/salary.git -b claude/v0-10-2b-full-parallel`, or `git clone <bundle>`; `npm ci` (Node 22). Confirm `git rev-parse HEAD` is `677ea92…` or a descendant, and `git merge-base --is-ancestor main HEAD`.
2. **Run what needs nothing.** `npx tsc --noEmit -p tsconfig.json`, `npm run lint`, `npm test`, `npm run build`, then the closure proof `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/production-closure/prove.mts` — or all of them as the CI workflow runs them: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/ci/run-workflow-steps.mjs resume`. Eight test files skip with a named reason on a machine without the evidence trees; restore the archive into `eval/` and `output/` and they run.
3. **Reconnect DEV.** If the project is paused, resume it from the Supabase dashboard (the owner's account). Re-issue the runtime credentials with `scripts/supabase-dev-guard/dev-credential.mts` (`issue`, `urls`, `runtime-roles`); the guard refuses every project reference but `cpzrbidxftzqcfeqqusu`. Verify the chain: `npm run platform:migration:verify`, then `scripts/supabase-dev-guard/chain-replay.mts` — if the schema is gone, apply the 53 migrations in order.
4. **Regenerate what the ledger held** only if the project was reset: Pool P batches 1–16, the selections, the withdrawal, the proofs' fixtures (§2). Every script refuses `TIVDOC_UNATTENDED` where a human is required and refuses a production environment always.
5. **Run the DEV matrix** as the freeze does — the nineteen proofs in `scripts/legal-review-projection/` and `scripts/shadow/` listed in the state doc's freeze section, then `scripts/dev-runtime/journey.mts` (17 steps). Expected: every proof PASS; the grant proof `executed 22 / denied 0 / refused_by_precondition 0 / unexplained 0` whatever its fixture session's prior state.
6. **Read the resume point** at the end of `docs/tivdoc-development-state.md` and `docs/merge-readiness.md`. The engineering backlog was exhausted at long run 10; what remains is the human gate below.

## 4. The human gate, unchanged

The owner runs `owner-reviewer-identity.mts keygen` if they have not, then
`register --reviewer-id <their.id>` at a keyboard, in an interactive shell,
with `TIVDOC_UNATTENDED` unset — after DEV is resumed, never before a pause.
Then a labour lawyer reads `docs/legal/sensitivity-report.he.md` (report v7),
confirms the seven visual readings against the pages in package v12
(`visual_confirmed: true` in the attestation, or the database refuses),
decides the six open questions, and attests as the second, independent
identity. BL-24 (the 10.6.2018 directive on an official host) and BL-25 (the
seven visual confirmations) are theirs; BL-16 is permanent. Nothing
engineering-side blocks this gate.

## 5. Things a resuming session must not do

Deploy, merge, open a pull request, change a Vercel or GitHub setting, move
any parameter, selection or spec out of `draft`, attest, read customer or
real payslip data, open the composites, call a provider, fetch from a
non-official host, create a second Supabase project, `npm install`, use a
worktree, or copy from the owner's OneDrive folder.
