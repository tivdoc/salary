# Payslip Extraction V2

Payslip Extraction V2 improves transcription of low-resolution Israeli payslips without adding legal reasoning. It preserves provider output as candidates, normalizes values deterministically, and keeps unresolved disagreement visible.

## Scope and boundaries

- V2 is extraction and technical validation only.
- It does not determine legal applicability, entitlement, or damages.
- Originals are never modified.
- Generated or generative super-resolution is not used.
- Production routes, uploads, payments, analytics, and Supabase are not wired to V2.

## Deterministic preprocessing

`src/server/engine/extraction/preprocessing.ts` implements `payslip-raster-preprocess-1`.

For raster pages below 1,200 pixels wide it applies a fixed 2x or 3x Lanczos upscale, grayscale conversion, conservative contrast gain, sharpening, and bounded small-angle deskew. The source bytes and SHA-256 remain available separately. Every processed image and crop has its own digest, dimensions, and versioned transformation metadata.

PDF inputs remain original file inputs. The current local crop implementation operates on PNG and JPEG pages; a PDF remains supported as full-page OpenAI input and can gain crops later through a separately versioned rasterizer.

## Crop strategy

`payslip-semantic-bands-1` uses four broad, overlapping document bands:

- header
- earnings
- totals
- pension

The bands are layout-agnostic and are not coordinates tuned to one payroll vendor or the five regression files. First pass receives original full-page context plus at most four enhanced crops. Targeted recovery receives original full-page context plus only the crop regions required by its selected fields.

## Structured concepts

V2 separates the following concepts in strict Structured Outputs:

- generic visible fields
- salary type, with documented and inferred values separated
- payroll rows with label, quantity, rate, percentage, and amount columns
- gross, total deductions, and net candidate totals
- pension base and separate employee, employer, and severance rates and amounts

Unknown and legacy payroll labels remain `unknown`; their row columns are retained without being silently mapped to a canonical entitlement field.

An inferred salary type is retained only in the pass assessment. It is not emitted as a documented extraction field and therefore cannot become a document-provenance canonical fact. Only an explicitly labeled salary type can enter the documented field stream.

## Targeted recovery

The first pass is normalized and evaluated by Gate 0 and the critical-field confidence policy. A deterministic selector chooses only fields that are missing, invalid, suspicious, require confirmation, or conflict. The OpenAI recovery prompt requests only those fields and does not include first-pass numeric guesses.

V2 permits at most one targeted recovery request per document. Both complete pass records are retained with:

- raw and normalized candidates
- evidence and warnings
- validation and confidence assessment
- model and prompt version
- response ID, tokens, and duration
- preprocessing and selected-region metadata

## Resolution policy

`payslip-v2-resolution-1` is deterministic:

- first missing plus usable recovery candidate: promote the recovery candidate
- independent agreement: select one candidate and apply a bounded confidence increase
- disagreement within or across passes: retain candidates and mark the field conflicted
- recovery still missing: the targeted field remains missing
- invalid candidates are not promoted

The LLM does not resolve conflicting values. Gate 0 sees retained conflicts, and the canonical snapshot resolver emits a conflicted fact with no selected canonical value.

## Gate 0 additions

Gate 0 now carries field keys on issues and can receive an explicit extraction context. It emits `critical_field_missing` for contextually required fields, including hourly rate and regular hours when hourly analysis is implied, total concepts when a totals section is visible, and pension base when a pension section is visible. It also checks incomplete pension relationships, severance arithmetic, and gross/deductions/net reconciliation.

These are technical consistency checks, not legal rules.

## Benchmark reporting

The V2 report stores first-pass and post-recovery metrics separately. Per document it records recovery fields, resolution outcomes, conflicts, recovered and unresolved fields, wrong/missing/hallucinated values, Gate 0 issues, API calls, tokens, latency, and staged cost.

Hallucinated field records now include the field ID, raw extracted value, normalized value, confidence, warnings, and Gate 0 result.

V1 reports remain unchanged. V2 comparison projects salary type to `documented_only` scoring for documents where the salary basis was manually inferred rather than explicitly labeled. The report labels that comparison as `explicit_salary_type`.

## External benchmark safety

The five approved files remain under the ignored `eval/real-payslips/redacted/` directory. Results remain under ignored `output/payslip-openai/` paths.

The V2 external test requires both:

```text
OPENAI_API_KEY=<new rotated key>
OPENAI_API_KEY_ROTATED_AFTER_2026_08_29=true
```

The confirmation flag is intentionally separate from key presence. This prevents an old or unverified key from being used accidentally. Logs contain only operational metadata and never include document bytes, field values, labels, PII, or the API key.

Run the controlled benchmark with:

```bash
npm run benchmark:payslip:openai:real:v2
```

Without both safety conditions the command verifies the local corpus and exits without an OpenAI request.

## Readiness

V2 is not production-ready until the controlled five-document run demonstrates material critical-field improvement with fewer wrong monetary values and controlled cost. Even a successful five-document run is evidence only for expanding to a 30-50 document evaluation corpus, not for starting the Legal Rules engine or declaring production readiness.
