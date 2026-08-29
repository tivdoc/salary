# Wave 2 Minimum Wage review dossier V0.4

This worker prepares deterministic technical evidence for human review. It does not perform legal review, interpret law, create a real monetary value, approve a source, activate a parameter, or implement an Israeli legal rule.

## Source-role boundary

The dossier records the current source IDs and evidence exactly. `IL_MIN_WAGE_LAW` is a binding-instrument candidate represented by an official consolidated copy whose consolidation date and historical lineage are unknown. It remains `needs_review` and inactive. `IL_MIN_WAGE_OFFICIAL_RATES` is National Insurance Institute implementation/corroboration material. It is non-binding, explanatory, and cannot independently establish a monetary rule or override the binding source, even when its technical parse is available.

Both selected artifacts, their observation timestamps, parsed-output hashes, hashed parser-identity bundles, and round-trip citation locators are bound into the source-set hash. A parser-identity hash covers the recorded parser, normalizer and chunker version labels; it is not presented as an executable-binary hash. HTML citation page `1` is explicitly a normalized logical page, not a claim that the source is paginated.

## Technical byte-change review

The exact three isolated rate-table candidates are represented by artifact hashes beginning `c19dbf55`, `5b5e2ff9`, and `93d59562`. Each differs at the raw-byte level while its normalized-text hash equals the selected baseline. The technical classification is therefore `normalized_text_identical`, and every candidate remains `pending_human_review`. Candidate structure hashes are left unset because the change report did not persist candidate chunk bundles. This classification neither establishes semantic legal equivalence nor constitutes approval.

## Numeric-parameter governance

The generic state machine is:

`draft → independently_verified_twice → activation_eligible`

It requires exactly two distinct human reviewer identities. Each verification binds the source and source version, raw artifact hash, parsed version and hash, parser hash, exact citation, value representation, unit, effective interval, sector, population, dossier hash, and source-set hash. A source-byte, parsed-content, parser, citation, value, unit, interval, sector, population, dossier, or source-set change invalidates the verification state and returns the parameter to an inactive draft with no attestations.

State-machine fixtures are wholly synthetic and legally neutral. `activation_eligible` remains `inactive`; activation is a separate owner decision outside this worker.

## Invariants and blockers

- Real numeric candidates: `0`.
- Real parameter attestations: `0`.
- Active parameters: `0`.
- Real activation-eligible parameters: `0`.
- Human legal review is still required for source identity, consolidation history, citations, intervals, sector/population scope, and all three byte-change candidates.
- Two independent human parameter verifications are still required after a lawful candidate is created in a future authorized wave.

Deterministic ignored evidence is written under `output/parallel-wave-2/batch-b/minimum-wage-dossier` and includes the dossier, technical diffs, governance invariants, and a hashed manifest.
