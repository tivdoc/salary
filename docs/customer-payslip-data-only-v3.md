# Customer payslip data-only evaluation V3

This repository contains only safe tooling, tests, configuration, and documentation. Customer artifacts, inspection evidence, review packages, ground truth, and benchmark output remain in Git-ignored directories. The tooling never reads the original OneDrive copies, never calls an external service, and never records personal text or private source paths.

## Evidence generations

- V1 (`eval/customer-payslips/redacted`) failed because OCR/keyword absence was treated as sufficient evidence and identity-bearing layout regions could survive. It is never eligible for use.
- V2 (`eval/customer-payslips/redacted-v2`) is the immutable, locally verified source generation. It is still pending owner review and is never sent externally by this tooling.
- V3 (`eval/customer-payslips/data-only-v3`) is derived only from the five hash-pinned V2 rasters. It extracts inward-inset payroll-table sections, applies deterministic non-generative resize/sharpen processing, and assembles those sections on a blank neutral canvas. It cannot include a full-page background or add document labels.

Per-document source-aware inventories and manifests are written under `inspection-v3`. Normalized rectangles make the crop/inventory relationship independently checkable. A timestamp-independent freeze hash pins the corpus. The two contact sheets and owner checklist are under `review-v3`; generated status remains `pending_owner_visual_review` and tooling cannot approve it.

The engineering classification is `verified_deidentified_data_only_evaluation_artifact`. That describes the local pipeline evidence; it is not a claim of legal anonymity. Automated checks establish hash lineage, allowlist containment, raster-only output, metadata removal, local identifier-label scanning, and inherited barcode safety from the verified V2 subset. They cannot replace an owner's visual confirmation that no partial identifier remains and every scored row/column is legible.

## Local commands

```text
npm run eval:customer:redaction-v3
npm run eval:customer:verify-v3
npm run eval:customer:status
npm run eval:customer:review-package
npm run eval:customer:ground-truth:init
npm run eval:customer:ground-truth:validate
npm run eval:customer:cleanup-plan
```

Commands are idempotent. Existing evidence is accepted only when its deterministic content matches; an unexpected difference stops execution instead of overwriting it. `cleanup-plan` is dry-run only and performs no deletion.

Ground-truth initialization writes value-empty templates. Each field uses exactly one of `exact`, `expected_absent`, `ambiguous`, or `unscored_not_annotated`. Exact critical values must receive two distinct reviewers before freezing. Expected-absent fields cannot carry a value. Model output cannot be imported into ground truth.

The dry-run cleanup plan inventories only neutral IDs, safe hashes/dates, artifact categories, and ignored directories. It schedules nothing by default and has no deletion implementation.

## External benchmark gate

No external benchmark is implemented or executed here. A future customer benchmark must deny execution unless all of these are true simultaneously:

1. explicit owner de-identification approval;
2. explicit V3 owner visual approval;
3. exact V3 artifact hash match and successful V3 automated verification;
4. frozen, independently reviewed ground truth;
5. a rotated API key confirmation;
6. an explicit external-execution flag;
7. neutral V3-only input paths and ignored output paths.

The gate rejects originals, V1, V2, path escapes, non-neutral filenames, output outside the ignored benchmark root, and any attempt to import model output into ground truth. The synthetic security suite covers split/Unicode PII, labels, contact details, source paths, crop-boundary attacks, manifest leakage, and gate bypasses.

## Generic local corpus expansion

`npm run eval:corpus:prepare -- --input <local-source-directory> --output <git-ignored-output-directory>` creates neutral working copies, SHA-256 and perceptual duplicate groups, format/page/dimension/quality metadata, a text-native-versus-raster PDF candidate classification, a diversity summary, and empty ground-truth templates. It stores no source filenames or paths. Customer evaluation directories and the known customer OneDrive source are explicitly rejected; customer payslips must not become permanent corpus data.
