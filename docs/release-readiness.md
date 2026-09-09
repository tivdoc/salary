> 2026-09-09 scoped task resumed: P06 base repaired; 44 local + 23 actual DB checks pass, migration122 upgraded on isolated DEV. Verified Preview still ea0875a. One QA engineering financial flow is now being implemented; real activation/production remain closed. See HANDOFF.md and P06-field-topic-baseline.json.

> **2026-09-09 owner-requested stop:** Development is paused. The [interim handoff](interim-handoff-2026-09-09-he.md) supersedes continuation instructions and status labels below. Latest P06 scope code has 38 focused passes only; candidate migration 122 is NOT applied/executed, and DB fix, typecheck/lint and hosted proof are pending. Verified Preview remains ea0875a (123 checks); do not deploy the WIP application on the current 121-migration schema. No production rollout.

# Tivdoc release readiness — 2026-09-09

The release is **not an RC and not ready for live sales**. Development continues under the owner-approved [v1.1 decisions](release-specs/tivdoc-launch-decisions-and-next-task-v1.1-he.md). Implementation, verification, readiness and deployment are distinct below.

## Current source and deployment

- Integration branch: `codex/tivdoc-release-completion`, [Draft PR #2](https://github.com/tivdoc/salary/pull/2), dependent on [upload-integrity PR #1](https://github.com/tivdoc/salary/pull/1). Parallel UI is preserved through `85177bcf507c3820cc5f1131f4f438a56b1f504c`; its separate checkout was not edited.
- Verified [isolated Preview](https://salary-249wckccu-tivdoccom-5042s-projects.vercel.app): application `ea0875a5eb633acbb4435c04217a0d13dbffcecb`, deployment `dpl_6xrS9bt6xNLkUaKbnSKSVGrnHjHs`. CI/build/closure `34307799736` and `34307796375` passed. Later evidence and synthetic test-fixture repairs are identified separately in HANDOFF.md.
- Preview uses DEV project `cpzrbidxftzqcfeqqusu`, database `tivdoc_release_replay_20260907`, the real server-side PostgreSQL adapter and private DEV Storage. Sales, mail and extraction-provider flags remain disabled. **No release-branch production rollout occurred.**
- Fresh schema proof: `tivdoc_release_chain_20260908_163bc3c`, all 121 unchanged migration files (119 raw and two recorded managed-platform compensations). Shared role provisioning unchanged.

## Implemented versus verified

| Capability | Implemented | Verified | Ready to operate / deployed |
|---|---|---|---|
| Saved uploads and late completion | Immutable versions, case-wide limits, explicit replacement, exact request linkage, retry/concurrency authorization | Current Preview: 12 hosted checks, eight current/retained object hashes; second payslip, replacement, contract-only completion and foreign refusal | Named DEV Preview; no production rollout |
| Field readings and replacement | Exact document/version/bytes/candidate/month/revision; identified readings, corrections and stale history; focused replacement from negative/unreadable answers | 15 DB + 14 hosted checks; normal sign/PUT/complete path, both real source objects retained until owned cleanup | Named DEV Preview; synthetic extraction, no live OCR accuracy or inferred corrected amount |
| Saved requests and support | Typed answers/drafts/corrections, expiry, customer support and unified finding-specific owner queue | 12 request + 12 customer support hosted checks, including retries; owner reply injected through actual operations DB role | Customer journey in Preview; configured owner HTTP/UI and real mail delivery unproved |
| Customer cancellation | Same-origin authenticated selected-order cancellation, exact receipt, case/order locks and one-time credit release | 8 customer + 11 existing quote DB checks; 10 hosted checks with committed response loss/retry, foreign identity, reload and four widths | Named DEV Preview; any checkout/payment prevents cancellation; no supplier call |
| Price and order policy | Saved 99/199/349 ILS tiers, initial credit, atomic quote acceptance, expiration and correction ledger | 9 quote + 11 acceptance DB assertions; 12 correction DB + 8 current refund-status browser checks; payment binding and contract fixtures | Customer pending status in Preview; trusted monetary reader, customer quote UI and provider settlement remain |
| AI report/PDF/source | Versioned AI disclosure and publication gates, historical human terms, exact protected source and finding correction | 9 DB + 11 hosted checks; real PDF/source bytes, foreign refusal, mobile and PDF visual inspection | Named Preview with owner-seeded synthetic report/payment; canonical product projection writer and correction regeneration absent |
| Saved worker | Paid admission, durable provider receipts, fenced queue/heartbeats, canonical saved draft and standalone executable | Clean ea0875a bundle: 34 DB/Storage checks, two fresh Node process replays and revoked session refusal; two objects/cases cleaned | DEV executable; provider transport injected. Managed machine lifecycle/scheduling and live provider reconciliation not ready |
| Calculation provenance | Distinct fact/parameter pins, exact RuleSpec replay and full saved-stage/case/run binding | 36 new local + 6 actual DB assertions (054ddaf); prior full local suite 3,033 pass/37 opt-in skip | Included in current source; arithmetic foundation only, no activated monetary execution |
| Expected versus recorded comparison | Explicit interpreter subtraction, source component provenance and signed result | 11 new local + 2 actual DB assertions (ddeff9a), with repeated trace/field proof | Included in current source; not a Finding, proof of pension transfer or pricing permission |
| Public UI | Parallel studio UI, v1.1 prices/AI wording, responsive navigation and accessible video alternatives | 44 current hosted checks; protected mobile layouts and new Hebrew month question inspected | Named DEV Preview; complete assistive-technology/user-study acceptance remains |

The [123-check receipt](release-evidence/P13-ea0875a-integrated-preview.json) binds all browser results to the same deployed application. Eleven source objects were verified and removed; 14 successful-run synthetic cases and their owned identities/sessions were cleaned. Older identity-cleanup receipts do not separately count deleted identity rows. The clean worker proof uses two additional cases and objects. Exact deployment error query: zero rows in its recorded 20-minute window.

One field fixture initially failed before PUT because its primary month lacked a retained payslip. The corrected fixture passed all 14 checks against the same unchanged application; its hash and failed/passing receipts are retained. This is a test-data repair, not a weakened upload guard or a live OTP proof. Earlier 4ce9a2b contact-verification fixture failure and 115a2dd/163bc3c passing evidence remain archived. A synthetic paid report is not a validated salary finding or a real payment.

## Remaining engineering and dependencies

Ordinary unfinished engineering: saved legal execution and paid/expected/gap-to-product projection/quote composition; corrected report regeneration; customer quote and configured owner presentation; unified provider reconciliation for customer requests and cumulative refunds; managed worker lifecycle/scheduler; purchased-topic question generation and reminder execution; contact-change verification and complete privacy purge/accounting separation; operational cost/Storage controls; remaining offline/shadow/rollout acceptance.

Scoped external dependencies are in [release blockers](release-blockers.md): authorized OCR credentials and measured calibration; genuine source/parameter/golden activation evidence; Resend sender/DNS/webhook/test-recipient configuration; verified Invoice4U merchant checkout, receipts and refund settlement. AI research decisions are not human attestations. The six real unserved customers remain real and unserved unless an actual delivery is separately proved; they are never QA fixtures.

The automatic ceiling remains 5,000 ILS per finding. With one initial month and at most three checked topics, an automatic initial report cannot reach the 20,000 ILS pricing tier under this policy. A commercial price table does not authorize weakening an accuracy gate.

See [acceptance matrix](release-evidence/P13-acceptance-matrix.md), [package tracker](release-completion-tracker.md) and [handoff](../HANDOFF.md) for historical exact-source results, failures and continuation boundaries. No blocked capability is marked completed here.
