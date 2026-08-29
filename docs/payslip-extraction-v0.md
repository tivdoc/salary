# Tivdoc payslip extraction V0

## Boundary and lifecycle

Quick Scan V0 is an internal, in-memory document-intelligence pipeline:

```text
private document source
  -> provider-independent extractor
  -> raw candidates with source locations
  -> deterministic normalization
  -> Gate 0 extraction validation
  -> PII-minimized representation
  -> canonical employment snapshot in memory
```

No current route, customer UI, payment flow, analytics integration, or persistence repository invokes it. It does not write extraction attempts or snapshots to Supabase. Database integration verification remains pending because no isolated Tivdoc Supabase environment is currently available.

Extraction stops at technical facts and anomalies. It cannot produce a Finding, calculate an entitlement, say that an employer owes money, or conclude that a legal violation exists.

## Provider abstraction

`DocumentExtractor` receives a validated `ExtractionRequest` and a `PrivateDocumentSource`. The source reads bytes through trusted server-side access; providers never receive public Storage URLs or browser credentials. An adapter returns the vendor-neutral `ExtractionResult` contract.

The contract records provider/extractor versions, detected document type, document-quality confidence, individual field confidence, source document/page, optional source fragment and bounding box, extraction method, warnings, and safe failure codes. Vendor response formats and credentials do not cross into the domain.

V0 includes only `FixtureDocumentExtractor` and `SyntheticDocumentSource`. They prove the boundary without OCR credentials or real customer documents. A future OCR adapter must translate its output into the same raw candidate schema and must not embed business rules in vendor mapping code.

## Candidate data and provenance

The constrained payslip candidate vocabulary covers:

- salary period, employment start date, and explicitly identified salary type;
- base, hourly, gross, net, travel, convalescence, pension, and severance amounts;
- regular, 125%, and 150% hours;
- pension and severance percentages;
- vacation and sick balances;
- structured unknown components with raw source label, optional normalized label, quantity, rate, amount, confidence, and provenance.

Employee name, employer name, and national ID are isolated as sensitive metadata. Bank information has no accepted metadata kind. Sensitive metadata and unknown raw labels are not canonical employment facts.

Candidates may repeat or disagree. The extractor does not choose a canonical value and cannot write canonical facts directly.

## Deterministic normalization

Normalization is pure TypeScript and uses strings and `BigInt` for decimal arithmetic:

- Money accepts deterministic Israeli/European forms such as `8,500.00 ₪`, `8.500,00`, and `500,00 ₪`, then emits safe integer ILS minor units. It never parses money through binary floating point.
- Hours accept integer, dot-decimal, comma-decimal, and explicit Hebrew/English unit text, then emit canonical decimal strings.
- Percentages emit integer basis points, so `6%`, `6.00`, and `6,5%` become `600`, `600`, and `650`.
- Salary periods accept explicit month/year forms and Hebrew month names, then emit the exact first and last ISO date of that month.
- Arbitrary employment dates are conservative: ISO is accepted, and a local day/month form is accepted only when the ordering is unambiguous.

Normalization failure remains explicit. Suspicious values are not corrected automatically.

## Gate 0

Gate 0 detects extraction and document-internal inconsistencies only. Its statuses are `valid`, `suspicious`, `invalid`, and `requires_confirmation`.

Structural checks include failed normalization, invalid salary years, negative money/hours, impossible monthly hours, invalid percentages, implausible money magnitude, low document quality, low field confidence, and OCR ambiguity warnings.

Arithmetic checks run only when their inputs exist:

- hourly rate × regular hours versus the parsed base component;
- pension base × contribution percentage versus the parsed employee/employer contribution;
- known component sum versus gross only when the extractor explicitly says the parsed component set is complete;
- evidence-backed factor-of-ten scale anomalies.

Comparisons use integer/rational arithmetic with rounding tolerances. Gate 0 reports an issue but never silently replaces a parsed value. It deliberately makes no judgment about legal compliance.

## Candidate-to-snapshot resolution

The resolver creates an `EmploymentSnapshot` through existing canonical fact contracts:

- a strong valid documentary value becomes `confirmed`;
- moderate confidence or suspicious validation remains `candidate`;
- low confidence or explicit ambiguity becomes `needs_confirmation`;
- invalid candidates do not become confirmed facts;
- disagreeing candidates remain `conflicted` and retain their candidate IDs;
- genuinely absent fields become explicit `missing` facts;
- overtime bands are combined deterministically while retaining both documentary references.

Document, page, safe text span, optional bounding box, confidence, and timestamps remain traceable. The initial factual ontology now includes gross/net salary, overtime bands, severance contributions, and leave balances. Sensitive identity metadata and unknown components are not promoted into the canonical snapshot.

## PII minimization and logging

The full extraction is restricted internal data. `minimizePayslipForSemanticProcessing` creates a separate future-agent representation containing normalized employment fields, confidence, document/page/bounding-box references, and normalized unknown-component values.

It removes:

- employee and employer identity;
- national ID;
- raw field values and OCR fragments;
- raw unknown-component labels;
- all sensitive metadata.

Bank data is not modeled. Future provider adapters that receive full-page OCR must keep that OCR inside the extraction stage and pass only the minimized representation forward.

Safe engine logs allow operational IDs, stage, status, duration, provider ID, extractor version, retry count, and safe error code. Strict parsing rejects OCR text, names, IDs, bank data, salary values, and chat content.

## Synthetic fixtures and benchmark

Source fixtures and manually explicit ground truth are stored separately. The ten scenarios are:

1. clean monthly payslip;
2. clean hourly payslip;
3. 125% and 150% overtime;
4. pension and severance components;
5. travel component;
6. genuinely missing base field;
7. contradictory complete arithmetic;
8. deliberate OCR magnitude ambiguity;
9. Hebrew/RTL labels;
10. unknown salary component.

The fixtures are structured synthetic representations, not real documents or customer data. Text-native and OCR extraction methods are represented, but no claim is made that V0 performs image OCR.

Run `npm run benchmark:payslip`. The fixture adapter currently reports:

| Metric | Result |
| --- | ---: |
| Fixtures | 10 |
| Extraction failures | 0 |
| Exact fields | 68 / 69 |
| Missing expected fields | 0 |
| Hallucinated fields | 0 |
| Expected-absent false positives | 0 / 1 |
| Money values | 28 / 29 |
| Hours values | 4 / 4 |
| Salary periods | 10 / 10 |
| Expected validation catches | 3 / 3 |
| Confidence Brier score | 0.005343478260869569 |

The one intentional field/money miss is the synthetic `8,500 -> 85,000` OCR case. The benchmark retains the incorrect normalized value and confirms that Gate 0 raises both ambiguity and scale warnings. This is the desired behavior: detection without unsupported correction.

The same harness accepts any future `DocumentExtractor`, allowing provider comparisons over identical fixtures and ground truth.

The first isolated server adapter now implements this interface with the OpenAI Responses API. See [OpenAI Payslip Extraction V1](./openai-payslip-extraction-v1.md). V0's deterministic normalization, Gate 0, minimization, and canonical resolution remain the downstream path.
