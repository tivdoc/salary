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
