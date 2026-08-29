# Wave 1 synthetic deterministic rule runtime

## Scope and safety boundary

`src/engine/rule-runtime` is an isolated execution kernel for synthetic fixtures only. The registry requires `runtime_kind: "synthetic_only"`; fixture identifiers and fact paths use the `synthetic.*` namespace. It contains no Israeli rule, entitlement, legal parameter, customer data, document/case access, LLM call, deployment hook, persistence hook, or Finding creation API. It does not activate or review any legal source.

The synthetic trace deliberately specializes the existing Calculation Trace contract: it reuses the existing rule reference, formula/version, calculation values, steps, output, engine version, and timestamp fields. Its input specialization replaces employment-specific fact paths with `synthetic.*` paths and adds provenance plus the frozen Wave 1 snapshot placeholder. This prevents a test fixture from masquerading as an operative employment calculation.

## Deterministic execution contract

- The versioned registry addresses definitions by the exact `rule_id@rule_version`, validates reference order, rejects duplicates, canonicalizes unordered metadata, hashes content, and deep-freezes entries.
- Decimal values are parsed into an integer coefficient and scale and are evaluated with `BigInt`. Money addition converts existing safe integer minor units to `BigInt`, checks currency identity, and rejects overflow before converting back. Runtime arithmetic never uses binary floating point.
- Rounding is a named policy (`half_even`, `half_up`, or `toward_zero`) and each round step records input/output scale, discarded digits, tie detection, and whether the retained coefficient was incremented.
- Inputs are sorted by stable ID before trace creation. Canonical JSON sorts object keys without locale APIs. The trace uses the request timestamp instead of the wall clock, and its SHA-256 is the frozen result hash. Replaying the same request is therefore independent of host timezone, locale, and supplied input order.
- Every input carries a synthetic fact path, fact ID, explicit fixture provenance, confidence in integer basis points, and an exact link to the request's snapshot placeholder.
- Missing, conflicted, unconfirmed, low-confidence, wrong-path, wrong-unit, wrong-currency, and snapshot-mismatched facts reject before evaluation.
- Every supplied legal reference is parsed through the frozen `LegalEvidenceRef` contract. Any reference that is not both reviewed and active is rejected. A definition may require exact source/version references. Wave 1 fixtures contain no reviewed or active reference; the success fixture is explicitly non-legal and has no legal dependency.
- Input count, step count, and decimal digit limits are deterministic resource ceilings. Cancellation is checked before execution and before each operation. A cancellation, policy rejection, resource rejection, or internal failure returns a frozen non-success result with `trace: null` and `output_hash: null`; no partial execution artifact is exposed.

## Verification

Run the focused suite directly (package wiring is reserved for the orchestrator):

```powershell
npx vitest run src/engine/rule-runtime/runtime.test.ts
```

The fixtures cover success, missing/conflicted/unconfirmed/low-confidence facts, explicit rounding, inactive and unreviewed evidence, absent required evidence, wrong versions, replay, canonical trace round-trip, cancellation, and resource ceilings. Money primitives use ISO testing code `XTS` and do not represent wages or an operative amount.
