# Overnight V0.7 P8 — ready integration portion

## Scope and truth boundary

This lane is a consumer-owned integration harness, not a second implementation of product or legal truth. It composes the actual local P1 transaction, idempotency, job, fencing and outbox adapters; P2 verified identity, authorization, audit, request guards and private object storage; P5 internal-operations service and HTTP adapter; P6 customer portal service; P7 health, observability, backup/restore and default-off operator controls; and the existing canonical `CaseAnalysisService` composition.

All journeys use deterministic synthetic actors and fixture inputs. The only Money used is the legally neutral synthetic currency `XTS`. No customer record, live payment, external service, network call, production delivery, Shadow Mode, legal activation or legal numeric value is used.

## Ready evidence

Run:

```powershell
npx vitest run src/server/product/integration --reporter=verbose
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/overnight-v07/integration/run.mts
npx tsc --noEmit --pretty false
```

The script writes the deterministic, Git-ignored receipt to `output/overnight-v0.7/p8/ready-receipt.json`. The receipt is hash-bound and fails verification if any non-dependency acceptance check fails or if any prohibited-effect count is nonzero.

The ready matrix covers the integrated synthetic lifecycle, exact-hash manual export, stale revision and idempotency, transaction/job/outbox fencing, payment chargeback invalidation, owner-only portal invitation/clarification/provenance/release/privacy flow, P2/P6 exact artifact identity, security guards, production denial, canonical real-corpus fail-closed behavior, and P7 local backup/restore and coarse readiness.

## Integrated dependencies and exact remaining skips

The follow-up seam consumes the canonical P3 corpus/workspace verifier and the
canonical P4 RuleSpec skeleton, golden template, Ground Truth and Offline
Shadow modules. Their exact current hashes and zero-real-output invariants are
bound into the P8 receipt; no duplicate legal or extraction truth was added.

The public fixture journey is precisely `SKIPPED_NO_ELIGIBLE_PROVENANCE`
because no independent eligible provenance record is present. Native browser
and PDF visual verification is performed separately from the unit harness and
receives its own artifact receipt.

These skips are not success claims. Only the P3/P4 dependency blockers were
removed by direct canonical verification.

## Safety invariants

- Current real corpus: seven `blocked_legal_readiness` topics, zero calculations, zero Findings, zero approvals, zero exports.
- Production delivery, customer processing and customer Shadow Mode remain false.
- Test identities and the synthetic portal repository are rejected in production mode.
- Operational output contains only opaque identifiers, hashes, enumerated status and counts.
- Every original product/service lane remains unchanged; this lane writes only its frozen allowlist and ignored evidence.

