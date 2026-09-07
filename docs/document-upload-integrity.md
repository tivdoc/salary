# Document upload integrity — 2026-09-07

## Base and scope

- Repository: `tivdoc/salary`; PR base: `claude/v0-10-2b-full-parallel`.
- Remote was fetched before editing and still pointed to reviewed `5285bc56346c6ee317b82afc7e3e0a8084a3d99c`.
- Preserved the later local handoff commit `06ee5f1` from the existing engineering checkout. Work started on that commit in an isolated worktree, branch `codex/document-upload-integrity`. Existing checkouts and their untracked files were left alone.
- Read `AGENTS.md`, `HANDOFF.md`, and the relevant S2/resume/product-state history. This authorized defect correction supersedes the historical assertion that no engineering remains before activation. It does not activate the product or change any production gate.
- No repository-wide line-ending conversion. No production customer data used.

## Reproduction before the fix

An isolated test invoked the original completion route with a saved first payslip and contract, then a manifest containing only a second payslip. The test failed: Storage `remove` was called with both previous paths (`cases/test/payslip-01.pdf` and `cases/test/contract.pdf`) although the corresponding database rows remained. This was reproduced before replacing the route. The new service, database and HTTP proofs exercise preservation of both documents.

## Protocol and implementation

The server renders an authoritative case snapshot, including current document/version IDs and open document requests. The form separates saved files, additions and explicit replacements. Clients send a stable batch UUID and immutable manifest, never a slot or object path. Session storage retains only the batch UUID, scoped to the case; after a reload the user can finish that exact attempt or cancel it. A partially transferred attempt can be retried with the original files in the same tab, or cancelled and selected again after reload.

Reservation serializes on the case row and accounts for saved documents plus every live reservation. It enforces 12 payslips, one contract, one attendance report, 10 MiB per file and 25 MiB active/pending bytes per case. Replacement reserves the positive size increase and checks both target document and expected version. Simultaneous replacements cannot silently win over each other. Distinct additions reserve distinct slots.

Each file receives a new UUID version path. Storage signatures explicitly disable upsert. Retries inspect actual object existence and skip a completed PUT; an existing object cannot be overwritten with a replayed token, even by adding `x-upsert: true`. Complete resolves files from the reserved manifest, downloads private objects, checks actual size, MIME, file signature and SHA-256, and then calls one database transaction. These checks validate transfer integrity and supported signatures, not document semantics.

Publication archives the previous version and swaps only the selected document, or inserts only the reserved addition. Case/request/batch/document changes commit together. No upload endpoint deletes objects. A failed validation or transaction leaves the former version reachable. Completed-batch retries return current state; cancellation, including a tombstone before a delayed sign request, prevents later publication.

Late completion requires a payslip across the whole case, not the current upload. Only the explicitly selected compatible request is answered. Paid and advanced case states retain their payment/status rules; unpaid awaiting-document cases can resume the funnel. Paid cases return to their documents, without restarting payment. The initial check month remains locked after payment.

Every HTTP stage validates the signed case cookie and matches it to the rendered case ID. Database functions verify contact state and ownership of batches, replacement targets and requests. SQL functions are invoker-only and executable only by trusted server roles, not anonymous/authenticated browser roles.

Integration fixes discovered by real verification:

- The canonical migration had imposed an unconditional engine identity FK on product documents. Generated ownership columns now preserve separate product-case and engine-identity FKs. Narrow runtime column grants and the product-row policy allow funnel uploads while retaining canonical ownership restrictions; the DB proof checks those restrictions.
- Explicit isolated local runtime configuration keeps SQL on the DEV replay database even when private Storage credentials are present. Supabase RPC errors retain only allowlisted `UPLOAD_*` codes.
- CSP permits the configured Supabase origin for direct uploads. It does not permit arbitrary origins.
- PostgreSQL Date values render as `YYYY-MM` in the case document list.
- Scoped component CSS supplies missing card/file-picker styles and keeps saved-document/replacement controls usable on narrow screens.

## Verification and limits

All live fixtures were synthetic, with random case IDs and synthetic PDFs. The DEV target is the existing allowlisted project `cpzrbidxftzqcfeqqusu`, replay database `tivdoc_v09_devruntime01`; it is not the dashboard's default `postgres` database.

| Verification | Result |
| --- | --- |
| Focused Vitest: upload schema/form/transfer/service/routes, snapshot page, access adapters, dates, request rules, upload-session ownership, migration expectations | 13 files, 66 tests passed |
| `npx tsc --noEmit` | Passed |
| `npm run lint` | Passed |
| `npm run build` with the DEV Supabase public origin | Passed; production build includes TypeScript validation |
| Actual PostgreSQL, disposable schema, real migration functions and two web-role connections | 16 checks passed |
| Local production Next build + actual private DEV Storage + actual replay DB | 11 HTTP checks passed |
| Chromium UI, local dev server + same real services | Add payslip, return with persisted files, explicit replacement, injected completion 503, reload and retry without File objects all passed |
| Chromium UI, local production build + same real services | Persisted files rendered; contract-only replacement changed one of six documents and returned to the paid case; no JavaScript errors (existing font preload warnings) |
| Final CSS, production build, Chromium at 390px and 1280px | Saved-document controls and file pickers rendered correctly; mobile content width equals viewport (390px); injected sign 503 followed by cancellation and reload retained all six documents and cleared the pending attempt |

The DB checks cover addition preservation; sign/commit retry; failed and stale replacement; parallel additions and competing replacements; contract-only request completion and payment preservation; cross-case batch/target/request rejection; unverified contact; aggregate pending-byte quota; count/type/file-size limits; expiry and cancellation; transactional rollback after writes; browser-role execute denial; canonical RLS/FK preservation; unpaid requested-payslip resumption.

The HTTP proof exercises real signed PUTs, downloaded bytes, retained prior objects, replay overwrite and path spoof rejection, idempotency, lost PUT-response recovery, cross-case cookie/batch mismatch, incomplete transfer failure, contract-only completion, parallel publication and server-rendered persisted state. The browser additionally proves the actual file picker, navigation and reload recovery, rather than only calling handlers directly. Intentional injected 503 responses are test failures, not unexplained runtime errors. Synthetic case, identity and private-object fixtures were removed after verification.

The full test run was **not green**: initially 2,358 passed, 9 failed, 23 skipped (327 files). Two outdated assertions about the old protocol/latest migration were corrected and pass in the focused run. The other seven failures were rerun unchanged on base `06ee5f1` in a second clean worktree: 7 failed, 15 passed across six files. They are:

1. `scripts/canonical-persistence-v091/foundation/trusted-git.test.mjs`: assumes a physical `.git` directory, not a worktree pointer.
2. `src/server/platform/capabilities/route-split.test.ts` (two): compares with the checkout's old local `main`, yielding an existing resume route and status-route diff outside its expected budget.
3. `src/engine/wave2/evidence-audit/git-audit.test.ts`: missing historical worker object `aa1697c772c7fc3379a9bdb4edfae92c00b4303b`.
4. `src/server/system-marathon/governance-owner-schema-usage-repair.test.ts`: baseline file hash differs with Windows line endings.
5. `src/server/system-marathon/runtime-canonical-helper-acl-repair.test.ts`: baseline file hash differs with Windows line endings.
6. `src/server/product/dependency-invalidation/postgres-migration.test.ts`: baseline exact multiline grant assertion differs with Windows line endings.

The full suite was not rerun after fixing its two changed assertions; the final focused run includes both. Unrelated history, main refs and line endings were not rewritten to make those seven baseline failures pass.

## Repeating live proofs

Use the existing allowlisted DEV credentials and CLI login, never a constructed/default connection URL. The first command creates and drops a random disposable schema. For the second, the checked-in migration must already be applied to the isolated DEV replay database, and `salary-documents` must be a private bucket. It starts its own loopback server and deletes its own random fixtures/objects in `finally`.

```powershell
node --experimental-strip-types scripts/dev-runtime/document-upload-proof.mts
$env:NEXT_PUBLIC_SUPABASE_URL='https://cpzrbidxftzqcfeqqusu.supabase.co'
npm run build
node --experimental-strip-types scripts/dev-runtime/document-upload-live-proof.mts --production
```

Add `--hold` only for browser verification. It writes temporary synthetic cookie state under `../upload-verification`, waits up to 30 minutes and cleans up after a `STOP` file. Do not publish cookie state or credential files. The proof intentionally uses closed preview route guards and does not enable durable product activation.

## Deployment and remaining dependencies

Migration `20260907040711_document_upload_integrity.sql` was applied only to the isolated DEV replay database. Its LF-normalized SHA-256 is `b3697d93b147a11c421b40c6a4b50edab2260b0ae814c7f4784ee90dee568bd0`. All five installed function bodies were compared with the file and matched; direct catalog inspection confirmed invoker mode, denied browser execution and forced RLS on the two new tables. The Supabase MCP migration/advisor endpoints lacked permission; the existing guarded pg/CLI access provided the verification instead. No claim of a successful MCP advisor scan is made. This replay database does not use `supabase_migrations` history; do not mistake it for production deployment history.

No production application deployment or production migration was performed. No merge or product activation was performed. Production/default-PostgREST integration remains a deployment validation step; the live SQL proof used the actual isolated runtime adapter, and Supabase adapter behavior is covered locally.

Before a coordinated production cutover, stop issuance from the old destructive upload endpoints and let outstanding legacy upsert tokens expire (the SDK's signed upload token lifetime is two hours). Apply the reviewed migration and ship the API/UI protocol together. Old payloads fail closed under the new routes. Do not roll the application back to the destructive legacy completion route after accepting new uploads. Validate production policies and existing-row FK compatibility before applying; DEV coverage does not prove every production row is compatible.

Superseded versions and abandoned objects are deliberately retained. Active/pending document quota is enforced, but retained history is not charged against that quota. An auditable retention/garbage-collection policy remains separate work; it must account for live tokens, outstanding batches and all database references. There is no unsafe opportunistic cleanup in this change.
