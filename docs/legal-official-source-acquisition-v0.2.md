# Official legal source acquisition V0.2

This workflow acquires and inventories official-source candidates. It does not perform legal review, determine applicability, activate a source, create a numeric parameter, or create a legal rule. The corpus readiness status is fixed at `LEGAL_SOURCE_CORPUS_INCOMPLETE` for V0.2.

## Entity and lifecycle boundaries

The V0.2 contracts keep these identities separate:

- an `instrument` identifies the law, order, permit, or other legal object;
- a `legal_text_version` identifies a particular publication or consolidation claim;
- an `artifact_version` identifies immutable bytes and their acquisition provenance;
- a `parsed_version` identifies deterministic parser and normalizer output;
- fetch and catalog observations record attempts and discovery evidence, not legal versions;
- a `legal_claim` remains unverified until an actual human decision is recorded as a `human_review_event`.

Acquisition, parsing, evidence, review, and activation are independent dimensions. A challenge or error response is `quarantined / failed / incomplete / not_a_legal_source_version`. A valid candidate remains `needs_review / inactive`. The legacy `@discovery-v0*` suffix is an ingestion revision, not a legal-version identifier.

Issuer, promulgation publisher, artifact host, artifact role, canonicality, consolidation date, and acquisition method are stored independently in `legal-provenance.v0.2.json`. No authority, date, relation, scope, or applicability follows from a host, filename, title, or year.

## Staged acquisition

1. Run the existing allowlisted fetcher once for a canonical or direct official URL. It rejects redirects outside the allowlist and unexpected or challenge content without evasive retries.
2. If that fails, use only visible links in a normal public browser. Do not log in, solve a CAPTCHA, replay internal APIs, reuse session material, alter a browser fingerprint, or print a page to PDF. Browser and catalog captures are discovery evidence only.
3. If the original official download is still unavailable, generate the controlled owner handoff:

   ```powershell
   npm run legal:sources:acquisition:request
   ```

The generated request folders are under ignored `output/legal-knowledge/acquisition-handoff-v0.2/`; their matching inboxes are under ignored `eval/legal-knowledge/acquisition/incoming/`.

## Controlled owner import

The owner opens the request's canonical URL in a normal local browser, checks HTTPS and the exact allowed host, downloads the original file from the official link, and leaves it byte-for-byte unchanged. Email, messaging apps, mirrors, caches, Internet Archive, conversion tools, copy/paste, and Print to PDF are not accepted. The owner completes the strict receipt with the official final URL and acquisition time. A sanitized screenshot may be retained only as discovery evidence.

With network disabled, import and verify the original:

```powershell
$env:TIVDOC_LEGAL_NETWORK_DISABLED = '1'
npm run legal:sources:acquisition:import -- --request-id <request-id> --file <original-filename> --receipt receipt.json
npm run legal:sources:acquisition:verify
```

Import resolves paths within the per-request inbox, rejects symlinks and traversal, validates PDF structure and passive content, calculates SHA-256 locally, writes to a content-addressed immutable store, and appends an audit event. Identical bytes are idempotent; different bytes produce a distinct candidate. Import does not fetch, review, promote, or activate anything. Owner provenance remains `owner_attested_official_download`.

## Status and readiness

```powershell
npm run legal:sources:acquisition:status
$env:TIVDOC_LEGAL_NETWORK_DISABLED = '1'
npm run legal:sources:acquisition:readiness
npm run legal:sources:readiness -- --from 2019-01-01 --as-of 2026-08-29 --sector general
```

Acquisition readiness is a separate gate: exit `0` means all acquisition targets are ready for owner legal review; `1` means implementation or evidence is incomplete; `2` means controlled owner downloads are still required; `3` means an environmental or permission blocker prevents reliable implementation or handoff. Corpus readiness remains non-zero because owner legal review, effective coverage, scope, and activation are absent.

Candidate retrieval is exposed only by the review API/CLI and always reports `usable_for_rules=false` unless an independently reviewed active source set is available in a future version. Runtime consumers receive the active-only API, which has no needs-review fallback. An open end is `end_unknown` when later catalog coverage is incomplete.

## Evidence package

After the deterministic source reports have been produced, create and verify the portable package offline:

```powershell
$env:TIVDOC_LEGAL_NETWORK_DISABLED = '1'
npm run legal:sources:review-package:v0.2
```

The ignored folder `output/legal-knowledge/review-package-v0.2/` contains reconciled inventories, observations, provenance, readiness results, retrieval matrices, citations, reproducibility and scope evidence, owner requests, and a hash manifest. `output/legal-knowledge/review-package-v0.2.zip` uses fixed archive timestamps and stable path order; the packaging helper reopens it and verifies every manifest entry and hash.
