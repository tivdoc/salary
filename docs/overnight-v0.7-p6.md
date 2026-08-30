# V0.7 P6 customer portal, clarification, entitlement and privacy

## Result

Lane P6 is implemented as a default-off, synthetic-only customer portal boundary. The service and API factory are locally verified. The actual Next page and route return a non-disclosing `404` until the P2 server identity and private-storage adapters are integrated and proven. No live customer data, invitation delivery, payment provider, analytics, legal computation, Shadow run or production delivery is used.

Local status: `LOCALLY_VERIFIED_DEFAULT_OFF`.

## Contract and scope

- Contract base: `5373447e6cb18ab9e73a58fede18b96d573f584a`.
- Frozen shared ports consumed without modification: `src/engine/wave4/contracts.ts`.
- Canonical types consumed without replacement: `VerifiedActor`, `ServerFeatureFlagPort`, `CaseLifecycleState`, `FactPath`.
- Feature flag: `TIVDOC_CUSTOMER_PORTAL_ENABLED`, checked server-side and default false at the real route.
- Synthetic repository construction with mode `production` is rejected.
- No package, lockfile, shared export, shared configuration, existing funnel, price, questionnaire or analytics file is changed.

## Implemented capabilities

### Owner-only customer projection

`CustomerPortalService` verifies the server actor, `customer_owner` role, actor ID, tenant ID and assigned case ID at the data boundary. Failures use the same `PORTAL_NOT_FOUND` result. The projection excludes owner and tenant identifiers, converts lifecycle states to coarse Hebrew customer-safe states, normalizes internal blockers and exposes document references without document bytes.

### Synthetic invitation and upload contracts

The synthetic repository hashes invitation tokens, binds audience, owner and case, checks expiry, and rejects replay. It never delivers an email, message or notification. Upload reservation accepts only a known owner document, exact expected SHA-256, byte length, a small MIME allowlist and a future expiry. It stores no uploaded customer bytes and is not a replacement for the P2 private object-storage adapter.

### Deterministic clarifications

Questions are derived only from canonical missing or conflicted `FactPath` states, frozen legal-input requirements, or an assigned human operations request. The task hash binds case, FactPath, origin, prompt, dependency hash, conflict IDs and question version. Changed dependencies invalidate the prior task and advance the version.

Answers are `declared` candidates. They bind the exact question ID and version, consent and terms versions, explicit confirmation, answer revision and documented conflict IDs. They require human review and do not overwrite documented facts. A changed answer appends an invalidated report revision and clears its release receipt. No autonomous chatbot, legal interpretation or arithmetic exists.

### Verified entitlements and released artifacts

The only entitlement input is an owner-bound `VerifiedProductEvidence` record from a verified server source. Revoked, refunded or chargeback evidence denies entitlement. The API rejects unexpected client fields, including amount and product flags.

`screening_summary` can expose only released verified scope and safe blockers. Its Hebrew wording explicitly says that it is limited, is not a complete calculation, and does not establish absence of entitlement. `full_reviewed_report` additionally requires complete coverage and no blockers.

Report access binds the current released report revision, edition entitlement, report hash, artifact SHA-256, object version and non-null release receipt. A grant expires after five minutes. Download rechecks owner scope, entitlement, current release state, grant hash, expiry, object version and artifact hash. The filename is derived from an opaque hash. Delivery remains disabled.

### Consent, privacy and audit

Consent and privacy commands are append-only, revisioned and idempotent. Reusing an idempotency key with a different command fails. Export, correction and deletion requests are recorded for authorized operations; external deletion is not performed. Deletion under legal hold becomes `restricted_by_legal_hold`. Audit receipts contain only safe identifiers, action codes and hashes in a SHA-256 chain.

### Hebrew RTL surface

The server-compatible component covers no-case, loading, error, awaiting payment, awaiting documents, review, clarification, blocked, released-report and hold language. It uses one `h1`, semantic landmarks, labelled navigation, a skip link, live status regions, system dark mode, visible focus, mobile collapse and reduced-motion handling.

Design read: regulated customer service with a calm, trust-first, accessibility-first language. The chosen dials were `DESIGN_VARIANCE 3`, `MOTION_INTENSITY 2`, `VISUAL_DENSITY 5`. Local CSS modules were used with no new dependency. Motion was intentionally limited to interaction feedback. No marketing imagery or decorative application preview was introduced because this is a private product surface, not a landing page.

## Next.js guides read before Next edits

The following bundled Next 16.3.2 guides were read in full before editing `src/app`:

- `node_modules/next/dist/docs/01-app/01-getting-started/02-project-structure.md`
- `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`
- `node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md`
- `node_modules/next/dist/docs/01-app/01-getting-started/11-css.md`
- `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
- `node_modules/next/dist/docs/01-app/02-guides/authentication.md`
- `node_modules/next/dist/docs/03-architecture/accessibility.md`
- `node_modules/next/dist/docs/01-app/02-guides/testing/vitest.md`

The implementation follows Promise-based route params, Web `Request` and `Response`, authorization close to the data boundary, server-only feature gating, CSS modules, and synchronous server-component unit rendering.

## API integration contract

`createPortalApi(service, identity)` is the tested API factory. The P2 integration must supply a `PortalRequestIdentityPort` that verifies a server session and CSRF without constructing an actor from request headers or body fields. It must supply the production feature-flag port and a real repository adapter over proven P1 transactions and P2 private storage. The actual route must remain the current empty `404` until those adapters are integrated and the authorization tests pass in the integrated tree.

Required integrated checks before enabling:

1. P2 server identity verifies `VerifiedActor` and CSRF.
2. P2 private storage enforces owner-scoped access, hash, size, MIME, quarantine and object version.
3. Verified product evidence is supplied from the authoritative server source with no client amount or flag.
4. Released report records and immutable object bytes are transactionally consistent.
5. Browser tests cover two owners, invite replay, expiry, forgery, CSRF, upload, clarification invalidation, blocked screening, unreleased reports and short-lived download.
6. Production confirms zero synthetic adapter or fixture loading.

## Verification

Focused tests:

```text
npx vitest run src/server/product/customer-portal src/components/portal-v07/portal-shell.test.ts --reporter=verbose
23 passed, 0 failed
```

Deterministic verifier:

```text
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/tivdoc-portal/verify.mts
overall: LOCALLY_VERIFIED_DEFAULT_OFF
V07-P6-PORTAL: pass
V07-P6-CLARIFICATION: pass
V07-P6-ENTITLEMENT: pass
V07-P6-PRIVACY: pass
outside_allowlist: 0
```

TypeScript and lint commands:

```text
npx tsc --noEmit --pretty false
npx eslint src/server/product/customer-portal src/app/portal-v07 src/app/api/portal-v07 src/components/portal-v07 scripts/tivdoc-portal
```

The verifier runs the focused suite, checks the allowlist, hashes the implementation sources, verifies the static default-off boundary and emits JSON to stdout. It does not write tracked or runtime evidence.

## Boundaries and blockers

Verified zero counts:

- Real customer reads: 0
- Production or preview connections: 0
- Live payment calls: 0
- Invitation or report delivery calls: 0
- OpenAI calls: 0
- Customer Shadow runs: 0
- Legal values or rules invented: 0
- Automatic report releases: 0

Open blockers:

- `P2_SERVER_IDENTITY_ADAPTER_NOT_INTEGRATED`
- `P2_PRIVATE_STORAGE_ADAPTER_NOT_INTEGRATED`
- `CUSTOMER_DATA_READ_AUTHORIZATION_NOT_PROVEN`
- `BROWSER_E2E_AND_VISUAL_VERIFICATION_DEFERRED_TO_P8`
- `PRODUCTION_DELIVERY_DISABLED`

These blockers are expected dependency gaps. They keep the customer page and API non-disclosing and disabled. They do not weaken the locally verified synthetic contracts.
