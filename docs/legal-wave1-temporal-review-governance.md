# Wave 1 temporal, topic-readiness, and review governance

This implementation is an inactive engineering foundation. It contains no real legal relationship verification, legal approval, active source, jurisdiction-specific monetary parameter, or rule.

## Stable query semantics

- `--from YYYY-MM-DD` is an inclusive civil date on the **valid-time** axis. It asks which claims say they were operative on that date. It is never interpreted in the host timezone.
- `--as-of YYYY-MM-DDTHH:mm:ssZ` is an inclusive canonical-UTC cutoff on the **knowledge-time** axis. Only claims ingested by that instant and not invalidated by that instant can be observed.
- A source discovered after `--as-of` cannot change the result of an older query. A retroactive claim may apply to an earlier `--from`, but appears only once its ingestion time is within `--as-of`.
- Signing, publication, commencement, operative interval, payroll-reference period, ingestion, review, activation, and invalidation remain separate fields. No timestamp is inferred from another.

The standalone CLI uses synthetic, inactive fixtures only:

```powershell
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/wave1-topic-readiness.mts --from 2024-02-15 --as-of 2024-03-01T00:00:00Z
```

## Fail-closed policy

Topic readiness is scoped by topic, valid date, knowledge cutoff, sector, and population; it does not read or weaken global corpus readiness. It stays `not_ready` when any required catalog entry, source role, parse, citation, effective claim, scope claim, valid review attestation, or activation is absent. Operative instruments, official implementation/corroboration, secondary explanations, and parliamentary research are distinct roles. Parliamentary research is non-operative and cannot independently support a monetary rule.

All Wave 1 relationship claims (`amends`, `supplements`, `temporarily_overrides`, and `revokes`) are schema-limited to `unverified`. Review attestations form an append-only event log and bind artifact bytes, parsed output, parser version, source-set version, interval claim, scope claim, reviewer identity/role, and review time. Changed bytes, parse output, parser version, source set, interval claim, or scope claim invalidates dependent readiness until a new review is appended.

The future activation evaluator is side-effect free. It requires a valid attestation plus distinct legal-content and activation-control approvals bound to the same hash. It never activates a source itself.
