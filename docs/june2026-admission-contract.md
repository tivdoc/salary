# June 2026 factual admission contract

This implementation closes the current-source factual mapping portion of the
[canonical binding boundary](june2026-canonical-binding-boundary.md). It does
not activate a legal catalog or transform the collected declarations into
legal assessments. The exported function is
`prepareJune2026AdmittedContext` in
`src/engine/minimum-wage-june2026/admitted-context.ts`.

## Scope and caller responsibility

The first contract accepts one document for June 2026, hourly remuneration and
one monetary row that reconciles with the saved base and gross amounts. Regular
hours must be positive, no greater than 182, with at most four decimal places.
It does not classify other compensation arrangements or choose a legal sector.

The server must load all inputs inside the existing authenticated, paid-scope,
current-source transaction. `current` is the current case/run/revision/input
hash/order/month pin, including the immutable document ID/version/hash/page
count and purchased topics. `saved` is the separately loaded pin for the
canonical run. The stage contains the actual persisted canonical facts and its
SHA. The checkpoint and collection must come from the same scoped journal and
current document. These are server capabilities, not client request fields.
Matching caller-supplied hashes alone cannot authenticate ownership or a paid
entitlement; this pure engine module makes no such claim.

The module recomputes the canonical stage SHA and the ordinary topic input
reference, checks all run/source pins, verifies the checkpoint result SHA and
full June period, and refuses provider-supplied customer confirmations. This
keeps replacement and changed-input detection independent of the arithmetic.

## Deterministic decisions

| Input | Accepted factual meaning | Deliberately not inferred |
| --- | --- | --- |
| Canonical regular hours, base, gross, salary type and period | Preserve the existing `confirmed` status only when there are no conflicting IDs, exactly one corresponding normalized candidate, an equal value and documentary provenance on that exact version/page. | No confidence upgrade, professional review or newly invented confirmation. A canonical `candidate`, `missing`, `conflicted`, `rejected` or `needs_confirmation` remains blocked. |
| Existing customer reading confirmation attached to a fact | Additionally match case/month/version/source, candidate ID/SHA, normalized extraction SHA and result SHA. The existing loader must authenticate the actual request/revision. | A customer reading confirmation does not classify wages or establish statutory applicability. |
| One monetary row equal to saved base and gross | A reconciled source row and two existing fact references that the ordinary v1 arithmetic trace can consume. | Equality and an OCR label do not establish a complete earnings inventory or legal base classification. Even a row labelled overtime stays legally unreviewed; it cannot execute through this context alone. |
| Collected age, arrangements, hours description, sector, role, completeness or component answer | Replayed immutable declaration with its exact source target, request, revision and author; preserve declared/unknown/conflicted/stale state. | Free text or `yes` is not mapped to a legal selector, approved classification or confirmed applicability assertion. |
| Missing, expired or replaced target | Retain a blocked evidence state; expired dates use the captured evaluation timestamp, never the engine wall clock. | No automatic renewal, default answer or silent reuse after source replacement. |

All five required canonical facts initially require documentary provenance.
An identified hours answer cannot enter through an arbitrary declared fact.
Supporting a new declared-hours fact requires its explicit scoped journal
semantics in the ordinary canonical pipeline. The existing engineering answer
path must not silently become that admission policy.

Rows with no monetary amount remain visible in the source checkpoint. They do
not contribute an invented zero amount. The separate completeness and legal
classification gates remain unresolved even when exactly one row has an amount.

## Output and ordinary executor integration

The immutable result is either `factual_context_ready` or
`factual_context_blocked`, with a context SHA, exact source/canonical pins,
per-fact candidate references, and targeted factual issues. When ready,
`source_fact_bindings` maps the existing regular-hours fact and saved base fact
to `fact.regular.hours` and `fact.component.1`; it uses the existing
`CalculationSourceBinding` contract. Blocked contexts return no runnable
operand bindings. The result never contains a calculated amount or report.

It always returns `legal_activation: false`, `publication_allowed: false` and
`component_legal_classification: unreviewed`. All six applicability assertions,
earnings completeness, component legal classification and active catalog remain
explicit `not_admitted` gates. A factual-ready result is therefore a reusable
validated input context, not permission to call an executor or publish findings.

The root server adapter can persist this context in the same canonical run's
review diagnostic and pass its verified source references to the ordinary
executor only after the existing catalog and a separately defined case
assessment policy have admitted the run. The implementation neither accepts an
`approved: true` switch nor adds a new human-signature purpose. It does not
require a person to review every case: a future deterministic assessment policy
can have explicit approved semantics and provenance.

## Saved server loader

`loadSavedJune2026AdmittedContext({context, job, orderId, analysisRunId})` in
`src/server/product/processing/saved-june2026-admitted-context.ts` now implements
the server-side assembly boundary. Its inputs contain no caller-supplied facts,
command or confirmations. It verifies the provisioned worker principal and
tenant, locks the current source and rechecks the exact active paid entitlement.
The persisted run joins its document/extraction/declaration snapshot IDs to the
actual immutable input-version row; its command and idempotency key also bind
the selected order and job. The saved pin comes from that row rather than a
copy of the current pin.

The loader reads the three actual persisted stages, checks their outer hashes,
canonical inner facts hash/case/run and ordinary topic references, and binds
their timestamps and snapshot hashes. These checks happen before compatibility
fallbacks. `SavedCaseSnapshot.loadPinned` then reconstructs the saved document
and reading confirmations from the actual journal. Each confirmation retained
in the canonical facts must exactly match a reconstructed request/revision;
an invented machine `verified: true` without such a confirmation is refused.
Existing canonical confirmed facts without a claimed verified reading keep
their original status and provenance; the loader does not upgrade them.

`readSavedExtractionProvenance` supplies the actual source page count and
provider provenance, also checked against saved byte size, MIME type and
document version/hash. Old receipts without provenance or page count, multiple
documents and incomplete extraction return explicit `context_blocked` reasons.
They cannot claim factual or legal admission. Malformed or foreign records,
stale revisions, missing entitlements and mismatched hashes continue to throw;
compatibility handling does not hide integrity failures.

The checked-in schema supports the loader's joins. The SQL was reviewed against
those definitions, but this subtask did not execute it against a database.
The root task owns callback wiring, the analysis fingerprint change, and actual
DB/Preview verification.

## Verification scope

Local focused result: `admitted-context.test.ts` passed **41/41**; ESLint passed
for the two new TypeScript files. The first run exposed two invalid fixture
values, corrected to existing schema values before the successful run. These
are pure synthetic tests; they do not prove that a server loaded a persisted
stage or authenticated a request. That proof belongs to the scoped saved
adapter's separate DB/integration evidence. No DB/build/Preview run was made by
this subtask.

After resuming from checkpoint `6178869`, the new server loader's focused suite
passed **25/25**, and ESLint passed for its two files with zero warnings. These
tests use a recording SQL adapter while executing the real saved snapshot,
reading reconstruction, extraction provenance and context implementations.
Their receipt objects are produced by `extractSavedPayslip` with an explicitly
injected provider transport. They establish neither real database authority nor
live OCR. They include old journal revisions and forged canonical confirmations
with recomputed hashes, a less-permissive persisted fact status, revoked scope,
foreign worker identity, source receipt mismatch and typed legacy/multiple
document fallback.

Focused tests cover actual context materialization and reuse of its operand
bindings by the existing v1 source trace. The arithmetic oracle is independently
fixed at 24,058 agorot for 100 hours and 330,000 agorot recorded, using the unsigned
candidate's exact 182 divisor policy. This test is explicitly arithmetic-only;
the source trace says `arithmetic_provenance_only`, and legal activation stays
false. It is not a new OCR, DB, provider or customer-report proof.

Negative cases cover current/saved case/run/revision/order mismatch, purchased
scope, source version/hash/page count, changed canonical/reference/checkpoint
hashes, raw-provider confirmations, unconfirmed/conflicting facts, equal-hash
tampering of values, unsupported hours, multiple monetary rows, forged or
duplicate declarations, expiry and stale source targets. Execution results and
server integration evidence are reported in the package handoff after the
coordinated test lane runs.
