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

## Exact pending dependencies in the first P8 commit

The base commit does not contain the P3 or P4 lanes. P8 therefore exposes, but does not fake, `P3ReviewWorkspaceIntegrationPort` and `P4QualityShadowIntegrationPort`. Their receipt entries are `PENDING_NOT_IN_INTEGRATION_BASE` with blocker codes `P3_REVIEW_WORKSPACE_AND_CORPUS_ADAPTER_NOT_IN_BASE` and `P4_RULESPEC_GOLDEN_GT_SHADOW_ADAPTER_NOT_IN_BASE`.

The public fixture journey is precisely `SKIPPED_NO_ELIGIBLE_PROVENANCE` because no independent eligible provenance record is present. Native visual verification remains pending until the P3/P4 integration supplies the final local routes and artifacts; structural PDF/hash verification is already exercised here.

These skips are not success claims. A follow-up P8 seam commit must consume the canonical P3/P4 services after their merge and remove only the dependencies actually proven by that integration.

## Safety invariants

- Current real corpus: seven `blocked_legal_readiness` topics, zero calculations, zero Findings, zero approvals, zero exports.
- Production delivery, customer processing and customer Shadow Mode remain false.
- Test identities and the synthetic portal repository are rejected in production mode.
- Operational output contains only opaque identifiers, hashes, enumerated status and counts.
- Every original product/service lane remains unchanged; this lane writes only its frozen allowlist and ignored evidence.

