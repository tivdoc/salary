# Payslip Extraction V2.1

Payslip Extraction V2.1 is a non-degrading recovery revision. It keeps the V2 first-pass prompt and structured output, but replaces broad recovery selection and winner-picking with selective evidence gathering and deterministic, conservative resolution.

## Scope

- Extraction and technical consistency validation only; no legal conclusions.
- No production, upload, Supabase, payments, analytics, or customer UI integration.
- No corpus-specific coordinates, labels, or expected values.
- At most one targeted recovery call per document.

## Non-degrading invariant

The complete first pass is immutable evidence. Recovery never edits its candidates, confidence, warnings, provenance, or Gate 0 assessment.

- Agreement preserves the first-pass candidate exactly. It does not boost confidence or clear warnings because both passes use the same model family and are correlated evidence.
- Disagreement creates a visible `conflicted` resolution. Neither observation wins, and the canonical extraction keeps the first-pass observation instead of replacing it.
- Recovery abstention or omission preserves an existing first-pass observation.
- A field missing in the first pass can be introduced only when it was explicitly targeted, came from the selected crop, clears the confidence threshold, passes Gate 0, and creates no deterministic cross-field contradiction.
- Historical Gate 0 issues remain sticky unless a newly recovered field directly resolves a missing or incomplete relationship. Arithmetic warnings are never cleared merely because the model repeats the same value.

The result retains first pass, recovery pass, field resolutions, historical validation, current validation, final sticky validation, and any explicitly resolved historical issue codes as separate records.

## Selective recovery

`payslip-v2.1-selective-recovery-1` requests only material critical gaps:

- a missing critical field;
- an unreadable or low-confidence critical field; or
- a critical structural ambiguity or conflict.

A plan contains at most four fields and exactly one semantic document region. Stable moderate-confidence fields are not re-read. If there is no material expected gain, the decision is stored as `recovery_skipped_no_material_gain` and no second model call is made.

## Resolution states

The deterministic resolver exposes `confirmed`, `candidate`, `missing`, `suspicious`, `conflicted`, `requires_confirmation`, `recovered`, and `invalid`. Arithmetic and cross-field consistency can keep a repeated observation suspicious or invalid; model agreement is not an override.

## Benchmark reporting

V2.1 reports first-pass and final accuracy separately and does not rewrite V1 or V2 reports. Safety reporting includes:

- recovery regressions and silent regressions;
- wrong accepted critical values;
- suspicious observations preserved after agreement;
- correctly introduced conflicts; and
- recovery yield for correct, newly introduced missing critical fields.

Field evidence records the raw and normalized values, confidence, warnings, provenance, and Gate 0 result. A hallucination is counted only for a field explicitly annotated `expected_absent`; fields that are merely not annotated are labeled `unscored_not_annotated`.

## Controlled external run

The five approved redacted inputs and all reports remain under ignored evaluation and output paths. The external test requires a configured API key plus the explicit rotation confirmation flag and enforces no more than two calls per document.

```text
OPENAI_API_KEY=<rotated key>
OPENAI_API_KEY_ROTATED_AFTER_2026_08_29=true
```

Run it once with:

```bash
npm run benchmark:payslip:openai:real:v2.1
```

This five-document benchmark can justify only `EXPAND_FIRST_PASS_CORPUS` or `ITERATE_EXTRACTION_AGAIN`; it cannot establish production readiness.
