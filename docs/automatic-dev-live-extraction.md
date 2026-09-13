# Automatic DEV: live extraction boundary and evidence

Date: 2026-09-09. Package baseline: `70e13b9964ab360185970de1a601bbf843ff9e2a`, branch `codex/tivdoc-release-completion`. This document covers extraction only; the root handoff records the eventual integrated commit, schema and Preview. The local runs below tested uncommitted changes on this baseline, not an already deployed commit.

## Status

| Capability | Implemented | Evidence | Remaining boundary |
| --- | --- | --- | --- |
| Live runtime factory using the existing OpenAI SDK adapter | Yes | Configuration and constructor tests | No usable API key; no successful live request |
| Exact source/pass/run and request receipts in saved checkpoints | Yes | Injected transport, receipt tampering and failure tests | Receipts are server-recorded evidence, not externally signed attestations |
| Actual uploaded-byte and actual page-count validation | Yes | Saved synthetic PDF, changed-byte rejection and out-of-bounds provider page tests | No real employee document was processed |
| Missing, ambiguous, zero-gap and replacement live inputs, plus scan/photo simulations | Fixtures and opt-in proof runner | Five generated PDFs; seven rendered inputs inspected; independent input manifest | Live proof is blocked before any API call |
| Live OCR accuracy | Not proved | Explicit `BLOCKED_CONFIGURATION` receipt | Supply a valid authorized key and an available model, then run the live proof |
| Deployment, real DB flow and financial publication | Outside this extraction subtask | Root handoff owns these claims | No deployment or database changes were made by this subtask |

No confidence value was raised. The existing V2 `high` mapping stays `0.94`; canonical confirmation gates remain unchanged. No customer answer, finding, completed report, law activation or human approval was fabricated.

## Integration contract

`src/server/product/processing/live-extraction-runtime.ts` exports:

```ts
createLiveExtractionRuntime(environment = process.env):
  | { state: 'configured'; extractor: OpenAiPayslipV2PassExtractor;
      provider: { kind: 'openai_live'; model: string;
        extractorVersion: string; policyVersion: 'tivdoc-openai-live-runtime-v1' } }
  | { state: 'blocked'; provider: 'openai';
      code: 'LIVE_EXTRACTION_PROVIDER_UNCONFIGURED' | 'LIVE_EXTRACTION_CONFIG_INVALID' }
```

The factory accepts environment configuration only. It offers no injected transport argument and creates the existing `createOpenAiPayslipV21ExtractorFromEnv` implementation. `configured` means configuration parsed and the SDK client could be constructed; it does not prove credentials, model access, billing or OCR success. The existing default model is preserved rather than assumed to be available. Installed OpenAI SDK inspected: `7.8.0`.

`checkpoint.run.provider_receipts` is an optional backwards-compatible array, emitted for every new first/recovery provider pass. `readSavedExtractionProvenance(checkpoint)` returns `kind`, `providerAttempted`, `allPassesSucceeded`, `checkpointResultSha256` and validated `receipts`. Legacy checkpoints without receipts return `unproven_legacy`; model names cannot turn them into live evidence. The worker's immutable, authorized checkpoint remains the storage trust boundary.

Receipt origin is selected internally by construction: an explicitly supplied test transport is `injected_test_provider`; the configured SDK transport is `openai_live`; absent credentials are `not_configured`. Callers cannot select a provenance flag. The root financial coordinator consumes these saved receipts rather than assuming all output came from an injected provider.

`provider-receipt.ts` and `error-contract.ts` are pure validation contracts, without SDK, secret configuration or `server-only` implementation imports. `errors.ts` retains its `server-only` boundary. This lets financial/customer artifact validators reuse receipt validation without importing a provider client.

## What receipts bind

The strict `tivdoc-openai-provider-receipt-v1` body and canonical SHA bind:

- case, immutable document version, parent analysis run, extraction/pass IDs;
- actual source hash, byte length and MIME; actual inspected source page count for new runs;
- hash of the complete built request, without exposing file bytes or request bodies;
- raw extraction hash, pass kind, extractor and prompt versions;
- requested model and actual returned model, response ID and request ID when returned;
- duration, bounded status/error/HTTP code and token usage when provided;
- explicit cost state `not_returned_by_provider` with a null amount. No cost is estimated or invented.

The parser recomputes receipt and result hashes and cross-checks each receipt against its saved raw pass, context, usage, version and source. `source_page_count` is optional only for historical compatibility. For new runs it comes from actual PDF/image inspection, not model output. Provider-reported page counts and every candidate/row evidence page must stay within that inspected document; a mismatch produces `provider_source_page_mismatch` with no candidate facts. Prepared source bytes, size, MIME and SHA must also match the immutable upload before dispatch; altered crops fail their own SHA checks.

These are internal integrity checks. A party with arbitrary write access to all trusted checkpoint data could forge hashes; the receipt is not an external provider signature. Ownership, immutable checkpoint writes and document access authorization remain required in the surrounding system.

## Configuration investigation and blocker

The authorized search examined presence/nonblank state only and never printed credentials:

- Process, User and Machine environment scopes for the OpenAI extraction key/model/timeout and relevant gateway variables.
- This checkout's environment files and the existing private release-work replay configuration.
- The same-project OneDrive checkout `.env.local` and the parallel website-review checkout.
- Fresh authenticated Vercel environment inspection for project `salary`, Development, global Preview and this branch's Preview override. Production was not changed.

No usable OpenAI or gateway key was found. The branch Preview `OPENAI_API_KEY` entry exists but is blank. No candidate secret file was created. The private helper is `../release-work/live-ocr-config-inspection.mjs`; the shareable result contains no secret values: [configuration receipt](release-evidence/automatic-dev-live-extraction/provider-configuration-inspection.json), checked at `2026-09-09T15:05:20.636Z`.

An explicitly enabled real-provider proof was attempted at `2026-09-09T15:28:45.301Z`. It failed before dispatch with `LIVE_EXTRACTION_PROVIDER_UNCONFIGURED`, recorded `providerCalled: false`, and exited 1. This is an **environment/configuration blocker**, not a passed live extraction test. [Blocked proof receipt](release-evidence/automatic-dev-live-extraction/live-provider-blocked-proof.json).

No API provider response, request ID, latency, token usage, actual model version or cost can be reported for a live call because none occurred. Those fields have only been verified using explicitly injected transport data so far.

## Independent synthetic input corpus

[Input manifest](release-evidence/automatic-dev-live-extraction/independent-input-oracles.json) contains exact hashes, sizes, file paths and literal expected outcomes. Its builder imports PDF tooling only, not a rule, calculator, provider response, seeded finding or report. Expected arithmetic is specified independently of the financial engine implementation, in minor units, for the existing engineering-only June 2026 hourly scenario.

| Input | Source hours | Recorded base, minor units | Independent outcome |
| --- | --- | --- | --- |
| Clear | 100 | 330000 | `100 * 3540 - 330000 = 24000` |
| Missing hours | Absent | 330000 | No result; an identified answer of 100 would imply 24000 |
| Ambiguous hours | 100 and 110 | 330000 | No result while the conflict is unresolved |
| Zero gap | 100 | 354000 | `100 * 3540 - 354000 = 0` |
| Replacement | 120 | 396000 | `120 * 3540 - 396000 = 28800` |
| Scan simulation | Raster of clear | 330000 | Same oracle as clear |
| Photo simulation | Raster of clear, degraded and rotated | 330000 | Same oracle as clear |

The five PDFs are synthetic English payslips, plainly marked as synthetic, with June dates, hourly salary and no extra salary components. The two raster files are simulations, **not actual scanner or camera captures**. They do not establish accuracy on Hebrew Israeli employer layouts or real employee documents.

Generation and review:

- `live-extraction-fixtures.generate.mts` creates the five PDFs and literal oracle manifest.
- `live-extraction-fixtures.rasterize.py` extracts text with pdfplumber, checks month/base amount/page count, renders with pypdfium2 and makes the two raster simulations.
- An assistant visually inspected all seven rendered inputs in `output/release-completion/automatic-dev-live-extraction/input-contact-sheet.png`: source amounts were readable, with no observed clipping or overlap. [Preparation receipt](release-evidence/automatic-dev-live-extraction/fixture-preparation.json) explicitly distinguishes this AI inspection from human or legal approval.

The live proof runner performs extraction through the verified saved-upload adapter with isolated local metadata/storage stubs and the real factory. It checks extracted period, hourly salary, base and hours against the literal corpus; ambiguous and missing inputs must remain unresolved. It writes actual checkpoints and receipts only after an actual API attempt. It does not establish DB scheduling, a customer answer flow, replacement invalidation or financial report publication by itself; those belong to the integrated DEV proof.

## Focused verification and reproducible commands

Completed local command (2026-09-09 15:32 UTC):

```powershell
node ./node_modules/vitest/vitest.mjs run src/server/product/processing/dev-financial-contract.test.ts src/server/product/processing/live-extraction-runtime.test.ts src/server/engine/extraction/providers/openai/openai-v2.test.ts src/server/engine/extraction/providers/openai/openai-adapter.test.ts --maxWorkers=1 --reporter=dot
```

Result: **4 files, 93 tests passed**. Coverage includes request/source/run receipt binding, tamper rejection, legacy distinction, actual PDF page boundaries, changed prepared bytes, bounded 401/403/404/429/400/timeout/connection failures and no implicit retry. The 40 financial-contract tests in that command are root-owned integration coverage. Their pure import had failed before the error-contract split and now succeeds without removing the server implementation boundary or adding a mock to the financial contract tests.

`live-extraction-fixtures.test.ts` was added afterwards for seven real-byte signature/page/hash checks and independent oracle consistency. It had **not yet been run by this subtask when this document was first written**; the root final verification receipt must record its result.

Live proof invocation, after authorized secure key/model provisioning in an isolated DEV process:

```powershell
$env:TIVDOC_LIVE_EXTRACTION_PROOF = '1'
node ./node_modules/vitest/vitest.mjs run src/server/product/processing/live-extraction-proof.test.ts --maxWorkers=1 --reporter=verbose
```

This opt-in runner uses the real SDK and can incur provider usage. It does not silently replace a missing key with an injected provider. Detailed output is saved under `output/release-completion/automatic-dev-live-extraction/`; keep any future nonsynthetic source contents private. The proof is skipped in ordinary unit runs until explicitly enabled. Unset the opt-in environment variable after the isolated run.

No full build or typecheck was run by the extraction agent; the root owns serialized integration checks. No tests, confidence guards, source checks or production activation gates were removed to obtain a passing result.
