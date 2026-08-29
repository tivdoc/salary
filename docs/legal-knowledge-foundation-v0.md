# Legal Knowledge Foundation V0 / Corpus Remediation V0.1

Legal Knowledge V0 is a local, versioned, auditable foundation for Israeli employment-rights sources. It is independent of OpenAI, Supabase, Next.js routes, browser code, customer cases, extraction adapters, and entitlement calculations.

## Architecture and source hierarchy

The pure domain is under `src/engine/legal-knowledge`. It defines source, authority, effective-period, taxonomy, citation, chunk, retrieval, numeric-parameter, lifecycle, and case-law contracts. Server-only manifest, fetch security, deterministic normalization/chunking, immutable artifact, and change-detection code is under `src/server/engine/legal-knowledge`.

Precedence is contextual and structured rather than a single opaque score:

1. primary binding statute, regulation, extension order, or binding judgment;
2. official implementation material and official rate tables;
3. official explanatory guidance;
4. secondary explanatory sources.

Sector-specific operative material is preferred in its sector while the general baseline remains visible. Employer names never determine sector. A secondary source may assist discovery or cross-checking but cannot independently activate a critical monetary rule.

## Source versions and temporal applicability

Every source version carries publication, retrieval, effective-period, applicability-basis, authority, topic, sector, status, and verification metadata. Source identity is the stable `source_id`; version identity is the exact `source_id@source_version`. Parsed versions add a deterministic ID derived from the source version, raw hash, normalized hash, parser version, and normalizer version. Open-ended periods are supported. Fail-closed source-set resolution distinguishes `NOT_APPLICABLE`, unresolved causes, `CONFLICT`, `UNVERIFIED_CANDIDATE_SET`, and `RESOLVED_ACTIVE`; it never uses nearest-version, latest-document, manifest-order, or `needs_review` fallback.

No approved legal coverage document exists in the repository. V0.1 therefore uses an engineering-only corpus boundary of `2019-01-01` through `2026-08-29` in `Asia/Jerusalem`. This is not a limitation-period or entitlement statement. The versioned matrix is `src/server/engine/legal-knowledge/legal-coverage.v0.1.json`; any topic/date/sector gap keeps the corpus incomplete.

No source in V0 is active. The discovery manifest is domain-verified but remains `needs_review`; content hashes and retrieval timestamps are added only to ignored local observations. Activation requires an immutable content hash, official canonical URL, retrieval timestamp, appropriate effective-date treatment, and content verification.

## Official corpus workflow

The source-controlled manifest covers discovery for minimum wage, working time/overtime/weekly rest, general pension, travel reimbursement, convalescence, annual vacation, and sick leave. V0.1 adds official candidates for the 2018 short-work-week order, the 2018 general overtime permit, and the 2016 convalescence order. All remain `needs_review`. Convalescence remains incomplete because the official 2026 catalog record and the full effective/relationship history cannot be retrieved and verified from the catalog endpoint.

Only `legal:sources:fetch`, `legal:sources:changes`, and `legal:sources:catalogs` perform HTTP requests. The boundary accepts HTTPS only; checks exact hosts and every redirect; rejects credentials, fragments, literal/private/resolved-local IPs, challenge pages, misleading MIME, wrong magic bytes, empty wrappers, active PDF content, oversized responses, and truncated PDFs; omits credentials/referrers; and stores only safe headers. URLs in logs have query and fragment material removed. Artifacts are content-addressed and immutable under ignored paths. A changed response creates an isolated review candidate and never replaces the selected baseline automatically.

`legal:sources:build` deterministically extracts HTML, plain text, and text-native PDFs. PDF extraction uses local `pypdf`; OCR and AI are not used. Parser page/text limits and source-specific structural markers fail closed. Normalization preserves source wording and order while normalizing Unicode, whitespace, punctuation variants, and repeated PDF margins. Legal-structure chunking prefers chapters, sections, clauses, pages, and headings over arbitrary token windows. Every chunk retains stable exact offsets, source-version and parsed-version IDs, raw and normalized hashes, parser version, page references, topics, sectors, effective metadata, and authority.

Local generated data remains ignored:

- `eval/legal-knowledge/artifacts`
- `eval/legal-knowledge/normalized`
- `eval/legal-knowledge/manifests`
- `eval/legal-knowledge/catalogs`
- `output/legal-knowledge`

## Retrieval and citations

The provider-independent baseline filters by topic, exact date, sector, source type, language, status, and minimum authority. Ranking affects inspection display only, never version resolution. The temporal resolver returns the complete applicable source set and a rationale for every member, retains a general baseline alongside a sector source, requires an explicit sector, and exposes overlapping versions or undocumented sector overlap as conflicts.

A future Legal Applicability output cannot assert support without a valid citation referencing existing source versions and chunks. A deterministic monetary rule must cite active eligible sources. Unsupported citations, mismatched chunks, and excerpts absent from the cited chunks are rejected.

## Numeric parameters and future AI boundary

Numeric parameter candidates carry source version, citation, effective period, unit, exact normalized representation, sector, conditions, extraction method, and verification status. Parsed numbers remain candidates. Consumption requires an active parameter, two reviewers, and an active operative source eligible to support a monetary rule.

A future model may receive only retrieved chunks, identify candidate applicability, and summarize or explain cited material. It may not invent sources, create or modify active parameters, calculate monetary entitlement, or emit unsupported legal assertions. Model output never becomes verified legal truth automatically.

## Change review and future persistence

Remote changes are classified as unavailable URL, changed redirect, changed bytes, changed normalized text, changed metadata/effective dates, unchanged, or new version pending review. `legal:sources:changes` creates an ignored review report and never promotes or replaces a source. `legal:sources:diffs` produces offline raw-byte and normalized-text diffs for isolated observations. `legal:sources:catalogs` snapshots the extension-order and work-permit catalogs and detects additions, removals, and metadata changes; catalog detections are discovery evidence only.

Review/audit events are strict and append-only, bound to exact hashes and effective intervals, and include actor, actor type, timestamp, decision, and reason. System actors cannot claim human review, rejection, or activation. Candidate source-set relations are explicit and never interpreted automatically.

## Reproduction commands

Run from the repository root:

```powershell
npm run legal:sources:validate
npm run legal:sources:fetch          # network
npm run legal:sources:build          # offline artifacts only
npm run legal:sources:status         # offline
npm run legal:sources:catalogs       # network
npm run legal:sources:changes        # network
npm run legal:sources:diffs          # offline
npm run legal:sources:coverage       # offline
npm run legal:sources:search -- --topic pension --date 2026-08-29 --sector general --active-only
npm run legal:sources:citations      # offline
npm run legal:sources:reproducibility # offline, two clean builds plus timezone/order probes
npm run legal:sources:review-package # offline
```

The review package is written to `output/legal-knowledge/review-package-v0.1` with status `pending_owner_legal_review`. It contains inventory, coverage, per-version evidence, lineage/gaps, catalog and byte diffs, temporal queries, citation round trips, parser QA, reproducibility, security/scope evidence, owner/legal questions, and a future activation checklist.

Future persistence may use `legal_sources`, `legal_source_versions`, `legal_artifacts`, `legal_chunks`, `legal_parameters`, and `legal_review_events`. No migration has been created or applied. V0 deliberately uses local ignored manifests first.

## Intentional limits

This is not a complete corpus of Israeli employment law. The Knesset Hours of Work and Rest endpoint currently returns a 505-byte anti-automation challenge shell and is rejected; the official extension-order and work-permit catalog pages currently return HTTP 403 to the deterministic fetcher. The 2026 convalescence catalog record therefore remains unresolved. No entitlement calculation exists, no Legal Rule is active, no numeric candidate is created, no customer finding is generated, no Production integration exists, and no customer data is processed. Source verification and effective dates remain mandatory before legal use. Secondary sources cannot independently support critical monetary rules. The corpus status remains `LEGAL_SOURCE_CORPUS_INCOMPLETE`.
