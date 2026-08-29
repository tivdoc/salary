# Wave 2 corpus hardening and deterministic Pension OCR V0.4

This worker adds fail-closed evidence tooling only. It does not modify the legal manifest, fetch/build state, registered artifact/version/chunk sets, review state, activation state, parameters, or rules.

## Source and artifact roles

The derived role classifier preserves the canonical `LegalSource` vocabulary while making five safety roles explicit: binding operative instrument/version, official implementation or corroboration, official guidance, secondary explanatory material, and acquisition-only/staged bytes. Only a registered binding operative instrument/version can enter the operative-candidate set or independently support a future monetary-parameter dossier. This is eligibility scaffolding, not legal approval.

The resulting real-manifest proof keeps `IL_CONVALESCENCE_KNESSET_RESEARCH_2025` secondary and outside operative resolution. `IL_MIN_WAGE_OFFICIAL_RATES`, issued by the National Insurance Institute, remains official implementation/corroboration and cannot independently support a monetary parameter. Staged Working Time and permit files are not corpus versions.

## Pension 2016 OCR

The only accepted source PDF is the official three-page artifact with SHA-256 `f3e7de9d9b36900e18efa33f0286a1eeddbb8e062d8a19e102af94967921dd70` and size 64,285 bytes. The toolchain rejects customer-like paths and any different bytes before spawning a renderer or OCR process.

The official upstream `tesseract-ocr/tessdata` Hebrew model is pinned to commit `ced78752cc61322fb554c280d13360b35b8684e4`, SHA-256 `7da6ea6b7a2620ec8e8b41de2967a13d429635a56657a0b30b622501a573d3e1`, and 5,413,459 bytes. Its pinned Apache-2.0 license has SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`. Acquisition evidence records the immutable URLs, observation/server timestamps, redirect chain, media type, declared/actual sizes, and hashes.

Rendering is pinned to Poppler `pdftoppm 26.05.0`, 300 DPI, DeviceGray, PNG, ascending pages. OCR is pinned to Tesseract `5.4.0.20240606`, language `heb`, OEM 1, PSM 6, `preserve_interword_spaces=1`, and `user_defined_dpi=300`. Raw OCR is retained per page. Normalization V1 performs only deterministic Unicode and whitespace normalization. Every normalized line maps back to raw page/line evidence and round-trip citations are hash-checked. Two clean runs must have identical per-file bytes and reports.

Successful OCR is a derived candidate only: `needs_review`, inactive, absent from the registered corpus, and ineligible for parameters until human line-by-line page verification. OCR confidence is never legal confidence.

## Container segmentation

The 40-page 2025 Knesset publication is treated as a container. The convalescence instrument is bound to Chapter 7, section 24, from the heading on PDF page 16 through the continuation at the top of PDF page 25, ending immediately before Chapter 8, section 25. Pages 1-15, the Chapter 8 portion of page 25, and pages 26-40 are excluded. Retrieval requires an exact artifact, page, and section match, so page overlap alone cannot include unrelated text on a mixed boundary page.

The same versioned container/instrument contract applies to gazettes, amendment publications, and permit attachments. It creates no legal effect, commencement, scope, or applicability interpretation.

## Working Time graph and permit diagnostic

The 20-item official publication inventory maps one-to-one to 20 graph nodes: the original promulgation, 18 amendment publications, and one error correction. Nineteen candidate edges point to the original. Every edge remains unverified; no consolidated/current text, commencement, effectivity, or applicability is inferred.

The exact catalog identifier is `GOVIL-WORK-PERMIT:premit-8753`. Its exact frozen official URL is inspected without generating a URL, bypassing access controls, or substituting an unofficial copy. A 404 on the exact catalog-provided URL is classified `stale_official_catalog_link`; a similarly titled official publication is not treated as a replacement without explicit official replacement evidence.

## Strict real-corpus readiness

The diagnostic covers exactly seven topics: minimum wage, working time, pension, travel, convalescence, vacation, and sick leave. Each report exposes separate parse, citation, source-role, review, effective-interval, sector, population, and activation gates. All topics remain `not_ready`; the strict gate exits non-zero and the corpus status remains `LEGAL_SOURCE_CORPUS_INCOMPLETE`.

## Commands

Run the evidence build from the repository root, pointing `--corpus-state-root` at the read-only worktree containing the existing legal evaluation state when necessary:

```powershell
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/wave2-corpus-hardening/run.mts all --corpus-state-root C:\dev\tivdoc\salary
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/wave2-corpus-hardening/run.mts verify
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/wave2-corpus-hardening/run.mts readiness
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/wave2-corpus-hardening/run.mts readiness-strict
```

Evidence is written only under `output/parallel-wave-2/batch-a/corpus-hardening`. The `verify` command is read-only and validates every recorded file size and SHA-256. Diagnostic readiness exits zero while preserving `not_ready`; the separate strict readiness command exits `2` while any required gate is missing.
