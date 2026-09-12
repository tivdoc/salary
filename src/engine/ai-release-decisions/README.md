# Deterministic AI method decisions v1

The server validates each descriptor against its current admitted configuration,
reviewed interpretation and source receipts, including expiry and revocation.
This module then matches the exact compiled recipe/source-policy hashes and
source versions, validates the whole source packet through the ordinary composer,
and evaluates explicit typed predicates. It does not obtain external authority.

Apply it while constructing the command-pinned `DocumentReviewInput`, before
`document_review_sha256` is fixed. The source packet is copied, never edited in
place. No descriptors means the original object and bytes are returned unchanged.
Actual customer-answer history is resolved by the ordinary composer before a
predicate is considered; original facts remain original in the returned packet.
Rebuild that original packet for each changed answer or policy. Passing this
factory's earlier method decisions back as source fails with
`AI_DECISION_REBUILD_BASE_REQUIRED`; stale fact-bound acceptance is not recycled.

The initial recipes cover selected rounding methods, explicitly selected
minimum-wage method compatibility, complete-week aggregation, statutory-rest
method prerequisites, and explicit 2026 convalescence rate/proration methods.
Their acceptance is a versioned AI interpretation decision, not a claim that the
statute prescribes every rounding or proration convention. Archived judgment
copies retain their acquisition limits. The rest method does not authorize work
on a rest day and does not identify the worker's statutory rest window for them.

Every receipt pins the exact decision ID, recipe, interpretation, legal sources,
consumed paths, value/state/source hashes and validity. Existing decisions other
than `missing` remain untouched, including deliberate unknown, conflict, stale
and expired records. Renewal of those records needs an explicit later policy or
source-review flow; this module does not silently replace them.

Independent coverage/exclusion and better-arrangement decisions remain missing.
So do wage classification, pension product/base relationship, travel tariff and
ticket inventory, presence/work/break classification, annual leave workdays and
quarter choice, benefit-year/due-date allocation, and binding contract conditions
unless independently established elsewhere. `obligation.rounding` is deliberately
unsupported: the current contract catalog has no mapped legal-source manifest,
and a printed clause is not proof that the agreement is binding. No artificial
statutory source is inserted to fill that gap.

These method receipts grant neither publication nor a debt attestation. The
ordinary AI runtime still recomposes exact rules/facts/decisions and checks each
financial result against current server authority. Unresolved applicability and
missing facts continue to block their dependent calculations.
