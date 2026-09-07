# Release decisions

- D-001 (2026-09-07, owner execution plan §3): select up to three initial topics in minimum wage, working time, pension, travel, convalescence, vacation, sick leave order. Supersedes older selection by signal strength. Selection cannot depend on the amount of a prospective finding.
- D-002 (owner execution plan §§3–4): request expiry resumes the clock and triggers partial-service/operations assessment; never fabricates a successful report. Supersedes v1.1 D-9.2. AI research is labelled AI; no human signature/attestation is created.
- D-003 (parallel work safety): use a separate existing worktree for integration, preserve PR #1 once, merge website commits when available. The current main-site checkout is not a safe integration base: its base is old and contains ongoing changes.
- D-004 (environment isolation): P00 replay uses new database `tivdoc_release_replay_20260907` in the existing allowlisted DEV project. A private credential copy outside Git points only at that database; shared credentials stay unchanged. This proves SQL replay, not hosted PostgREST or production readiness.

- D-005: preserve original pinned migration hashes. Host tests now call the same LF-aware digest routine already used by the migration verifier; semantic SQL comparisons normalize only in memory. Original worker commits were found and fetched from the engineering archive; audit tests still require exact commits and patch/blob equivalence. Missing objects are an explicit precondition, not a substituted expected value.
- D-006: release Preview branch variables override inherited production Supabase credentials with the allowlisted DEV project. No global Preview or Production variable is changed; hosted mutations wait for schema compatibility.

- D-007 (P04, AI source inspection): convalescence gazette page is 9132, not 9134. Correct citation only; retain human gate and historical opinion bytes.
- D-008 (P04): travel uses actual relevant discounted cost and attendance, bounded by daily cap/monthly pass; missing price cannot become entitlement at cap. New inactive RuleSpec, seven-topic AI worksheet.
- D-009 (P04): ordinary sick pay uses actual wage as a fact; first-day zero is an explicit AI legal interpretation for the ordinary branch only, exceptions require applicability. Historical sensitivity spec preserved.
- D-010 (P04): latest owner authorization permits AI-authored expected worksheets; they are separate from the human golden ledger and never activate it. 42 values authored before executing tests.


D-011 / P06: SLA human service hours are Sunday–Thursday 09:00–17:00 Asia/Jerusalem, with national/Jewish holiday dates from the [official CSC 2026 calendar, pp.2–3](https://www.gov.il/BlobFolder/policy/calendar_2026/he/calendar_2026.pdf). This is a Tivdoc service policy, not an interpretation of civil-service employee rights; its special agreement days and shortened hours are not copied. Automatic SLA counts elapsed time. Blocking intervals are unioned before subtraction. Unknown calendar years explicitly refuse an SLA calculation. Order-bound persisted SLA clocks remain to be connected with P09.

D-012 / P06: expired document requests remain terminal. An already reserved upload may still save its documents after request expiry, without answering a newer request or rejecting otherwise valid uploaded files. Correction of a submitted text/choice/number is a new answer revision; the original row is retained. Drafts do not invalidate analysis; submitted corrections do.
