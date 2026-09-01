# Tivdoc V0.10 local-system closure

This document is the W9.1/W9.3 architecture, restart/degraded-mode runbook and human/external action index for the repository at `a060e71c271bdc510bef9c8eb64699635dbdec3a`. It does not replace the frozen Marathon execution contract, inventory or ledger.

## Canonical authority and inventory

The machine-readable inventory is
`src/server/system-marathon/canonical-entrypoints.v0.10.0.json`. It enumerates the stable App Router pages and APIs, durable worker surfaces, relevant CLIs and application services, including their exact source, canonical target, Marathon classification, dependencies, blockers and non-claim.

Reachability remains owned by the existing verifier, `npm run canonical:reachability:verify` (`scripts/product-integration/reachability/verify.mts`). Persistence ownership remains owned by `src/server/platform/persistence/wiring-map.ts` and the single application composition root, `src/server/platform/composition/canonical-postgres-application.ts`. The closure inventory cites those authorities; it does not create a competing import graph or persistence map.

The closure contract asserts these stable-product invariants:

- unknown production-reachable symbols: `0`;
- duplicate canonical contracts: `0`;
- wave/version-specific stable product paths: `0`;
- direct repository construction outside the composition root: `0`;
- product-reachable memory fallbacks: `0`.

Release-specific verification commands remain evidence entrypoints, not stable product routes or services. Existing direct-Supabase intake, document and payment routes are explicitly classified rather than silently described as canonical PostgreSQL wiring.

## Architecture and restart/degraded-mode runbook

| Boundary | Canonical target | Restart behavior | Degraded mode and exact non-claim |
| --- | --- | --- | --- |
| Durable PostgreSQL | `startCanonicalApplicationPostgres` and the exact 14-capability wiring map | Recreate the connection factory, run the schema compatibility probe, reclaim expired job leases with a new fencing token, and replay idempotency/outbox receipts. The disposable loopback proof exercises a genuine database stop/start. | `disabled` fails closed. `memory_test_only` requires the hermetic sentinel and is forbidden at the non-test boundary. Stable Next routes are not yet bound to `DurableProductPostgresApplication`; no managed PostgreSQL runtime is claimed. |
| Identity | `CryptographicJwtIdentityVerifier` through `authenticateProductIdentity` | Re-resolve active public keys and durable session state; reject expired, revoked, rotated or mismatched tokens. Do not recover identity from headers, query parameters or unsigned cookies. | Hermetic sessions are local proof only. Without a managed key resolver and durable session-state reader, operations and portal access remain unavailable; no managed identity provider is claimed. |
| Private storage and controlled import | `SupabasePrivateBlobProvider`, `importControlledOfficialArtifact` and the controlled-import PostgreSQL ledger | Reconcile immutable byte hashes, reservations, ledger checkpoints and object inventory before resuming. A parser crash may resume only from an exact journal binding and idempotency key. | The managed storage adapter and isolated Supabase runner fail closed without an approved target. Child-process screening is not OS-level sandbox proof. No official source, customer document or live provider access is claimed. |
| Human trust and legal governance | `InMemoryReviewerTrustStore`, signed canonical decision envelopes and `LegalOperationsApplicationService` | Reconstruct trust only from genuine organization, policy, key, rotation/revocation and signed decision records. A process restart cannot treat generated test keys or missing trust history as attestation. | The current trust store is process-local and therefore not a durable product trust repository. All real source, parameter and RuleSpec lifecycle gates remain inactive without genuine signatures and separation of duties. |
| Offline Shadow | `OfflineShadowControlPlane` | Re-register the exact definition and resume only from a durable repository when one is supplied; do not infer completion from logs or metrics. | The current control plane is in-process and synthetic/offline. Real mode is fail-closed, promotion is always false, Customer Shadow authorization is `NO`, and customer-data reads remain `0`. |
| Custody and privacy | `CustodyReplicationOutbox` plus `reconcilePrivacyStorage` | Restore an authenticated outbox snapshot, verify exact destination receipts, then reconcile database/object/backup inventory before releasing work. Stale leases require fencing-token replacement. | Local synthetic replication and deterministic reconciliation are not off-host custody, deletion execution, achieved RPO/RTO or managed disaster recovery. |
| Evidence package | `scripts/full-local-system-marathon/evidence-core.mts` and the detached verifier | Rebuild from the declared payload set, recompute every hash from bytes, and reject missing, traversing, duplicate-normalized or self-referential entries. | A local path, manifest, ZIP or hash is only `prepared`. External delivery requires the actual bytes, an identified auditor receipt and a verified/rejected signature-bound decision. |

### Operator sequence after a local restart

1. Confirm the expected Git HEAD and a clean tree; do not reuse evidence from another tree.
2. Detect the persistence environment with `npm run platform:persistence:env:detect`. For the owned disposable local database, use `npm run verify:postgres:dynamic`; do not point it at a remote or production target.
3. Run `npm run canonical:reachability:verify` and `npm run platform:persistence:wiring:verify`; treat either failure as a closed product boundary.
4. Verify route/auth denial and synthetic journeys with `npm run product:routes:verify`, `npm run product:auth-boundary:verify`, `npm run product:e2e:synthetic` and `npm run product:e2e:negative`.
5. Re-run controlled import, human trust, legal, ground-truth, Shadow, custody/privacy and evidence verifiers only against their permitted synthetic or already-authorized bytes. A blocked human/external gate must remain blocked.
6. Never recover by switching a non-test path to memory, weakening identity, bypassing exact hashes, force-approving a review, activating legal artifacts, reading customer material, calling a live provider, deploying or applying a remote migration.

## Single human/external queue

The authoritative actionable queue is
`src/server/system-marathon/owner-action-index.v0.10.0.json`. It contains exactly these groups, in order:

1. official-source handoff;
2. legal-source review;
3. effective-period, sector and population review;
4. parameter attestations;
5. RuleSpec approval and golden cases;
6. payslip visual review, dual annotation and adjudication;
7. external audit delivery;
8. isolated Supabase, managed identity and storage;
9. parser sandbox platform proof;
10. off-host custody;
11. Customer Shadow authorization.

Every queue item names the external owner, prerequisites, exact evidence, blocked truth and limited completion effect. It contains no task that can be completed by routine local engineering.

## Preserved truth and non-claims

```text
REAL_LEGAL_TOPICS_READY: 0/7
REAL_SOURCES_ACTIVE: 0
REAL_PARAMETERS_ACTIVE: 0
REAL_RULES_ACTIVE: 0
REAL_CALCULATIONS_OR_FINDINGS: 0
HUMAN_GROUND_TRUTH_LOCKED: 0
REAL_CUSTOMER_DATA_READS: 0
CUSTOMER_PROCESSING_ENABLED: NO
CUSTOMER_SHADOW_AUTHORIZED: NO
PRODUCTION_DELIVERY_ENABLED: NO
DEPLOYMENTS: 0
REMOTE_MIGRATIONS: 0
LIVE_PROVIDER_CALLS: 0
OPENAI_CALLS: 0
PRODUCT_REACHABLE_MEMORY_FALLBACKS: 0
```

No generated test key is a human signature. No blank template is a legal value or golden result. No staged path is an active source. No prepared package is external delivery. No local synthetic proof is Production, Customer Shadow, a real calculation, a legal finding or permission to process customer material.
