# Document review SQL boundary review

Migration `20260911144617_document_review_identified_completions.sql` adds five SECURITY DEFINER definitions. This is a technical source review, not a human approval or legal attestation.

| Definition | Reason for privilege boundary | Scope and refusal |
| --- | --- | --- |
| private.document_review_request_current | Internal access to private targets and paid entitlement | Exact case, month, purchased topics, order hash and current document version/hash; no runtime EXECUTE grant |
| private.document_review_request_open | Worker creates a request from a persisted analysis stage | Actual worker principal and verified machine tenant; locked current source revision and dispatch dependency; same canonical run, input hash, stage/result/target hash, purchased scope and full source manifest |
| private.guard_document_review_request | Protect existing answer tables across web/worker writers | Immutable target and original answer; linked identity, current source, expiry and strict typed answer; source upload cannot masquerade as a numeric declaration |
| public.case_request_review_states | Existing web adapter reads only owned question state | Explicit linked case identity, no anonymous/authenticated execute; target is retained server-side and omitted from customer API response |
| private.document_review_answer_history | Worker reads immutable identified answers | Actual worker principal and verified tenant; exact hashed input journal, request target, revision, identity, text and timestamp; no later answer injected into an earlier revision |

All five pin an empty search_path. Target records are append-only, RLS-enabled and have no direct write grant to any runtime, service_role, anon or authenticated. Helper functions for question formatting and answer parsing are SECURITY INVOKER with EXECUTE revoked from runtime roles. Existing current-source guards and answer journals remain in force.

The upgrade passed a rolled-back preflight and was applied only to isolated `tivdoc_release_replay_20260907` (DEV project `cpzrbidxftzqcfeqqusu`) on 2026-09-11. Actual ACL probes deny direct target insertion to all listed runtime roles; only the worker may call open/history. The definer inventory increases from 314 to 319 with exact-name assertions, retaining the global empty-search-path and surface-count checks. Dynamic path evidence is recorded separately in the package handoff.

No Production schema, customer notification, payment or authority record is changed by this package.
