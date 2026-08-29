# OpenAI Payslip Extraction V1

## Scope and isolation

OpenAI is Tivdoc's first extraction provider, but the core engine remains provider-independent.

The implementation is an isolated, server-only evaluation capability. No upload route, customer UI, payment flow, analytics integration, funnel step, or Production job imports it. It does not persist extraction output. Database integration verification remains pending.

The pipeline remains:

```text
private document bytes
  -> server-only OpenAI adapter
  -> strict structured transcription
  -> provider-independent raw candidates
  -> deterministic normalization
  -> Gate 0 technical validation
  -> field-specific confidence assessment
  -> canonical snapshot resolution
```

The model is a transcription component. It cannot emit a legal conclusion, determine a violation, decide entitlement, calculate compensation, or silently correct a suspicious number. The JSON schema has no legal-result fields and rejects additional properties.

## Responses API and model configuration

The adapter uses the official `openai` Node SDK and the Responses API:

- `responses.parse()` and `zodTextFormat()` provide Structured Outputs validated against a strict Zod schema;
- PDFs are sent as Base64 `input_file` content;
- JPG and PNG images are sent as Base64 `input_image` content with high visual detail;
- `store: false` is set on every request;
- direct Base64 inputs avoid creating persistent Files API objects;
- normal unit tests inject a narrow transport and make no network requests.

The current default is `gpt-5.6-sol`, selected on 2026-08-29 because the official model catalog identifies it as a strong vision-capable Responses model with Structured Outputs. It is configuration, not business logic:

```text
OPENAI_API_KEY=
OPENAI_EXTRACTION_MODEL=gpt-5.6-sol
OPENAI_EXTRACTION_TIMEOUT_MS=120000  # optional; not included in .env.example
```

`OPENAI_API_KEY` is read only by server code. It must never use a `NEXT_PUBLIC_` prefix, enter a response body, or be logged. A blank or absent key produces the safe `openai_not_configured` result before document bytes are read. Production Vercel secrets are not changed by this work.

Authoritative implementation references:

- [Responses API reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [File inputs](https://developers.openai.com/api/docs/guides/file-inputs)
- [Images and vision](https://developers.openai.com/api/docs/guides/images-vision)
- [GPT-5.6 Sol model capabilities and pricing](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
- [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)

## Versioned prompt and structured output

The prompt version is `payslip-extraction-openai-v1`. Its instructions require visible-value transcription, exact preservation of suspicious values, null/omission for unreadable data, and abstention instead of guessing.

The structured schema contains:

- detected document type and quality metadata;
- visible field candidates for period, salary type, base/monthly pay, hourly rate, regular and overtime hours, gross, net, travel, convalescence, pension contributions and base, contribution percentages, severance, and leave balances;
- additional unmapped earnings rows;
- isolated employee name, employer name, and synthetic employee ID metadata;
- one-based page and source-label evidence;
- ordinal transcription confidence and constrained warning codes.

The model returns visible strings. Tivdoc's deterministic normalization layer converts monetary values into integer ILS minor units. Bounding boxes remain absent because the Responses API does not supply reliable boxes for this flow; none are invented.

Every provider result records `provider_id`, model, extractor version, duration, safe provider response ID, and token usage when available. Failed results carry only an approved safe error code:

- `openai_not_configured`
- `unsupported_document`
- `provider_timeout`
- `provider_rate_limit`
- `provider_invalid_response`
- `structured_output_validation_failed`
- `extraction_failed`

Raw provider errors and responses never enter customer-facing errors or safe logs.

## Confidence and retry policy

Model-reported confidence is only an ordinal transcription signal. Candidate confidence is capped by document quality and reduced by ambiguity warnings. After normalization, a separate field-specific policy also considers:

- missing critical fields;
- conflicting normalized candidates;
- candidate warnings;
- document quality;
- Gate 0 invalid, suspicious, or confirmation-required assessments;
- thresholds configured per field rather than one global score.

The initial critical policy covers period, salary type, gross, hourly rate and regular hours when hourly/mixed, pension base and present contribution families, and overtime bands when present. A low overall error rate cannot conceal weak accuracy for a pension or overtime field because the benchmark reports each critical field separately.

The adapter performs one pass in V1 and disables SDK retries so first-pass failures remain visible. The boundary supports a future explicit flow:

```text
first extraction
  -> normalization
  -> Gate 0 and critical-confidence policy
  -> suspicious or low-confidence only
  -> optional second extraction or stronger configured model
  -> compare candidates
  -> user confirmation if still ambiguous
```

No automatic second pass is enabled yet.

## Synthetic rendered corpus

The benchmark generator deterministically creates ten obviously fictitious documents:

1. clean monthly PDF;
2. clean hourly PNG;
3. overtime JPG;
4. pension-heavy PDF;
5. dense Hebrew/RTL PNG;
6. low-resolution JPG;
7. mildly rotated PNG scan;
8. blurred, grayscale, compressed JPG scan;
9. ambiguous-number PDF preserving visible `85,000` versus `8,500`;
10. contradictory-arithmetic PNG.

All documents carry a conspicuous synthetic banner and use fictional names, employers, and IDs. Ground truth is a separate source module. Generated manifests contain fixture metadata and checksums, not normalized answers. The `RenderedPayslipDocumentSource` exposes only approved artifact bytes and verifies their SHA-256 checksums.

Generated documents are reproducible and ignored under `output/payslip-openai/`; large binaries are not committed. PDF pages are rasterized into deterministic A4 PDFs so no hidden answer text or ground-truth metadata is available to the extractor.

## Benchmark execution and reporting

Normal tests never call OpenAI and explicitly exclude the external benchmark file. Run the opt-in benchmark separately:

```bash
npm run benchmark:payslip:openai
```

Without `OPENAI_API_KEY`, the command generates and validates the synthetic corpus, prints `openai_not_configured`, and exits without network traffic. With an approved local key, it sends only those generated documents and reports:

- fixture and failure counts;
- exact, critical-field, money, hours, and period accuracy;
- missing and hallucinated fields;
- Gate 0 catches;
- per-fixture and per-quality results;
- per-critical-field results;
- average duration and token totals;
- estimated cost only when token usage is complete and a versioned authoritative model price is known.

The current `gpt-5.6-sol` estimate uses the official 2026-08-29 catalog prices of USD 4 per million input tokens and USD 20 per million output tokens. Unknown model pricing yields `null` rather than an invented estimate. Timestamped result files do not overwrite historical benchmark results.

## Privacy and safe logging boundary

Allowed logs contain only operational IDs, provider/model/extractor identifiers, status, duration, token counts, safe response ID, retry count, and safe error code. Forbidden log content includes salary values, names, national ID, OCR/document text, document bytes, provider error messages, and API keys. Strict logging schemas and adapter tests enforce this boundary.

Sensitive identity metadata remains in the restricted raw extraction result. `minimizePayslipForSemanticProcessing` removes identity and source text before any future semantic agent receives the result. Future agents should normally consume this minimized structure, not the original document.

## Before any real Tivdoc payslip

Real customer documents remain disabled. A separate approval is required for all of the following:

- an OpenAI project and scoped Production API credentials;
- retention, abuse-monitoring, data residency, and other data-control settings;
- privacy-policy and customer-notice implications;
- document upload, deletion, and lifecycle rules;
- isolated database integration verification and persistence decisions;
- accuracy thresholds and a reviewed confirmation experience;
- Production route/UI wiring and operational monitoring.

No Production secret, route, upload flow, Supabase migration, database row, or customer document was changed or used by this implementation.
