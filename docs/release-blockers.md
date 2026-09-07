# Release blockers and verification gaps

| ID | Step / environment | Evidence, attempted diagnosis | Completed / remaining / resume condition | Independent continuation |
|---|---|---|---|---|
| B-001 RESOLVED | P00 replay role postconditions / isolated DEV | All 75 files applied (73 unchanged, 2 documented managed-platform compensations). Historical runner expects NOLOGIN for all runtime roles; existing DEV runtime credentials intentionally use LOGIN. No role/password altered to satisfy a test. | Independent catalog comparison verified all four runtime login roles have no elevated attributes; governance owner remains NOLOGIN. Existing dev-credential.mts deliberately provisions login. No role changed. | P01 host-test repairs |
| B-002 | P01 hosted adapter / Preview | Existing upload proof used direct pg on isolated replay plus real Storage. Automatic Vercel preview alone is not PostgREST evidence. | Inspect test deployment env names/target and configure an isolated deployment path or record exact access failure; never redirect to customer DB. | P02 report safety |
| B-003 | P11 parallel UI work | `website tivdoc dev` is actively editing `codex/website-v1-3`, based on older main. | Website commit/PR needed for safe merge; no source files copied mid-edit. | Product contracts/backend |

Missing documents and legal/provider gaps will be added only after inspecting their actual dependencies. Do not treat a historical lack of access as a new proven blocker.
