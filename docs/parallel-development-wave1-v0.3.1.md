# Parallel Development Wave 1 V0.3.1

This wave runs as two batches of three isolated workers. Batch A is integrated before Batch B branches are created. No worker branch edits shared package wiring, central manifests, lockfiles, or barrel exports.

## Frozen shared interface boundary

The strict schemas in `src/engine/wave1/contracts.ts` freeze `RuleExecutionRequest`, `RuleExecutionResult`, the hash-only `RuleInputSnapshot` placeholder, `LegalEvidenceRef`, `TopicReadinessResult`, and `ReviewAttestationRef`. Batch B must consume these contracts without redefining them. A later wave may replace the snapshot placeholder through an explicit versioned migration.

## Batch A integration

- Controlled import reports empty-ledger verification separately from tooling self-test, test-only acquisition-instance verification, instance readiness, and corpus acquisition readiness.
- The test instance uses an existing public official artifact, is explicitly synthetic, performs no network request, and is never represented as an owner import.
- The 2025 Knesset artifact is ingested from the worker's single-fetch evidence without a second download. It remains a separate `needs_review`, inactive source with no relation, interval, scope, applicability, or numerical claim.
- The pension 2016 artifact remains parse-failed because the deterministic local Hebrew OCR language pack is unavailable. No citation or parsed candidate is fabricated.
- The work-permits discovery inventory is complete at 58/58 and the Hours-law publication inventory is complete at 20/20. Catalog entries remain discovery evidence and every permit remains `unknown_pending_legal_review`.
- Three minimum-wage byte changes are `unreviewed_byte_change`; two retained 505-byte challenge observations are rejected transport observations. No semantic equivalence is asserted.

## Safety boundary

There are no reviewed or active legal sources, numerical candidates, active parameters, operative Israeli legal rules, customer documents, Production access, deploys, or Shadow Mode. The active-only retrieval path remains fail-closed without candidate fallback.

## Batch B integration

- Temporal resolution keeps civil-date `valid_time` separate from UTC-instant `knowledge_time`; signing, publication, commencement, operative, payroll-reference, ingestion, review, invalidation, and activation times remain distinct. Relationship claims are unverified and topic readiness fails closed when any required evidence or review gate is absent.
- Persistence verification is restricted to a fail-closed local/disposable target. When Docker, the Supabase CLI, or a verified isolated identity is unavailable, only static migration and synthetic store evidence is produced and the result is `PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED`.
- The rule runtime is isolated and synthetic. It uses exact decimal arithmetic, explicit rounding traces, canonical hashing, immutable requests/results, resource and cancellation limits, and rejects incomplete facts or legal dependencies that are not reviewed and active. It creates no Finding and contains no operative legal rule.
- The ignored V0.3 review package is built offline by `npm run parallel:wave1:review-package`; its deterministic archive is consumer-extracted into a temporary directory and verified against the package manifest before success is reported.
