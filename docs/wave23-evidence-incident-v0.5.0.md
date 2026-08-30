# Wave 2.3 evidence incidents and immutable quarantine governance

This component records the trust discontinuity at V0.5.0. It does not repair, replace, or retroactively qualify V0.4, V0.4.1, or V0.4.2.

## Historical authority disposition

| Package | Immutable identity | Failure disposition | Permitted use |
|---|---|---|---|
| V0.4 | ZIP `77bd9874…096c`; manifest `9fa62f68…5bf`; erratum `98e709e5…98a4` | `quarantined_failed` | `forensic_only` |
| V0.4.1 | ZIP `3926163f…70d2`; manifest `f4a4ea36…f16b` | `quarantined_failed` | `forensic_only` |
| V0.4.2 | ZIP `c3c71358…6636`; manifest `6b8082a2…9c1` | component evidence only; it did not close the historical chain | `forensic_only` |

Quarantined or forensic-only roots may be inspected. They cannot satisfy a current audit baseline, legal-source activation, or Shadow evidence admission. Disposition records are append-only and each record hashes its reason, immutable package identity, state, capabilities, and parent record hash. A failed-root latch cannot be cleared.

## Incident and recovery semantics

The generator resolves the eleven frozen V0.4 references and four frozen V0.4.1 mismatches through their exact package member and JSON pointer. An incident key is the tuple `(repository_path, claimed_sha256, claimed_byte_count)`. Reference counts are therefore reported separately from unique incident counts. A same-path crosswalk never constitutes recovery of claimed bytes.

The bounded recovery check is restricted to repository Git objects and reflogs, existing registered worktrees, the three exact known historical ZIPs, and the two known Wave 2.2 W1 recovery-output roots. It does not scan unrelated directories, generate brute-force candidates, or accept speculative normalization. Recovery requires bytes matching the claimed SHA-256 and byte length and a Git clean-filter result equal to the historical committed blob for that path.

`pre_commit_generated_evidence_bug` remains a hypothesis. It is never emitted as causally proven. Unresolved references retain `unexplained_possible_integrity_failure` and `unrecoverable_or_unavailable`.

## Commands and deterministic evidence

Run from the repository root with the bundled Python runtime or Python 3:

```text
python scripts/wave23-evidence-incident/incident_registry.py self-test
python scripts/wave23-evidence-incident/incident_registry.py diagnostic
python scripts/wave23-evidence-incident/incident_registry.py strict
```

`diagnostic` exits 0 when the bounded harness completes. `strict` deliberately exits 6 because the historical roots remain failed; that expected nonzero exit does not mean the historical subject passed.

The ignored directory `output/parallel-wave-2.3/workers/w1-evidence-incident` contains:

- `cross-package-incident-registry.json`
- `evidence-root-disposition-registry.json`
- `bounded-recovery-matrix.json`
- `negative-case-matrix.json`
- `historical-gate-status.json`
- `git-evidence.json`
- `diagnostic-result.json`
- `evidence-manifest.json`

All JSON uses sorted-key deterministic serialization. Report and matrix hashes bind canonical compact JSON excluding only their own hash field. The manifest binds the serialized evidence files and excludes itself.

## Negative guarantees

The adversarial matrix rejects illegal failed-to-trusted promotion, treating a crosswalk as missing-byte recovery, omission of a reference, collapsing the reference count into the unique count, altered package identities, fallback to V0.4/V0.4.1 for current admission, and tampering with either a reason or parent hash.

No legal source, legal rule, customer material, numeric parameter, Finding, owner import, persistence operation, network action, Production action, or Shadow execution is performed by this component.
