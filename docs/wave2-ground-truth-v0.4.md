# Wave 2 Ground Truth annotation and benchmark tooling — V0.4

## Scope and invariants

This module is a synthetic-only human annotation foundation. It consumes the frozen `GroundTruthManifest`, `GroundTruthFieldAnnotation`, `calculationValueSchema`, money/date/decimal representations, and document bounding-box contract. It does not replace those contracts. The manifest schema version and revision govern the document, every section, and every field; `projectVersionedGroundTruth` exposes that inheritance as a deterministic read model.

No document acquisition or extraction provider is present. The evidence command constructs values in memory and writes only under the ignored `output/parallel-wave-2/batch-b/ground-truth` directory. There is no OpenAI or generative-model dependency, network access, legal rule or parameter, database client, migration, deployment, external persistence, Finding, or real Ground Truth data.

## Explicit human workflow

The demonstrated state sequence is:

`annotation_1 → annotation_2 → disagreement → human_adjudication → locked_ground_truth`

The two annotation passes require different authors. A disagreement is derived only from unequal canonical values. Agreement does not lock or adjudicate anything: a third, independent human must still submit a complete adjudication pass. Every adjudicated field resolves the exact two annotation IDs for the same field. Values remain tied to document hash, page, section, optional bounding box, author and timestamp.

Locking hashes a canonical, sorted payload and freezes the validated object. A changed object with the same locked revision is rejected. A later correction begins revision `n + 1`, uses a new manifest ID, names the superseded manifest, preserves the prior locked object and requires a non-empty reason.

Validation fails closed for empty manifests, incomplete evidence, duplicate annotation/field identities, document mismatch, unknown or out-of-range sections/pages, invalid normalized geometry, actor/pass mismatch, non-monotonic timestamps, incomplete adjudication and locked-hash mismatch.

## Deterministic evaluator

The evaluator accepts only locked truth. It reuses canonical calculation values and compares their canonical JSON. It emits:

- overall, critical-field, monetary, hours and pay-period accuracy;
- a sorted field error matrix covering correct, mismatch, missed and unexpected values;
- false-conflict and missed-conflict field lists;
- a canonical SHA-256 over the report payload.

Ratios use integer arithmetic with six decimal places, without binary floating-point calculations. Input prediction and profile ordering does not affect output bytes.

## I/O denial canary

The access guard accepts only a dedicated synthetic-root path and an injected opener. The denial test passes a synthetic prohibited sentinel; the guard throws before invoking the callback. It also rejects traversal before I/O. The canary neither names nor probes any real directory.

## Reproducible commands

```text
npm exec vitest run -- src/engine/extraction-ground-truth --reporter=verbose
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/extraction-ground-truth/run.mts validate
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/extraction-ground-truth/run.mts evaluate
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/extraction-ground-truth/run.mts all
npm exec eslint -- src/engine/extraction-ground-truth scripts/extraction-ground-truth
npm exec tsc -- --noEmit
git diff --check
```

The generated evidence is synthetic and remains Git-ignored. Real human annotation remains an external future action: `HUMAN_GROUND_TRUTH_REQUIRED`.
