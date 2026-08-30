# Wave 2.1 ledger-bound visibility and parser enforcement

This worker changes only the controlled local import boundary. It does not import an owner artifact, review or activate a source, create a rule or parameter, or claim distributed coordination.

## Visibility protocol

The final visibility authority is an immutable atomic marker under `.commits/<artifact-sha256>.json`. A reader accepts it only after validating the identity reservation, request and operation identity, artifact record, event, final journal entry, byte count, artifact hash, regular-file/link-count constraints, and a fresh isolated PDF screen. Root ledger records, events, and published bytes are recovery material until that marker exists and validates. The canonical owner-artifact inventory enumerates commit markers, not root ledger records.

The injected crash matrix covers every stage from receipt through the commit marker. Before the marker, the real reader returns no artifact version and emits no parse result, citation, chunk, or retrieval result. A crash immediately after the marker remains visible because the marker was already atomically committed. Truncated journal, event, ledger, or marker records fail closed.

## Concurrency and recovery

Local multi-process tests cover identical concurrent imports, different bytes under one request/source identity, identical bytes with conflicting bound document identity, stale locks, same-PID/start-time poisoning, process termination while holding the lock, and a reader racing publication. Locks bind PID, random token, process start estimate, and a refreshed lease. These results are local filesystem/process evidence only; they are not a distributed-lock or replicated-custody claim.

## Canonical parser path

`scripts/legal-acquisition.mts import` calls `importOwnerOfficialArtifact`, which calls `importControlledOfficialArtifact`, which screens bytes in the permission-restricted child process before any commit. The committed reader repeats isolated screening before returning a record. `validateOwnerPdfBytes` also delegates to the isolated screener. The low-level in-process PDF validator remains a non-canonical test helper and is not reachable from owner import or owner inventory entrypoints.

The exact assurance labels are:

- `PARSER_APPLICATION_ISOLATION_VERIFIED`
- `PARSER_OS_SANDBOX_NOT_VERIFIED`

The child process, permission model, limits, timeout, cancellation, output schema, and network canary prove application isolation. They do not prove an OS network namespace, container/VM boundary, cgroup/native RSS or PID limit, or read-only root filesystem. No container runtime was installed or required by this worker.

## Commands

Local/adversarial verification is allowed to succeed:

`node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/wave21-controlled-import/verify.mts local`

Strict operational readiness intentionally fails until durable replicated storage, a persistent ledger, OS sandboxing, persistence evidence, and a nonzero verified owner ledger exist:

`node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/wave21-controlled-import/verify.mts strict`

Ignored evidence is written to `output/parallel-wave-2.1/workers/w3-ledger-parser`. Persistent owner ledger entries remain zero. Synthetic test copies are excluded from that count and remain inactive, unreviewed, unparsed, and unusable for legal rules.
