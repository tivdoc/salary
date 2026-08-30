# Overnight V0.7 P4 — legal quality, extraction Ground Truth and offline Shadow

## Status and boundary

This lane implements only deterministic, offline engineering mechanics. It does not add legal values, formulas, interpretations, approvals, active real rules, customer material, network access, external persistence, Findings, reports, delivery or promotion. The real catalog remains inactive and every real-catalog Shadow slot is `blocked_legal_readiness`.

The lane consumes the canonical FactPath, topic, hashing, RuleSpec value, Ground Truth workflow and locked-manifest contracts without modifying them. The Shadow evaluator is an injected port so later integration can adapt the canonical engine without creating a second truth system.

## Acceptance inventory

- `V07-P4-RULESPEC`: seven versioned, non-operative human-authoring skeletons. Each exposes canonical FactPaths and placeholder slots only. The activation linter rejects unresolved placeholders, legal numeric literals, missing citation/approval evidence, arbitrary code/eval/callback/dynamic import shapes, cycles, depth/operation bounds, unsafe units, undeclared Facts, unapproved dependencies and unproven Money/rational bounds. Activation and execution are always denied.
- `V07-P4-GOLDEN`: exactly 42 legally blank templates: six scenarios for each of seven topics. Templates bind blank input/source/RuleSpec/parameter/period/expected/reviewer fields to a canonical hash, cannot be approved, and support strict idempotent append-only import, dependency invalidation and deterministic version diff.
- `V07-P4-GT`: a deterministic synthetic offline workspace reuses the canonical dual-annotation, disagreement, human adjudication and locked Ground Truth state machine. Document/page/section and workspace seals, evidence geometry, actor separation and immutable locked history are enforced. The extended evaluator distinguishes value, absent, null, conflict and error outcomes and emits typed tolerances, critical/Money/hours/pay-period metrics, layout/document slices, conflict metrics, agreement, calibration inputs and baseline regression.
- `V07-P4-SHADOW`: a server-only, default-off, offline control plane accepts only deterministic synthetic, approved public non-identifying or explicitly sealed non-customer engineering bundles. It provides immutable version-pinned definitions, deterministic batch scheduling, revision-guarded retry/cancel/resume, command and per-case idempotency, seven topic slots, stage status, comparison taxonomy, aggregate zero-output metrics, reviewer handoff hashes, replay and an append-only audit hash chain. Production fixture enablement hard-fails.

## Deterministic commands

No `package.json` command was added because the execution contract reserves it for the orchestrator. The equivalent lane commands are:

```text
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/legal-quality/run.mts all
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/extraction-ground-truth-v07/run.mts all
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/shadow/run.mts all
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/shadow/run.mts synthetic
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/shadow/run.mts real-blocked
```

Focused verification:

```text
npx vitest run src/engine/legal-quality src/engine/extraction-ground-truth/overnight-v07 src/server/engine/shadow --reporter=verbose --maxWorkers=1
npx eslint src/engine/legal-quality src/engine/extraction-ground-truth/overnight-v07 src/server/engine/shadow scripts/legal-quality scripts/extraction-ground-truth-v07 scripts/shadow
npx tsc --noEmit --pretty false
git diff --check
```

## Ignored evidence

All generated artifacts are canonical JSON plus a trailing newline and have byte SHA-256 receipts. They remain ignored under:

- `output/overnight-v0.7/p4/legal-quality/`: seven skeletons, 42 blank templates and manifest.
- `output/overnight-v0.7/p4/ground-truth/`: sealed synthetic workspace, evaluation, provenance inventory and manifest.
- `output/overnight-v0.7/p4/shadow/`: synthetic seven-slot run, real blocked seven-slot run and manifest.

## Residual blockers

- `RULE_LEGAL_APPROVAL_REQUIRED`
- `HUMAN_LEGAL_SOURCE_REVIEW_REQUIRED`
- `NUMERIC_DUAL_ATTESTATION_REQUIRED`
- `HUMAN_GROUND_TRUTH_REQUIRED`
- `LEGAL_SOURCE_CORPUS_INCOMPLETE`
- `REAL_RULES_INACTIVE`
- `SHADOW_PROMOTION_THRESHOLDS_UNSET`
- `CUSTOMER_SHADOW_NOT_AUTHORIZED`

```text
REAL_LEGAL_TOPICS_READY: 0/7
REAL_SOURCES_ACTIVE: 0
REAL_PARAMETERS_ACTIVE: 0
REAL_RULES_ACTIVE: 0
REAL_CALCULATIONS_OR_FINDINGS: 0
ISOLATED_PERSISTENCE_VERIFIED: NO
OFFLINE_SHADOW_ENGINEERING_COMPLETE: YES
CUSTOMER_SHADOW_AUTHORIZED: NO
CUSTOMER_PROCESSING_ENABLED: NO
PRODUCTION_DELIVERY_ENABLED: NO
```
