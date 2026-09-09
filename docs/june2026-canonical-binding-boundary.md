# June 2026: remaining canonical binding boundary

Read-only assessment, 2026-09-09. Code inspected at the `f0d8081` application
checkpoint, with the collection integration through schema130. This document
adds no implementation, test run, DB proof, approval or deployment.

## Decision for this package

Do not replace `SAVED_RULE_EXECUTOR_NOT_ACTIVATED` with a nominal executor.
There is no small adapter that completes an additional admitted execution
boundary using only the authorities currently available. The existing pure
June candidate already calculates, checks the component ledger and produces a
fully pinned arithmetic receipt. Another adapter fed with fabricated confirmed
evidence would repeat that demonstration without solving the missing admission.

This is a technical gap as well as a legal activation dependency. It is not a
claim that a human must review every customer's case. A reviewed deterministic
policy could eventually classify well-defined factual inputs. The present
implementation has neither that admitted case policy nor an authenticated
resolver for case-specific legal assessments. The current trust purposes do
not provide such a resolver; reusing a source-review signature for a customer's
component classification would change its meaning.

## What is connected already

- `src/server/product/processing/saved-june2026-collection.ts` opens and reads
  questions against the current case, purchased month/topic, immutable document
  version and extraction checkpoint. It materializes the saved answer journal
  into declared, unknown, conflicted, missing, expired or stale evidence.
- `src/engine/minimum-wage-june2026/collection.ts` binds declarations to the
  exact target hash, request, answer revision, identity and source. A declaration
  remains `legal_classification_status: unreviewed` and
  `candidate_evidence_admitted: false`.
- `src/server/product/processing/saved-analysis.ts` reads this collection in
  the fenced source transaction and stores it in the canonical run's
  `review_pending` diagnostic. It still submits `sector: unverified` and
  `population: unverified` to the catalog.
- `src/engine/legal-operations/june2026-catalog.ts` pins the acquired sources
  and policy in that same run. Its June selection remains inactive: no active
  parameter versions or RuleSpec are returned. The independent readiness
  evaluator remains in force.
- `src/engine/minimum-wage-june2026/executor.ts` is an unsigned pure candidate.
  Its synthetic confirmed-evidence tests prove arithmetic and rejection rules;
  they are not evidence of current-source admission or legal activation.

The actual collection DB proof and its limits are recorded separately in
[the collection integration record](june2026-collection-integration-2026-09-09.md).

## Exact interfaces still missing

| Boundary | Available contract | Missing contract and required authority |
| --- | --- | --- |
| Case evidence admission | `June2026WageEvidence` in `src/engine/minimum-wage-june2026/evidence.ts` requires confirmed, missing or conflicted applicability/completeness/classification assertions and their provenance. Saved collection returns unreviewed customer declarations. | A materializer must resolve exact current declarations plus authenticated assessment/policy evidence into those assertions. It must identify which factual statements may be admitted, which legal classifications require an approved decision rule or authorized assessment, and how conflicts or absent evidence block admission. It cannot translate every `declared` value into `confirmed`. |
| Active legal selection | Source/parameter/rule/golden review and lifecycle guards exist in `src/engine/legal-operations/`, including signed, purpose-bound human trust. June has pinned unsigned candidates. | An immutable active selection must resolve the exact approved source, parameter, RuleSpec and golden versions for June and the admitted sector/population. Source/rounding decisions and required activation attestations are still absent. Customer answers cannot create them. |
| Exact ordinary-run context | `CaseAnalysisService` persists the canonical facts stage and topic input reference before calling `RuleSpecExecutorPort.execute`. That port receives `selection`, `rule_input`, `execution_id` and `calculated_at`, not the actual facts or collection. | A narrowly scoped loader/context port must retrieve the same canonical stage and admitted evidence, verify case/run/input/source revision, recompute the topic input reference and bind the same catalog. Use the existing fenced transaction and repository; do not reload a later mutable case state. |
| Operand provenance | `createSourceCalculationTrace` in `src/engine/calculations/source-trace.ts` accepts confirmed canonical facts or pinned parameters and validates the full arithmetic trace. | A supported mapping from admitted earnings components to canonical operands is needed. Arbitrary component rows are not canonical ledger facts today. A general solution requires an explicit fact/trace contract, with immutable versioning and historical-reader compatibility. |

These are contracts to define and implement, not permission requests added by
this assessment. In particular, no new case-level human-signature requirement
is inferred from v1.1. Any authorized deterministic admission path must have
explicit semantics, provenance and tests rather than silently adopting the
candidate's synthetic `confirmed` fixtures as policy.

## Smallest single-base option

A restricted calculation could use the existing confirmed
`compensation.base_monthly_salary` and regular-hours facts, the arity-one June
RuleSpec and its two pinned parameters. The v1 source trace can represent those
operands without adding a component ledger fact type. The ordinary executor
could load the already persisted `canonical_facts` stage, recompute its hash and
the topic reference from `src/engine/case-analysis/service.ts`, then construct
the existing source trace and result.

That avoids a new trace format only for a demonstrably single eligible base
component. It still needs admitted evidence that the earnings list is complete,
that the one component is the eligible base, and that every applicability
condition holds. Equality of base and gross, an OCR label, or a customer's
component choice does not establish those conditions by itself. Additional
unclassified rows, absence pay, exclusions, conflict or an uncertain scope must
keep the calculation blocked. Consequently, the adapter has no admitted
production input today; implementing only this last arithmetic mapping would
not remove the missing boundary.

The existing pure candidate already covers the arithmetic for this option.
There is no additional injected proof counted here. A single-base adapter is
worth implementing alongside the admission contract and its actual saved-run
integration, rather than as an unreachable helper in the delivery package.

## Suggested next bounded task and end conditions

Scope one June 2026 general-private hourly, single-eligible-base path. Preserve
the multi-component and other-period blocks. Before implementing the adapter,
record the admission semantics for each applicability assertion, completeness
and base classification; choose the authoritative policy/assessment source and
bind its version and provenance. Do not expand the human trust model implicitly.

The technical task ends when all of the following are demonstrated:

1. A current scoped collection plus the explicitly admitted assessment/policy
   evidence materializes into `June2026WageEvidence` with an auditable mapping
   for every field. Unknown, conflict, missing, expired and stale inputs retain
   their distinct blocked states. A customer declaration alone cannot satisfy
   a legal-classification gate.
2. The ordinary executor loads the exact persisted canonical stage and verifies
   the case, analysis run, source/input revision, document version/hash, topic
   input hash and active dependency pins. It runs through the existing
   `CaseAnalysisService` readiness gate and validated source-trace path.
3. A scoped synthetic DEV case produces findings and HTML/PDF from that same
   canonical run only under an explicitly identified test admission mechanism.
   Replacement, answer correction, foreign identity, replay and restart cannot
   publish stale results or duplicate findings. The test admission mechanism
   must not be reachable by an ordinary customer or be presented as live legal
   activation.
4. A real-mode run with the currently missing activation attestations remains
   blocked. Technical completion and actual activation are reported separately.
   Real customer readiness additionally requires the existing legal reviews,
   exact parameter/rule/golden activation and actual employee evidence; live
   provider and delivery availability remain separately reported dependencies.

The candidate arithmetic under review is **₪240.58** for 100 hours and ₪3,300
recorded, using the monthly floor times hours divided by 182 and final agora
rounding. The older engineering demonstration is **₪240.00**, using published
₪35.40 hourly precision. Neither the collection proof nor this assessment
resolves or signs the rounding decision. See the source sections, exceptions
and unsigned decision packet in
[the canonical review dossier](minimum-wage-june2026-canonical-review.md).
