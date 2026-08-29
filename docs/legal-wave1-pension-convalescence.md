# Legal Wave 1 - Pension and Convalescence

This worker is a source-closure evidence layer only. It does not review or activate a legal source, derive a monetary value, create a legal rule, determine effectivity or applicability, or relate one instrument to another.

## Pension 2016

The parser pins the raw artifact to SHA-256 `f3e7de9d9b36900e18efa33f0286a1eeddbb8e062d8a19e102af94967921dd70` before extraction. Native extraction is attempted first. If native text does not meet a minimal text/identity sanity check, only local deterministic Tesseract OCR with the Hebrew language pack is permitted. The fixed OCR configuration is 300 DPI, ascending PDF page order, OEM 1, PSM 6, and preserved interword spaces. Two OCR runs must produce the same normalized hash.

The evidence records parser, renderer and OCR versions/configuration; raw, rendered-page and text hashes; page mapping; and citation round-trip checks. Missing Hebrew OCR support, empty text, corrupt/encrypted/active PDFs, mapping gaps, non-deterministic OCR, or sanity failures return a typed fail-closed result. A parsed result is still `needs_review`, `inactive`, and unusable for rules.

Run the source-specific parser without central wiring:

```powershell
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/wave1-pension-convalescence.mts parse-pension --input <pinned-pdf-path>
```

## Convalescence 2025

The exact discoverable official URL is `https://fs.knesset.gov.il/25/law/25_lsr_6133485.pdf`. The acquisition command permits one no-redirect safe fetch for that exact HTTPS host/path and creates an attempt marker before network access. It validates the PDF envelope and structure before immutable publication. A blocked attempt produces an exact owner request and cannot silently retry in the same evidence directory.

```powershell
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/wave1-pension-convalescence.mts fetch-2025
```

The official 2025 PDF is modeled as a separate instrument with empty relation and effectivity claim sets. The Knesset research note remains a secondary explanatory/corroborative source and is excluded from operative candidates. Neither record is reviewed, active, or usable for rules.

## Integration request

The orchestrator may add a package script for this dedicated CLI and may wire the acquired 2025 source into central inventories as `needs_review`/`inactive` after validating the worker evidence. Central acquisition/readiness/package modules, manifests, barrels and shared documentation were intentionally not edited by this worker.
