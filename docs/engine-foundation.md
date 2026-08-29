# Tivdoc investigation engine foundation

## Scope and isolation

The investigation engine is a non-routable TypeScript domain module under `src/engine`. Nothing in the current questionnaire, upload, payment, analytics, Meta, GA4, or customer-status flow imports it. It adds no API route, user interface, LLM provider, legal rule, or calculation formula. The separate, unapplied persistence foundation is described in `docs/engine-persistence.md`.

The internal, provider-independent synthetic payslip pipeline is described in `docs/payslip-extraction-v0.md`. It ends at validated canonical facts in memory and does not introduce legal conclusions or customer-visible behavior.

The existing `cases.status` field remains the customer-funnel state. Engine execution uses an independent `AnalysisRun` lifecycle so investigation progress cannot accidentally unlock, block, or reinterpret a paid customer flow.

## Trust boundary

AI agents may classify documents, extract candidate facts, propose conflict resolutions, select an approved interview question, form hypotheses, request information, propose approved rule IDs, and narrate verified findings. Every agent receives an explicit input snapshot and has `database_access: "none"`.

AI output is always parsed by a strict Zod output schema. Unknown fields are rejected. In particular:

- Document Intelligence outputs candidate facts, never findings.
- The Fact Resolver preserves conflicts and emits a separate resolution proposal.
- The Investigator outputs hypotheses and requested facts, never money or findings.
- Interview selects a versioned question already present in the approved bank.
- Legal Applicability proposes IDs from a versioned catalog; it does not write or execute law.
- Report receives verified findings only and may only narrate those supplied findings.

Legal truth belongs in reviewed, versioned rule definitions. Monetary results belong in deterministic, versioned calculation code. Neither exists in this foundation.

## Canonical facts and provenance

`CanonicalFact` is a discriminated union keyed by a known fact path. The initial ontology covers employment dates, salary type, monthly and hourly salary, regular and overtime hours, workdays, breaks, pension base and contributions, travel reimbursement, convalescence payment, and document periods.

Every fact includes:

- a stable fact and case ID;
- a typed value or an explicit absence;
- status, confidence, and creation time;
- one or more provenance references;
- retained conflicting fact IDs and explicit resolution metadata when applicable.

Provenance has four source classes:

- `documented`: an immutable document ID and optional page/text locator;
- `declared`: a questionnaire response or conversation message;
- `derived`: named deterministic derivation plus its input fact IDs;
- `inferred`: an agent output tied to an analysis run.

A `missing` or `conflicted` fact has no canonical value. A conflicted fact retains at least two competing fact IDs. It cannot become `confirmed` while retaining those conflicts unless a human-confirmation or deterministic-precedence resolution is recorded with selected inputs, actor, rationale, and time.

Conversation-derived facts use `declared` provenance whose source reference contains the originating `conversation_id` and `message_id`.

## Interview and conversation history

Questions are stable `(question_id, version)` records and target only paths in the known fact ontology. Supported types are single choice, multiple choice, yes/no, number, money, date, time, document request, and free text. Choice options have stable IDs, display labels, and normalized primitive values. `allow_free_text` is explicit for every question, supporting the intended multiple-choice-first experience with an escape route.

Conversation and message contracts preserve case, conversation, analysis run, role, agent, question version, selected option IDs, free-text answer, rendered content, model, prompt version, and timestamp. Customer messages cannot claim model provenance; assistant messages must record it.

## Hypotheses and investigation loop

Hypotheses are structured records with category, status, priority, reason, supporting and conflicting fact IDs, required fact paths, and proposed versioned rule references. Free-form agent prose cannot cross the Finding boundary.

The loop is:

```text
fact snapshot
  -> investigator hypotheses
  -> missing fact request
  -> approved question or immutable document request
  -> declared/documented candidate fact
  -> fact resolution
  -> investigator again
  -> approved rule applicability proposal
  -> deterministic calculation
  -> evidence-backed finding
  -> verified findings only to report narration
```

The investigation may stop only when every relevant hypothesis is `confirmed`, `rejected`, `not_applicable`, or `blocked`, and no outstanding high/critical-priority fact expected to materially change the analysis remains. `canInvestigationStop` encodes this policy.

## Analysis-run state machine

Run types are `initial_scan`, `full_investigation`, and `shadow`. Run states and allowed transitions are:

```text
queued -> running | failed
running -> waiting_for_customer | partial | blocked | completed | failed
waiting_for_customer -> running | blocked | failed
partial -> running | waiting_for_customer | blocked | completed | failed
blocked | completed | failed -> terminal
```

Run records contain immutable identity, run type, engine version, contract version, and an optional parent run ID. A terminal historical run is never reused for re-analysis. New evidence after a terminal result creates a new run with a new ID and may link `parent_run_id` to the previous run. `shadow` runs use the same contracts but must not affect the customer funnel.

Implementations may update lifecycle state while a run is active, but must retain state-transition events for audit. Terminal run inputs, outputs, versions, and timestamps are historical records and must not be overwritten.

## Findings, evidence, and deterministic calculations

A Finding contains category, status, period, paid/expected/gap money, numeric and tiered confidence, fact references, evidence references, an exact rule ID/version, a calculation trace, and a confirmation flag.

Expected amounts and potential gaps require a deterministic calculation trace. A trace records the formula ID/version, exact rule version, input fact IDs and typed values, ordered intermediate steps, final output, engine version, and execution time. Steps may reference only earlier inputs or steps.

Money is represented as `{ currency, minor_units }`, with `minor_units` a safe integer. For ILS this means agorot. Floating-point monetary amounts are rejected; decimal quantities used by formulas are canonical strings. All money in one finding must use one currency.

Inference-only monetary output is quarantined: it can only be a low-confidence `needs_confirmation` record with `requires_confirmation: true`. It cannot become a high-confidence or verified monetary finding. Verified findings cannot require confirmation and are the only findings accepted by the Report Agent.

## Immutable multi-document migration

The current production model intentionally permits one row per `(case_id, document_type)` and uploads with `upsert` to paths such as `cases/{case_id}/payslip-01.pdf`. The completion route also removes superseded objects. This task does not change that behavior.

A later, separately approved migration should proceed additively:

1. Add immutable document metadata needed for audit: UUID identity, content hash, optional document period, ingestion state, and optional `supersedes_document_id`. Preserve existing columns during compatibility.
2. Backfill existing rows without moving objects. Treat their current paths as legacy immutable locations and compute hashes in a controlled background job.
3. Remove the `(case_id, document_type)` uniqueness constraint only after all current writes are compatible with multiple rows. Add indexes such as `(case_id, document_type, created_at)` and a uniqueness constraint on an immutable storage path/content identity as appropriate.
4. Introduce versioned upload endpoints that allocate the document UUID before signing and write new objects to `cases/{case_id}/documents/{document_id}/original.ext` with `upsert: false`.
5. Dual-read legacy and new rows while the existing customer UI continues presenting one slot per document type. A replacement in that UI creates a new immutable row and marks lineage; it never overwrites or deletes prior evidence.
6. After monitoring and retention/legal approval, migrate legacy objects to UUID paths or retain an explicit legacy-path variant. Any deletion must be a separate retention policy, never part of replacement.
7. Only then remove legacy upload behavior and compatibility code.

The `ImmutableDocument` contract models the target record and enforces its UUID-based path, content hash, lineage, and optional period. The repository now contains a review-only Phase A SQL migration. It has not been applied to Production, Preview, or a local Supabase instance; see `docs/engine-persistence.md` for its boundaries and remaining phases.

## Persistence direction

When persistence is approved, use append-oriented tables for analysis runs, run transitions, conversations, messages, fact assertions/resolutions, hypotheses, findings, and calculation traces. Foreign keys should preserve case and run ownership. Store exact contract, prompt, model, engine, rule, and formula versions used for every material output. Persistence adapters should live outside agent implementations and parse records at the domain boundary on both read and write.

The first server-only provider implementation is documented in [OpenAI Payslip Extraction V1](./openai-payslip-extraction-v1.md). The low-resolution, targeted-recovery design is documented in [Payslip Extraction V2](./payslip-extraction-v2.md). OpenAI-specific code stays outside the pure engine, and neither extractor is wired to Production.
