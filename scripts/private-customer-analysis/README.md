# Private owner analysis of paid source copies

This is a local owner workflow, not the customer queue. It uses the existing
OpenAI extractor, V2.1 normalizer/fact resolver, RuleSpec interpreter and Hebrew
PDF renderer. It does not insert canonical findings, grant test authority,
change Production, send notifications or publish to a customer account.

1. Read only the selected saved payment/questionnaire/document rows. Preserve
   historical service scope and QA uncertainty; never call payment status routes
   whose verifier can mutate payment or emit analytics.
2. Download each selected case's exact source file set through authorized
   Storage access. Stage it outside this repository and explicitly exclude it
   locally from any enclosing home-directory Git repository.
3. Import the ZIP, or the exact raw filename for a one-document case:

   `python -B scripts/private-customer-analysis/import-download.py --snapshot PRIVATE_SNAPSHOT --work-id CASE-01 --archive PRIVATE_DOWNLOAD --output PRIVATE_CASE_SOURCE_DIR`

   Existing bytes/receipts are immutable. Every source is tied to its case,
   metadata and observed SHA. Legacy records do not acquire invented historical
   versions. A separate read-only storage observation can retain actual object
   version/eTag metadata; it does not prove that legacy uploads never overwrote
   earlier bytes.
4. Review sources independently before any provider call. Freeze a private
   reference with file/page/region, literal label and value, uncertainty and
   explicit AI-review provenance. An incorrectly classified upload or clipped
   image must remain incomplete. Do not infer hours or customer answers.
5. Create the private authorization and new ledger once. The schema is exported
   by `src/server/private-analysis/extraction.ts`; the required scope flags
   and source/project/QA/reference pins are checked. The owner's package ceiling
   is 40 content requests/USD15. Its initial operative tranche deliberately uses
   the existing stricter 12 requests/USD5 policy. Never replace or reset a ledger
   to obtain more budget. Count requests and unknown outcomes consume reserved
   budget; the SDK retries zero times.
6. For an enrolled source:

   `node scripts/private-customer-analysis/run.mjs PRIVATE_ROOT DOCUMENT_ID PRIVATE_OPENAI_CONFIG_JSON`

   The config is private and contains `OPENAI_API_KEY`. The source reference is
   hash-checked, never sent to the model. File-page coordinates are explicit:
   one raster file is one source page even when several printed panels appear.
   The opt-in `-fp1` prompt retains historical default request bytes. Schema-valid
   provider output is retained even if its page coordinates fail the source guard.
7. Repeating a completed job verifies its provider receipt and recomputes derived
   facts before reusing it. Source/reference changes and forged derived facts are
   refused. Interrupted/unknown outcomes are not silently recalled. A failed
   generation with no response/token evidence remains an unknown outcome even
   when an HTTP failure receipt exists. Inspect its private receipt before any
   separately authorized retry design; no retry command currently bypasses this.
8. Use `calculatePrivateDocumentArithmetic` with the frozen AI/source evidence.
   It accepts explicit printed values, periods, components and candidate rounding,
   and replays the existing interpreter trace. It grants no legal admission.
   Missing, conflicting and unreadable operands remain distinct blocked results.
   Current/retro deductions, taxable benefits, net and final payable remain separate.
9. Use `renderPrivateOwnerReport` for a readable private HTML/PDF from the same
   reviewed text. It escapes HTML, loads no remote resources and adds an explicit
   owner-only AI-draft notice. Save the calculation/reference/source manifest
   alongside it. No actual customer artifact belongs in Git or public CI.

To pause provider activity, preserve a copy of the authorization, then set
`enabled:false`; the ledger and source receipts remain unchanged. This local
analysis has no background process to restart. DEV worker machine permissions,
its provider expense capability and test calculation authorities are separate;
none is renewed by this workflow. The prior managed workers and webhook remain
stopped unless separately resumed through their documented lifecycle.

Focused verification: Python importer unittest, private-analysis Vitest files,
existing OpenAI adapter tests and production-refusal guards. A mocked SDK proves
only local control flow. Actual 503 provider failures are environment/provider
evidence, not extraction accuracy or a successful live report.
