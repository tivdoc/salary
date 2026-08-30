# Wave 3 W3 canonical case analysis

W3 implements one offline application route:

`stored provider-independent snapshots → existing Gate 0 and Canonical Facts → existing canonical RuleInput snapshot → seven topic projections → evaluateLegalReadiness → frozen catalog/executor ports → traces → AnalysisResultBundle → frozen report/review ports`

`CaseAnalysisService.runCaseAnalysis` is the sole service. `CaseAnalysisApplication` is the CLI/API/test dispatch and contains no competing decision logic. W1 and W2 are represented during worker isolation by fixture implementations of their frozen ports; final integration substitutes their merged implementations without changing the service path.

## Deterministic boundary

Commands pin document, extraction, and declared-fact IDs and SHA-256 values, period, `asOf`, topics, scope, mode, and idempotency key. The service reads stored normalized extraction snapshots, invokes the existing `validatePayslipGate0` and `resolvePayslipSnapshot`, then calls `createCanonicalRuleInputSnapshot`. Missing or conflicted critical facts stay missing/conflicted. Every topic publishes exactly one frozen outcome, and a blocked topic cannot erase unrelated calculated topics.

The catalog decision is not trusted opaquely: the service replays its embedded normalized input through the existing `evaluateLegalReadiness` function and requires the decision hash to match. Execution additionally requires exactly two pinned parameter attestations and a reviewed pinned RuleSpec. Only the `synthetic_test` fixture catalog can execute in this worker. Its values use ISO test currency `XTS`, identity-only traces, and carry no legal meaning. Real mode exposes seventeen opaque current-corpus source slots, returns all seven topics blocked, and produces zero execution, Finding, or approval.

The in-memory staged adapter is deliberately non-durable. It persists immutable hashes for:

1. input snapshot;
2. Canonical Facts;
3. RuleInputs;
4. catalog and dependency pins;
5. topic results;
6. report artifacts;
7. pending review.

An injected failure after any stage leaves no completed run or approval. Resume reuses matching stages, rejects changed stage bytes, creates no duplicate, and matches an uninterrupted result/report. Completed replay reads only the stored bundle and pinned dependencies; it does not reload extraction, resolve the current catalog, execute a rule, rebuild a report, consult current time, or fall forward. A missing pin returns `PINNED_VERSION_UNAVAILABLE`.

## Neutral fixtures

- `COMPLETE_THREE_PERIOD_FIXTURE`: three provider-independent synthetic payslip snapshots and seven confirmed topic projections.
- `PARTIAL_THREE_PERIOD_FIXTURE`: the same three periods with one explicit missing fact and one unresolved declared conflict.

No document bytes, customer identifiers, real legal values, operative rules, provider calls, OpenAI calls, external databases, migrations, deployment, delivery, or Shadow execution exist in these fixtures.

## Commands

Run the raw acceptance matrix:

```powershell
node scripts/full-system/verify-case-analysis.mts --output output/parallel-wave-3/workers/w3-case-analysis/acceptance-matrix.json
```

Run or inspect the complete fixture, render report metadata, record a fixture-only exact-hash review, replay, inspect partial coverage, or traverse the fail-closed real-catalog path:

```powershell
node scripts/full-system/case-analysis-demo.mts --action complete --output output/parallel-wave-3/workers/w3-case-analysis/demo-complete.json
node scripts/full-system/case-analysis-demo.mts --action inspect --output output/parallel-wave-3/workers/w3-case-analysis/demo-inspect.json
node scripts/full-system/case-analysis-demo.mts --action render --output output/parallel-wave-3/workers/w3-case-analysis/demo-render.json
node scripts/full-system/case-analysis-demo.mts --action review --output output/parallel-wave-3/workers/w3-case-analysis/demo-review.json
node scripts/full-system/case-analysis-demo.mts --action replay --output output/parallel-wave-3/workers/w3-case-analysis/demo-replay.json
node scripts/full-system/case-analysis-demo.mts --action partial --output output/parallel-wave-3/workers/w3-case-analysis/demo-partial.json
node scripts/full-system/case-analysis-demo.mts --action real --output output/parallel-wave-3/workers/w3-case-analysis/demo-real.json
```

Focused verification:

```powershell
npx vitest run src/server/engine/case-analysis/case-analysis.acceptance.test.ts --no-file-parallelism
npx eslint src/engine/case-analysis src/server/engine/case-analysis scripts/full-system
npx tsc --noEmit --pretty false
```

Generated outputs belong under `output/parallel-wave-3/workers/w3-case-analysis` and remain ignored. The final orchestrator must replace fixture W1/W2 ports, retain the same acceptance IDs, and verify the combined path. Production durability, migrations/RLS, legal review, real parameter/rule activation, Ground Truth, customer processing, delivery, OS parser sandboxing, and Shadow Mode remain blocked.
