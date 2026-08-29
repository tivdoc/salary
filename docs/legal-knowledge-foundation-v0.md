# Legal Knowledge Foundation V0

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

Every source version carries publication, retrieval, effective-period, applicability-basis, authority, topic, sector, status, and verification metadata. Open-ended periods are supported. Explanatory material may use `explanatory_as_of` without an artificial operative date. Helpers resolve historical versions, include date boundaries, and surface gaps or overlapping versions as ambiguity instead of choosing silently.

No source in V0 is active. The discovery manifest is domain-verified but remains `needs_review`; content hashes and retrieval timestamps are added only to ignored local observations. Activation requires an immutable content hash, official canonical URL, retrieval timestamp, appropriate effective-date treatment, and content verification.

## Official corpus workflow

The source-controlled manifest covers discovery for minimum wage, working time/overtime/weekly rest, general pension, travel reimbursement, convalescence, annual vacation, and sick leave. It prioritizes official legislation, Ministry of Labor, Knesset, and National Insurance sources. Convalescence remains incomplete because the current general operative order and versioned updates have not yet been verified on an official endpoint.

`legal:sources:fetch` is the only ingestion command that performs HTTP requests. It accepts HTTPS only, uses an explicit official-domain allowlist, follows only allowlisted redirects, omits credentials/referrers, sends a descriptive Tivdoc user agent, applies timeout and byte limits, and stores only safe headers. Artifacts are content-addressed and immutable under ignored paths. A changed response creates a review requirement and never replaces active knowledge.

`legal:sources:build` deterministically extracts HTML, plain text, and text-native PDFs. PDF extraction uses local `pypdf`; OCR and AI are not used. Normalization preserves source wording and order while normalizing Unicode, whitespace, punctuation variants, and repeated PDF margins. Legal-structure chunking prefers chapters, sections, clauses, pages, and headings over arbitrary token windows. Every chunk retains stable offsets, hashes, page references, topics, sectors, effective metadata, and authority.

Local generated data remains ignored:

- `eval/legal-knowledge/artifacts`
- `eval/legal-knowledge/normalized`
- `eval/legal-knowledge/manifests`
- `output/legal-knowledge`

## Retrieval and citations

The provider-independent baseline filters by topic, date, sector, source type, language, status, and minimum authority. It ranks deterministic topic, sector, authority, effective-date, heading/text keyword, and operative components. It preserves exact source/chunk references, marks review-required results, returns general baselines alongside sector-specific material, and exposes overlapping versions as conflicts.

A future Legal Applicability output cannot assert support without a valid citation referencing existing source versions and chunks. A deterministic monetary rule must cite active eligible sources. Unsupported citations, mismatched chunks, and excerpts absent from the cited chunks are rejected.

## Numeric parameters and future AI boundary

Numeric parameter candidates carry source version, citation, effective period, unit, exact normalized representation, sector, conditions, extraction method, and verification status. Parsed numbers remain candidates. Consumption requires an active parameter, two reviewers, and an active operative source eligible to support a monetary rule.

A future model may receive only retrieved chunks, identify candidate applicability, and summarize or explain cited material. It may not invent sources, create or modify active parameters, calculate monetary entitlement, or emit unsupported legal assertions. Model output never becomes verified legal truth automatically.

## Change review and future persistence

Remote changes are classified as unavailable URL, changed redirect, changed bytes, changed normalized text, changed metadata/effective dates, unchanged, or new version pending review. `legal:sources:changes` creates an ignored review report and never promotes or replaces a source.

Future persistence may use `legal_sources`, `legal_source_versions`, `legal_artifacts`, `legal_chunks`, `legal_parameters`, and `legal_review_events`. No migration has been created or applied. V0 deliberately uses local ignored manifests first.

## Intentional limits

This is not a complete corpus of Israeli employment law. No entitlement calculation exists, no Legal Rule is active, no customer finding is generated, no Production integration exists, and no customer data is processed. Source verification and effective dates remain mandatory before legal use. Secondary sources cannot independently support critical monetary rules.
