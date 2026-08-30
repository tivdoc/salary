# Wave 2.2 corpus transition and canonical readiness V0.4.2

This worker freezes technical corpus-transition evidence and a fail-closed legal-readiness decision contract. It does not review, activate, promote, or infer legal effect from any source. Dates in the readiness registry are deterministic query fixtures only; they are not effective-date claims.

## Corpus transition

The generated source ledger records all 17 registered source versions and keeps acquisition, parsing, segmentation, source role, explanatory/corroborative retrieval, operative eligibility, citation, interval, sector, population, review, and activation as independent fields. It validates the exact transition from 16 parsed / 1 failed / 274 chunks to 14 parsed / 3 fail-closed / 202 chunks.

The chunk evidence contains:

- all old and current stable chunk IDs in the 17-source ledger;
- 72 stable net-delta records: 54 for the 2025 convalescence container-to-instrument selection and 18 for the two selector-boundary sources;
- a complete 65-to-11 convalescence mapping with nine stable-text mappings, 53 exclusions outside pages 16–25, a page-16 trim, and a page-25 two-to-one merge;
- positive selected-span coverage for every one of the 11 current chunks, negative leakage evidence for every excluded chunk, and `needs_review` boundary evidence for pages 16 and 25;
- real registered multi-instrument and permit/attachment source fixtures whose technical result remains fail-closed and inactive.

Successfully parsed non-operative records retain their parse state. Review retrieval is role-labelled and may return official corroborative/guidance/secondary explanatory material; active runtime retrieval and operative/monetary gates exclude those roles.

## Sole readiness source

`evaluateLegalReadiness` is the only domain decision function. The diagnostic CLI, strict CLI, corpus/topic adapter, server resolver/admission adapter, future activation adapter, and future Shadow admission adapter call it directly. Previous Wave 1 and strict-corpus functions remain only as deprecated report-shaping adapters. Their readiness status and exit behavior derive from the canonical decision.

The registry freezes 28 stable cases: historical, current as-of 2026-08-29, missing-sector, and sector-placeholder cases for each of seven topics. Every evidence-backed result is `BLOCKED_NOT_READY`; no date, sector, population, review, or activation is inferred.

## Pension transcript revisions

The transcript-revision contract binds the immutable raw PDF, render, raw OCR, and normalized page hashes. A correction creates a new append-only reviewed-transcript hash set bound to its parent revision, reviewer identity, UTC timestamp, and revision hash. The generated decisions are synthetic contract fixtures, remain `needs_review`, and perform no corpus registration or activation.

## Offline evidence commands

Run the diagnostic generator against a local corpus state:

```text
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/wave22-corpus-readiness/run.mts --corpus-root <local-corpus-root>
```

Run the independent strict readiness behavior by adding `--strict`. It writes the same deterministic evidence but exits 2 while any canonical readiness case is blocked. Evidence is written only under the ignored directory `output/parallel-wave-2.2/workers/w2-corpus-readiness`.

The worker status is `PARALLEL_WAVE_2_2_PARTIAL`, the corpus status remains `LEGAL_SOURCE_CORPUS_INCOMPLETE`, and no real legal rule, parameter, finding, customer data, external persistence, production, Shadow run, or deployment is introduced.
