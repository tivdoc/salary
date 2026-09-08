# Tivdoc release readiness — development checkpoint, 2026-09-08

The release is **not an RC and not ready for live sales**. Work continues under the owner-approved [v1.1 decisions](release-specs/tivdoc-launch-decisions-and-next-task-v1.1-he.md). This is a current evidence index, not a replacement execution plan or a claim that P00–P13 is complete.

## Source and deployed environment

- Integration branch: `codex/tivdoc-release-completion`, [Draft PR #2](https://github.com/tivdoc/salary/pull/2), dependent on [upload-integrity PR #1](https://github.com/tivdoc/salary/pull/1). Source includes the cumulative price-correction intake, customer pending status and supplier charge/checkout contract repairs. Exact implementation commits are recorded in Git and HANDOFF.md; source is newer than the separately identified Previews.
- Parallel UI integrated through `85177bcf507c3820cc5f1131f4f438a56b1f504c`; its author's checkout is separate and unchanged by this task.
- Verified [isolated Preview](https://salary-ezhfzrike-tivdoccom-5042s-projects.vercel.app): exact `45cf30f178a86e45793e90e3789f225fe7024e9d`, deployment `dpl_6fpJkYMsbFRvxfFPUEVJudSJbSoM`. CI `34255608069` and `34255602893` pass. The later correction intake is not in this deployment.
- Preview uses DEV project `cpzrbidxftzqcfeqqusu`, database `tivdoc_release_replay_20260907`, the actual server-side PostgreSQL adapter and DEV Storage. Sales, mail and extraction-provider flags remain disabled. No release-branch production rollout occurred.
- Current fresh schema proof: `tivdoc_release_chain_20260908_80c4b2a`, 117 migrations, 115 raw and two explicitly recorded managed-platform compensations. Shared role provisioning unchanged. This separate database contains no customer fixtures.

## Implemented versus verified

| Capability | Implemented | Verified | Ready to operate / deployed |
|---|---|---|---|
| Saved document addition/replacement and selected late completion | Immutable versions, reservations, case-wide limits, explicit replacement and exact request linkage | Hosted UI → HTTP → actual DB/Storage, retry after transferred bytes, two tabs, foreign-case refusal; 12 current checks, 8 object hashes | Verified in the named DEV Preview; no production rollout |
| Saved answers and support | Versioned answers, draft recovery, correction/retry identity, expiry and customer support | 12 request + 12 support hosted checks with owned synthetic identities | Named DEV Preview; live mail/reminder delivery unproved |
| AI report publication, source and PDF | Versioned AI policy, immutable published data, exact paid-offer/source gates, automation disclosure and finding-specific correction recovery | 9 actual DB + 11 hosted report checks; real source bytes, foreign access refusal, PDF text and visual inspection | Named DEV Preview with owner-seeded synthetic report/payment; canonical writer and real rule activation absent |
| Quote and paid-order commercial rules | Saved original pricing policy, initial-credit reservation, atomic acceptance, unstarted cancellation and checkout freshness | 9 ledger + 11 acceptance + 11 cancellation DB assertions; focused arithmetic tests | Internal worker boundaries; no customer quote UI, live checkout or trusted monetary reader |
| Downward price correction | Immutable cumulative request ledger and original-policy arithmetic; preserves paid terms and entitlement | 12 actual worker/peer/web DB checks; eight hosted customer-order checks on d6c2b16 | Customer pending status proved on d6c2b16 DEV Preview; no provider dispatch/settlement, owner queue UI or canonical correction reader |
| Saved extraction and worker | Verified stored source, durable invocation receipts, monthly canonical draft, fenced paid admission and clean standalone bundle | Earlier 34-check Node bundle DB/Storage proof includes two fresh process replays and revocation | Live OCR accuracy, managed machine lifecycle and scheduling not ready |
| Public UI | Parallel studio integration, responsive navigation, process tabs, accessible video alternatives, v1.1 pricing and AI wording | 44 hosted checks on the named source; mobile protected-header containment proved separately in report flow | Named DEV Preview; full assistive-technology/user-study criteria remain |

The current combined [91-check receipt](release-evidence/P13-45cf30f-integrated-preview.json) identifies its exact source. Nine Storage objects and eight owned synthetic cases/identities were removed after the hosted checks; no real customer was used. The exact deployment's 20-minute error query returned zero rows. A passing synthetic report is not a validated salary finding or a real payment.

Additional focused Preview: https://salary-jew7zf36n-tivdoccom-5042s-projects.vercel.app, exact d6c2b16461ad0a4efde40cb4c3a34f689d61002d; CI 34259344025/34259340084 pass. Eight customer-order refund checks, 12 DB assertions and owned cleanup pass. This is separate from the full 91-check source above. A subsequent Invoice4U charge-kind/currency repair and QA endpoint support pass 67 local tests but are not in that Preview.

## Remaining work and external dependencies

Ordinary unfinished engineering: canonical paid/expected/gap semantics and evidence binding; saved monetary projection and quote reader; corrected report regeneration; customer quote/cancel and configured owner presentation; one provider reconciliation path accounting for customer requests and cumulative corrections; managed worker lifecycle/scheduler; contact-change verification and complete privacy purge/accounting separation; operational cost/Storage controls; remaining offline/shadow/rollout acceptance.

External dependencies are scoped in [release blockers](release-blockers.md): authorized OCR credentials and measured calibration; genuine source/parameter/golden activation evidence; Resend sender/DNS/webhook/test-recipient configuration; verified Invoice4U checkout, receipt and refund contract. No AI decision is recorded as a person's attestation. The six real unserved customers remain real and unserved unless an actual delivery is separately proved; they are never QA fixtures.

The existing automatic ceiling remains 5,000 ILS per finding. With one initial month and at most three checked topics, an automatically published initial report cannot currently reach the 20,000 ILS pricing tier. Changing an accuracy policy to make a price tier reachable is not authorized by a commercial price table.

Use the full [acceptance matrix](release-evidence/P13-acceptance-matrix.md), [package tracker](release-completion-tracker.md) and [handoff](../HANDOFF.md) for individual results, failed runs and precise continuation boundaries. `Implemented`, `verified`, `ready to operate` and `deployed` remain separate states.

Current payment binding checkpoint (base bfd61f6): 14 actual DEV assertions, 97 focused local checks plus three definer checks. Applied migration tail is 20260908182405_payment_reference_binding.sql (117 files), with unchanged execution ACLs. Fresh 80c4b2a replay now proves all 117 files; the 116-file predecessor is archived. The READY bfd61f6 Preview is not yet browser-proved and does not include the later binding change.
