# Wave 2 V0.4 — Canonical Facts to Rule Inputs

## Scope and safety state

This worker adds an internal, synthetic-only path from the canonical fact
snapshot to the existing deterministic rule runtime. It does not add an
Israeli entitlement rule, legal parameter, source activation, Finding,
eligibility decision, customer report, external persistence adapter, database
operation, network operation, LLM call, or customer fixture.

The fixtures use generic synthetic work-hour signals and no monetary value.
They do not name or encode any Israeli right or amount.

## Immutable snapshot

`createCanonicalRuleInputSnapshot` validates the canonical existing
`EmploymentSnapshot` schema, orders only collections that are semantically
order-independent, and hashes the entire normalized snapshot with canonical
JSON and SHA-256. Values, types, statuses, confidence, timestamps, provenance,
conflict metadata, case identity, analysis identity, and schema version remain
hash-bound. The returned snapshot and reference are recursively frozen.

The synthetic fixture snapshot SHA-256 is:

`6c75faa9e8b6a94d9acbb4e2f7b017c623bae9296f16d2fd81c2d38b695f26fa`

## Versioned mapping and deterministic transformations

The mapping registry binds each canonical fact path to one rule input and one
synthetic runtime path. It records a minimum confidence, explicit maximum age,
expected output type/unit, and an explicit transformation ID/version. Duplicate
input IDs, canonical paths, or runtime paths are rejected. Entry order does not
affect the registry hash.

The only implemented transformation is:

- `canonical.hours.amount@1.0.0`: copies the canonical decimal amount and its
  exact unit from an hours value.

No transformation infers, defaults, guesses, converts currencies, supplies a
missing value, changes confidence, or calls a model. Unknown versions and
type/unit mismatches fail closed.

The fixture mapping-registry SHA-256 is:

`d136be74dbe11574626922a6f4ae3de01d2373861ff2eb9e96c4329e81e51a4f`

## Fail-closed preparation

Preparation preserves the source fact ID/path, calculation value and type,
canonical provenance, confidence, confirmation state, stale state, snapshot
version/hash, and transformation ID/version. Missing, conflicted, candidate,
needs-confirmation, rejected, stale, future-dated, below-threshold, unsupported,
or transformation-incompatible inputs produce deterministic structured
rejections.

The frozen `RuleInputPreparationResult` invariant is enforced: if any mapping
rejects, the published `values` array is empty. The detailed rejection records
retain the expected threshold/age and observed ID/status/confidence/timestamp,
so the same snapshot, registry, and explicit preparation timestamp replay the
same decision.

The ready fixture preparation SHA-256 is:

`0bf931cd2d8c69d0d4e59a22cc77a4185e22a4fd1e9a726f75b3dc9464f610ee`

## Internal synthetic vertical flow

The path is:

`Canonical Snapshot → Input Preparation → Readiness Gate → Existing Synthetic Runtime → Internal Evaluation Record`

The readiness gate verifies preparation, registry/snapshot bindings, rule-input
path/type/unit alignment, complete input sets, exact basis-point confidence,
and the absence of required legal evidence. A rejected gate never constructs a
runtime request. Runtime rejection produces no partial trace.

The internal record schema hard-codes:

- `record_kind = internal_synthetic_evaluation`;
- `is_finding = false`;
- `is_eligibility_decision = false`;
- `is_customer_report = false`;
- `external_persistence = not_permitted`.

It also binds the request ID, rule ID/version/content hash, execution-policy
version, canonical snapshot, mapping registry, preparation, readiness decision,
runtime result, and trace hash.

No persistence function or adapter is exposed. All clock inputs are explicit.
Canonical serialization and normalized input collections make replay invariant
to timezone, locale, object-key order, fact order, provenance order, and mapping
order.

Fixture replay evidence:

- readiness SHA-256: `7332c9f0e267835b79846ae9cd29784c5a05fdf4bd57ec3373423dd6399c374d`
- trace SHA-256: `8e30aa9b54840ba1f72a7b732038e72e205ca3edd675444c72cef1547854f4f4`
- internal-record SHA-256: `b7721337962f74d8bcdf638b03ce0259e73c1b2dcaab749b71b4d2a7bdb155ee`
- canonical record bytes: `1804`
- deterministic synthetic output: decimal `2.68 synthetic.point`

## Verification

Run focused tests without adding package scripts:

```text
npm exec vitest run src/engine/rule-input/rule-input.test.ts src/engine/analysis-orchestration/synthetic-vertical-slice.test.ts
npm exec eslint -- src/engine/rule-input src/engine/analysis-orchestration
npm exec tsc -- --noEmit
git diff --check
```

The focused suite covers canonical hashing, immutability, registry hashing and
uniqueness, preservation of every required input field, all fail-closed fact
states, stale/future/low-confidence facts, transformation controls, successful
internal execution, preparation/readiness/runtime rejection boundaries, no
partial trace, and byte-identical replay.
