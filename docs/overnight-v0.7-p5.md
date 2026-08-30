# Tivdoc V0.7 P5 — default-off internal operations adapter

## Status

`INTERNAL_OPS_DEFAULT_OFF` and `LEGAL_SOURCE_CORPUS_INCOMPLETE` remain in force. This lane adds a guarded internal adapter and does not add a second case lifecycle, readiness evaluator, calculation engine, report builder, persistence system, authentication system, or audit truth.

The actual P1 persistence and P2 identity/security implementations are integration dependencies. Until their frozen consumer ports are installed, an explicitly enabled API responds with the safe problem code `OPS_BACKEND_UNAVAILABLE`; the default response is an empty, non-disclosing 404.

## Next.js guidance read before implementation

The implementation was written after reading the repository-installed Next.js 16.3.2 guides:

- `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md`
- `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`
- `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
- `node_modules/next/dist/docs/01-app/02-guides/data-security.md`
- `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/robots.md`
- `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`

The route uses promised catch-all parameters, standard Request/Response APIs, `force-dynamic`, explicit no-store/noindex headers, server-only service modules, strict client inputs and minimal projections. The UI is a narrow client boundary and never receives server environment variables.

## Server-only flags

All flags default to false and accept only the exact strings `true` or `1`:

1. `TIVDOC_INTERNAL_OPS_UI_ENABLED`
2. `TIVDOC_INTERNAL_OPS_API_ENABLED`
3. `TIVDOC_SYNTHETIC_OPS_ENABLED`
4. `TIVDOC_PUBLIC_FIXTURE_OPS_ENABLED`
5. `TIVDOC_MANUAL_REPORT_EXPORT_ENABLED`
6. `TIVDOC_CUSTOMER_PROCESSING_ENABLED`
7. `TIVDOC_CUSTOMER_SHADOW_ENABLED`
8. `TIVDOC_PRODUCTION_DELIVERY_ENABLED`

The last flag is projected as false regardless of environment because this lane contains no delivery operation. Enabling either synthetic or public fixture operations in `NODE_ENV=production` throws `OPS_PRODUCTION_FIXTURE_FORBIDDEN` before a fixture can load.

## Frozen integration ports

`InternalOpsIdentityPort` consumes P2 server-verified identity and authorization. `InternalOpsProjectionPort` consumes minimal P1/P2 projections from canonical case, payment, document, extraction, fact, readiness, analysis, report and audit services. `InternalOpsCommandPort` is the P1 atomic command boundary for revision and idempotency enforcement.

The P5 service also enforces role, case assignment or valid break-glass scope, reason, command ID, expected revision, and idempotency key before delegation. This is defense in depth; the installed P1/P2 adapters remain responsible for atomic authorization and mutation. `installInternalOpsPorts` is a one-shot integration seam.

Canonical readiness in the synthetic acceptance fixture is produced only by `evaluateLegalReadiness`. Real-data-shaped fixture requests pass no operative candidates and remain blocked. No legal value, Israeli entitlement parameter, RuleSpec, customer document, OCR content, salary value, external request or delivery is present.

## API surface

Reads:

- `GET /api/internal-ops-v07/capabilities`
- `GET /api/internal-ops-v07/queue`
- `GET /api/internal-ops-v07/cases/:caseId`
- `GET /api/internal-ops-v07/cases/:caseId/{timeline,payment,documents,extraction,facts,readiness,analysis,report,audit}`

Mutations:

- `POST /api/internal-ops-v07/cases`
- `POST /api/internal-ops-v07/cases/:caseId/payment/reconcile`
- `POST /api/internal-ops-v07/cases/:caseId/documents`
- `POST /api/internal-ops-v07/cases/:caseId/extraction/review`
- `POST /api/internal-ops-v07/cases/:caseId/facts/resolve`
- `POST /api/internal-ops-v07/cases/:caseId/analysis/{request,resume,replay}`
- `POST /api/internal-ops-v07/cases/:caseId/report/{submit,approve,reject,export}`

Every mutation has a strict versioned JSON contract, command ID, idempotency key, expected revision, reason, and server-injected trusted actor. The adapter rejects unknown keys. Report approval is bound to the current report revision, report SHA-256 and analysis-result SHA-256. Export additionally requires the current detached approval-receipt SHA-256, explicit local download destination, and the manual-export flag.

After the atomic export command succeeds, the port returns the already approved canonical artifact bytes. The route streams them with no-store, artifact-hash, correlation and format headers and no server-supplied filename or path. The browser creates a fixed local filename and immediately revokes its object URL. No delivery destination or asynchronous delivery path exists.

There are no delivery, force-ready, payment-marking, amount override, conflict-ignore or legal-rule activation operations. The problem envelope contains only a stable code, correlation ID, retryability and schema version. It never returns a stack, SQL text, secret, object path, filename, raw OCR, salary field or report body.

## Role and scope policy

- Intake operator: case creation, payment reconciliation and opaque document references.
- Extraction reviewer: extraction decisions.
- Fact reviewer: fact-resolution decisions.
- Legal reviewer: canonical analysis request/resume/replay and report submission.
- Report approver: exact-hash approval/rejection and, when separately enabled, local manual export.
- Auditor: audit projections and replay inspection, without mutation authority.
- Scoped background worker: analysis request/resume/replay only.
- Break-glass administrator: only with a verified reason and unexpired server-side expiry.
- Anonymous and customer-owner roles: no internal-ops capabilities.

All non-create case operations require the case to be in `assigned_case_ids`, unless P2 provided a valid break-glass actor. P2 authorization is called after the static role/scope check for every read and mutation.

## UI and safety semantics

`/internal-ops-v07` is Hebrew, RTL, responsive and keyboard-addressable. It contains queue, Overview, Payment, Documents, Extraction, Facts, Legal, Analysis, Report and Audit views. Seven readiness cards always exist. `BLOCKED_NOT_READY`, `NOT_APPLICABLE`, missing and zero remain distinct. Blocked cards must contain blocker codes. The report panel carries an internal-draft watermark and has no delivery control. Mutation controls remain disabled until both a selected case and the required capability are present.

The UI metadata and API headers are noindex/nofollow/noarchive and no-store. Rendering uses React text nodes only. Identifiers are opaque, path traversal segments are denied, document payloads accept no filename, and raw content is absent from all projection contracts.

## Verification commands

Package aliases are orchestrator-owned and intentionally were not added in P5. Equivalent offline commands are:

```text
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/tivdoc-ops/run.mts contract
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/tivdoc-ops/run.mts api
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/tivdoc-ops/run.mts ui
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/tivdoc-ops/run.mts e2e
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/tivdoc-ops/run.mts synthetic
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/tivdoc-ops/run.mts real-blocked
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/tivdoc-ops/run.mts public
```

The public command reports `SKIPPED_FEATURE_FLAG_DISABLED` by default; it does not expose a public route. The acceptance matrix covers default 404, missing P1/P2 ports, static and delegated role checks, seven canonical synthetic readiness decisions, all-seven real blocked decisions, stale revision, idempotent replay/conflict, payment refund hold, upstream report invalidation, exact-hash approval/export, path traversal, unknown filename input, script input, absent forbidden endpoints, accessible RTL rendering and no customer delivery.

## Integration blockers

- P1 must implement the projection and atomic command ports over durable canonical services.
- P2 must implement verified identity, tenant/case scope, authorization, audit and object-security adapters.
- The orchestrator must wire package aliases and install the P1/P2 ports after their commits merge.
- Real legal readiness remains 0/7; customer processing, customer shadow, production delivery and public fixtures stay off.
