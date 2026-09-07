# Release decisions

- D-001 (2026-09-07, owner execution plan §3): select up to three initial topics in minimum wage, working time, pension, travel, convalescence, vacation, sick leave order. Supersedes older selection by signal strength. Selection cannot depend on the amount of a prospective finding.
- D-002 (owner execution plan §§3–4): request expiry resumes the clock and triggers partial-service/operations assessment; never fabricates a successful report. Supersedes v1.1 D-9.2. AI research is labelled AI; no human signature/attestation is created.
- D-003 (parallel work safety): use a separate existing worktree for integration, preserve PR #1 once, merge website commits when available. The current main-site checkout is not a safe integration base: its base is old and contains ongoing changes.
- D-004 (environment isolation): P00 replay uses new database `tivdoc_release_replay_20260907` in the existing allowlisted DEV project. A private credential copy outside Git points only at that database; shared credentials stay unchanged. This proves SQL replay, not hosted PostgREST or production readiness.

- D-005: preserve original pinned migration hashes. Host tests now call the same LF-aware digest routine already used by the migration verifier; semantic SQL comparisons normalize only in memory. Original worker commits were found and fetched from the engineering archive; audit tests still require exact commits and patch/blob equivalence. Missing objects are an explicit precondition, not a substituted expected value.
- D-006: release Preview branch variables override inherited production Supabase credentials with the allowlisted DEV project. No global Preview or Production variable is changed; hosted mutations wait for schema compatibility.
