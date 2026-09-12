# Release integration checkpoint — work continues

The single scope and acceptance contract remains [tivdoc-release-candidate-v1](tivdoc-release-candidate-v1.md). Base `0c5d9c0`; preceding pushed engineering checkpoint `54279912fc6e30dd4dd0a16b8407412ddb2570d7`, whose two CI runs passed. This checkpoint is not release acceptance, a deployment or a human attestation.

## Implemented and locally verified

- All nine purchased topics have bounded source-dependent branches through the existing entitlement composer and RuleSpec executor. Fixed/linear contractual commitments and bonuses preserve unknown conditions and distinguish unmet conditions from zero money. Historical RuleSpec v0.6.0 remains readable; the new topic extension is v0.6.1.
- Automatic payroll/pension/benefit adapters consume retained extractions, identified readings, questionnaires and source relationships. Attendance/contract extraction has a separate typed receipt; it cannot silently stand in for payroll facts. Conflicts, units, row/cell identity, source versions and reading history are retained.
- The existing durable extraction invocation/checkpoint path now supports scoped attendance/contract requests, uncertain provider outcomes, receipt replay and independent-month continuation. This code has replay/provider-contract tests; no new live provider call or managed scheduler acceptance was performed here.
- Document-field UI/API support individual non-payroll cells with confirm, correction, unknown and unreadable. Versioned money normalization v2 rejects malformed grouping; v1 replay preserves historical semantics. Partial reading decisions do not confirm an entire document or legal applicability.
- Versioned AI policy, source/interpretation/test receipts, compiled generator identities and deterministic decision recipes are connected to the ordinary case-analysis service. The automatic assessment is a derived manifest witness, not a document reading or a new legal decision. Actual missing operands and applicability decisions remain blockers.
- The same-run qualified AI report renderer preserves expected, recorded and signed difference separately. It does not relabel a candidate as a verified debt or infer an actual pension transfer. Historical rendering without the new envelope is unchanged.

Evidence sets are independent; counts below are not an end-to-end pass total. Focused runs passed: policy61; runtime27; service/persistence validation31; decision recipes23; automatic assessment8; configuration/build25; strict money/reading/provider70; shared UI/API80; qualified report9. Root integration groups passed75 (worker/runner/snapshot/automatic evidence) and25 (configuration loader, existing request opening and source dispatch); the finalizer/key group passed70 and the Finding persistence group48. A separate late-provider-receipt group passed11 after the retained-version fix. Typecheck found test-only narrowing/environment types after these additions; those were fixed before the checkpoint's final typecheck. No test thresholds or guards were removed.

## DEV and migration status

Isolated DEV schema **172** has applied, preflighted migrations:

1. `20260912080403_document_evidence_invocation_contract.sql`
2. `20260912082645_document_evidence_identified_readings.sql`

Forty synthetic SQL contract assertions passed in a rollback transaction. Two subsequent migrations are code only, not applied at this checkpoint:

3. `20260912084511_document_evidence_answer_revision_currentness.sql`: keep remaining questions/source accessible after answer-only revisions; preserve exact document/version/hash and normalization-policy currentness. Money helper matched all45 input rows for both historical and new policy, **90 comparisons**.
4. `20260912085031_ai_release_configuration_registry.sql`: immutable configuration/enrollment journal, worker-only DEV/QA context and separate expiry/revocation. Ten direct-table permission checks passed with the preflight. Enrollment lifecycle, concurrency and publication integration still require DB verification.

A further retained-source receipt helper (`20260912091000_document_evidence_retained_receipts.sql`) is not applied or DB-tested yet. It enables saving a late provider result against immutable old-version metadata while current-source checkpointing still refuses it. The Finding schema/RPC migration is undergoing root integration separately.

The complete100-check follow-up preflight rolled back. It is not proof of migration application, full enrollment or an end-user journey. Private receipts record migration hashes and the exact isolated database. No Production changes.

## Remaining software work before acceptance

1. Ordinary AI Finding persistence and finalizer profile/key selection are implemented and locally tested; their SQL boundary still needs DEV proof. Complete report publication/currentness. The findings schema extension represents actual source references, nullable confidence and signed comparisons; it does not invent UUID facts or confidence.
2. Apply and verify the remaining DEV migrations; issue a scoped QA enrollment and reusable operational configuration without reviving revoked machine grants or resetting spending.
3. Make protected report/source access, pending notifications and operational health reflect current AI configuration/expiry. An old source revision or policy must not become current through retry or a late delivery event.
4. Run one final full-app/DEV chain, update the five private drafts from the integrated path, inspect matching HTML/PDF and prove targeted source/answer changes, retry, replacement and foreign access. Earlier browser/Preview evidence belongs to older application versions.
5. Complete release acceptance CI, exact build/schema/deployment manifest, migration order, transition checks and rollback runbook. No current browser or Preview acceptance is claimed here.

## Activation decisions and external dependencies

[Product boundary research](ai-release-product-boundary-2026-09-12.md) separates statutory reserved legal services from internal reviewer quorums and per-report signature claims. The concrete unresolved external decision is review of the actual personalized report/question/actions and operating model against that boundary. A generic AI label does not settle it. This is distinct from the software tasks above and does not stop their implementation.

Source and method decisions retain their own receipts, periods and limitations, including hourly minimum-wage method and monetary rounding. No human approval was created. Historical private source gaps and ownership review remain scoped to their cases.

Provider ledger remains **10/12 content calls, USD3.56 reserved/5, two historical unknown costs**. No provider spending, customer messages, charges, Production changes or parallel UI edits were made in this checkpoint. Continue the authorized release work; do not stop merely because this checkpoint is saved.
