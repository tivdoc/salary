# Wave 2.3 W2 — Corpus lifecycle and canonical readiness V0.5.0

This package is an engineering/audit baseline. It does not review or activate a legal source, infer legal effect, create a parameter or rule, or admit Shadow or Production use.

## Orthogonal lifecycle

`src/engine/wave23/corpus-trust/lifecycle.ts` records acquisition, technical parse, instrument boundary, publication/quarantine, retrieval visibility and surface, source role, monetary-support eligibility, human review, interval, sector, population, and activation independently.

The corrected reconciliation is:

- 17 acquired source versions;
- 16 technically parsed and one technical parse failure;
- two technically parsed sources are independently instrument-boundary quarantined;
- 274 extracted chunks, 202 instrument-resolved/review-retrievable chunks, and quarantine cardinality 72;
- the 202 review-retrievable chunks partition into 86 binding-role-candidate chunks and 116 explanatory/corroborative chunks;
- all 17 real sources are `needs_review`, inactive, and non-operative;
- reviewed, active, and operative real-source counts are zero.

The old `14 parsed / 3 fail-closed` label conflated technical parsing with later instrument selection. Under V0.5.0, only `IL_GENERAL_PENSION_INCREASE_EXTENSION_ORDER_2016@discovery-v0.2` is a technical parse failure. `IL_GENERAL_OVERTIME_PERMIT_2018@discovery-v0.1` and `IL_CONVALESCENCE_EXTENSION_ORDER_2023@discovery-v0.2` remain technically parsed while quarantined from retrieval pending instrument/boundary review.

The BTL rates source is corroborative and cannot independently support a monetary rule. The Knesset research source is secondary explanatory. Neither classification implies review, legal effect, or activation.

The 72 existing `CHUNK_TRANSITION_001` through `CHUNK_TRANSITION_072` IDs and their before/after chunk identities are consumed without renumbering. V0.5.0 retains the legacy reason for forensic crosswalk and adds a corrected lifecycle reason that does not convert instrument quarantine into parse failure.

## Sole readiness decision source

`evaluateLegalReadiness` remains the sole domain decision function. The six frozen delegates are diagnostic CLI, strict CLI, corpus/topic gate, server resolver admission, future activation admission, and future Shadow admission. The V0.5.0 decision hash binds the evaluator version, normalized case, all normalized candidates and lifecycle fields, citation and review bindings, valid and knowledge time, sector, population, activation, monetary eligibility, and source-version binding.

V0.5.0 fails closed with the 11 contract reason codes. Inputs and collections are normalized and sorted before hashing. Date validation uses explicit UTC ISO dates; no local timezone, locale-default collation, object-key order, or candidate order enters the hash.

The pre-existing V0.4.2 case registry remains a forensic/backward-compatible adapter input. It still calls the same exported evaluator and stays blocked. New V0.5.0 evidence uses the explicit version contract and full lifecycle fields. The topology guard permits only the canonical delegate plus named pre-existing deprecated/audit adapters to import the evaluator directly; it rejects a second evaluator or any new runtime direct import.

## Isolated positive and negative proof

The single positive fixture uses only `SYN_*` identities. It is test/audit-evidence-only and is explicitly forbidden from product manifests, persistence, source activation, and product exposure. All six delegates return the same `READY` decision hash. A reachability guard proves `test_fixture_production_reachable=false` and fails if a production path references the fixture.

Eighteen stable mutation cases cover missing and failed parse, quarantine and hidden retrieval, role, citation, review, invalid interval, sector mismatch/missing/unknown, population mismatch, inactive state, monetary ineligibility, secondary-only and corroborative-only monetary evidence, stale binding, and ambiguous boundary. Each case is replayed and verifies its exact reason set and decision hash.

Seventeen legally neutral temporal/sector/population cases cover day-before/start/end/day-after, an open-ended interval, gap, overlap, amendment precedence, general/sector-specific precedence and fallback, missing/unknown sector, population inclusion/exclusion, and valid-time versus knowledge-time changes.

Five legally neutral multi-instrument cases prove exact declared selection, positive completeness, zero neighboring-instrument leakage, ambiguity quarantine, and separation of technical parsing from permit identity/authority review.

## Reporting reconciliation

The reporting artifact distinguishes:

- the complete V0.4.1 Ground Truth negative matrix (`GT_NEG_001` through `GT_NEG_007`, 7/7) from the later independently re-derived five-case subset (`GT_NEG_001` through `GT_NEG_005`, 5/5);
- command 38 local controlled-import harness success (expected/actual exit 0, local subject passed) from command 30 operational admission denial (expected/actual exit 5, expectation matched, operational subject did not pass);
- one W1 test file passing from two W1 tests passing;
- the non-authoritative narrative number range 1–53 from the generated contiguous command ledger containing exactly IDs 1–51 and denominator 51/51.

## Evidence generation

Run offline from the integrated repository:

```powershell
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/wave23-corpus-trust/generate-evidence.mts --corpus-root C:\dev\tivdoc\salary
```

The ignored output is `output/parallel-wave-2.3/workers/w2-corpus-trust`. It contains a manifest plus lifecycle, stable-transition, delegate/real-case, mutation, temporal/sector/population, multi-instrument, reporting, and zero-invariant JSON artifacts. Generation reads only the already-existing prior transition ledger and repository source files; it performs no network access or external side effect.

Required zeros are: customer files, OpenAI calls, external Supabase connections, migrations, deploy actions, persistent owner imports, reviewed sources, active sources, real numeric candidates, real numeric attestations, active parameters, Israeli rules, findings, and Shadow runs.
