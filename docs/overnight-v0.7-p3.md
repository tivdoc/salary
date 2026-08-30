# V0.7 P3 — official corpus and legal-review workspace

## Capability truth

This lane is an inactive, fail-closed legal-corpus inspection and human-review aid. It does not interpret law, select legal meaning, activate a source, create a parameter or RuleSpec, calculate a result, produce a Finding, or authorize customer/Shadow/Production use. All acquisition candidates are written only below the ignored `output/overnight-v0.7/p3/` tree. Existing manifests, artifacts, build state, citations, readiness, selected corpus, registry, and package files are read-only.

The implementation calls the canonical legal-source manifest loader, working-time inventory validator, canonical source-role inventory, unverified amendment candidate graph, strict real-corpus readiness adapter, safe official fetcher, media/challenge validator, and immutable artifact store. It does not contain an alternative readiness evaluator or activation path.

## Current corpus reconciliation

`scripts/legal-v07/run.mts reconcile --corpus-state-root C:\dev\tivdoc\salary` recomputes the following from the current tracked and ignored corpus bytes and rejects inconsistent one-to-one identities or cardinalities:

| View | Current count/state |
|---|---:|
| Registered source versions | 17 |
| Registered review state | 17 `needs_review`, 0 reviewed, 0 active |
| Raw fetch observations / failures / unique hashes | 23 / 1 / 23 |
| Legacy build view | 14 parsed, 3 failed, 202 chunks |
| Lifecycle-corrected view | 16 technically parsed, 1 technically failed, 2 instrument-quarantined |
| Extracted / quarantined / retrievable chunks | 274 / 72 / 202 |
| Canonical-binding candidate / explanatory chunks | 86 / 116 |
| Citation round trips | 14 passed, 3 not auditable |
| Working-time inventory | 20 law publications, 58 permit rows, 68 unique permit links |
| Historical bounded acquisitions | 88 requested, 72 acquired, 15×403, 1×404 |
| Genuine decisions/signatures | 0 / 0 |
| Ready legal topics | 0/7 |

The Hours of Work and Rest Law registered representation is technically parseable, but no official institutional consolidated text was observed. The 20-publication predecessor/amendment graph has unverified relation edges and performs no automatic consolidation. Working-time permit relevance, applicability, expiry, revocation, sector coverage, commencement, and relation claims remain unverified.

The official 2016 pension PDF is a three-page image-only artifact. Its native page text hashes are empty; deterministic page-render hashes are preserved; the configured Tesseract installation lacks the Hebrew language pack; status remains `parse_failed_closed` with `ocr_hebrew_language_pack_unavailable`. OCR confidence would not constitute legal confidence even if tooling became available.

Convalescence evidence separately exposes the 1988, 2016, 2023, and 2026 orders, the 2024 and 2025 laws, and the non-operative 2025 Knesset research document. It neither conflates instruments nor infers predecessor/successor, publication/commencement, applicability, or effective intervals. Minimum-wage evidence exposes one official-rate baseline and three different inactive byte candidates that normalize identically; technical equivalence is not approval.

For each of `minimum_wage`, `working_time`, `pension`, `travel`, `convalescence`, `vacation`, and `sick_leave`, effective period, sector, population, human review, and activation remain unresolved. Canonical strict readiness remains `LEGAL_SOURCE_CORPUS_INCOMPLETE` with exit code 2.

## Bounded official acquisition

`attempt-missing` reads nine existing registry targets plus the exact 16 historically failed working-time artifact URLs from the immutable prior report. Each URL receives exactly one public unauthenticated GET, with concurrency at most two, 12-second timeout, two redirects, and 8 MiB limit. The canonical fetcher checks HTTPS and the already accepted official host allowlist, DNS/private-address rejection before each request, redirect destinations, declared length, streamed length, PDF magic or HTML signature, expected media, and challenge/error HTML. It sends no cookies or credentials and performs no retry, bypass, mirror lookup, search-engine discovery, CAPTCHA action, header manipulation, or private endpoint access.

A successful response is stored content-addressed and write-once as an **inactive candidate** with acquisition time, safe URL/redirect chain, media, length, tool version, baseline relation, and SHA-256. A changed byte object never overwrites a baseline. A failed request produces a `SKIPPED_BLOCKED` receipt containing the exact blocker, attempted action, safe fallback, affected acceptance, downstream impact, and next human action. Both paths state `selected_corpus_mutated=false` and `readiness_mutated=false`.

Live outcomes are intentionally not embedded in tracked documentation. The machine report at `output/overnight-v0.7/p3/acquisition/acquisition-report.json` is the run evidence. Re-running requires a new absent output root; the tool never overwrites a prior evidence run.

## Seven-topic offline review workspace

`build-workspace` creates seven deterministic sets of:

- canonical JSON with exact source/artifact/text/source-set/interval-scope/workspace hashes, parse/OCR warnings, citation locators, diffs, quarantines, readiness gates and unresolved scope;
- Markdown suitable for offline review;
- static HTML with escaped content, no script, no network dependencies, no analytics, `noindex,nofollow`, and local CSP `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'none'; connect-src 'none'; script-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
- an unsigned blank decision template whose decision, identity, trust, timestamp, algorithm, key and signature fields are all null.

The workspace index and owner-action index bind all seven topics. A portable evidence index binds exact public official artifact bytes, normalized text JSON, chunk JSON, and the three hash-verified pension page renders copied from the current corpus state; no customer material is included. The evidence manifest binds every generated file by path, byte count, and SHA-256. Verification rejects missing/changed bytes, unsafe static HTML, nonblank templates, generated decisions/signatures, and any selected-corpus mutation.

Decision import validates exact workspace, source set, artifact set, normalized-text set, interval/scope, topic, identities, timestamp, key and algorithm binding before trust evaluation. Reviewer and importer must be distinct. The signature payload is canonical JSON. Only an injected cryptographic `SignatureVerificationPort` can verify a signature. There is no configured trust store in this lane, so imports return `REVIEWER_IDENTITY_AND_SIGNATURE_VERIFICATION_MISSING`; even a valid review record does not activate a source or make it usable for rules.

## Commands

These are the lane-local equivalents requested by the V0.7 contract; root `package.json` is orchestrator-owned and was not changed.

```powershell
# legal:corpus:reconcile
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/legal-v07/run.mts reconcile --corpus-state-root C:\dev\tivdoc\salary

# legal:sources:attempt-missing (fresh absent output root only)
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/legal-v07/run.mts attempt-missing --corpus-state-root C:\dev\tivdoc\salary

# legal:review-workspace:build
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/legal-v07/run.mts build-workspace --corpus-state-root C:\dev\tivdoc\salary

# all three acceptance IDs plus artifact/hash/zero verification
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/legal-v07/run.mts all --corpus-state-root C:\dev\tivdoc\salary
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/legal-v07/run.mts verify --corpus-state-root C:\dev\tivdoc\salary

$env:TIVDOC_P3_CORPUS_STATE_ROOT='C:\dev\tivdoc\salary'
npx vitest run src/server/engine/legal-knowledge/overnight-v07 src/engine/legal-knowledge/overnight-v07 --reporter=verbose
```

Existing canonical reconciliation/readiness commands remain authoritative and must also be run from a state root containing their ignored inputs:

```powershell
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/wave2-corpus-hardening/run.mts readiness --corpus-state-root C:\dev\tivdoc\salary
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/wave2-corpus-hardening/run.mts readiness-strict --corpus-state-root C:\dev\tivdoc\salary
```

The strict command is expected to exit 2 while 0/7 topics are ready; that is a verified fail-closed result, not a command failure to hide.

## Owner actions and blockers

1. Supply unchanged inaccessible official bytes through the established owner handoff, or access each exact official URL through an ordinary public browser without bypass.
2. Install/pin the required deterministic Hebrew OCR capability in an isolated environment and repeat page/line/citation verification; retain human legal review.
3. Have authorized legal reviewers decide source identity, publication versus commencement, instrument lineage, exact citations, conflicts/quarantines, effective periods, sectors, and populations for all seven topics.
4. Configure reviewer identity, trusted public keys, revocation, audit custody, and separation-of-duties verification; import exact hash-bound genuine signatures.
5. Separately complete numeric dual attestation and RuleSpec legal approval. A source review cannot satisfy either gate.

Applicable blockers remain `LEGAL_SOURCE_CORPUS_INCOMPLETE`, `OWNER_OFFICIAL_SOURCE_HANDOFF_REQUIRED`, `HUMAN_LEGAL_SOURCE_REVIEW_REQUIRED`, `EFFECTIVE_PERIOD_SECTOR_POPULATION_REVIEW_REQUIRED`, `REVIEWER_IDENTITY_AND_SIGNATURE_VERIFICATION_MISSING`, `NUMERIC_DUAL_ATTESTATION_REQUIRED`, and `RULE_LEGAL_APPROVAL_REQUIRED`.

Status invariants: `REAL_LEGAL_TOPICS_READY: 0/7`, `REAL_SOURCES_ACTIVE: 0`, `REAL_PARAMETERS_ACTIVE: 0`, `REAL_RULES_ACTIVE: 0`, `REAL_CALCULATIONS_OR_FINDINGS: 0`, `CUSTOMER_SHADOW_AUTHORIZED: NO`, `CUSTOMER_PROCESSING_ENABLED: NO`, `PRODUCTION_DELIVERY_ENABLED: NO`.
