# Automatic attendance and contract evidence: code map

Read-only audit, 12 September 2026. Repository HEAD observed: `54279912fc6e30dd4dd0a16b8407412ddb2570d7`. The working tree also contains the concurrently implemented entitlement branches. No provider request, database query, deployment or test run was performed for this audit. Customer documents and prior reading artifacts remain outside Git. Proposed interfaces below are not implemented capabilities.

## Finding

The ordinary upload and immutable case-input journal preserve contracts and attendance files, but the saved worker extracts only payslips. The existing source-review admission can securely accept a prepared review of those other documents; it does not create that review from a fresh upload. Therefore the prior reviewed-source execution proves engine/persistence integration, not automatic contract or attendance extraction.

This is a software gap, separate from missing source facts, uncertain readings and legal applicability. A new queue, a second calculation engine, or relabeling a contract as a payslip would not repair it.

## Current path and exact boundaries

| Port | Existing behavior | Consequence / required change |
|---|---|---|
| `src/server/engine/extraction/verified-upload-source.ts`: `loadVerifiedUpload` | Loads immutable document by case and version; verifies physical path, byte length, SHA, file signature and page/pixel bounds. Document type itself is generic. | Reuse unchanged as the source port. Never accept a provider/browser Storage path. |
| `src/server/product/processing/saved-job-runner.ts`: `plan` | Selects journal documents with `type === 'payslip'` for purchased months. Authenticated source-review scope can skip their OCR; missing financial sources still receive a partial review. | Add explicit attendance/contract work selection. A monthless contract must not inherit the journal month as its factual effective date. Reuse one immutable extraction across applicable purchased months. |
| `saved-extraction-worker.ts`: `admit`, `prepare`, `validateResult`, `recordSavedExtractionResult` | Admission SQL requires journal and database type `payslip`. Result type is `ReturnType<typeof extractSavedPayslip>`. The durable invocation key includes case/version/policy/expected month. A pending unknown outcome prevents a new call; late known responses are stored before currentness admission. | Introduce typed extraction dispatch and a separate non-payslip policy/result variant while retaining the same leases, invocation table, receipt-only recovery and bounded transport. Preserve old payslip path/keys. |
| `src/server/engine/extraction/saved-payslip.ts` | Explicitly rejects a non-payslip and calls `runOpenAiPayslipExtractionV21`. | Add a sibling entry point; do not remove this guard or invoke its payroll schema for contracts. |
| OpenAI `v2-request.ts`, `v2-schema.ts`, `v2-adapter.ts` | Request, structured schema and semantic crops are payroll-specific. `extraction/contracts.ts` detected types are only `payslip` and `unknown`. | Reuse verified byte transport, preprocessing primitives, receipts and budget authorization; add purpose-specific strict schema/prompt/normalizer. Reusing the class without a purpose-specific request would still be payroll extraction. |
| `processing/extraction-checkpoint.ts` | Writer type, policy and source-match SQL are payslip-only. | Add an explicit discriminant, immutable result SHA and exact type/policy verification. Do not overwrite a historical checkpoint to change its interpretation. |
| `processing/saved-snapshot.ts`: `SavedCaseSnapshot.read` | Filters payslips; loads normalized payroll checkpoints and payroll reading annotations. Source-review mode intentionally yields no fake payroll extractions. | Load a separate authenticated non-payslip collection with original machine payload and separate identified-reading overlays. |
| `engine/case-analysis/contracts.ts`: `StoredCaseInputSnapshot` | `extractions` is `NormalizedPayslipExtraction[]`; optional `document_review_input` is separately pinned. | Add an optional versioned collection, not a widened unvalidated array. Historical absent-field bytes must remain unchanged. |
| `engine/case-analysis/service.ts`: snapshot admission | Verifies document/extraction hashes and enforces corresponding payroll document/extraction cardinality. Separately verifies `document_review_sha256`. | Do not simply append non-payslip documents to the existing payroll arrays. Independently pin the new collection, or bind its generated review evidence into the existing separately hashed review input; validate this explicitly before use. |
| `processing/saved-document-review.ts`: `sourceReviewInput` | First loads an admitted prepared source review. Otherwise generates an inventory-only partial review when payroll documents are absent, or uses `reviewInputFromPayslips`. | Add deterministic composition from admitted non-payslip observations. A fresh normal worker must produce this composition without developer-generated calculation inputs. Preserve prepared historical review receipts as their original provenance. |
| `saveSavedDocumentReview` / `document_review_source_admit` | Validates paid order/month, source versions, source bytes and operation replay, then creates an immutable review reference and new source revision. Cannot accept fabricated identified answers. | Reuse the admission boundary if the automatic adapter persists source reviews. Its changed source job must be scheduled/claimed before analysis; do not continue under the old lease/source. Avoid a repeated admission loop for byte-identical generated input. |
| `reports/document-field-confirmation.ts`, `reading-verification.ts` | Scalar, row, scope, transcription and structure targets all reconstruct from `tivdoc-saved-extraction-v1` payroll checkpoints and salary-period guards. | Add a separate document-cell/paragraph target variant. Do not invent a salary scalar to expose a clause or attendance time. Reuse identified answer revisions, protected source display and currentness checks. |
| `processing/saved-field-readings.ts`, `saved-reading-dependencies.ts`, request SQL | Load immutable target/answer history and enforce exact source, checkpoint, period and purchase pins for existing variants. | Extend the target dispatcher and SQL allowlists/reconstruction. TS-only support would leave the product disconnected. Root owns migration and saved integration. |

`engine/agents/contracts.ts` already defines a generic page-text `documentExtractionSchema` and candidate-only `documentIntelligenceExchangeSchema`. They preserve useful documentary provenance constraints, but repository searches found declarations/tests rather than a saved-worker provider implementation. `engine/extraction/multi-document-intake.ts` and its server adapter accept already supplied canonical documents/extractions/facts and check cross-document periods; they do not extract attendance or contract contents from uploaded bytes. Neither is evidence that the missing path is already wired.

The invocation/checkpoint table names do not alone require a new table. Their generic JSON storage and existing worker role can potentially hold a new policy variant, subject to actual schema/RLS checks by the integrating agent. Existing currentness RPCs, managed-worker unknown-outcome checks and field-scope predicates contain hardcoded payslip policies. Those must be audited deliberately; broadening a TypeScript union alone is insufficient.

## Retained private evidence: what it establishes

The retained attendance reference has its own versioned schema, original source hash, source dimensions, literal date/cell readings, per-cell location/readability, totals and unresolved semantics. It is explicitly marked `ai_document_review`, `provider_calls: 0`, `human_verified: false`. This is a valuable independent regression oracle and source-design example, not a saved live-provider receipt.

The retained admitted case-source review includes attendance, contract and payroll source documents with `ai_document_review` and exact reading receipts. It contains constructed review checks. It demonstrates source pinning, execution and history after admission. It does not demonstrate ordinary upload-to-extraction. No private dates, amounts, names, source identifiers or clause text are copied here. The original artifacts must stay immutable; any comparison with a new extraction needs a new evaluation receipt that distinguishes manual AI source review, live provider output and identified account answers.

## Proposed minimal versioned source contract

Add new modules rather than modifying the historical payroll provider schema:

```ts
type NonPayslipEvidenceKind = 'attendance' | 'contract';

// Parsed server-owned envelope; provider emits observations, never these pins.
type SavedNonPayslipExtraction = {
  schema_version: 'tivdoc-saved-document-evidence-v1';
  case_id: string;
  product_document_id: string;
  version_id: string;
  input_sha256: string;
  policy_version: string;
  requested_scope: { purchased_months: readonly string[] };
  result_sha256: string;
  result: {
    kind: NonPayslipEvidenceKind | 'unknown';
    provider_receipt: unknown; // existing strict receipt schema, not arbitrary JSON
    raw: unknown;             // purpose-specific strict provider schema
    normalized: unknown;      // purpose-specific strict normalized schema
    physical_page_count: number;
    source_coverage: unknown; // page/block coverage with omissions/quality flags
  };
};
```

The `unknown` types above mark ports needing named strict schemas, not runtime acceptance of arbitrary objects. The provider receipt must preserve actual request ID, model, prompt/schema version, usage and outcome origin. Budget is reserved before I/O and is not reset for a new document kind. No new call is needed for a valid receipt-only retry. Extraction cache identity should be document/version/policy/request-shape, not an invented contract salary month; expanding a scope after a source-limited extraction requires an explicit new request policy rather than silent reuse.

Normalized observations need all of:

- Stable original block/row/cell or paragraph identity; literal text/number, source page and region/locator, raw SHA, source label, normalization result or explicit missing/unreadable/conflicting state. Different observations remain separate even when values or labels match.
- Attendance: printed dates and their year evidence; entry/exit time cells, explicit next-day dates when present; breaks, printed totals and rate/category columns as separate observations. `08:30` clock time, `8:30` duration and `8.30` decimal hours are different typed values. Missing breaks are not zero; a clock interval is not automatically paid time; a printed overtime column is not a legal classification.
- Contract: complete paragraph text and UTF-8 SHA, page/section reference, explicit amount/rate/quantity and currency tokens, effective dates, stated conditions, cross-references and missing annexes. A read clause is not an admitted agreement, and an extracted promise is not proof that its conditions were fulfilled.
- Provider confidence retained unchanged. Reuse established per-cell acceptance only when its policy genuinely supports the value type and evidence; no whole-document verification and no invented threshold for contract interpretation.

A new identified target should carry common case/document/version/source/checkpoint/policy pins, a target kind, original observation hash, exact cell/paragraph selector, and the intended purchased execution period separately from the observed source period. `confirm` applies only to a present proposed reading; `correct` validates type and retains original bytes; `unknown`/`unreadable` remove only the latest effective reading for that target. Source absence needs an explicit source-transcription target and cannot be confirmed as an existing provider observation.

A contract paragraph/text confirmation and agreement-binding assessment remain distinct. Likewise, attendance date/time reading and paid-time/overtime applicability remain separate. Correcting one cell must not confirm its row, siblings, period, payroll mapping or legal classification.

## Bounded implementation ownership proposal

Suggested first independent implementation lane:

1. NEW `src/engine/extraction/document-evidence/contracts.ts`, `normalization.ts`, `reading.ts` and synthetic tests: strict attendance/contract observations, exact hashes, typed normalization, immutable overlays.
2. NEW `src/server/engine/extraction/providers/openai/document-evidence-{schema,prompt,mapper,request}.ts` plus focused mapper/replay tests: reuse transport/preprocessing/receipt primitives, no provider call during implementation.
3. NEW `src/server/engine/extraction/saved-document-evidence.ts`: verified upload → typed result. The parent integrates invocation/checkpoint dispatch and budget authorization.
4. NEW `src/server/product/reports/document-evidence-confirmation.ts` plus tests, with negotiated additions to the existing target/answer dispatcher. UI and database are parent/coordinated ownership.

Separate integration lane (not edits authorized by this audit): saved worker plan/admission/checkpoint dispatch, saved snapshot/hash guard, saved reading loader, request opener/currentness SQL, protected UI display, and deterministic document-review/entitlement input composer. The composer uses existing `executeRuleSpec` through the ordinary CaseAnalysisService and existing obligation/working-time branches. It must consume the machine extraction plus genuine identified readings, not import the retained private source-review packet.

## Required proofs before claiming the gap closed

1. Synthetic attendance and contract files enter through ordinary upload, exact source bytes reach the provider adapter, resulting immutable checkpoints reach the normal snapshot and review. Injected replay and live extraction are reported separately.
2. Provider omission, duplicate row/location, ambiguous date/year, midnight interval, unreadable cell, missing annex and contradictory clause remain explicit. No inferred zero, paid hours or legal approval.
3. Identified correction changes only its dependent calculation; unknown/unreadable blocks the same dependency; prior machine payload and answer revisions remain unchanged.
4. Source replacement, wrong case/month/order, changed checkpoint or foreign source locator reject target reuse. A multi-month contract is read once only if source coverage supports reuse, while effective period/applicability are validated per execution month.
5. Restart, concurrent invocation, unknown provider outcome and budget exhaustion use existing controls; no duplicate paid call or source-admission loop.
6. At least one fresh non-payslip input reaches an ordinary generated report without a developer-prepared case packet. Legal and factual blockers stay visible even if the pipeline executes successfully.

No such new end-to-end proof is claimed by this audit.

## Implementation increment following the audit

The new `engine/extraction/document-evidence/` contracts, literal normalization and identified-reading primitives are implemented. Purpose-specific OpenAI schema/prompt/request/mapper/adapter and `saved-document-evidence.ts` now use verified uploaded bytes, the existing provider receipt contract and a mandatory host spend authorization callback. There is no default unbudgeted extractor or automatic provider retry. Requested months are sorted; `dispatch_month` is only their earliest routing key and is not an observed source date.

The saved validator replays normalization from preserved provider output and checks exact source metadata. Original output, normalized candidates and identified corrections remain distinct. The protected request journal/UI, worker dispatch, source snapshot and normal report composition are integration work managed separately; this increment alone does not prove those connections.

Validation: the two new focused suites passed **20/20**, with targeted lint clean. After adding the routing-month contract, the five provider/upload tests passed again, including a wrong/unsorted dispatch rejection, and lint remained clean. All provider responses in these tests are explicitly injected synthetic fixtures. No provider, database or browser proof was performed by this implementation lane.

The budgeted factory now optionally returns `documentEvidenceExtractor` under an explicit `sol-document-evidence-scope-v1` source/case/version/kind/page allowlist, within the existing source and finite-window permissions. It shares the existing file lock, busy fence, generation counter and package ledger. The request uses the existing **10,000 output-token ceiling**, not a larger reservation. Count and generation use the original 12-request / $5 ceiling; prior unknown outcomes remain charged and block implicit retry. The historical managed package expiry remains unchanged. Both successful and failed provider receipts are retained; a count failure leaves its unknown reservation intact. Seven added focused budget regressions plus the existing budget/provider tests passed **24/24**, with targeted lint clean. No new ledger was created or reset in the product factory.

The new server reading bridge and request opener are also implemented. They reconstruct one cell/paragraph target from the verified checkpoint and exact current document, reuse the v2 answer decoder and existing `document_field_request_open`, and retain unknown/unreadable answers as identified history without a numeric value. Opening selects current paid months itself; caller selectors only narrow actual observation IDs. Default opening is restricted to period-start/end gates, with all other observations explicitly deferred until a consuming analysis requests them. Nine focused bridge/opener regressions passed, with targeted lint clean. Their database boundary was simulated; target-union/SQL/UI/snapshot integration still requires the coordinated validation described above. Existing v2 text corrections retain their 500-character wire limit; full original paragraphs remain preserved independently.

The shared target union, answer pre-save validator, reading resolver/materializer, request display and existing customer reading form now accept `document-evidence-reading-v1`. A non-payroll resolution requires current authenticated `ImmutableDocument` metadata; reconstructing from the receipt alone fails. Policy, case, month, source and checkpoint changes remain rejected. The non-payroll materializer returns `kind: document_evidence`, including negative reading history; it never appends a payroll scalar. Confirmation is unavailable for conflict/unreadable candidates. Paragraph correction uses a bounded textarea. Its fixed basis is explicitly `system_action_context:identified_source_correction`, not a claimed user-written explanation or agreement approval. The existing protected source route is reused; an absent bounding box leaves the original protected page available without inventing a highlighted region.

The opener additionally accepts optional `month` to narrow a consuming report's requests to that purchased month, with `rest_day` supported for attendance and contract. An unpurchased month opens no question. Pure checkpoint schemas/replay moved to `saved-document-evidence-contract.ts`, re-exported by the existing I/O modules; SDK/storage modules retain their server-only boundary. Seven focused suites covered **80 passing tests**: 68 server/provider/compatibility tests passed initially; the 12-test UI suite passed after fixing its stale-form test fixture to render the form directly (the thread correctly hides stale active forms). Targeted lint passed for 16 changed files. These are synthetic unit/integration-boundary tests; actual SQL currentness, DEV browser and normal worker evidence are recorded separately by the coordinating integration lane.

Non-payroll money normalization now defaults to `document-evidence-normalization-v2`. It rejects malformed separator groups before the established exact-agorot parser, preserving source text as an unavailable observation. Historical v1 checkpoints and reading targets replay with their original parser and bytes; v2 targets explicitly bind their normalization policy. Valid currency/thousands/signed values remain supported without inferring currency or legal applicability. Four focused suites passed **70/70**, including v1 replay, v1 currency correction, strict v2 corrections, changed-policy currentness, and provider/reading compatibility. Targeted lint passed for six files. The coordinating SQL migration separately binds and validates the same versioned policy; its private parity matrix contains 45 synthetic inputs. No provider request was made for this change.
