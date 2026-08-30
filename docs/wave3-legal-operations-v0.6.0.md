# Wave 3 legal operations V0.6.0

## Boundary and outcome

This module is the human-controlled legal-input plane and bounded RuleSpec runtime for the seven frozen Wave 3 topic slots. It does not interpret law, populate a real parameter, approve a real source, or activate the real catalog. The current real catalog is deliberately `BLOCKED_NOT_READY` for 7/7 topics with 0 active parameters and 0 active rules.

The tracked implementation is confined to `src/engine/legal-operations`, `src/server/engine/legal-operations`, `scripts/legal-operations`, and this document. Generated review packets and acceptance evidence belong under Git-ignored `output/parallel-wave-3/workers/w2-legal-operations`.

## Strict contracts

`contracts.ts` supplies strict V0.6.0 schemas for review packets, five source-decision dimensions, blank decision templates, owner handoff, parameter candidates, two independent parameter attestations, RuleSpec/golden approvals, dependency bindings, lifecycle commands, signed activation/revocation/supersession actions, and append-only receipts. Unknown keys, incompatible versions, malformed hashes and dates, inverted intervals, unsafe Money, and non-integer rational lexemes reject.

All canonical hashes use recursively key-sorted UTF-8 JSON with a final newline. Every downstream eligibility command is pinned to these eight dependency dimensions:

1. source bytes;
2. citations;
3. effective interval;
4. sector/population scope;
5. parameter set;
6. RuleSpec;
7. golden cases;
8. reviewer decisions.

A change in any dimension fails closed. There is no implicit latest-version selection.

## Append-only state machines

The in-memory reference store is deterministic and append-only. The same idempotency key and command is a stable replay; a different command under that key fails. Existing artifact bytes cannot be mutated in place.

- Review packet: `draft -> ready_for_review -> changes_requested | rejected | approved`; a change request may return to `ready_for_review`.
- Source: `needs_review -> content_verified -> applicability_verified -> eligible -> active -> superseded | revoked`.
- Parameter and RuleSpec: `candidate -> structurally_valid -> awaiting_attestations -> approved -> eligible -> active -> superseded | revoked`.

Transitions cannot cross artifact kinds or skip states. Activation is a separately signed action by `human_activation_approver`. An actor who participated earlier cannot self-activate the same artifact. A monetary candidate needs two distinct human parameter reviewers bound to exactly the same value, unit, rounding policy, source versions, and dependency hashes. Secondary/corroborative-only support rejects. Rule semantics and golden expected outputs require distinct reviewers.

## Seven review packets

`review-packets.ts` deterministically builds one JSON packet, one Markdown packet, and one blank decision template for each topic: minimum wage, working time, pension, travel, convalescence, vacation, and sick leave. The owner handoff index lists five pending human roles/signatures for every packet.

The frozen corpus lifecycle does not expose immutable artifact-byte or chunk-byte hashes to this module. The packets report those identities as unavailable and add explicit blockers; no hash, publication metadata, interval, sector, population, authority decision, or legal meaning is invented. Technical parse failures and instrument-boundary quarantines appear as blockers rather than omissions. Consequently every real packet is `incomplete` or `blocked` and `usable_for_rules` is always false.

## Bounded RuleSpec

`rulespec.ts` is a flat, forward-reference-only DAG. It admits only declared typed facts, exact-version parameter references, structural rational zero/one, exact integer/rational operations, safe Money scaling and addition, comparisons, bounded selection, min/max, and bounded aggregation. Rounding is explicit: `exact`, `toward_zero`, `half_up`, or `half_even`.

The schema denies executable expressions, callbacks, JavaScript, dynamic import, file/network access, cycles/forward references, undeclared inputs, invalid units, unsafe Money, excessive integer digits, excessive steps/depth, and oversized aggregation. Every execution emits deterministic step and result hashes. The server adapter converts a successful exact-snapshot synthetic execution into the existing canonical `CalculationTrace`; an absent exact `RuleInputSnapshot` registration fails closed.

## Catalog isolation

The seven synthetic fixtures use only neutral test identifiers, currency `ZZZ`, synthetic dates/scopes, structural ratios, and synthetic amounts. The catalog boundary is a literal `synthetic_test` mode with `production_manifest_reachable: false` and no external persistence. Runtime values `real`, `development`, `preview`, `production`, and `shadow` cannot load that catalog. The real catalog delegates all admission to canonical `evaluateLegalReadiness`, returns no source/parameter/rule selection unless ready, and is frozen at 0/7 ready.

## Commands

Run with Node's TypeScript stripping enabled:

```text
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/legal-operations/run.mts build-packets
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/legal-operations/run.mts verify
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/legal-operations/run.mts status
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/legal-operations/run.mts strict-readiness
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/legal-operations/run.mts synthetic-demo
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/legal-operations/run.mts import
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/legal-operations/run.mts propose-activation
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/legal-operations/run.mts activate
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/legal-operations/run.mts revoke
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/legal-operations/run.mts supersede
```

`strict-readiness` intentionally exits 2 when the fail-closed real status is correctly 0/7 ready. The import/lifecycle demonstration commands exercise the same append-only service and synthetic acceptance matrix; they do not persist or activate real data.

## Acceptance evidence

Focused tests cover strict schemas and canonical hashing; every review, source, parameter, and rule transition; forbidden skips; independent attestations; non-primary monetary rejection; all eight binding mutations; RuleSpec static and resource safety; deterministic trace replay; idempotency; append-only mutation denial; activation, revocation, and supersession; packet pairs/templates; synthetic catalog isolation; seven synthetic golden executions; exact-snapshot canonical trace generation; and real 0/7 readiness.

Generated evidence contains:

- `review-packets/`: 7 JSON packets, 7 Markdown packets, and 7 blank decisions;
- `owner-handoff-index.json`;
- `review-packet-manifest.json`;
- `acceptance-matrix.json`;
- `strict-readiness-summary.json`;
- `evidence-summary.json`.

These artifacts are audit evidence only. They are not Findings, eligibility decisions, customer reports, legal approval records, or production/shadow inputs.
