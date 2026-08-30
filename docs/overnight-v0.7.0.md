# Overnight engineering program V0.7.0

The execution contract is `src/engine/wave4/execution-contract.v0.7.0.json`.
It freezes canonical call paths, server-only default-off flags, lane ownership,
dependencies, acceptance IDs, and prohibited-action counters for this wave.

Preflight at required base `6b49158017457af5a7c8b13efe361353bbdf2c6c`
confirmed tree `cebbfb451bb6d0e3e3ef60b637c29c42bc3a2c3f`, the declared branch, and a
clean working tree. Docker, Supabase CLI, and PostgreSQL CLI were unavailable;
no database host or credentials were inspected. Playwright CLI and Poppler are
available for local synthetic browser and PDF verification.

The V0.6 contracts are adapter and review boundary records: they import and
reuse canonical Facts, Money, RuleInput, readiness, trace, report and review
models. The canonical service graph remains `CaseAnalysisService`,
`evaluateLegalReadiness`, `CanonicalRuleSpecExecutor`, and
`DeterministicReportBuilder`. Synthetic ready catalogs remain test-only and are
guarded by the existing production-reachability verifier.

Dynamic database, RLS, transaction, migration and backup claims are prohibited
until a verified disposable local target exists. Static contracts, migration
files, local adapters and fail-closed receipts remain required.
