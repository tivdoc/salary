# June2026 collection integration

This extends the unsigned candidate/source package saved in `90ffe97`. It does
not activate that candidate, produce a live-OCR financial report or attest legal
conclusions. The current product policy still closes unanswered requests after
ten days; no automatic renewal/reminder loop was added.

The existing saved extraction transaction now opens a bounded inventory of
June2026 minimum-wage questions: six applicability declarations, earnings
completeness and at most32 individual component descriptions. Both the worker
adapter and SQL require the document's actual month and an active paid order
containing minimum wage for that month. A July purchase cannot authorize June.

Each target binds the case, product document, version UUID, source SHA,
extraction policy/result SHA, month and legal interpretation policy SHA. The
component projection uses safe integer money/page values so JavaScript and
PostgreSQL hash the same bytes even when the full extraction contains1e-7
confidence/geometry. The entire original extraction remains bound by its SHA.
SQL derives the exact displayed question and options; a worker cannot invert a
question's meaning while the answer interpreter assumes the original wording.

Original answers require the identified RPC. Originals, corrections and drafts
all recheck current document/checkpoint/month/purchase and the linked identity.
Corrections append to the existing answer journal and source outbox; opening a
question does not itself create a new input revision. An exact retry is not a
second answer. One answer does not stale its siblings. Replacement invalidates
all prior source targets. The existing thread reads current-state metadata for
this namespace, while the existing notification eligibility/status functions
recognize these requests. No new queue or email provider was introduced.

The same canonical run persists the typed collection receipt in its hashed
`review_pending` stage: declared, unknown, conflicted, missing, expired or stale.
It includes the actual request, answer revision, actor, source and policy.
Declarations remain `needs_confirmation`/`unreviewed`; they never become a
customer's legal approval. The canonical report still has no monetary result
while admission is blocked. Expired unanswered targets return no opened UUID;
reissuing a closed request is a remaining product policy/implementation task.

## Upgrade and evidence

- Schema128: `20260909181537_june2026_minimum_wage_collection.sql`.
- Schema129: `20260909183727_june2026_collection_age_prompt.sql` — includes a
  person whose eighteenth birthday is June1 and aligns SQL/TypeScript wording.
  The first functional run caught the mismatch; schema128 was not silently
  edited after application. Both upgrades were applied to the existing isolated
  DEV database before deploying dependent code. A fresh129-file replay was not
  performed.
- Schema130: `20260909185038_june2026_collection_source_link.sql` reuses the
  identified source RPC for June questions, including foreign-identity and
  replacement checks. The thread links the exact document and labels the answer
  as a declaration. It does not misleadingly call required applicability input
  an optional accuracy improvement. No new design flow was introduced.
- Local pure collection tests:52; orchestration/materializer and adapter tests
  are included in the final focused receipt. Full TypeScript/lint results and
  exact tested source SHA are in the package handoff.
- Actual PostgreSQL proof uses worker/web roles and provisioned synthetic
  machine identity, with existing RLS. No permissive fixture policy or disabled
  guard. It proves month/topic refusal, eight necessary questions, exact prompt
  parity, replay, parallel original answers, correction history, scoped reads,
  replacement invalidation and two separately persisted canonical review runs.
- The proof uses synthetic DB document metadata/checkpoints and synthetic paid
  entitlements, including a legacy full-offer fixture solely for the scope
  matrix. It performs no Storage upload, OCR, OTP session injection, email send
  or payment. Existing upload proofs are reused. Its blocked draft is not a live
  financial report. Test machine identities are revoked afterward; synthetic QA
  cases/history remain for inspection and are not enrolled in a worker registry.

The initial CI on `90ffe97` also caught a real historical-artifact regression:
the parser used the current June catalog to validate old parent keys. New
financial artifacts now pin their parent-key catalog SHA explicitly. The v1
reader retains the exact original key recipe for old artifacts; unchanged
historical HTML/PDF byte tests pass. Hash, source and calculated-result checks
remain enforced.

## Remaining canonical admission work

Collection is now connected; the next technical boundary is an admitted
evidence materializer and the ordinary executor binding. It must distinguish
factual customer declarations from legal component/sector/section30 assessment,
use only current scoped inputs and verified source/parameter/rule versions, and
create findings through the same canonical parent. No implementation may turn
free text or an OCR label into a legal confirmation merely to enable the rule.

The source/rounding/attestation decisions and blank human-review packet are in
[the canonical review dossier](minimum-wage-june2026-canonical-review.md).
Those are separate from the technical adapter and from missing provider access.
v1.1 removes the promise of a human review for every AI report; it does not
produce the source/rule activation attestations required by the current code.
