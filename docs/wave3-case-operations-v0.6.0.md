# Wave 3 case operations and deterministic reports V0.6.0

This lane implements a headless, production-shaped application boundary for verified payment evidence, append-only case state, immutable human review tasks, deterministic report artifacts, and exact-hash manual export eligibility. It contains no live payment, delivery, customer-file, OpenAI, external database, migration, deploy, or Shadow adapter.

## Canonical lifecycle

The versioned lifecycle is:

```text
awaiting_payment
  → awaiting_documents
  → awaiting_extraction_review
  → awaiting_fact_resolution
  → ready_for_legal_evaluation
  → awaiting_legal_review
  → awaiting_report_approval
  → report_ready
  → release_hold
  → delivered | cancelled
```

`delivered` is only a domain state. No delivery implementation exists. Cancellation is permitted from nonterminal workflow states. The payment-gated transition cannot be invoked through the generic transition method.

Every accepted command appends a hash-chained event containing the case revision, actor, role, injected-clock timestamp, reason, command hash and prior event hash. Same idempotency key plus identical command returns the original result without another event. Reuse with different command content is rejected before mutation. Invalid transitions leave state and audit history unchanged.

Upstream document, extraction, fact, catalog, analysis or report mutation creates a new case revision, returns the case to the corresponding review stage, appends an invalidation event and makes prior report approval/export eligibility unusable. Prior tasks, decisions and receipts remain preserved.

## Payment evidence

Only `PaymentEvidencePort.loadVerifiedEvidence` is consumed. There is no `paid=true` boundary and no provider call. Advancement requires one exact settled evidence snapshot bound to the case reference, opaque customer reference, currency and integer-minor-unit `Money` amount. Unmatched, mismatched, pending, failed, cancelled and duplicate evidence fails closed. Refund, chargeback, or a material revision/hash change moves an already paid case to `release_hold` and invalidates report approval.

## Human review and export

Four immutable task kinds are supported: extraction review, unresolved fact conflict, legal-evaluation review and report approval. Decisions bind reviewer identity/role, exact input/output hashes, timestamp, reason and schema version. The strict decision boundary rejects unknown fields, including any replacement monetary total. Corrections must produce a new upstream snapshot and deterministic rerun.

Manual export eligibility requires both:

1. case state `report_ready`; and
2. an approved, non-invalidated report task whose output hash exactly equals the requested report hash.

No automatic export or delivery occurs.

## Deterministic report package

`DeterministicCaseReportBuilder` consumes the frozen `AnalysisResultBundle` and emits canonical JSON, RTL Hebrew HTML, a reopenable PDF and a canonical manifest. The report has all seven topic slots, full Fact provenance/conflict state, readiness/source-version bindings available in the bundle, rule versions and calculation traces. Missing instrument/citation/parameter detail is represented as absent and never invented.

The pre-approval report records the required decision schema and declares that reviewer metadata lives in the detached, hash-bound review receipt. Embedding the later decision inside the already approved bytes would create a circular hash and mutate the approved artifact, so reviewer identity, role, decision, timestamp and reason remain in the immutable receipt whose output binding is the exact `report_sha256`.

Incomplete coverage is labelled exactly as a known subtotal, never total entitlement. Blocked or unknown topics are displayed and are not treated as zero. The report carries an awaiting-human-review marker and explicitly forbids monetary override. The PDF metadata binds report/case IDs, analysis hash and JSON/HTML component hashes; verification reopens the PDF and recovers those values.

## Commands

Run with Node's TypeScript stripping from repository root:

```text
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/case-operations/run.mts case:ops:verify
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/case-operations/run.mts case:ops:synthetic-demo
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/case-operations/run.mts case:report:verify
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/case-operations/run.mts case:privacy:verify
```

All commands delegate to the same case, review and report services. Generated neutral synthetic artifacts and raw matrices are written only to the ignored `output/parallel-wave-3/workers/w1-case-ops` directory.

The receipt records zero customer reads, provider calls, delivery attempts, external writes, OpenAI calls, external Supabase connections, migrations and deploy actions. Privacy-safe logs contain only opaque identifiers, hashes, revisions and status/event codes; raw reason text, amount, customer reference and document bytes are excluded.
