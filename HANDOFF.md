## Release completion P07 checkpoint — 2026-09-07

Base P06 `f80e586`; draft PR https://github.com/tivdoc/salary/pull/2 is stacked on upload PR #1. Added session cookie refresh against actual DB expiry, revoke/logout, encrypted delivery outbox, Resend REST adapter with timeout/idempotency, Svix-verified webhook inbox, durable recipient suppression and provider-state propagation. Scheduler intentions can enqueue exact request reminders; customer text distinguishes queued from provider acceptance. New CEP-109 is explicitly inventoried with the dispatcher count updated to 41. No messages sent, no provider/DNS/production changes.

Ten actual PostgreSQL checks PASS, including concurrent workers, fencing, early/duplicate/out-of-order events, suppression, product receipts, renewal and revocation. Focused P07 tests and typecheck PASS; final lint/HEAD-dependent inventory check recorded after checkpoint. Build exited 0, with a cache-persistence ENOSPC warning; small subsequent copy edits require final integrated build. The two code/lease tests are synthetic contracts, not provider delivery. Migrations through reminder linkage were applied only to isolated release DB; webhook worker grant is checked in for the next replay.

P07 remains PARTIAL: live domain/provider/browser proof, recipient authorization and contact-change verification are outstanding. P05 complete engine composition is still open. Continue P08; do not pause the other packages. Disk capacity was partially recovered using permitted single-cache-file removal and compression; no recursive deletion succeeded and no parallel website file was changed.

## Release completion P06 checkpoint — 2026-09-07

Base P05 `9d9d706`; continuing on `codex/tivdoc-release-completion`. Field-family fallbacks retain the original code/crop and ask about the correct field. Text/choice/number validation runs in server code and SQL; document questions enter the authenticated upload flow with an exact request ID. Drafts survive a read/reload without triggering analysis. Corrections append a version, preserve the original, and invalidate source analysis. Expiry and answers are terminal alternatives; 48h/5d reminder intentions are durable and deduplicated. A reserved document can finish after request expiry without answering a newer request. Added a bounded worker command and a sourced 2026 Jerusalem service clock that unions overlapping pauses.

Validation: 129 tests/17 files PASS; 11 actual PostgreSQL checks PASS; tsc, full lint and production build PASS. Database changes applied only to isolated `tivdoc_release_replay_20260907`. No provider messages sent and no scheduler deployed. Remaining: order-bound persisted SLA (P09), reminders through provider outbox (P07), hosted schedule and browser acceptance (P11/P13). P05 full composition remains open. Current evidence: `docs/release-evidence/P06-request-db.json`.

## Release completion P05 checkpoint — 2026-09-07

Base P04 `1ffb17d`; branch `codex/tivdoc-release-completion`. Added a transactional source journal for document, questionnaire, answer, period and payment changes. Unchanged content does not enqueue another revision. The dispatcher uses the existing canonical PostgreSQL jobs repository with three attempts; mode and current-input fencing are explicit. An approved/published report must match the current input revision. Historical inputs survive changes.

Actual isolated release PostgreSQL: eight checks PASS (atomic capture, no-op retry, rollback, concurrent changes, two cases, fresh worker connection, ACL, historical hashes). Local: 16 tests across new fencing and existing durable-queue contracts PASS; typecheck PASS. Full lint PASS; migration-chain tests 5/5 PASS. Migration only in `tivdoc_release_replay_20260907`; no hosted/production deployment.

P05 remains PARTIAL: the complete saved-extraction → canonical composition → product projection transaction, parameter invalidation, scheduling entry point and actual Storage/provider journey still need integration. This checkpoint does not relabel the existing synthetic composition as live. Continue P06 independently, then return to composition integration as downstream contracts settle.

## Release P04 checkpoint — 2026-09-07

P03 follow-up `036c7ff` passed tsc/lint/build. P04 sources and AI decisions are in `docs/release-legal-research.he.md`; 224 tests/25 files, tsc/lint passed. New RuleSpecs remain inactive. No DB activation, customer analysis or deployment. Continue P05–P13 and revisit B-002/B-004/B-005 when capability changes.

## Release P03 checkpoint — 2026-09-07

P02 pushed as `0a4da4c`. Saved-upload OCR adapter and acceptance hardening implemented; local tests/build/typecheck/lint pass. Live OCR and calibration remain B-004, durable invocation continues P05. Continue P04–P13; see tracker.

## Release P02 checkpoint — 2026-09-07

Branch `codex/tivdoc-release-completion`, base `45abb7e`. P00/P01 pushed; P02 report safeguards and actual saved-report reader now tested (46 tests + tsc/lint/build, five isolated DB checks). No production deployment. Continue P03–P13 from `docs/release-completion-tracker.md`; browser and full writer remain open. Preserve the other website checkout.

# HANDOFF — Tivdoc (`tivdoc/salary`)

## Active release completion — 2026-09-07

Continue `codex/tivdoc-release-completion` using [the tracker](docs/release-completion-tracker.md), [baseline](docs/release-baseline.md), [decisions](docs/release-decisions.md) and [blockers](docs/release-blockers.md). The current owner instruction authorizes P00–P13 development and verification autonomously. Preserve the separate website work; do not roll back to the old main checkout. P00 has a fresh DEV replay and real ACL comparison; P01 is next. Historical activation gates remain closed until their evidence exists.

## 2026-09-07 update — safe document completion

**[verified]** A dedicated `codex/document-upload-integrity` branch now implements immutable uploads, case-wide reservations, explicit versioned replacement and atomic late completion. The reviewed remote base remained `5285bc5`; the additional local handoff commit `06ee5f1` was preserved before editing. Existing working copies were not modified.

Read [Document upload integrity](docs/document-upload-integrity.md) before continuing: it records the original deletion reproduction, protocol, 66 focused tests, 16 real PostgreSQL checks, 11 real Storage/HTTP checks, browser recovery evidence, seven reproduced baseline test failures, and rollout/retention dependencies. This defect correction is authorized engineering work; historical statements below that no further engineering remains do not supersede it.

**[verified]** Only the isolated DEV replay database received the migration. The application was built and exercised locally. No production migration, application deployment, merge or activation was performed. Production rollout must coordinate the migration/API/UI and expiry of legacy upsert tokens; old and abandoned objects remain retained until a separate safe retention policy exists.

---

**Written 2026-09-06 by the Claude (Cowork) session that produced long runs 9–12, at the owner's
instruction, for whoever continues the work (ChatGPT / Codex).**

Every factual claim below is marked:

- **[verified]** — checked in this repository or against a live service during the writing of this
  file, with the command named.
- **[from the runs]** — stated by a Claude Code run report in `docs/tivdoc-development-state.md`;
  reproducible by re-running the named proof, not re-checked here.
- **[not verified]** — believed true but not checked.
- **[no access]** — this session could not reach the system that would answer it.

Nothing here is guessed. Where a fact is missing, it says so.

---

## 1. Code and the point to continue from

| item | value |
|---|---|
| repository | `https://github.com/tivdoc/salary` **[verified]** (`git remote -v`) |
| repository visibility | **public** as of 2026-09-06 19:2x UTC **[verified]** — anonymous `git ls-remote` succeeded without credentials. The owner decided it should become private; that has not been done. |
| working branch | `claude/v0-10-2b-full-parallel` **[verified]** |
| handed-off commit | `5285bc56346c6ee317b82afc7e3e0a8084a3d99c` **[verified]** — local `HEAD` equals `origin/claude/v0-10-2b-full-parallel`; `git rev-list --count origin/…..HEAD` = 0. Nothing is unpushed. |
| commit subject | `fix(closure): the opt-out route's probe expected a 400 it will never send` |
| history depth | 519 commits on the branch **[verified]** |
| `main` | `b963844bdcc1c3192f24516c9154a00a5f1ac0e9`, subject *Complete GA4 server measurement and funnel reporting* **[verified]**. The branch is **497 commits ahead of `main`** **[verified]**. |
| what the live site serves | `main` **[from the runs]** — see §6. |

### Local working-tree state at handoff **[verified]**

- `git status` on Windows (`core.autocrlf=true`) shows **one** entry: untracked
  `.claude/settings.local.json` — machine-local editor/agent settings. **Deliberately not committed**
  (local configuration, not project state).
- A `git status` run from a Linux mount shows 550 files "modified" with **90,113 insertions and
  90,113 deletions**. This is **line-ending noise only** — `git diff --ignore-all-space --shortstat`
  is empty and the raw diff is `-line` / `+line^M`. **Do not commit it.** If a tool offers to
  "normalise line endings", refuse: it would rewrite 550 files for nothing and destroy diff history.
- No stash, no detached work, no uncommitted source change. **[verified]**

### Other branches and parallel work **[verified]** (`git branch -vv --all`)

Roughly 30 `codex/*` branches from earlier phases (`codex/v07-p1…p8`, `codex/v08-w1…`,
`codex/v010-w1…w9`, `codex/v010-pg-*`, `codex/v0101-*`, `codex/tivdoc-engine-foundation`), most of
them still checked out in worktrees under `C:/dev/tivdoc/worktrees/…` and
`C:/dev/tivdoc-v07-*`. **[not verified]** whether any of them holds work that never reached
`claude/v0-10-2b-full-parallel`; the branch names correspond to phases whose outcomes are described
in `docs/tivdoc-development-state.md` as merged, but that was not re-checked commit by commit.
**Before deleting any of them, check.**

### What was done to the repository for this handoff

- `HANDOFF.md` (this file) added and committed. **No merge, no deploy, no PR, no settings change.**
- One repair: a stale empty `.git/index.lock`, created when this session ran `git status` through a
  mount that could not unlink it, was removed. Without that, every `git` command in the repository
  would have failed with "Another git process seems to be running". **[verified]** it is gone.
- No secret, no customer document and no credential was read, copied, printed or committed.

---

## 2. What exists, by area, and how far each one actually goes

The rule used below: **"in code" ≠ "verified locally" ≠ "works live"**. Nothing in this table is
called finished because code was written.

| area | what changed and why | key files / commits | state |
|---|---|---|---|
| **Legal engine** | Parameters, decisions, resolutions, shadow runtime. Six open legal questions resolved and recorded as append-only `legal_decision_resolutions` (grade `owner_recorded`); an external review produced errata E1–E7, closed by owner decision without a lawyer. | pools H/D/S/R/E2/E3/L4–L10; runs 11–12; `scripts/dev-runtime/parameter-decision-matrix.mts` | **Verified on DEV, inactive by design.** 62 parameter versions, **all draft or superseded**, **0 attested**, **0 active**. 6 decisions / 8 resolution rows. **Topics 0 of 7.** **[from the runs]** |
| **Legal sources / rules** | 23 sources under a controlled import path with hashes and citations; corpus additions bound to statute text. §18 (regular wage includes fixed contractual premiums) registered as parameter #62, bound to the statute rather than to the judgment. | `scripts/legal-sources.mts`, `scripts/legal-acquisition.mts`, `output/legal-knowledge/` | **Partial.** BL-27: the 2000 framework order is fetched and verified but its *attested* import waits on a human receipt (`output/legal-knowledge/acquisition-handoff-v0.2/ACQ-V02-FRAMEWORK-EXTENSION-ORDER-2000/README`). BL-32: י"פ 7287 host refused by the allowlist. 1990 order: `acquisition_blocked`, no official host found. **[from the runs]** |
| **Document extraction** | OpenAI extraction path (`OPENAI_EXTRACTION_MODEL=gpt-5.6-sol`), benchmark suites, fact contract split into `source` / `read_by` / `verified` / `confidence`. | `src/server/engine/extraction/…`, `npm run benchmark:payslip*` | **Code only, end-to-end unproven.** Run 13-T (the trial on 7 dummy cases) has **never started** — BL-29, no `.env.local`. Ground Truth for extraction does not exist. **[from the runs]** |
| **Database** | 74 migrations in tree **[verified]** (`supabase/migrations`, tail `202609070004`). RLS forced on 66 tenant-scoped tables; definer surface 111, ungated 2, unexpected 0. | `supabase/migrations/*`, `scripts/dev-runtime/*` | **Applied on DEV only** — chain 74/74. **Remote production migrations: 0.** **[from the runs]** |
| **API / routing** | Capability split (product half vs engine half) with a canonical entry-point inventory; every new route registered before it is written. | `src/server/platform/capabilities/route-split.ts`, `canonical-entrypoints.v0.10.0.json` | **Verified locally.** Inventory 108, product-stable 97, dispatcher roots 40, app routes 19, api routes 20; closure 48/48 over both environments; `product_runtime` imports nothing from the engine, proven per route file. **[from the runs]** |
| **Customer area** | S1 access (one-time link + 6-digit code → identity-bound 30-day session, `/login`, `/cases`); S1.5 (recipient allowlist that fails closed, `refused` as a state distinct from `failed`, channel verification before identity binding, one-time path token TTL 6 h); S2 documents (twelve payslip slots, review-before-payment screen, per-file status); S2.3/S2.4 (post-payment upload, "I'll find it later" → blocking request + `awaiting_document` + paused SLA); S3.4 case screens (`/case/[id]`, `/thread`, `/documents`, `/reports`). | `src/app/case/…`, `src/app/api/…`, CEP-096…106 | **Verified locally and on DEV; not live.** Access journey 26/26; `awaiting-document.test.ts` 7/7. **[from the runs]** |
| **Payments** | Invoice4U is the live provider (on `main`) with a reconciliation workflow. The branch adds a terms-consent checkbox whose **version is recorded before checkout**. | `.github/workflows/reconcile-payments.yml` (byte-identical to `main`), `legal-terms.test.ts` 4/4 | **Live part works on `main`** **[not verified — no access to production]**. The consent addition is **code + local tests only**. |
| **Reports** | `case_report_projection` v1 — the engine↔product contract. **Three structural gates**: `activation` (active / awaiting_verification) → `applicability` (applicable / refused:`<fact>`) → `certainty` (only when both hold). A number at low certainty **cannot be constructed**. 11 refusal codes mapped to thread requests. | `case-report-projection.test.ts` 14/14 incl. "a draft parameter carries no amount"; `refusal-requests.test.ts` | **Verified locally. Zero real rows.** No role holds insert on `case_report_projections` until run 16, by design. **[from the runs]** |
| **Front end / UI** | S5 home page rebuilt to design direction B (navy #00236A / teal #12B5A8, Rubik+Heebo), **four sections deliberately absent** until real assets exist. S4 funnel hygiene: one progress indicator, per-field validation with `aria-describedby`/`aria-invalid`, abandonment reminder with opt-out, M01 dashboard reading real events. | `landing-v5.test.ts`, `funnel-progress.test.ts` 5/5, `abandonment.test.ts` 7/7 | **Verified locally and on DEV; not live.** |
| **Operations** | S6 review queue (D-10.2 positive list + D-10.3), wording-only editing enforced structurally, `recheck_required`, M01 with eight D-11 numbers where **a number with no data is a dash, never a zero**. | `report-qa.test.ts` 16/16; `report-qa-proof.mts` 12/12 on DEV | **Structure verified on DEV; the queue flow is proven only against an in-memory mirror**, because projections are unwritable until run 16. That gap is deliberate and documented. **[from the runs]** |

**Summary sentence for the next engineer:** the product is complete as *code with proofs*, and
**none of it is live**. `main` — 497 commits behind — is what customers see today.

---

## 3. Source documents and binding decisions

### In the repository

| path | what it binds |
|---|---|
| `docs/tivdoc-development-state.md` (366 KB) | The history and the authority. **Read `## Where the system stands (after LR12) — 2026-09-06` (≈ line 5274) and `## Resume point` (≈ line 5413) first.** |
| `docs/merge-readiness.md` | Exactly what a merge into `main` would and would not change, with a hash per claim. Generated at head `19ccf7d`; the shape holds, the commit count is now 497. |
| `docs/design/assets-needed.md` | Which owner-supplied asset switches on each omitted home-page section. |
| `docs/reviewer-onboarding/vladimir-kremen.he.md`, `leo-kremen.he.md` | The exact keygen/register steps for the two reviewer identities. |
| `src/config/product-offer.json` | **Binding product configuration**: 9.99 ₪ preliminary / 149 ₪ full, 15 min / 1 bd / 3 bd SLA, access TTLs, and `contact` (`info@tivdoc.com`, `0585960615`, `+972585960615`). **No component may carry a figure of its own.** |
| `src/server/platform/capabilities/route-split.ts` | Every route assigned to the product half or the engine half; a new route fails the test until it is assigned. |
| `AGENTS.md` | **687 bytes, and it is not project guidance** — it is a block that `next dev` writes itself, saying this Next version differs from training data and that `node_modules/next/dist/docs/` must be read before writing Next code. **`CLAUDE.md` is 12 bytes: `@AGENTS.md`.** **[verified]** There is no hand-written repo instruction file; the governing rules live in `docs/tivdoc-development-state.md` and in the tests. |
| `.claude/settings.local.json` | Untracked, machine-local. Not part of the handoff. |

### Outside the repository (owner's OneDrive, `C:\Users\smart\OneDrive\Рабочий стол\Tivdoc\`)

These are the briefs the runs executed. **The standing rule is that they are read-only reference and
are never copied into the repository** (two evidence files and the design files were the only
exceptions ever granted). `tivdoc-open-decisions-legal-opinion.md`,
`tivdoc-legal-opinion-approval-record.md`, `tivdoc-external-review-1-response.md`,
`tivdoc-site-run-full-system.md`, `tivdoc-run-13t-trial-cases.md`, `tivdoc-run-13-pending.md`,
`tivdoc-run-14-offline-shadow.md`, `tivdoc-owner-checklist.md`, `tivdoc-golden-cases-42.xlsx`,
`tivdoc-manual-check-worksheet.xlsx`, `tivdoc-long-run-9…12*.md`, `design/landing-v5/*`.

### Binding decisions, and what each one replaced

1. **Two distinct human reviewer identities per parameter** (G-4, R-9). A model is never a reviewer
   identity. *Replaces* any idea that an owner declaration can activate a topic.
2. **Activation is a separate owner decision** after `draft → independently_verified_twice →
   activation_eligible`. *Replaces* "verified means live".
3. **Anti-graduation**: blocked or superseded records are never edited; new packets are added.
4. **Resolutions are append-only**, born `owner_recorded`; `attested` is unreachable from code
   (BL-26).
5. **The six legal rulings** (2026-09-05, `tivdoc-open-decisions-legal-opinion.md`, sha256
   `3ddad7e8…`): divisor 182 from 1.4.2018 with 186 kept as the statutory floor for severity
   classification; pension cap from the NII "§2 – benefits" column; 2011/2016 overlay precedence;
   additive rest-day composition (175 % / 200 %); convalescence measured in havra'a years
   (1.7–30.6), with `rate_not_published` from 1.7.2026; daily working-time threshold.
6. **Errata #1** (external review, 2026-09-05, closed by the owner **without a lawyer**):
   Q2's cited source is a *draft* of 26.1.2025 and does not address the order (value unchanged,
   proof grade lowered); Q4's "multiplicative has no support" reframed — §18 pulls a fixed
   contractual premium into the base; **Q6 changed from "8.6/7.6 by default" to
   `conditional_on_schedule`** — *this replaces the earlier default and is the single most important
   legal change*; the vacation table corrected to §3(א). Every report and package from then on
   carries `legal_basis: opinion_3ddad7e8 + errata_1_owner_closed`.
7. **Three gates replace the withdrawn D-6.4** (which capped certainty by parameter grade):
   activation → applicability → certainty. See §4.
8. **The supersession label is `superseded_by_external_review_2026-09-05`** — the string already in
   the ledger. An owner-approval document once carried a different wording; that variant is
   withdrawn.
9. **Merge readiness** (owner, 2026-09-05): PR into `main` — yes, **but opened by run 16 only**;
   previews — keep; repository → private — yes, owner action.
10. **S5 content** (owner, 2026-09-05): Hebrew only at launch; no person photo, video, founder story,
    proof strip or testimonials until real assets exist. **A founder story is never model-written.**

### Contradictions still open

- **The owner has twice stated that a reviewer identity was registered and that domain verification
  was done.** Every gate check disagrees: 0 identities in DEV, and no MX/SPF/DKIM/DMARC on
  `tivdoc.com`. Recorded as BL-30; unresolved. Treat the database and DNS as the truth.
- **`docs/merge-readiness.md` says 421 commits** ahead of `main`; it is now 497. The document was
  generated at an earlier head and was not regenerated.
- **BL-32 is used for two different things** in the run reports (a Vercel-link concern that was later
  void, and the refused legal-source host). Only the second meaning is live.

---

## 4. Engine and report state

### What the engine can actually check

**Nothing, for a customer, today.** Seven topics are implemented as rules — minimum wage, overtime,
rest-day premium, travel, pension, convalescence, vacation and sick pay — and **all seven are
`awaiting_verification`**, because activation needs two attested identities and there are zero.
Every projection the product can render says
**"ממתין לאימות בסיום הפיתוח"** for all seven. That string is not a placeholder; it is the truth,
and the fixture that renders it is the one the case screens use. **[from the runs]**

### Source and approval status

- **Automatic**: citation binding (a parameter cannot claim text the corpus does not contain),
  hashes on every source, the parameter-decision matrix 21/21, the reproducibility and coverage
  scripts under `npm run legal:sources:*`.
- **Human**: **none.** 0 reviewer identities, 0 attestations, 0 visual confirmations. The six
  resolutions rest on `owner_recorded` evidence — an owner statement with a document hash, which is
  explicitly **not** an attestation. The approval record's approver fields read
  `not_disclosed` / `owner_statement_2026-09-05` / `full_document_assumed` because no lawyer's name,
  licence or evidence was ever supplied. **[from the runs]**

### Provisional parameters, assumptions, open questions

- `working_time_daily_threshold` is **derived** (43 h ÷ 5) and carries a mandatory assumption slot,
  `five_day_even_distribution`. Attesting it requires naming that assumption (BL-28).
- Branches kept named but unrun: `statute` (8 h) and `nine_hour_day` (9 h) for Q6; the multiplicative
  composition for Q4, retired as a separate branch and folded into the §18 base rule.
- **A new open decision** the opinion itself created: `rest_day_daily_threshold` — from which hour
  does overtime start on a rest day that is not the employee's regular working day? Default: the
  employee's own day length. Low confidence.
- Unanswered verification items (V1–V13): most remain `לא נבדק`. V4 closed (the CMA document is a
  draft), V6 partly closed, V5 blocked by the host allowlist, V9 waits for the 2027 convalescence
  rate to be published.

### Missing information, contradictions, and when no amount is shown

Three gates, in order, per topic:

1. **Activation** — the RuleSpec and every parameter it uses must be active. Otherwise the topic
   renders as "awaiting verification": **no amount, no range, not even a direction.**
2. **Applicability** — each rule declares its applicability facts (days per week, regular day length,
   §30(א) role, sector). A missing fact produces a **refusal**, which becomes a question in the case
   thread — it is *not* a lower certainty score.
3. **Certainty** — high / medium / low, derived from fact quality alone. Any answer a person typed
   carries `provenance: person` and is capped at medium. **Low certainty renders a direction, never a
   number**; the contract makes a low-certainty amount unconstructable, and a test proves it.

### The product boundary

Preliminary check 9.99 ₪: one month, up to three topics, **no amount unless the basis is complete**.
Full report 149 ₪: every month, human-reviewed before publication (D-10.3). The second product is
disclosed before any payment (D-5.1). There is no third product. All figures come from
`src/config/product-offer.json`.

### Is there a proven path from documents and answers to a report?

**No — and this is the most important gap.** The path exists in code and each segment is tested, but
the end-to-end run over real payslips (run 13-T, the seven dummy cases) **has never executed**,
because the four production variables are absent from the engineering machine (BL-29). What *is*
proven: the contract renders correctly from fixtures; the access journey completes 26/26 in a second
browser profile; the operations journey completes 19/19 on DEV. What is **not** proven: extraction on
a real payslip, engine output for a real case, and any delivery to a real person.

---

## 5. Tests and evidence

### Commands **[verified present in `package.json`]**

```bash
npm test                    # vitest run — the whole suite
npm run lint                # eslint
npx tsc --noEmit            # type check
npm run build               # next build
node scripts/ci/run-workflow-steps.mjs   # runs the CI workflow's own steps locally
```

DEV proofs (each needs `~/.tivdoc-dev/credentials.env` and runs as the runtime roles):
`scripts/dev-runtime/parameter-decision-matrix.mts`, `dynamic-matrix.mts`, `access-journey.mts`,
`report-qa-proof.mts`, `funnel-counts-proof.mts`, `shadow/verify-v010.mts`.
Legal corpus: `npm run legal:sources:validate | status | citations | reproducibility | coverage`.

### Last results **[from the runs — long run 12, at commit `5285bc5`, 2026-09-06]**

- vitest **322 files, 2362 passed, 3 skipped, 0 failed**; tsc **0 errors**; eslint **0/0**;
  `next build` compiled; production closure **48/48 over both environments, identical posture**.
- DEV: migration chain **74/74** (tail `202609070004`); definer surface **111**, ungated 2,
  unexpected 0, reserved-execute 14; dynamic matrix **14 checks, 10 supported, 10 passed**; RLS force
  **66 tenant-scoped tables, 0 unforced**; parameter-decision matrix **21/21**; operations journey
  **19/19**; access journey **26/26**; S6 structure **12/12**; D-11 counting proof **6/6** (seeded and
  rolled back).
- **The code has not changed since that run** — `HEAD` is still `5285bc5` and the tree is clean.
  These numbers describe the handed-off commit. Not re-run for this handoff (expensive, and nothing
  changed).

### Skips and failures

- **3 skipped** tests **[from the runs]**; the reason per test was not recorded in the report.
  **[not verified]** — read the vitest output if it matters.
- **4 dynamic-matrix checks unsupported** (10 of 14) — capabilities the DEV instance does not offer;
  reported as unsupported rather than passed, deliberately.
- **Run 13-T: BLOCKED** at D1 in four consecutive runs — BL-29.
- **S6 queue flow**: proven against an in-memory mirror only. Granting the operations runtime insert
  on `case_report_projections` would have produced a nicer receipt by opening a boundary a wave
  early; the run refused. Do not open it before run 16.

### Where the evidence lives

`output/` — per-wave receipt directories (`runtime-product-closure-v0.10.2/`,
`full-local-system-marathon-v0.10.0/`, `legal-knowledge/`, `parallel-wave-*`, `probe/`, `playwright/`,
and more). `docs/tivdoc-development-state.md` carries a "Freeze" section per run with the full matrix.

### Three kinds of test, kept apart

1. **Synthetic / hermetic** — the vitest suite, fixtures, the in-memory mirror. The overwhelming
   majority.
2. **Real service, isolated** — the DEV Supabase project, as the actual runtime roles, with real RLS.
   The journeys and proofs above.
3. **Live production** — **none has ever run.** Counters: deployments 0, remote production migrations
   0, messages to any real contact 0, provider calls 0, OpenAI calls 0, customer rows 0.

---

## 6. Environments, data and services

### Running it

Node **v22.23.2**, npm **10.9.8** **[verified on the engineering machine]**. Next **16.3.2**, React
**19.2.8**, TypeScript **6.0.3**, vitest **4.1.11** **[verified in `package.json`]**.
`npm install` then `npm run dev`. **`AGENTS.md` warns that this Next version differs from training
data — read `node_modules/next/dist/docs/` before writing Next code.**

### Environment variable names **[verified — `.env.example`]**, values never in this document

| name | purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | database and storage |
| `CASE_TOKEN_SECRET` | signs the one-time case link token |
| `OPENAI_API_KEY`, `OPENAI_EXTRACTION_MODEL` (`gpt-5.6-sol`), `OPENAI_API_KEY_ROTATED_AFTER_2026_08_29` | payslip extraction |
| `INVOICE4U_API_KEY`, `INVOICE4U_CLEARING_COMPANY_TYPE`, `PAYMENT_RECONCILIATION_SECRET` | payments and the reconciliation workflow |
| `NEXT_PUBLIC_GA_MEASUREMENT_ID`, `GA4_API_SECRET`, `NEXT_PUBLIC_META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN`, `META_DATASET_ID`, `META_CAPI_TEST_EVENT_CODE` | analytics |
| `NEXT_PUBLIC_SITE_URL` | absolute URLs |
| *(not yet chosen)* email/SMS provider credentials | BL-31 — no provider exists |

**The four the runs need on the engineering machine are `NEXT_PUBLIC_SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `OPENAI_EXTRACTION_MODEL`. There is no `.env.local` on
that machine** **[from the runs, four consecutive gate checks]**.

### Migrations

74 in the tree **[verified]**. **DEV: 74/74 applied. Production: 0 applied** — every migration script
refuses a production or preview environment by guard, and the runner targets the isolated DEV project
**[from the runs; `scripts/production-refusal.mjs`]**.

### Preview and production

- **Production**: `tivdoc.com`, Vercel team `tivdoccom-5042s-projects`, serving `main`
  (`b963844`) **[from the runs]**. **[no access]** — this session's Vercel access reaches a different
  account, so the actually-deployed commit could not be confirmed against Vercel's API. Confirm with
  `vercel ls` or the dashboard.
- **Preview**: kept enabled by owner decision. **[no access]**
- **DNS**: `tivdoc.com` on Cloudflare (account `65e5bae8…`, zone `f37f61e7…`), `www` → Vercel.
  **No MX, no SPF, no DKIM, no DMARC** as of 2026-09-05 19:27 UTC **[verified then via
  DNS-over-HTTPS]** — so `info@tivdoc.com` **cannot receive mail** and no sending domain is verified.

### Where customer data lives

Supabase: a private storage bucket **`salary-documents`** for uploaded payslips **[verified in
`route-split.ts`]**, plus the product tables (`cases`, `documents`, `payments`,
`questionnaire_responses`, and the S1/S2/S3 additions). Access control is RLS forced on 66
tenant-scoped tables, invoker-security functions, signed upload URLs, and an identity-bound session —
**[from the runs]**, on DEV. **Backup and restore state: [no access]** — whatever Supabase's plan
provides for the production project; no restore drill is recorded for production.

### Dummy data and waiting customers

- **DEV: 0 customer rows.** **[from the runs]**
- **Production: [no access].** Earlier in this engagement the owner said the live site holds **seven
  dummy customer cases with full details**; run 13-T was written to use them. Whether any **real,
  paying customer is waiting** could not be checked from here — it needs `npm run cases:report` with
  production credentials, or the Supabase dashboard. **Check this first: it is the only item on this
  page that can be hurting someone right now.**

---

## 7. Continuing the work

### The blockers, and which ones stop a working customer path

Upload → identity → payment → check → follow-ups → report:

| stage | state | blocker |
|---|---|---|
| upload | built, DEV-proven | — |
| identity (link + code) | built, DEV-proven | **BL-31 — no email/SMS provider. In production nothing is delivered, so nobody gets in. Full blocker.** |
| payment | live on `main` (Invoice4U) | consent addition not deployed |
| check | **never executed end-to-end** | **BL-29 — no `.env.local`; run 13-T has never started** |
| follow-ups (thread) | built, DEV-proven | depends on delivery → BL-31 |
| report | contract built; no row can exist | **0 attestations → topics 0/7 (BL-30, BL-25/26/28)**; insert withheld until run 16 |

Also open: BL-16 (permanent), BL-27 (attested import of the 2000 order), BL-32 (refused legal-source
host), BL-33 (schedule facts not in the corpus). BL-34 is closed on our side: **DEV is project
`cpzrbidxftzqcfeqqusu`, database `tivdoc_v09_devruntime01` — not the `postgres` the dashboard shows.
Deleting or resetting that project destroys every run's evidence.**

### Priority order (dependencies, not preference)

1. **Owner, ~15 minutes** — the four variables into `.env.local`; Cloudflare email routing + DMARC;
   repository → private; choose a provider and add its DKIM; the attested download of the 2000 order.
2. **Run 13-T** — needs only item 1. See below.
3. **Two reviewer identities** (Vladimir Kremen, Leo Kremen — `docs/reviewer-onboarding/`), then
   attestations, then the 42 Golden Cases (`tivdoc-golden-cases-42.xlsx` already contains all 42
   scenarios; only the expected values are missing).
4. **Run 14** — offline shadow, topic by topic, minimum wage first
   (`tivdoc-run-14-offline-shadow.md`). Its Gate 0 refuses to start until 2 identities, one fully
   attested topic and that topic's Golden Cases exist and 13-T has passed.
5. **Run 15** (customer shadow) and **run 16** (production activation: the PR into `main`, deploy
   behind a flag, kill switch, human review on production). Their briefs are written after run 14.

### The next task, precisely

**Run 13-T — the trial run over the seven dummy cases.** Brief: `tivdoc-run-13t-trial-cases.md`.

- **Goal**: prove the pipeline end to end — real extraction, engine output, seven draft shadow
  reports — before anyone spends twenty hours on attestations against a pipeline nobody has run.
- **Prerequisite**: the four variables in `C:\dev\tivdoc\salary\.env.local` (gitignored). Nothing
  else.
- **Scope**: D1–D6 of that brief. Sender stays `none` / `file-sink`. **Zero messages.** No
  attestation, no activation, no deploy.
- **Expected files**: none in `src/` if it passes; a receipt under `output/`, a freeze section in
  `docs/tivdoc-development-state.md`, and whatever narrow fix D6 finds.
- **Acceptance**: Gate 0 prints the DB host and the case count; seven cases extracted with a
  per-field confidence; seven projections rendered as `awaiting_verification` (**they must not carry
  amounts — topics are still 0/7**); engine output cross-checked against the manual worksheet on two
  cases with the deltas named; counters unchanged except `openai`; `messages 0`.

### Known risks and things already tried that did not work

- **The owner's statements and the database have disagreed twice** (reviewer identity, domain
  verification). Always run the gate check; never take "it's done" as state.
- **A batch receipt does not prove a parameter is visible.** Long run 10 imported the §18 rule
  successfully and the census still read 61, because the census enumerates a declared list. Declare
  the entry too.
- **Unit tests passing against a fake proves nothing about the store.** Long run 11 built the whole
  thread while the store adapter's function allowlist would have thrown in production; long run 12
  found a `funnel_events` grant with no read policy that returned **zero rows** rather than an error.
  **On an RLS table, a grant without a policy answers every query with zero rows** — which reads as a
  confident zero. Prefer tests that read the source, and run the journeys.
- **A stale test can name a deleted file and assert nothing.** The sample-amount sweep pointed at a
  file S5 had removed; meanwhile the Open Graph share card was showing an invented finding with
  invented amounts on the most public surface the product has.
- **Do not accept an agent's fix without reading it.** An adversarial agent's proposal for a
  cross-tab race would have let the client name the case id — an authorization hole.
- **The line-ending trap** (§1): never "normalise" the 550 files.
- **Attempted and refused, deliberately, and not to be retried by an agent**: changing the
  repository's visibility, pulling production secrets from Vercel or copying them out of files,
  changing Cloudflare DNS or email routing, and sending real messages. These are owner actions.

---

*If any statement here conflicts with `docs/tivdoc-development-state.md`, that document wins — it was
written by the runs that did the work. This file is the map.*

P07 final checkpoint: 51 focused tests pass; typecheck and lint pass with zero warnings. The PostgreSQL proof passes 12 checks, including late token receipts and cancellation of answered reminders before claim. Reminder enqueue/link is atomic. Build completed before the final race guards with an ENOSPC cache persistence warning; the final edits are covered by typecheck/lint, not a clean final build. HEAD-based route closure runs immediately after this checkpoint commit. No provider mail, hosted schedule, DNS or production change.

## P08 checkpoint — saved reports and bounded publication

Base: `44ed78a` on `codex/tivdoc-release-completion`; new migrations through `20260907111000` applied only to `tivdoc_release_replay_20260907`. Historical published reports remain readable after source changes; approved/published envelopes cannot be overwritten. A new approval binds the exact saved projection, source input and wording fingerprint. New decisions require provenance; workers cannot use the human decision RPC. Authenticated operations has a distinct server PostgreSQL credential, actual preview, source download, assignment and approved/published queues.

Customer reports now expose saved revisions, PDF, pinned source and per-finding correction intake. Source byte checks reject a replaced/tampered object. Customer wording is restricted to shared non-monetary templates; old free text remains in the audit record and cannot inject a number into HTML/PDF. Publication commits one durable delivery intention; the existing encrypted notification worker drains it under a separate flag, without publishing again or generating repeated access tokens.

Evidence: 9 real review DB checks and 4 retained-source/correction checks, all synthetic; `P08-report-review-db.json`, `P08-report-source-db.json`. 145 focused tests passed before the final registry fix; capability tests were broadened and their final HEAD check follows the commit. Typecheck/lint/optimized build are being rerun against the final code. One synthetic PDF page was rendered and inspected; mixed-direction values were moved into separate cells. Tagged PDF and screen-reader compliance are not proven. No provider mail or production change.

Remaining integration: canonical calculation trace/fact-correction composition (P05), order/entitlement binding (P09), customer and operations browser journeys, and provider/DNS delivery. Operations Preview requires `TIVDOC_OPERATIONS_POSTGRES_URL`; it deliberately does not reuse the customer web role. No missing source or approval is treated as an empty successful report. Continue P09, then integrate the now-committed website change `ac319bf` in P11. Draft PR remains #2.

P08 final code checkpoint: typecheck, lint (zero warnings), and optimized production build passed after the provenance and registry changes. The final combined focused/registry suite and HEAD route closure run immediately after this commit. No browser or hosted-provider claim is added by the build.

## P09 checkpoint — order scope and reconciliation

Base `9f30cc1`; migrations `20260907120000`–`20260907123000` applied only to the isolated release DB. Initial and full orders have independent immutable server price, period, coverage, terms and SLA snapshots. Availability requires an explicit operations evidence record; no offer is enabled by migrations. New checkout requires a saved payslip, rechecks coverage and reserves a single provider attempt. Unknown provider outcomes remain uncertain; retry never resets the provider coordinates. Historical initial payments are preserved and cannot accidentally create another initial charge; unresolved historical checkouts require reconciliation.

The funnel and identity-scoped order page use the same quote/checkout service. Client prices are rejected. Order return only requests server verification and redirects to the authenticated order page; it cannot grant entitlement or a session. New reconciliation uses a dedicated worker credential and exact stored amount/log/order comparison. Legacy reconciliation explicitly excludes new-order payments. Full payment preserves initial case state. Paid order scope is captured in the existing immutable input journal. New report approval/publication requires the same case's paid active order and matching period/topics. Published history remains readable.

Persisted order service clocks start at verified payment and finish at first publication. Operations can attach only a same-case blocking request to an order pause; terminal request closes it. Human-track default is conservative until the canonical dispatcher selects its track. Refund intake is scoped and idempotent, explicitly `requested`; no provider refund, receipt retrieval or cancellation completion is claimed.

Verified: 14 actual PostgreSQL order checks; 10 review checks (including active paid entitlement), four retained-source checks; 37 focused contract/API/provider-validation/registry tests. Typecheck and targeted lint pass. Final HEAD-based route checks follow this commit. No new production build at this checkpoint: C: has roughly 250 MB free; previous P08 build passed. No new browser/provider/deployment claim.

Implementation still required: canonical per-order extraction/calculation production composition, historical full-period upload capacity, worker track/request linkage and shortened holiday-eve service policy, legacy order history migration/reconciliation UI, verified provider receipt/refund adapter and integrated browser journey. These are not marked complete. Provider integration is gated off. Continue independent P10 privacy/lifecycle work, then P11 UI integration, and return to internal integration gaps before acceptance.

## P10 checkpoint — privacy, retention and actual isolated restore

Base `8c4f8a5`; migrations `20260907130000`–`20260907133000` applied only to the isolated release DB. Owner-scoped privacy intake/history and fresh-authentication data export now have account and operations surfaces. Review cannot label a deletion completed without execution evidence. External GA4/Meta are closed until consent and private-navigation isolation are implemented and verified. Internal service events continue.

Orphan collection uses an explicit age policy, a separate grace period, reference checks, a durable deletion fence, repeatable Storage removal and an acknowledgment. Current documents, retained versions, analysis inputs, report evidence, active batches, live tokens and holds retain source objects. New references are refused after deletion is claimed. Holds serialize on the case and cannot falsely promise retention while removal is in flight. Terminal draft cleanup respects holds and writes a hashed audit record. Full case purge/accounting separation and verified contact changes remain implementation work; intake is not erasure.

Evidence: 12 actual PostgreSQL privacy/retention checks; four real DEV Storage checks including a crash after successful remove and before acknowledgment; 72 focused tests across 16 files and targeted lint pass. The final typecheck is being rerun: two nonincremental attempts exhausted system/heap memory; no clean final build is claimed with approximately 250 MB disk free. HEAD route checks follow the checkpoint.

An actual full custom-format pg_dump/pg_restore of the isolated synthetic DB clone succeeded: 118 table counts/full row-set hashes match, 72 FORCE RLS flags restored, saved draft report/provenance retained, and backed-up PDF bytes restored to a separate private bucket with the same checksum. Snapshot contains migrations through 132000; the subsequent 133000 hold/sweep migration is covered by the separate 12-check DB proof. Platform-owned extension comments were deliberately excluded, source schema/data/RLS were not relaxed; only the private backup clone temporarily relaxed FORCE for existing owners. Original isolated DB connections were briefly gated while draining only idle owned sessions for cloning. Signed pinned PostgreSQL 17.11 binaries were used; failed unsigned-binary, clone, ownership and timeout attempts remain in private diagnostic output. This is not an RPO/RTO service guarantee or a production backup drill.

Read-only production inquiry: four specified cases all show verified payments and under-review state; eight document rows have Storage metadata matches. No source bytes or delivery-provider receipts were inspected and no production record was changed. Private IDs/results are in the user-only output; public evidence is aggregate only. Storage remove metadata is authoritative for the GC proof; a cached download briefly remained readable, so immediate CDN erasure is not claimed.

P10 remains PARTIAL pending full purge/retention execution, contact re-verification, browser journeys and production migration/operational readiness. No production deployment, provider message or refund. Continue P11 by integrating committed website branding without replacing current upload/report/account behavior.

P10 final verification: incremental `npx tsc --noEmit` passed after the two memory-limited nonincremental attempts. Focused tests (72), lint and diff whitespace checks passed. A fresh optimized build remains unrun due to local disk capacity.

## P11 integration checkpoint — shared website and customer workspace

Base `027063c`; merge parent `ac319bf` from the parallel website task (its checkout remains unchanged). Integrated original Hebrew branding, indigo/coral tokens, responsive public navigation, process illustration, pricing, FAQ and honest missing-video/report-example fallback. Retained current capability guards, immutable upload flow, payment validation, received-state retry and identity access. The website offer adapter reads the existing validated product-offer JSON; no second price source. Closed sales are disclosed before the funnel. Public return links now reach authenticated cases. Unverified operator registration details were not expanded into a new homepage claim.

The customer shell has four case destinations, desktop sidebar/mobile bottom navigation, account/payment links and a network notice. Home reads saved blocking requests and published reports; failure is distinct from zero, and payment/case status no longer invents delivery. The selected action links to the same request ID in the thread. Missing document/request stores now throw instead of fabricating empty inventories. Added case loading/error recovery. Existing operations now uses the shared light brand tokens; no role or engine gate is opened.

Verification: 13 focused tests across four files passed with the threads pool, including three new saved-overview failure/expiry tests. Lint passed for the integrated surfaces. An intermediate typecheck passed before the last overview/branding edits; the final attempt failed with V8 system-memory exhaustion. A broader test run also exhausted memory; an earlier forks attempt failed with spawn UNKNOWN (nine tests ran, two workers never started). These are not reported as passes. Only roughly 200–250 MB free on C:. Local Next dev did not remain running, and Playwright reached ERR_CONNECTION_REFUSED; the release browser was closed. No final integrated build or browser/hosted Preview is proven yet. The parallel task's browser evidence belongs to its earlier SHA and is not reused as evidence for this merge.

P11 remains PARTIAL: complete responsive/keyboard/session/offline journeys on final build, actual pipeline-backed public example, service clock and provider-related UI proof, verified operator/media content and five real-user sessions remain. No video/play button or user-study result was invented. Continue independent P12 metrics/monitoring and P05 composition, then return to Preview and acceptance when resources/isolated hosted adapter permit.

## P12 checkpoint — observed metrics and operations monitoring

Base `f5dff35`; migrations 140000/141000 applied only to the isolated release DB. The real operations board now reads verified payments, published projections, paid full orders and owner-scoped report opens from SQL. QA is excluded from business metrics, while the monitor explicitly includes operational QA. Windows/cohorts, sample sizes, ratio denominators and a semantic outcome dictionary are visible. Historical S04/S05 codes no longer define counts. Missing review duration, provider cost and Storage integrity are not zero/success. Public health is explicitly process liveness/configuration presence, not readiness.

Added an authenticated monitor for source dispatch, expired worker leases/dead letters, notification backlog, uncertain checkout, unlinked publication delivery and overdue privacy requests. Persisted service clocks retain their calendar/budget and union overlapping pauses; unknown calendars and bounded scans are reported. Failure categories carry recovery instructions that preserve existing job/delivery/payment identifiers. The monitor displays actual configuration flags without claiming workers/providers are running. Full publication/topic control composition, provider cost accounting, current Storage-reference scan and verified scheduler/runbook recovery remain open.

Verified: six real DB metrics checks, three real DB monitor checks, all synthetic and cleaned up. A deliberate dead-letter record appeared with age/recovery advice. Fixtures included one explicitly non-QA classification control in the isolated database to prove exclusion; no real provider event, source bytes or browser report opening is claimed. An initial cleanup encountered the append-only QA log; the DEV proof now locks/restores its trigger transactionally while deleting only named synthetic cases, with no production change.

22 focused metric/monitor/clock/report/API tests passed. CI for `f5dff35` independently proved final P11 typecheck and lint (run 34128607354); it found five failing tests while 2469 passed and 48 skipped. Fixed five extensionless engine-test imports, updated the consent test to the immutable order path (including rejected caller terms and unticked consent), registered the five already-added product roots explicitly, and reviewed/pinned 221 definer declarations plus the latest migration. All 17 corresponding checks now pass locally; the exhaustive empty-search-path rule remains unchanged. Broad CI reruns after this checkpoint; build/production closure were skipped by the earlier failed suite and remain unproven for current HEAD.

P12 remains PARTIAL pending the listed composition/operational evidence, not closed by a metrics panel. P11 browser/Preview and P05 canonical saved-input → analysis → report transaction remain core outstanding work. Continue those and P13 integrated acceptance; do not declare a release-ready or deployed service.

P12 CI follow-up: run 34130517609 proved typecheck and full lint, with 2478 unit tests passing, 48 skipped and one route inventory failure. Registered the intentional health-response rewrite under CEP-019; its capability guard and engine-import prohibition remain enforced. This is an inventory correction, not a relaxed global diff budget. Build still awaits a green full suite.

P11/P12 integrated cloud follow-up (`27c4e6e`, run 34131081679): typecheck, full lint, all unit/guard tests and build passed. Production and Preview environment closure ran 164 script-refusal probes and found four unauthenticated case pages returning streaming 200 before login redirect. Removed the newly introduced parent `case/loading.tsx` boundary so page authentication finishes before headers; preserved the server auth checks and error recovery. Closure reruns after this fix. No customer data exposure was observed and no hosted deployment is claimed.

## P05 continuation — saved monthly input through canonical analysis

Base `605c435`. Added a transaction-bound saved snapshot reader, first-writer-wins extraction checkpoints and `runSavedMonthAnalysis`, using the existing CaseAnalysisService and PostgreSQL analysis adapters. Input hash/revision, case, immutable version, extraction policy, bytes digest, extracted month and order scope are checked. Different months are analyzed separately. A source change rejects stale work before replay. Saved declarations are not silently promoted into confirmed critical facts. The current real catalog remains inactive; no fixture executor, monetary answer, approval or publication is substituted.

Draft JSON/HTML/PDF use the existing canonical report schema and Hebrew renderer with an explicit saved-source draft label. Canonical stages, legal pins, per-topic results and draft bytes use one caller-owned transaction. Snapshot reads accept actual PostgreSQL month dates and bigint sizes; the existing P03 verified-upload reader now accepts its bigint size representation too.

Verified: 19 focused tests in three files and targeted lint passed. An actual isolated PostgreSQL proof passed four assertions: seven canonical stages/results, rollback removes analysis/report while retaining source/checkpoint, exact retry without duplicate run, and stale-source rejection. It uses synthetic extraction and order scope with migrator-only policies rolled back afterward; it is not worker-RLS, provider, byte-download, fresh-process durability, projection publication or browser proof. Receipt: `docs/release-evidence/P05-saved-analysis-db.json`. Local full typecheck again ran out of system memory; CI will validate this checkpoint.

Separately, complete CI on `605c435` passed typecheck, lint, all unit suites, build and production/Preview-environment closure (runs 34131759479 and 34131752920). This proves the prior integrated UI/monitor checkpoint and corrected HTTP redirects. It does not prove a hosted Preview, production deployment or these subsequent P05 edits.

P05 remains PARTIAL. Required next work: actual worker admission/session and provider invocation, per-order scheduling and final job success, typed declaration/correction application, active-rule/parameter binding, monthly/full-order report projection writer, publication/delivery gates and hosted journeys. Keep closed live/shadow composition explicit; do not equate persisted draft refusals with the completed customer service. P07/P09/P10/P11/P12 internal gaps and P13 acceptance remain active work.

P05 worker cancellation repair: CI on `6440303` proved typecheck/lint and 2487 tests, then exposed a real startup/cancel race in the pre-existing fresh-child runner. Reproduced deterministically before the fix by delaying the factory after its readiness marker: cancellation returned without closing the eventual runtime. The runner now retains the factory promise and includes its completion plus exactly one close in the bounded shutdown budget. A pre-aborted call does not start a factory. Seven real child-process tests and targeted lint pass, including the formerly failing 200 ms initialization race. The parent's hard deadline and sanitized error contract remain intact. CI reruns after this checkpoint.

## P09 continuation — paid historical document capacity

Base `7660321`; migration `20260907150000_paid_document_capacity.sql` applied only to the isolated release DB. Capacity now derives from distinct months across active paid full orders: at least 12 and at most 600 payslips per case; overlapping orders do not multiply the same month. Ordinary cases retain 25 MB total. Paid full cases allow each available document slot's existing 10 MB maximum (plus contract/attendance), while each batch remains at most 14 files and 25 MB. This accommodates the purchased historical period without enlarging single requests. Capacity does not grant an order or promise coverage outside its paid scope.

Reservation/commit both retain case serialization and whole-case checks, including pending reservations; completion rechecks revoked/suspended entitlement. Numeric slots above 99 are not truncated by lpad. Snapshot returns capacity and paid months to the existing upload UI. Historical paid months and saved months remain selectable; per-batch limits are displayed/enforced locally and in SQL. The case document page always provides explicit management access so a full payslip quota cannot hide contract completion or replacement. Removed the false promise that every uploaded month automatically belongs to the full report.

Verified: seven actual PostgreSQL assertions with two web credentials. They cover the ordinary 12-slot limit, only the paid case expanding to 116 months, concurrent slots 100/101 with prior versions preserved, 25 MB batch rejection, last-slot contention, revoked entitlement at commit with 115 existing documents preserved, and browser-role helper refusal. Fixtures are synthetic metadata/paid entitlement; no provider payment or Storage bytes are claimed. 26 focused upload/contract/migration tests and targeted lint pass. Full CI reruns on this checkpoint; actual final browser and hosted Preview remain unverified.

Prior checkpoint `7660321` passed complete CI including build and production/Preview environment closure (34133257751, 34133254166). P09 still requires receipts/refund provider integration, canonical full-period projection, per-order worker track/SLA integration and browser acceptance; capacity is no longer an unimplemented blocker.

## P11/P09 continuation — customer service clock

Base `efe7ead`. The authenticated order page now loads saved order clocks alongside order history. It shows running, paused, overdue, completed or unavailable explicitly, includes the server observation time and links each open pause to its actual completion request. It reuses the existing business-time function and persisted calendar/budget; overlapping pauses count once, and unsupported/out-of-range calendars do not produce invented remaining time. Failure to read clocks does not hide successful order history. No client-side financial or legal calculation was added.

Verified: nine focused clock tests and targeted lint pass. The actual isolated order proof now passes 16 assertions, including separate saved clocks for the initial/full verified orders and a cross-case identity refusal. Existing provider coordinates remain synthetic. This is DB/read-model evidence, not browser acceptance or proof that the dispatcher selects the correct processing track. The latter, request linkage automation and service-calendar policy extensions remain open.


## P13 first checkpoint — actual isolated Preview and acceptance inventory

Base `30f24e7`; full CI runs 34134352583/34134347940 passed typecheck, lint, tests, optimized build and closure. Vercel deployment `dpl_vZyBfGmubMuV4VqRhor1zv6gfTZS` is READY at the same source SHA. The Git-only build excludes local files. Branch-scoped DEV Supabase/public key values were read back and matched; case/service secrets remain sensitive. Added 24 branch-only disabled/empty overrides for sales, processing, notification/deletion workers and inherited provider/analytics values. No production environment changed. Bulk Vercel CLI array input returned Invalid JSON twice; single-object documented requests succeeded, with each scope explicit.

Authenticated Vercel HTTP liveness returns 200, readiness `not_assessed`, DEV Storage CSP and payment/analytics false. Unauthenticated external requests meet Vercel SSO protection; protection remains enabled. Local Chrome briefly opened about:blank, but reduced system virtual-memory headroom to roughly 73 MB; subsequent Node commands failed. Closed only the exact release Chrome profile and daemon. CUA also failed before browser creation (`failed to write kernel assets`, OS error 3). A separate cloud workflow now runs read-only public responsive/keyboard and anonymous authorization checks using a temporary deployment-scoped cookie stored as a GitHub secret. Its result is pending; remove the temporary repository secret after proof. No customer-session cookie, payment, email, provider or actual authenticated DB journey is implied.

`P13-acceptance-matrix.md` maps all 20 E, 21 F, 16 A and eight D criteria, plus the 13-T/14/15/16 sequence. Incomplete internal work remains FAIL/IN_PROGRESS; external provider/human/media requirements are explicit. No RC or rollout readiness claimed. P05/P07/P09/P10/P11/P12 work continues after this verification checkpoint. Hosted Data API isolation B-002 still prevents the complete release schema journey; read-only public Preview does not resolve it.


P05 declaration-scope hardening (base ba38da1): canonical input validation now rejects a hashed declared fact belonging to another case, duplicate paths and duplicate fact identifiers before canonical fact persistence. Previously the path Map silently selected the last declaration and the declared branch did not check case ownership. Added end-to-end service regressions using explicitly synthetic fixture ports for foreign-case and duplicate-path inputs. Local test launch could not start under approximately 100 MB system virtual-memory headroom (`Could not determine Node.js install directory`, then direct Node exited 1 without output); no local pass or pre-fix execution is claimed. Cloud typecheck/lint/regression verification follows this commit. Valid input behavior and existing saved artifact versions are unchanged. This does not complete questionnaire/OCR/correction reconciliation or worker admission.


P01/B-002 hosted adapter continuation (base a7a386d): added an explicit Preview-only selector for the existing web-role PostgreSQL RPC adapter. It accepts only the release branch, Vercel Preview, DEV Storage origin, the exact DEV pooler/role and `tivdoc_release_replay_20260907`; production, default `postgres`, elevated/different roles, projects and connection query overrides are refused before connection, with no fallback. This permits the release RPCs to use the verified isolated database while Storage remains on DEV. It is not a general production selector and does not migrate PostgREST's historical default DB. The legacy questionnaire creation/status paths still use PostgREST and require separate reconciliation; B-002 is not closed by this adapter alone.

Added 11 target-selection checks. Two direct Node checks (unset configuration and production refusal) pass locally; full Vitest/typecheck/lint are delegated to the next full CI because system virtual-memory capacity remains severely constrained. The Preview setting has not yet been enabled or deployed with this commit. Also removed the obsolete fixed 12-payslip/25MB error wording now that paid historical capacity can be higher. Git Credential Manager twice failed from memory exhaustion; push succeeded through the existing authenticated GitHub CLI credential helper without global credential changes.


P13 browser diagnostic: first cloud run 34136169928 passed authenticated DEV liveness but each page navigation timed out waiting for networkidle; the 15-minute job limit cancelled it before final receipt/screenshots. This is a failed browser attempt, not a verified layout. The probe now uses bounded DOM/main readiness, records navigation screenshots and saves a receipt after every check. Corrected the synthetic private route identifier to the actual eight-character syntax, so anonymous redirect tests exercise authentication rather than malformed-ID handling. The next run is still pinned to deployed 30f24e7.

Preview TLS continuation: the historical DEV URL uses sslmode=no-verify; the new hosted selector now requires verify-full. A direct Node TLS probe without the CA rejected SELF_SIGNED_CERT_IN_CHAIN. Retrieved the public Supabase CA over HTTPS from the URL in official Supabase Studio custom-content.json (SHA256 700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7) and bound it only to this Preview pool, with rejectUnauthorized=true and hostname validation. No global trust or SSL-enforcement setting changed. Retrying with CA was blocked before connection by local Node allocation failure; the existing psql executable was blocked by Windows Application Control (4551), so it was not bypassed. Actual CA-verified Node connection remains to be proven. Two attempts to add the branch-only DB setting failed with V8 memory exhaustion, so successful configuration/deployment of this adapter is not claimed. GitHub connector provides a read-only path to CI evidence while local CLI resources are constrained.


P13 public browser evidence (run 34137743637, deployed 30f24e7): all 20 public page/viewport checks passed (home, questionnaire, login, privacy, terms at 360/390/768/1440), no measured horizontal overflow or pageerror, RTL/main present. Keyboard reached a visible control; seven anonymous protected routes returned 307 before streaming. Forty screenshots and the receipt were uploaded as artifact 10024676820. Inspected mobile questionnaire/login and desktop hero screenshots locally; no authenticated document journey inferred. The final API check failed 405 because the probe used GET for a POST-only upload-session route. Corrected to POST with Origin and require the actual 401/session_required result; added meaningful mobile-menu keyboard and offline draft/restoration interactions. This failure remains in the record; the new complete run must pass.

B-002 progress: after system memory recovered enough, the branch-only sensitive Preview DB setting was successfully stored and its key/target/branch metadata verified. Actual Node connection with the bundled CA succeeded: exact isolated database, actual tivdoc_web_runtime, client TLS encrypted=true and certificate authorized=true. pg_stat_ssl reports the pooler's separate backend leg, not the client TLS socket; its false value is recorded, not misrepresented. Hosted RPC/browser proof still awaits deployment of the current code. Production is unchanged.


P13 protected Preview checkpoint (base 923517e): complete CI 34138089724 passed. Public run 34138087572 passed 25 checks and failed only the mobile-menu probe because its role/name locator stopped matching after the accessible label changed to close-menu. The stable aria-controls selector preserves the same keyboard/expanded/focus assertions. New Git-only deployment dpl_GwREzrFets3cZ4mMxWJTjf5ZCzMW is READY at 923517ec42e37296a68c69ae2d362a4629808efa and includes the explicitly isolated CA-verified PostgreSQL adapter. Updated the probe host/SHA and obtained a new host-scoped protection cookie; protection remains enabled.

Created exactly two synthetic QA cases in the named DEV database, with separate identities and four-hour seeded sessions; no OTP/provider or actual payment claim. An initial setup attempt used the wrong .co host assertion and refused before connection; the next transaction rolled back on the migrator's case_requests RLS. Successful setup writes requests through the actual worker role; no policy was weakened. Temporary GitHub secrets hold only the deployment cookie and synthetic case sessions, never DB/service-role credentials. A new real-browser document journey covers add/reopen, explicit replacement with an aborted completion and reload retry, duplicate commit, two-tab additions, contract-only selected request and cross-case API refusals. Syntax and diff checks pass; cloud execution is pending. Private fixture manifest permits exact cleanup and session revocation. The protected source-byte proof and final receipt remain pending, and P05/other internal package gaps remain active. No production changes.


P13 run 34139129328: all 26 public/keyboard/offline/anonymous checks passed on deployed 923517e. Actual protected browser passed owner access, initial payslip+contract upload, saved-state reopening, second payslip preservation, and abort-before-completion with old documents still present after reload. Retry after reload timed out without a completion response; the DB read confirms three unchanged current documents and one pending replacement. This is an unresolved journey failure, not a pass. Added a bounded saved-batch retry diagnostic that records only endpoint paths/statuses and visible error text, then captures the failure page. Temporary workflow step runs it against the same synthetic batch so evidence is not erased by resetting the fixture. No production or external provider action.


P13 diagnosis correction: fresh-browser run 34139633315 received 503 on completion. Direct owner HTTP resolves this as UPLOAD_INCOMPLETE. Actual Storage byte reads prove all three committed originals still return 200 with exact size/SHA; the pending replacement returns object-missing. Therefore the original injected completion abort was never reached: a sign/PUT failure happened earlier, and the broad alert check falsely classified its stage. The proof now requires the completion request before accepting that fault injection, records sanitized sign/PUT/complete status and failure screenshots, and resumes the same synthetic fixture by explicitly cancelling only its incomplete batch. No application data-loss or successful replacement claim follows from the earlier diagnostic. Local memory fell to about 30 MB virtual headroom: Node probes and a private pure-Python-driver installation failed with memory exhaustion; no application dependencies, OS trust, runtime permissions or other task processes changed. Browser/cloud checks remain usable.


P05 declaration reconciliation checkpoint (base 7505d48): the canonical seven-topic fact projection now aggregates a declaration with document assertions instead of returning the declaration and dropping documented values/provenance. Different values remain conflicted; agreement retains the least-confirmed status and both sources. No human confirmation or corrected monetary result is invented. Added two service-level synthetic regressions. The engine code pin advances to case-analysis@0.6.1; PostgreSQL still reads existing 0.6.0 dependencies. The saved monthly idempotency key includes the new engine version so an old draft cannot masquerade as the corrected run. Existing completed artifacts remain immutable/readable; questionnaire path mapping, explicit authorized correction resolution and full worker composition remain unfinished.

Verification: reviewed canonical stage payload shape and updated the tests accordingly. Focused Vitest could not start (Windows exit -1073740791 without test output), so no test pass or executed pre-fix reproduction is claimed yet. At the latest system probe only 5 MB commit headroom remained. Full CI for earlier 648faa9 passed; current changes await push/cloud checks. Repeated Git pushes fail before authentication because Git Bash/GitHub CLI cannot allocate/fork. The connector also refuses repository writes with 403; this is an integration permission error, not automatic approval review. A low-memory push helper uses the existing authenticated CLI token only over stdin and a process-scoped, github.com-only HTTP header, never a log/file/argument/global config; its first attempt also failed to start. The user was asked to free system memory while development continues. No unrelated process was stopped and no production change made.

## v1.1 recovery and P05 verification

Owner explicitly adopted launch decisions v1.1. No existing order terms or activation attestations were changed. Runtime/write access recovered; fetched origin and confirmed remote 4327b11 plus local 7505d486698e69bb7aa90485f9e82a1aa1db8d00. Before editing, created and verified a local-commit bundle (requires remote 4327b11), binary tracked patch and separate untracked regression copy in private ../release-work/recovery-20260907-v11. All three were read and SHA-256 hashed; a small write/read probe passed. Shared UI checkout was inspected read-only and retains its untracked output/supabase temporary files.

The existing P05 reconciliation changes now pass 30 focused tests across seven files, full typecheck and targeted lint. Conflicting declarations cannot discard documented values; agreement preserves both sources and the least-confirmed status. Foreign/duplicate declaration checks and existing canonical acceptance tests also pass. Typed questionnaire/correction composition remains open. Storage-before-fault verification and the protected hosted browser proof are ongoing separately; no replacement/retry success is inferred here. Production remains unchanged.

## P13 protected upload proof and request-clock repair

Base 7c1920b. That commit passed both full CI runs (34152484341/34152480743). The hosted owner proof exposed two test-locator errors and one real application regression. Next's route announcer has role=alert and was mistaken for the upload error; the old test refreshed before transfer/complete. The new proof selects the upload error, requires the actual complete boundary, reads the newly uploaded object directly from DEV Storage, and checks size/SHA before aborting complete. A nested select label needed partial label matching, and a foreign replacement correctly returns 403 rather than the test's 409 expectation. Failed attempts are retained.

Actual hosted checks now prove add-second preservation; explicit selected-version replacement; verified-byte fault plus reload retry; duplicate completion; concurrent tabs with distinct slots; contract-only selected-request completion preserving unrelated requests, case/payment status; cross-case session/add/replace/complete/request refusals; saved state at 360/390/768/1440 without client errors. These are synthetic seeded identities, not OTP delivery or real payments. Five receipts and a requirement map are in P13-protected-upload-verification.json. The deployed application is 923517ec42e37296a68c69ae2d362a4629808efa, deployment dpl_GwREzrFets3cZ4mMxWJTjf5ZCzMW; it is not current local code.

Contract-only completion initially returned 503: the invoker request-close trigger lacked UPDATE on private.order_sla_pauses. Reproduced with actual web credentials and rollback after checking source bytes. Migration 20260907190000 makes only this trigger a definer, pins empty search_path, binds order to request case and revokes direct runtime EXECUTE; web table rights stay closed. Four actual DB checks verify selected pause closure, unrelated/foreign pause preservation and unchanged direct ACLs. A role-switch test attempt was denied, so the successful proof used a separate actual web connection. An incomplete synthetic answer violated the pairing constraint and rolled back before the final valid probe. Temporary order fixtures were removed; request mutations rolled back. The migration is applied only to the isolated release DB. The subsequent hosted contract completion succeeds with the original batch.

22 focused upload/request/order/definer tests and targeted lint pass; full typecheck passed. Source inventory is explicitly 223 definer declarations. Protected proof now runs locally with DEV byte verification; the public CI workflow carries no Storage service credentials. Two owned synthetic browser cases and temporary GitHub secrets are pending exact cleanup after evidence capture. No production migration/deployment, RC, provider delivery or monetary-publication readiness is asserted. Continue v1.1 pricing and remaining P05–P13 composition.


## v1.1 launch pricing and cleanup checkpoint — base 76200bf (2026-09-07)
Owner adoption of launch v1.1 is authoritative. Product-offer v2 replaces the new full-order fixed 149 ILS fallback with total tiers 99/199/349 ILS, thresholds 500/5,000/20,000 ILS, initial verified credit and a seven-day quote policy. Landing/FAQ/terms render the same configuration and explain AI service, scope, credit and no automatic upgrade below the threshold. Terms are versioned 2026-09-07. Historical order snapshots and test-only 149 ILS fixtures remain explicit; no existing paid order is repriced.

The internal commercial calculator checks saved-basis schema, permitted wage/deposit components, checked months/topics, ambiguity, low confidence, duplicate economic components, offsets and alternatives; medium certainty uses only a permitted lower bound. It never extrapolates. Unknown does not expose an amount or tier. Synthetic quote fingerprints bind identity/case/input revision/coverage/purchased scope/credit/time; refund arithmetic only requests a downward difference and never claims provider settlement. This is NOT yet a trusted persisted basis assembler, atomic credit reservation, durable quote purchase or provider refund implementation. New full purchases explicitly refuse missing verified basis; initial and stored historical checkout behavior remain available under their existing activation flags. Continue the database/order binding, publication policy and P05 worker composition.

Verification: 54 targeted tests across six files pass, full typecheck passes, targeted lint passes after removing an unused proof import. CI 76200bf had 2,508 passes/49 skips and one stale migration-tail assertion failure, now corrected to the actual 20260907190000 migration; full CI must run on this checkpoint. Public Preview workflow 34153974511 passed against deployed 923517e, not this pricing UI. No current pricing UI browser proof yet.

Cleanup: all seven current files and the retained original were byte/SHA verified before cleanup. Exactly two exclusively owned synthetic DEV QA cases, identities/sessions and dependent records were removed, then their ten known Storage paths (nine uploaded, one never uploaded). Both owned Storage prefix inventories are empty; all ten cache-busted authenticated GETs return object-not-found. First same-URL GET immediately after DELETE returned cached bytes, so zero CDN invalidation latency is not claimed. Receipt: docs/release-evidence/P13-synthetic-cleanup.json. GitHub secrets TIVDOC_PREVIEW_CASE_FIXTURES and TIVDOC_PREVIEW_BROWSER_STATE were deleted and absence verified; the separate PAYMENT_RECONCILIATION_SECRET was preserved. Private ownership/recovery manifests remain outside Git. Previous synthetic sessions cannot be reused. No customer/production data, provider setting, deployment or legal activation changed. P00–P13 remain in progress; this checkpoint is not a release candidate.


## P05 typed saved questionnaire checkpoint — base c2d89b6 (2026-09-07)
Full CI for c2d89b6 passed (34154852261, 34154849023), and its production build completed locally. Its pricing UI still needs hosted/browser verification.

Reproduced an additional loss of a noncritical salary-type declaration: the isolated canonical-stage test failed with undefined before the change. The case-analysis aggregate now includes every declared path alongside the seven critical paths; code version 0.6.2 and saved-analysis idempotency pin prevent reusing an old cached computation, while persistence still decodes 0.6.0/0.6.1 histories. Added typed canonical paths for the questionnaire's actual precision: start month, birth year, declared role and schedule/transport/fund answers. No first-of-month start date, age band, workday list or legal exclusion is inferred. Existing critical conflict and foreign/duplicate declaration guards remain.

SavedCaseSnapshot now imports thirteen recognized explicit questionnaire fields from the pinned journal. Every field is declared and needs_confirmation, with actual questionnaire response ID and revision-derived fact ID. Unknown old provenance or statement period is not backfilled; missing fields stay absent and free-text responses remain evidence awaiting typed correction. The new insert trigger pins questionnaire statement_month to the check month at creation and forbids rewriting its case/period. Journal capture includes response ID, case, timestamp and statement month. Changing the case's checked month does not extrapolate earlier declarations to it. Migration 20260907193000 is applied only to the isolated DEV database; pre-existing journals are unchanged.

Verification: 55 tests in the first focused three-file run; expanded local suite 46 passes/1 external DB skip across ten files; separate questionnaire tests cover all thirteen fields, precision, ambiguous boolean, missing provenance, foreign case, month isolation and retry IDs. Full typecheck and targeted lint passed before final persistence-version literal alignment. Actual DB journal/worker-read proof has five passes, two exact synthetic cases removed. The real canonical PostgreSQL analysis proof has five checks including all thirteen declarations in the persisted stage, seven non-monetary refusals, rollback/retry and superseded-source rejection (P05-saved-questionnaire-analysis-db.json). Its first attempt exposed the strict decoder's unsupported new version and rolled back; the decoder was explicitly extended before the successful run. That proof uses transaction-local migrator fixture policies, not worker RLS admission, provider extraction or customer publication. Those integrations and typed questionnaire/request correction UI remain unfinished. This is continued P05 development, not completed P00–P13 or a production deployment.


## P08/P11 owner support checkpoint — base 5a6f268 (2026-09-07)
Both full CI runs on 5a6f268 passed (34155711807/34155709498). Continued implementation after pricing: customer case support and finding corrections now enter one durable owner queue. Existing correction IDs/report/finding links are preserved; the bridge is transactional and idempotent. Customer/owner messages are append-only and ordered by an internal sequence. Owner replies require exact configured TIVDOC_SUPPORT_OWNER_ACTOR_ID plus verified operations session/CSRF, and DB operations-role authority; no reviewer gets this permission automatically. The owner is labelled support, not a professional checker. Customers can read replies and reopen the same thread. Support actions do not change computed facts, approval, payment or entitlement. Correction application remains separate unfinished work.

Added case-shell support entry, customer thread view/forms, finding action wording and operations support panel. Queue includes original source, opening time, priority, state and a two-business-day INTERNAL response target measured from the first unanswered message. Unknown/out-of-calendar clocks remain explicitly unknown. Empty/missing save receipts cannot be reported as saved; request IDs survive retry within the open form. Reload draft persistence is not yet implemented for support forms. The queue exposes the first 100 open threads and declares that limit.

Actual DB proof P08-support-db.json: seven checks using independent web connections and actual operations credentials cover simultaneous retry, foreign case/thread refusal, closed owner functions to web role, owner reply idempotency, stale revision rejection, reopened customer follow-up, unchanged case/payment. Two exact synthetic cases/identities removed. P08-support-finding-db.json: five transactional checks also verify the report/finding bridge and duplicate correction, with preserved source access/refusal. Only migration 20260907200000 on the isolated DEV DB was applied. Definer inventory now explicitly 229 with empty search_path and scoped grants. Focused tests: 33 passes in five files before adding the missing-receipt test; typecheck/lint are rerun on final files. No support browser, real owner session, outbound notification or production proof yet. Owner actor mapping is intentionally not fabricated or configured; this is implemented support functionality awaiting that activation and browser proof. Remaining P00–P13, durable pricing binding, worker admission and AI publication policy remain open.

Support final local verification: 34 tests in five files, full typecheck and targeted lint all pass; no browser result is inferred.


CI follow-up on 824c44a: production-closure runs reject only the stale CEP-105 probe expectation (400 versus intentional same-origin 403 in production and preview). Artifact 10031240116 confirms both exact mismatches; the handler security check is retained and its route inventory expectation/reason corrected. Preview 824c44a is READY, but full CI on that commit is not green; browser verification is ongoing.


P13 launch Preview 824c44a browser checkpoint: 26 checks pass on https://salary-3zwy6a5w7-tivdoccom-5042s-projects.vercel.app, Chrome, widths 360/390/768/1440. Includes exact tier totals/balances on homepage and terms, RTL/overflow/page errors, keyboard/menu, offline questionnaire draft and anonymous authorization. P13-launch-preview.json binds this proof to 824c44a; no authenticated support or pricing checkout proof is inferred. CEP-105 route inventory fix passes 13 focused tests; CI is rerun on the next commit. Production unchanged.


P08 support browser checkpoint on Preview 824c44a: nine checks PASS (P08-support-browser.json). Actual hosted customer UI -> HTTP -> isolated DEV DB survives a saved request with deliberately lost response, retries once without duplicate thread, shows an operations-role DB reply after reload, accepts customer follow-up, deduplicates concurrent HTTP retries, refuses foreign case/Origin, retains case/payment states, and displays saved conversation in RTL at four widths. Owner response was injected through operations DB credentials; no owner HTTP/session/UI, OTP or outbound provider proof is claimed. Two fresh synthetic cases and identities were removed. Initial failed locator attempt is retained separately. It exposed the textarea value contaminating its implicit label; explicit linked labels fix this and successful saves now clear the retry ID for a subsequent deliberate identical message. These two UI fixes need the next Preview proof. Both full CI runs on 705ebad passed (34157316438/34157314194), including corrected closure probe. Production remains unchanged.


## P05 actual scoped worker checkpoint — base e950177 (2026-09-07)
Reproduced the worker's actual 42501 denial in intake_case_insert against engine_case_identity, preserved in P05-saved-worker-initial.json. Added only scoped worker SELECT/INSERT grants required by canonical analysis and a product-document SELECT policy requiring an authoritative machine tenant exactly saved-case:<case UUID>. The current mapping helper is SECURITY INVOKER; its original behavior/ownership remains unchanged. A transient draft attempt incorrectly assumed the older definer body; the extra governance-owner grants/policy were removed from DEV and are absent from the final migration. No new SECURITY DEFINER, broad document write, session provisioning, publication, reviewer or payment authority was added. Applied migration 20260907210000 only to named isolated DEV.

admitSavedSource verifies the actual worker principal and authoritative runtime SID/JTI tenant, locks the current source and requires a still-paid/non-refunded order bound to that journal's offer hash. Admission is idempotent. runSavedWorkerMonth composes admission with canonical adapters in the same caller-owned transaction; it does not acknowledge unfinished months or call a provider while locked.

Actual worker testing exposed a second product defect: PostgreSQL codecs/pins/results/traces demanded seven topics even for the initial three-topic order. Completion and replay now enforce the exact saved command topic set. Legacy seven-topic entrypoints/defaults remain strict; missing, duplicate and unpurchased topics refuse before writes. The test source journal is now captured from an actual synthetic paid order, never hand-rehashed. This is synthetic paid state, not a provider verification assertion.

Verification: P05-saved-worker-db.json has six PASS checkpoints under an independent actual worker login with a provisioned synthetic machine session and no fixture RLS policies on canonical tables. A mere GUC and foreign case/tenant are refused, an existing foreign product document stays unreadable, seven stages/three non-monetary purchased-topic results persist, rollback removes partial work, retry preserves draft bytes, and transaction end removes authorization. Canonical writes rolled back; two exact QA cases removed; append-only synthetic machine session revoked (retained per no-delete policy). Local 25 tests passed across analysis/snapshot/migration checks; full typecheck and targeted lint passed. Both full CI runs on e950177 passed; new checkpoint CI pending.

Still open: provisioning/renewing the real machine identity, scheduler/provider invocation, multi-month final acknowledgement/projection, active legal rule binding, AI publication mapping, monetary basis and durable pricing. No customer publication or production deployment is inferred from this worker proof.


P13 integrated Preview e950177 browser follow-up: https://salary-nvxblwmsh-tivdoccom-5042s-projects.vercel.app is READY and both e950177 CI runs passed. Repeated all 26 public/pricing/keyboard/anonymous checks and ten protected support checks at 360/390/768/1440. The corrected explicit field label remains stable after input. Two deliberate identical questions after confirmed saves are distinct; lost-response retries remain idempotent. Customer reply verification now waits for the saved message in the conversation list, not matching its still-unsent textarea content. Initial failed premature-reload attempt is retained as P08-support-browser-e950177-initial.json; all fixture cases were removed in both attempts. Prior 824c44a proof retained separately. Owner HTTP/identity configuration and outbound notifications are still not verified. Preview e950177 does not contain the newer e6fcd9f worker code; worker DB verification is separately pinned. Production untouched.


## P04 pension cap AI research checkpoint — base 9919622 (2026-09-07)
Both full CI runs on 9919622 passed (34159011081/34159008492), covering the e6fcd9f worker changes; the direct e6fcd9f runs were superseded/cancelled, not passed. Read the archived 2011 order PDF pages 2/4 visually and freshly downloaded Bituach Leumi chapter A, SHA d95df0592c4621b1cc32c5dda59d51ac576c3e825a683d28b38d62e1ffe3aeb1, page 7 footnote 34. The AI research decision selects section-2 benefits for the general 2025 mandatory-pension cap (13316), reasoning that amendment 244 freezes only Chapter XV collection. The official table independently gives 13769 for 2026. The May 19 final CMA clarification was located but its conclusion/body bytes remain unverified and are NOT the basis for applying the extension order.

Added bounded dated research candidates and tests through the existing inactive RuleSpec executor. Scope/unknown years, below/above-cap wages and employee/employer/severance contributions are separated. No paid-line comparison or employer debt inferred, no extrapolation, no active catalog entry or human attestation changed. Source/visual/inference receipt P04-pension-cap-decision.json and Hebrew decision explain applicability and effect. 77 tests in three files, full typecheck and targeted lint pass. Existing historical owner decision revisions are preserved. This resolves the 2025-column research question only; real applicability, legal parameter activation, calibrated evidence and versioned AI publication remain separate unfinished gates. No DB migration or production change in this checkpoint.


P04 CI correction on base 2dcd63f: both full CI runs failed the engine import-extension guard, with all other 2566 executed tests passing. Three new research-test imports now use explicit .js extensions. Focused guard and research suites: 11/11 PASS. No calculation or activation behavior changed. Full CI will rerun after push.


## P05 atomic draft completion checkpoint — base 1720d43 (2026-09-07)
completeSavedDraftJob reads the actual queue payload under the authenticated worker tenant, locks current case/source before job, requires the current fencing token, non-cancelled running lease and database clock, and binds every purchased order/month to its completed canonical analysis and persisted report receipt. One batched receipt query avoids loading/re-rendering all report bytes. A single SQL statement writes terminal success with exactly one immutable draft-ready outbox manifest. Replay verifies both persisted hashes and does not enqueue again. It never publishes to the customer or calls a provider. Each monthly worker invocation now requires the chosen order's own current paid offer and active entitlement; another paid order cannot authorize a suspended scope. Shared month keys preserve existing idempotency; overlapping initial/full purchases stay separate, and the existing 600-month creation bound refuses rather than truncates.

Verification: 38 local tests across completion/saved snapshot/canonical analysis PASS, full typecheck and targeted lint PASS. Two actual worker DB tests PASS in named isolated DEV without fixture RLS policies. New P05-saved-completion-db.json records eleven checks: initial/full January cannot substitute for missing February, suspended full entitlement refuses despite paid initial, monthly rollback/retry, stale fence/cancellation/expiry, lease expiry after receipt validation, atomic completion rollback/replay, unchanged customer status/payment/report visibility, verified-tenant isolation and cleared authorization. Both tests removed their exact two QA cases; canonical writes rolled back and append-only machine sessions were revoked. No migration change. Independent concurrent finalizers on separate connections are explicitly NOT yet proved; providers, actual Storage bytes, scheduler/machine provisioning and customer publication also remain unverified. Both full CI runs on 1720d43 passed (34160485907/34160484089); this new code awaits its own CI. Current integrated Preview remains e950177, not this worker checkpoint.

Remote integration observation: website branch advanced to 65af0c3 (public UI e82ae39). Its handoff reports production promotion dpl_2sd8iW5ybFaCnBgdq7scEFLwLYTR on a separate task. This task has not independently verified that deployment or deployed the release branch to production. UI media/accessibility changes will be reviewed and integrated separately while retaining v1.1 and advanced contracts.


## P11 latest parallel public UI integration — base d241978 (2026-09-07)
Reviewed website branch e82ae39/65af0c3 and imported its exact three committed explainer assets (MP4, poster, Hebrew VTT) and honest accessibility page. Added the request-time capability guard and full route registry/startup denominator updates for CEP-114, the footer link, sitemap entry and canonical URLs for terms/privacy. The poster was visually inspected. Existing v1.1 pricing, server sales/provider gates, source-bound upload/identity flows and the newer funnel progress component are retained; the older branch's hard-coded 149-ILS offer and simpler funnel were not substituted. This is a reviewed selective integration, not a whole-branch merge. The source task's reported production promotion does not deploy this release branch.

Local registry/startup/disposition suites: 20 tests PASS; full typecheck and changed-file lint PASS. The route split suite reads committed HEAD and must be rerun after this commit includes the new route. Expanded the pinned public Preview runner to cover accessibility at four widths, exact hosted media hashes, user-initiated 30-second playback, five frame captures, Hebrew captions/written alternative and canonical/sitemap links. Those new browser checks are pending a deployment of this commit; the existing e950177 browser receipt remains historical evidence only. No new compliance attestation, provider invocation or production deployment. A new integrated Preview will follow successful CI.


P11 CI follow-up (2026-09-08): 41a3b89 failed one remaining durable-local-config test that counted 45 dispatcher roots and 31 allowed roots. CEP-114 adds exactly one public accessibility page. The test now explicitly verifies that page is allowed, total roots are 46/allowed 32 and the fourteen blocked roots are unchanged. All seventeen focused config/route/reachability tests pass after the correction. The HEAD-based eight route tests also passed immediately after 41a3b89 was committed. Both complete CI runs on d241978 passed (34161128322/34161125706), proving the preceding draft-completion code; UI integrated CI/Preview verification is still pending.


## P13 integrated UI Preview proof — 9f9b6f5 (2026-09-08)
Both complete CI runs on 9f9b6f5 passed (34161799534/34161795824). Isolated Preview https://salary-hffq2xcce-tivdoccom-5042s-projects.vercel.app, deployment dpl_4YT8J3HjLY8JvFsMYKCxxwP38M63, is READY on that exact SHA. Thirty-three public browser checks and ten protected support checks PASS. The public proof now includes the accessibility page at four widths, exact served media hashes, manual 30-second playback, five frame captures, captions/always-available written alternative, canonical URLs and sitemap. Visually inspected poster, three played frames and mobile accessibility page; no monetary finding or professional endorsement appears in the explainer. Complete media failure/offscreen-pause/assistive-technology verification is still open. All v1.1 public prices, keyboard/menu, questionnaire offline draft, anonymous refusals and support retry/isolation checks continue to pass. Two exact support QA cases/identities removed. Temporary deployment access stayed local; no GitHub secrets created.

P13-launch-preview.json and P08-support-browser.json now pin 9f9b6f5; prior e950177 receipts are preserved with explicit filenames. This Preview includes worker draft completion and pension research/UI integration, but no new live worker/provider activation. P06 request-retry code currently in development is NOT in this deployment; do not attribute these support checks to that new answer/correction path. No release-branch production deployment.


## P06 saved request retry integrity — base 27e0a10 (2026-09-08)
Reproduced two defects in P06-request-retry-baseline.json using actual web DB credentials: a successfully saved initial answer returned no receipt on retry; deleting a draft reset its revision to zero and allowed an old form to recreate stale text after correction. Migration 20260908001500 adds a private persistent draft-generation head, advances it when answers/corrections clear drafts, and preserves the case-before-request lock order. Exact original-answer retries return the original receipt without overwriting later corrections. Exact correction/draft retries require the same expected generation, identity and content; differing writes conflict. Replayed corrections cannot clear newer drafts. Existing answer immutability trigger and RPC owners/ACLs remain unchanged; no new definer or private-table runtime grants. Historical cleared drafts have no recoverable old generation history; migration preserves current drafts and establishes monotonic generations going forward.

Service delegates terminal/expiry checks to locked SQL and verifies the returned draft/correction revision before acknowledging a save. Unknown actions and invalid edits return 400; version conflicts return a truthful 409 and UI offers an explicit reload of saved state while retaining typed text. The legacy lifecycle proof reads the current server draft revision instead of assuming zero after an answer.

P06-request-retry-db.json: eight PASS checks across two actual independent web connections in isolated DEV, with no fixture RLS policies. Simultaneous identical drafts/answers/corrections deduplicate; different drafts have one winner; original history, latest correction, source revision and case/payment state are preserved; stale/null/foreign/private-table access refuses. Applied this migration only to named isolated DEV. Both baseline and final probes removed their exact two QA cases and identity. Twenty-three focused local tests, full typecheck and changed-file lint pass. Public/support Preview 9f9b6f5 remains proven separately; hosted request answer/draft/correction retry still needs a new Preview of this code. No provider, production or typed canonical correction-application proof is claimed. Continue that protected browser verification and remaining P00–P13.


P06 browser-proof preparation (2026-09-08): isolated test reproduced customerErrorMessage returning undefined for the existing request_answer_failed fallback. Network failure could therefore hide the error instead of showing retry guidance. Added request-specific Hebrew copy and a guaranteed generic fallback for unmapped future codes; eight copy/request service tests, typecheck and lint pass. New preview-requests.mts prepares eleven hosted checks for response-loss draft/answer/correction, reload, stale/foreign refusal, concurrent HTTP correction, four widths and immutable original history. It is not yet executed against a deployment containing this request code; its host/SHA must be repinned before that proof. No new migration or production change in this follow-up.


## P06 hosted retry proof and midnight hydration repair — base ceb1e0e (2026-09-08)
Both full CI runs on ceb1e0e pass (34163002641/34162999086). Its isolated Git-only Preview is https://salary-l8hk2xi7m-tivdoccom-5042s-projects.vercel.app, deployment dpl_BYCDSJx6xsEwZXZdVsBQ6ofccQzE. Actual hosted draft/answer/correction response-loss retries, stale/foreign refusals and two independent HTTP correction retries passed six checks. The run then FAILED the no-browser-errors check: open-question dates rendered September 7 on the UTC server and September 8 in the Israeli browser. Both exact QA cases/identities were removed. Preserve the failed receipt as P06-request-browser-ceb1e0e-failed.json; this is not an all-pass browser proof.
An isolated regression reproduced the timezone mismatch before repair. Request dates now explicitly use Asia/Jerusalem. Open/expired classification uses a serialized request-time server instant through hydration, with a bounded client timer refreshing at the next expiry; DB expiry remains authoritative. The server clock line has a narrowly documented purity exception because it is captured after authenticated awaited data access, not recalculated on the client. Nine focused tests, full typecheck and changed-file lint pass. Hosted proof must rerun on a Preview containing this repair. No production, provider delivery or canonical application of corrections was performed. Prior 9f9b6f5 public/support receipts are retained under explicit filenames; their current receipts still describe that earlier Preview.


## P11 explainer failure and playback controls — base 9a88522 (2026-09-08)
Kept the parallel UI's reviewed video/poster/caption bytes and native controls. A small client component now pauses playback when fully offscreen or the document becomes hidden; returning never restarts playback. Source/media failures display an accessible status and a link that opens the existing full written alternative. No autoplay, motion-triggered playback, provider or public claims were added. The hosted public runner now checks actual loaded/active caption cues, keyboard playback, offscreen pause/no implicit resume, and an aborted media transfer with an operable written fallback. Frame captures center the media to avoid a sticky page header overlay.
Typecheck and changed-file lint pass. These new interactive checks are PREPARED, not yet run; they require a Preview of this commit. Full assistive-technology verification, hidden-tab browser evidence, actual 200% browser zoom, five real user sessions and canonical pipeline-backed public examples remain open. P06 midnight repair also still needs hosted revalidation. No production deployment.


## P06/P11/P13 integrated browser checkpoint — ca63a5f (2026-09-08)
Exact deployed SHA ca63a5fb760f22c36f7115c14fed49c855cfd55c passed both full CI runs 34163812752/34163810185. Isolated Preview https://salary-4p9ejfw9i-tivdoccom-5042s-projects.vercel.app, deployment dpl_BGe9qfU6eV5eDqZMNMafgxtz586D, is READY. No production target was requested; deployment came from Git only.
All 57 checks pass: 12 protected request checks, 35 public checks and ten protected support checks. Actual server-save response loss followed by draft/answer/correction retry produces exactly one version; original answers, latest corrections, input revision and case/payment state are preserved. Two independent HTTP contexts deduplicate one correction; stale version, foreign case and foreign Origin refuse. Reload at four widths shows the persisted correction without React errors. A newly seeded question expires while the page stays open and moves to the closed section without manual reload. The earlier midnight failure is retained, not counted as a pass.
Public media proof now verifies exact served bytes, manual keyboard playback, five loaded and active Hebrew caption cues, offscreen pause with no automatic resume under reduced motion, and an aborted video request with a working link opening the written alternative. Public pricing, accessibility/legal routes, menu keyboard/Escape, questionnaire offline restoration and anonymous refusals still pass. Visually inspected an active-caption frame, the mobile request thread and written fallback. The fallback screenshot records the opened transcript after the link; it is not a screenshot of the error before activation. Full assistive-technology testing, hidden-tab browser proof, actual 200% zoom and five real participants remain open.
The support proof again uses actual customer HTTP and DEV DB, with its owner reply injected by the operations DB role. It does not prove owner HTTP/UI/session or outbound provider delivery. Exactly four fresh QA cases and their test identities were removed across the request/support runs; no real customer was QA. Storage was not mutated. Temporary Preview access remained local and no GitHub secret was created. Receipts: P06-request-browser.json, P13-launch-preview.json, P08-support-browser.json. This Preview includes all application changes through ca63a5f; subsequent proof-script/document changes are not deployed application changes.
P00–P13 remain in progress: provider invocation and operational worker/scheduler composition, typed request/correction facts, trusted monetary evidence and durable quote/credit/refund, versioned AI publication, owner/provider activation, privacy/operations integration and final full-story acceptance still need completion. Existing source/accuracy/activation gates stay intact. No release-branch production deployment, real payment/email delivery or RC is claimed. PR #2 remains Draft with PR #1 as its dependency.


## P03/P05 durable saved extraction composition — base eac780b (2026-09-08)
Added saved-extraction-worker.ts and forward migration 20260908013000. Each short transaction requires the actual verified worker machine session; admission binds the persisted job payload/hash, paid purchased month, current source and lease/fence. Provider dispatch is inserted once per immutable case/file/month/extraction policy, with a final database-clock lease check in the INSERT itself. Provider/Storage I/O runs outside DB transactions. The existing real saved-payslip adapter still verifies physical path, PDF limits, size and SHA and uses its bounded extraction passes with SDK retries disabled.
A committed dispatch with no known result is an uncertain outcome and refuses automatic re-invocation. A recovered result can be recorded against the exact original journal/document identity even after source or lease changes; recording it grants no analysis/publication authority. The response is immutable, and checkpointing separately rechecks the current job/source/paid scope. Failed checkpoint commit retains the already committed response for recovery. Old same-file/month/policy checkpoints are reused without inventing a provider invocation or repeating OCR after questionnaire changes. No deletion, reset of uncertainty, fake delivery, machine-session provisioning or customer publication is introduced.
Migration applied ONLY to isolated tivdoc_release_replay_20260907. New private invocation table has FORCE RLS against verified saved-case tenant, no web/operations/service-role access, and column-limited worker result updates. An invoker trigger freezes binding and recorded responses; no new definer or global authority grant. The source inventory remains 229 definer declarations. Migration tail test was updated explicitly.
Verification: 18 sequencing/fault tests, 18 existing completion tests and five chain tests (41 total) pass, full typecheck and changed-file lint pass. P05-saved-extraction-worker-db.json has nine actual PostgreSQL checks across two independent worker connections: wrong worker refusal; actual expiry between admission and dispatch; concurrent pending-call refusal; PDF-byte/hash adapter outside case locks; receipt persistence before injected checkpoint rollback; cross-connection retry without provider repetition; immutable/foreign/web-role refusals; source change plus same-document checkpoint reuse; and all seven canonical draft stages for three purchased topics. The first bounded DB run had eight passes before the final atomic-expiry/source-binding hardening; the final nine-check run includes those fixes. One injected transport pass executed in the final run; no OpenAI network call, measured accuracy, hosted Storage or external delivery is proved.
Each DB run removed its exact two product QA cases/documents/invocations/checkpoints and revoked its synthetic machine session. Canonical identity/lifecycle and cancelled-job history are intentionally retained as synthetic audit history; monthly analysis writes rolled back. This is distinct from claiming all canonical writes were rolled back. Current receipt identifies its retained tenant; future runs retain a separate private ownership manifest per case. Case/payment state remained unchanged. Six real unserved customers were not QA.
The latest browser-proved application remains ca63a5f with 57 passing checks. This new worker module has NOT been deployed/activated or run through a hosted scheduler. Remaining P05 work includes runtime machine provisioning, scheduler/job loop and heartbeat wiring, operational reconciliation of unknown external outcomes, provider configuration/ground truth, costs and final customer projection/publication. Source/quality/AI publication, typed corrections and monetary quote/credit/refund remain independent unfinished work, not permission to stop P00–P13.


## P05 missing-reading reconciliation — base b6593ee (2026-09-08)
The first strengthened salary-type assertion correctly encountered the fixture's documented monthly versus declared hourly conflict; that expectation now explicitly preserves the conflict. Three dedicated missing-field reproductions then failed before repair: all document readings missing erased an explicit declaration; one missing reading erased agreement; and one missing reading hid a real conflict in the remaining sources.
Canonical aggregation now retains available assertions and their actual supporting provenance. An explicit declaration remains needs_confirmation when documentary coverage is missing; absent document fields are not presented as evidence supporting its value. A real conflict remains conflicted with null amount. Missing documentary coverage without a usable declaration remains missing: a value in another document/period does not fill it. The initial broad ignore-missing implementation failed the existing multi-period acceptance; the final scoped behavior passes those original acceptance expectations without changing their counts or weakening period coverage.
Code version advances to case-analysis@0.6.3, and saved monthly idempotency pins advance with it so an old cached result cannot stand in for the new algorithm. The DB decoder still reads 0.6.0/0.6.1/0.6.2 histories; no historical record or migration is rewritten. Forty-eight focused declaration/scope/canonical acceptance/completion/extraction tests pass, plus full typecheck and targeted lint. The actual two-worker PostgreSQL extraction proof passes all nine checks again and now asserts the persisted hourly questionnaire value survives an absent OCR salary type as needs_confirmation. Receipt includes tested base and exact local composition/service byte hashes. No provider call, calibrated accuracy, monetary publication or browser proof of this server-only change is claimed.
Both full CI runs on preceding b6593ee passed (34165568939/34165566435). New commit needs its own CI. The browser-proved Preview remains ca63a5f with 57 passes, not this newer extraction/reconciliation code. No new migration in this checkpoint, no production deployment, and no RC or full P00–P13 completion. Continue typed request/correction provenance, versioned publication and monetary/purchase composition and other outstanding packages.


## P05/P06 typed request/correction source — base e90ebe0 (2026-09-08)
Forward migration 20260908073000 pins every new question to the case's checked month at creation, stored with month precision as text. The caller cannot forge that scope and updates cannot relabel it. Older rows keep unknown scope; no backfill or old input-journal rewrite. The existing source-capture function now records case, statement month, answer kind, exact immutable answer revision and answer timestamp. Its existing owner/ACL remains unchanged; the new pinning trigger is an invoker, not a new definer. Applied only to isolated DEV.
The saved canonical adapter maps schedule_unknown and regular_day_hours_unknown into typed declared facts with case_request_answer/request_id/answer_revision provenance. Corrections select the current saved revision while old versions remain in the journal. A changed case/analysis month cannot extrapolate the answer. Generic text, document requests, monetary OCR confirmations and unrecognized codes remain evidence awaiting typed resolution. Existing accepted numeric day-length assertions (>0 through 24 hours) now fit the fact domain; this is an unconfirmed statement, not a lawful-hours decision or a change to questionnaire UI limits. Questionnaire-only snapshots remain unchanged. Agreement between questionnaire and request retains both sources without confirmation; disagreement becomes an explicit conflict instead of silent replacement.
Request UI now shows the saved month alongside open questions and recorded answers, using a deterministic month formatter. Browser period assertions are prepared, NOT yet run on a new Preview. Latest proven Preview still ca63a5f with 57 checks.
Verification: 183 focused report/domain/request/snapshot/chain checks across 21 files pass; full typecheck and targeted lint pass. P06-request-source-db.json has seven real web-RPC/journal/typed-adapter checks, including migration of an actual pre-migration synthetic question without rewriting its bytes, forged scope, original and corrected versions, immutable retry, changed month, conflict/agreement and foreign case refusal. P05-saved-extraction-worker-db.json again passes nine actual-worker checks and now proves corrected revision 2 reaches the persisted canonical stage as unconfirmed. An initial expanded fixture had questionnaire hours 8 and corrected answer 9; the engine correctly produced a conflict rather than the test's expected 9. That failed receipt is retained as P05-saved-extraction-request-conflict-fixture.json. The independent source-change fixture now changes worksFriday, preserving the explicit disagreement tests rather than weakening reconciliation.
All owned product QA cases and newly added request identities were removed; worker machine sessions revoked, canonical cancelled-job/lifecycle audit history retained explicitly as before. No real customer, provider network, customer publication, production schema or deployment changed. Both full CI runs on e90ebe0 passed (34186464109/34186462120); this package needs its own CI and hosted month-display/retry proof.
Remaining typed-request work includes field-specific monetary/document confirmation with exact source targeting, arbitrary conflict clarification, per-purchased-period request generation beyond the case's checked-month default, and accepted correction through final publication. Those are unfinished implementation, not covered by these two typed questions. Continue the integrated Preview and remaining P00–P13.


## P13 integrated Preview 6cb92fa (2026-09-08)
Both exact-SHA CI runs passed (34187331981/34187330199). Git-only isolated Preview https://salary-r1jvnsvor-tivdoccom-5042s-projects.vercel.app (dpl_CBYbmhxxK7aBHmozTxQk4Z3w2Na8) is READY and contains durable extraction, missing-reading reconciliation and typed request/month changes. Repeated all 57 hosted checks: 35 public/media/RTL/keyboard/anonymous, twelve protected request and ten protected support. The request proof now additionally verifies the actual August 2026 question and answer labels before and after saved correction/reload. Lost-response retries, independent concurrent clients, immutable history, foreign-case/Origin refusal, four widths, timed expiry and unchanged case/payment all pass. No React page errors. Previous ca63a5f receipts are archived under their exact SHA.
Exactly four newly seeded QA cases and their identities/sessions were removed across the request/support runs. No Storage fixture objects were created in these suites. Access used one temporary local host cookie, no GitHub secret. Owner reply remains actual operations-DB injection, not owner HTTP/UI or OTP/provider proof. Upload proof remains separately pinned to 923517e; it was not rerun as part of these 57 checks.
Preview is isolated DEV, with sales/provider/analytics disabled. New worker code being present in its bundle does not mean a hosted worker or scheduler ran. No release-branch production deployment or production migration occurred. Monetary assembly, durable pricing/credit/refund, versioned AI publication, operational worker/scheduler and the other explicitly open P00-P13 requirements remain unfinished. Continue implementation rather than declaring RC.


## P05 whole saved-job consumer — base c9ed360 (2026-09-08)
Added runSavedDraftJob for an already claimed/running, authoritatively scoped worker job. It plans only purchased file/month/order scope, reuses durable extraction receipts, commits each canonical month independently, and uses the existing atomic complete-scope finalizer. Overlapping initial/full orders share each file extraction while retaining separate purchased-topic monthly receipts. Missing documents do not erase available monthly work and cannot be extrapolated or omitted from the final completion obligation. The runner returns a typed missing-month error after saving available drafts.
A serialized transaction lane supports even a single host DB connection. Database-clock heartbeats run during external I/O; a delayed pulse cannot revive an expired/cancelled/reclaimed job. Each month rechecks its lease in the same transaction before commit, so expiry rolls all its stages back. The timer is stopped/drained before finalization and on failure. Cancellation allows known provider results to be durably recorded, then prevents further work. Unknown external outcomes keep their existing reconciliation hold; no automatic new provider invocation. Successful replay validates the saved completion manifest without a heartbeat or new work.
Verification: 62 focused tests across four files pass, full typecheck and changed-file lint pass. P05-saved-job-runner-db.json has nine underlying extraction/source checks plus seven runner checks under actual independent worker logins: persisted heartbeat during held provider I/O; stale source refusal; expiry after analysis rolls back its stages; injected finalizer failure preserves completed month/checkpoint; independent concurrent consumers produce exactly one monthly result and one manifest; completed replay; and a later two-month historical full order preserves both available January scopes while missing February prevents whole-job acknowledgement. The full-order fixture explicitly changes awaiting_payment to paid to fire the actual input-capture trigger; no provider settlement is claimed. One injected provider pass, real PDF byte/hash adapter, no network provider or hosted Storage.
Preserved the first failed clock-fixture receipt (local clock was incorrectly compared to DB time), the successful pre-missing-month proof, and the subsequent order-fixture failure (direct paid INSERT did not model the production state-transition trigger). Final proof compares DB timestamps with each other and uses the transition trigger. Fixture cleanup now drains pending provider work before rollback/delete. Every run removed its two exact QA product cases/identities and revoked its machine session. Canonical synthetic identity/lifecycle/job history, committed monthly report bytes and draft-ready outbox evidence are intentionally retained; no customer publication.
No migration or production change in this package. The browser-proved Preview remains 6cb92fa, 57 checks; this newer job consumer has not been deployed or activated. Both c9ed360 CI runs passed (34187994572/34187992879); this commit requires its own CI. Host machine provisioning, scoped claim/job loop, durable failure/recovery operations, scheduler, live provider/Storage integration, monetary executor/evidence binding and publication remain open. Continue those and the remaining P00-P13 work.


## P05 scoped host iteration and durable failures — base 3158133 (2026-09-08)
Added claimSavedDraftJob, recordSavedJobFailure and runSavedDraftOnce. They authorize the actual provisioned worker/case before reading private heads, dispatch only the current paid draft source, and claim that exact job using database-clock eligibility. A tenant-wide queue claim cannot consume another kind or superseded source. Concurrent callers serialize through case/job locks. Cancellation is never reset; expired leases advance the fence; exhausted jobs enter a durable hold instead of remaining unclaimable running rows.
Claim/failure transitions and safe audit reasons commit together. Transient failures use persisted 30/60/120-second backoff and the saved maximum attempts; source supersession cancels obsolete work, host interruption stays retryable, missing documents/unknown provider outcome require explicit follow-up. No raw provider error or customer text enters audit reasons. Old fences and expired leases cannot overwrite newer work; lost success responses validate/replay the saved manifest. Disabled execution/provider configuration is effect-free.
Verification: 79 focused tests across five files, full typecheck and changed-file lint pass. P05-saved-job-runtime-db.json has 22 actual isolated DB checks (nine extraction/source, seven whole-job, six new runtime). Independent worker connections compete for one current claim, a missing month produces a persisted hold/audit, transient injected failure records DB-time backoff, early polling does not consume an attempt, a retry advances the fence, and the third failure produces exactly one final hold with the three expected failure audit events. No additional injected provider pass. The safe audit path passed under existing scoped worker permissions; no grant or migration was added.
Two exact product QA cases and their request identity were removed and the machine session revoked. Synthetic canonical lifecycle/job/analysis/report/outbox/audit history remains explicitly retained, including held/retried jobs. This is not a live provider/hosted Storage, scheduler or customer-publication proof. Both 3158133 CI runs passed (34189114788/34189112298); the new commit needs its own CI.
The host iteration is implemented, not a provisioned or deployed daemon: production machine-session lifecycle, packaging/entrypoint, scheduling, unknown-outcome recovery operations, live provider configuration/ground truth and customer projection/publication remain open. Browser-proved Preview is still 6cb92fa with 57 checks. Its Git source includes earlier worker modules; that does not prove they are included in executable application bundles or that a worker ran there. No release-branch production change. Continue actual Storage composition, monetary/publication work and the other P00-P13 gaps.


## P05 two-case actual Storage composition — base 4b52001 (2026-09-08)
P05-saved-job-storage-db.json passes 26 actual isolated checks: the prior 22 runtime checks plus four Storage/two-case checkpoints. Uploaded two distinct generated PDFs with upsert=false to the existing private DEV salary-documents bucket; exact downloads matched their independent SHA-256 values. Actual scoped DB admission refuses another case/version before using server Storage access. A second provisioned case independently completed questionnaire, actual Storage bytes, durable extraction/checkpoint, canonical monthly draft/report and final manifest. Its replay did not repeat provider work and its worker could not read the first case's report. Both files remained byte-identical before cleanup.
Exactly two product QA cases/documents, the primary request identity and two owned Storage objects were removed. Exact bucket-prefix listings confirm object absence; both created machine sessions were revoked. Canonical synthetic audit/lifecycle/job/analysis/report/outbox histories for BOTH tenants remain explicitly retained. Storage bytes were removed only after their owned product case/document rows; retained synthetic audit references are not live customer documents. Private service credentials stayed in the local Node process and are absent from browser state, Git and receipts.
The transport still returned injected deterministic model responses (two passes total, one per case), so this proves physical Storage/DB/worker composition and recovery, not OpenAI network delivery, extraction accuracy, a real payment or customer publication. Provider-time NOWAIT case-lock checks remain valid while independent heartbeat transactions are allowed. Cleanup drains pending work and now closes all DB clients even if cleanup fails. The host result type was narrowed so succeeded always carries a validated completion result.
Final local verification: 79 focused checks, full typecheck and changed-file lint pass. No new migration or production mutation. Both 4b52001 CI runs passed (34189966638/34189965141); this checkpoint requires its own CI. Browser-proved Preview remains 6cb92fa/57 checks. Worker provisioning/host packaging/scheduler, actual provider calibration, canonical monetary binding, AI customer publication and the other P00-P13 gaps remain open.
The remote UI branch advanced from 65af0c3 to 68d82cc via cdc3ae6 and 133a41c. Read the new studio-design diff/document; integration is next, not already done. That branch reports a separate public production deployment of 133a41c (dpl_4CNGHNBCBBZa8rNrDZxFzkUxcwzV); this thread has not independently verified it and has not deployed the release branch to production.


## P11 studio integration — base 49b35c7 (2026-09-08)
Integrated the parallel UI delta 65af0c3..68d82cc15577f306776a82ca0c2c34a2529dbdfb through a three-way patch, preserving the release branch and the other working tree. Optical artwork, progressive process, reduced-motion support, responsive studio typography and compact navigation are now combined with the release's server capability guard, actual closed-sales configuration, AI disclosure, 99/199/349 totals and verified 9.99 initial-credit balances. Existing-case links enter /cases. The accessible manual explainer retains captions, offscreen pause and an operable written alternative; its new WebP poster is integrated. No route, migration, provider configuration or production change.
Local verification: full typecheck, changed-file lint and 36 focused pricing/entrypoint tests pass. Extended the pinned Preview runner for artwork/CTA placement, dark theme, keyboard process/report tabs, live reduced-motion changes, client-navigation CSS isolation and actual new asset hashes. These new browser checks have not run yet. Prior 6cb92fa Preview remains the last independently proved deployment (57 checks); exact new CI and a new isolated Git Preview are next. Both 49b35c7 CI runs passed (34190707932/34190702635). P11 and the overall P00-P13 release remain partial; no accessibility certification, live OCR accuracy, monetary publication or full rollout is claimed.


## P11/P13 integrated studio Preview proof — 17c668e (2026-09-08)
Preview https://salary-sy8byvdz5-tivdoccom-5042s-projects.vercel.app is READY from exact Git SHA 17c668ef480f1b70e612d8906a9b81d79073f121 (dpl_DW5iNh48muQ2Aovg6RH6pDAwWG7A). Both exact-SHA CI/build/closure runs passed: 34191818087 and 34191815067. Forty public plus twelve request and ten support checks PASS (62 total). Public proof now verifies the studio artwork and CTA at four widths, private-case links, active asset hashes, light/dark layouts, keyboard process/report navigation, actual live reduced-motion cancellation and legal-page CSS after client navigation. Manual video/captions/offscreen pause/network failure and existing sales/privacy gates still pass. Visually inspected the mobile hero and dark mobile pricing viewport; these checks are not full assistive-technology/accessibility certification.
Protected proof repeats lost-response/idempotent draft, answer and correction recovery, immutable history, month display, actual expiry, independent HTTP races, case/Origin denial, support replies and four-width rendering with no page errors. Four exact fresh QA cases/identities/sessions were removed. Support owner reply was through the actual operations DB role, not an owner browser/login. No OTP/provider/real-payment proof and no worker execution in Vercel are implied. Previous 6cb92fa receipts are archived with that suffix. P13-studio-runner-first-failed.json preserves the initial harness failures: a tsx-generated __name helper in a browser-evaluated nested function and networkidle waits. Fixed the callback and used DOM/element readiness; no product assertions were removed. New runner pins and evidence are a later proof commit, not a different application SHA.
The deployment is isolated DEV only, protected, with sales/payment/analytics/providers disabled. No release-branch production deployment, customer case mutation, migration or activation. Upload/Storage browser integrity remains independently proved on 923517e; it has not yet been repeated on this studio SHA. Internal host packaging/provisioning/scheduling, monetary result-to-evidence binding, durable quotes/credits/refunds and AI customer publication remain unfinished, with provider/source/accuracy activation separately blocked. P00-P13 is still partial; continue independent engineering.


## P05 canonical worker host and pooled recovery — base 784041d (2026-09-08)
Added createSavedWorkerHost: a case-pinned machine identity is installed and verified on every short transaction through the existing canonical root. Schema, actor/rotation/tenant, actual worker principal, build identity and local timeouts are checked. Application failure holds survive rollback; uncertain commits remain errors. The root/driver now share the dated disposable release-replay name convention; undeclared remote targets and production/default databases remain refused. No new grants, migration, session minting or HTTP entrypoint.
Three isolated red tests reproduced pooled connections being returned after failed BEGIN/COMMIT/ROLLBACK. Those connections are now destroyed on release. Final local verification: 121 focused tests across ten files, full typecheck and changed-file lint PASS.
P05-saved-worker-host-db.json passes 30 isolated DB/Storage checks (nine extraction/source, seven whole-job, six durable runtime, four Storage/two-case and four actual host checks). The second case uses a real TLS-verified node-postgres pool and the canonical host through questionnaire, actual Storage download/hash, durable extraction, monthly draft/report and completion. Exact replay performs no additional injected provider pass; another case report is invisible. Session-rotation mismatch and revocation refuse work; the pool has no acquired clients left. Two deterministic injected model passes total, not a network provider or accuracy claim.
The first run failed in cleanup because it attempted to reuse its deliberately revoked second session. Recovered exactly two identified QA product cases, one request identity and two hash-verified Storage objects; revoked both sessions and preserved the failure/recovery receipt. Cleanup now uses its existing fixture-owner authority for exact owned case/tenant jobs and records evidence before and after cleanup. Final successful run removed its own two product cases/identity/objects and revoked both sessions; synthetic canonical audit/report histories from both runs remain explicit evidence. No customer case or production change.
Both 784041d CI runs passed (34192584917/34192582908); this host commit requires its own CI. Current browser-proved Preview is still 17c668e/62 checks. The new host has not been deployed. Executable host packaging, managed machine lifecycle/scheduler, unknown-provider reconciliation, monetary/evidence binding, durable commercial quotes and AI customer publication remain open. See docs/saved-worker-host.md; continue P00-P13 rather than treating these bounded checks as RC completion.


## P05 executable DEV worker checkpoint — base 51aff42 (2026-09-08)
Added a Node command and pinned esbuild 0.28.2 build. It packages the canonical host, saved runtime, extraction and draft path, retaining external dependencies from the repository lockfile and the pinned Hebrew font/license. Manifest includes exact Git/source/dependency-lock/bundle/font hashes. Enabled work refuses an uncommitted build, so a clean committed build and actual child-process DB proof must follow this checkpoint. No environment secrets are embedded.
The command is disabled by default and rejects production/Preview. Explicit case/session/actor/rotation, exact disposable DEV target, worker-only DB login and certificate-verified pool are required. Replay-only mode needs no provider/Storage secrets and rejects unfinished work inside the transaction so provisional dispatch/claim rolls back. Full processing has a separate provider flag/configuration, project-matched Storage, existing model-policy pin, graceful signals and a bounded invocation. Stdout/stderr contains only safe state/reason/manifest hashes. It does not mint sessions, schedule recurring work or publish customer reports.
Local: 62 focused checks (12 new command/build/process-boundary checks), typecheck and changed-file lint PASS. The actual built dirty-tree artifact starts as disabled and both source entrypoints/bundle refuse hosted environments. Initial build failed because esbuild's Go regex API does not accept the JavaScript Unicode flag; removed that plugin flag and the real build passed. Existing host DB proof remains 30 checks; new clean-bundle DB/restart proof is pending, not implied by these units. Both 51aff42 CI runs passed (34193850196/34193845659); this checkpoint needs its own CI.
No new migration, production or provider-enabled deployment. Browser-proved Preview remains 17c668e/62 checks. Run the clean bundle proof next, then continue managed machine lifecycle/scheduling, monetary/quote/publication and the remaining P00-P13 work. See docs/saved-worker-host.md for exact configuration and limitations.


## P05 executable output recovery — base ba0712f (2026-09-08)
Both ba0712f CI runs passed (34194769222/34194765515), and the bundle was built from its clean tree. The first actual executable proof stopped at an unfinished-replay refusal: canonical safe diagnostic text on stderr preceded the command's JSON, while the test expected a single JSON document. P05-saved-worker-bundle-stdout-first-failed.json preserves the failed proof and cleanup (two exact QA product cases, one request identity and two objects removed; both sessions revoked; canonical synthetic history retained).
The command now emits exactly one structured result on stdout, including failure, and retains bounded driver diagnostics on stderr. Consumers no longer parse diagnostic lines as response JSON. Twelve command/build/process-boundary tests, typecheck and changed-file lint pass. A new clean committed build and actual child-process proof are next; no executable end-to-end success is claimed yet. Preview remains 17c668e/62 checks, with no production/provider/scheduler activation.


## P05 executable process proof — 7618c7f (2026-09-08)
P05-saved-worker-bundle-db.json passes 34 actual isolated DB/Storage checks: the prior 30 plus four executable checks. Bundle SHA 4cf95b3338abf92c6de124ad438018984d2504a692d2e8c999bc9e4a1f5db2cb was built from clean Git 7618c7f3b6d1ee54ebfe5400974dc9ed1cc73301; its manifest records source, lockfile, font and bundle hashes. The standalone Node program refuses an unfinished replay and rolls back provisional dispatch/claim, leaving no job for that source. After actual Storage-to-canonical-host processing, two new Node processes independently reopen the completed result and emit the same manifest hash without Storage or provider credentials. A later new process refuses the revoked session, with a safe structured stdout failure and bounded stderr diagnostics.
The first stdout/diagnostic mismatch remains preserved with its cleanup. This successful run removed exactly two owned QA product cases, one request identity and two objects, and revoked both machines. Canonical synthetic histories/reports remain explicitly retained. Provider responses were injected in the parent processing test (two total); child replay made no provider call. This proves executable packaging, scoped DB reopening/restart and no-I/O replay, not provider-enabled standalone processing, OpenAI accuracy, a deployed scheduler or customer publication.
The public/protected browser proof remains Preview 17c668e with 62 checks. No migration, production mutation or worker deployment. Both exact 7618c7f CI/build/closure runs passed (34195151754/34195148764). Managed machine lifecycle/scheduling, unknown-provider reconciliation, trustworthy monetary basis/quotes/credit/refund and versioned AI customer publication remain open; P00-P13 is not complete.

## P13 fresh integrated upload proof — 17c668e (2026-09-08)
The protected upload journey now passes all 12 browser checks on the actual studio Preview salary-sy8byvdz5-tivdoccom-5042s-projects.vercel.app, exact deployed SHA 17c668ef480f1b70e612d8906a9b81d79073f121. Fresh owned fixtures prove initial upload, saved-state return, additive upload, explicit replacement, verified Storage bytes before injected completion disconnection, reload/retry, duplicate completion, two real concurrent tabs, contract-only completion of the exact request, foreign-case refusal and four-width rendering without client exceptions. The original payslip and contract retain their document/version identities during addition; replacement changes only its selected version; case/payment remain under_review/verified.
The new owned runner checks the actual bytes of all seven current documents and the one retained replaced version against generated PDF SHA-256 and size. All eight objects remained readable. After browser shutdown it removed exactly its two QA cases and identities/sessions before removing their eight reservation-owned objects; both exact Storage prefixes are empty. No customer data, OTP, payment provider or production change. Visually inspected the final 390px saved-document screen. See P13-studio-upload-browser.json and P13-studio-upload-storage.json; the earlier 923517e proof remains untouched. Current studio application proof is now 74 checks (40 public, 12 request, 10 support, 12 upload), with separate actual Storage verification.
Local changed-runner lint and full typecheck pass. Both 8b6b3bd CI runs passed (34195528872/34195526364). This proof commit needs its own CI. No new application deployment or migration; managed worker scheduling, monetary/evidence binding, commercial quotes/credits/refunds and AI customer publication remain unfinished. P00-P13 remains partial; continue independent development.
## P08 support reload recovery checkpoint — base af51594 (2026-09-08)
Reproduced a lost-response support failure against actual Preview 17c668e: one message was already saved in DEV, but full reload erased the draft and its retry UUID. The failed receipt P08-support-reload-first-failed.json is retained; both exact QA cases/identities were removed. The customer form now records its draft and pending UUID before sending, restores after hydration, locks an uncertain payload until confirmed retry, and clears only the acknowledged form. A synchronous in-flight guard prevents same-render double submissions. Confirmed new messages get fresh IDs. Recovery is versioned, bounded to 2,000 characters/24 hours and scoped to case plus thread in sessionStorage. Logout clears these records. Text states that unsent drafts are local to this tab; disabled browser storage is disclosed and falls back to in-memory retry, not a false durable-save promise. This is not server-side draft persistence or cross-device recovery.
Sixteen focused recovery/support checks, full typecheck and changed-file lint pass. React review checked hydration, keyed case/thread state, labelled/disabled controls, exact pending payload and post-confirmation refresh. Extended real browser runner now requires reload recovery plus independent unsent new/reply drafts. A new exact-SHA Preview and hosted verification must follow this checkpoint; the previous Preview does not contain this fix.
Both af51594 CI/build/closure runs PASS (34196474050/34196471746). Separate legacy cloud browser workflow 34196471578 failed because its temporary TIVDOC_PREVIEW_BROWSER_STATE secret is absent; no browser ran there. Current local-to-hosted studio proof is 74 checks with eight actual Storage SHA verifications. No provider, migration or production change. Continue the remaining P00-P13 work; this is a bounded recovery fix, not release completion.
## P01/P08 pooled connection recovery — base 0e7c9d0 (2026-09-08)
Both 0e7c9d0 CI/build/closure runs PASS (34196901278/34196897740). Its isolated Preview salary-gpbszhds3-tivdoccom-5042s-projects.vercel.app / dpl_BJYg61ET86VsjieyH27o5aWU2u8Z became READY. The hosted support test proved unsent reload, lost-response reload/exact retry, independent drafts/reply and concurrent ownership behavior, then hit a real error screen during later width checks. Vercel logs identify EMAXCONNSESSION / XX000: the isolated session pool's 15-client limit. The failed receipt is retained; both owned QA cases/identities were removed. This is not a full successful browser run.
Two isolated red tests reproduced eight parallel cold resolver calls constructing eight pools, for both web and operations. Pool construction/cache assignment now has no asynchronous import gap. Pinned @vercel/functions 3.9.5 attaches both pools to Fluid's request lifecycle, with min 0 / max 2 / five-second idle timeout and fixed, non-sensitive idle-error diagnostics. The official API is https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#attachdatabasepool and guidance is https://vercel.com/kb/guide/connection-pooling-with-functions. This does not raise the DB connection allowance or change database selection/credentials.
Local: 36 pool/adapter/preview/recovery/support tests plus 12 executable bundle checks PASS; full typecheck and changed-file lint PASS; npm audit reports zero vulnerabilities. P01-product-pool-db.json proves one actual TLS web pool for eight concurrent read-only RPCs, at most two clients, actual idle TCP drain, and fresh reconnect through the same pool; all clients close. No fixture/identity was created. Constructor observation uses the real pg transport; it is not yet a proof of Vercel suspension. The initial test spy could not preserve the native pg prototype and was replaced by a real subclass; no live DB failure is inferred from that harness error.
Next: commit, exact-SHA CI and new isolated Preview, then complete support/logout and rerun the integrated journeys. Previous full studio proof remains 17c668e/74 checks/eight verified Storage objects. Current worker binary output was rebuilt by its boundary tests as a disabled dirty artifact; the earlier clean 7618c7f evidence/manifest remain archived and valid for their stated SHA. No production, provider, migration, scheduler or legal activation. Monetary/quote/credit/refund/customer-publication and other acceptance gaps remain unfinished internal work.
## P01 transaction pool readiness — base cf4d101 (2026-09-08)
Both cf4d101 CI/build/closure runs PASS (34198167583/34198164521). Direct verified-TLS probing confirms the DEV transaction endpoint on port 6543 resolves to exactly tivdoc_release_replay_20260907 as tivdoc_web_runtime. The Preview selector now permits that port in addition to the prior explicit 5432 rollback target, preserving its exact branch/environment/host/user/database/CA/query restrictions. Product web calls are single SQL-function statements without named prepared statements or session-carried request identity; canonical worker transaction handling is unchanged. Supabase's primary guidance recommends transaction mode for serverless clients: https://supabase.com/docs/guides/database/connecting-to-postgres#pooler-transaction-mode. The changelog was fetched through the shell after the web tool refused its Markdown content type; no applicable pooler breaking change was found.
Eighteen focused checks PASS including actual TLS/RPC/cold concurrency/idle release/reconnect on both ports (three actual assertions each, separate receipts). Full typecheck and changed-file lint PASS. Branch-only Preview configuration still needs its explicit port update and a new exact-SHA deployment; no production settings or database grants changed. Full browser proof is pending; the failed 0e7c9d0 session-pool run remains evidence, not a pass.
The legacy cloud browser workflow repeatedly triggered on runner edits without its removed temporary cookie (latest failed run 34198164527). It is now an explicit manual evidence run with an early required-secret failure, using the current public launch runner and its own artifact directory. Normal push/PR CI remains unchanged; no test was converted to a passing skip and no GitHub secret created. Linux uses the installed Playwright Chromium; local Windows uses installed Chrome. This manual cloud path is not newly verified. Continue with the isolated Preview and remaining internal P00-P13 work.