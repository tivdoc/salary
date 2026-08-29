# Wave 2 controlled import recovery and parser isolation

## Boundary and outcome

This lane strengthens local controlled-import tooling only. It did not perform an owner handoff, access a customer document, connect to Supabase or another external store, run a migration, use a model, activate a source, create a legal rule or emit a Finding. The persistent owner-import ledger remains empty. Synthetic imports exist only inside disposable test directories and are excluded from persistent readiness.

## State and reachability contract

The operation journal records this forward-only path:

`received → quarantined → validated → published → ledger_appended`

`rejected` is a terminal fail-closed branch from any pre-commit stage. This is a logical rollback: orphan bytes may be retained for recovery evidence, but they remain unreachable and cannot be selected. The private artifact and receipt live under the ledger's dot-prefixed transaction area while quarantined. Parser, retrieval and activation code do not read that area. An artifact becomes selectable only when its immutable artifact, event and root ledger record all exist and their hashes and identities agree. The journal is recovery evidence and never a selection source.

The journal binds the canonical request hash, raw receipt-input hash, operation ID, acquisition request ID, source ID, expected filename and media type, expected hash, private-copy hash, canonical receipt hash, published hash and canonical ledger-record hash. The event additionally binds artifact/version identity and actual byte count. A mismatch remains quarantined, records a safe rejection code when possible and returns non-zero.

## Recovery and concurrency matrix

| Condition | Control | Expected result |
|---|---|---|
| interruption after `received` | deterministic operation ID and immutable journal | retry obtains the exact private inputs or rejects closed |
| interruption after private copy | immutable private artifact/receipt and hashes | retry validates the same bytes; changed input cannot replace them |
| interruption after validation | recorded validated hashes | retry resumes publication for the same operation |
| interruption after artifact publication | root ledger absent | orphan artifact is not selectable; retry completes exact event and ledger |
| interruption after event publication | root ledger absent | event and artifact remain unselectable; retry appends exact ledger record |
| interruption after ledger append | fully bound commit marker | retry is idempotent |
| same request/source/hash concurrently | local atomic lock plus immutable writes | exactly one created result; other results idempotent |
| same bytes with conflicting identity | event/ledger/request binding | conflict is rejected; no second ledger record |
| different bytes under same expected identity | private/request/receipt hash binding | rejected and quarantined |
| dead local lock owner | PID liveness check and atomic stale-lock takeover | one recovery owner continues |

The lock coordinates processes on one local filesystem. It is not a distributed lock and is not evidence of replicated durability.

## Parser/screener isolation matrix

Untrusted PDF screening runs in a separate Node process. Input is provided only over stdin; a complete schema-validated JSON result is accepted only after exit code zero. The parent kills the child and discards all stdout on timeout, cancellation or output overflow. The child receives a minimal environment, Node filesystem permissions limited to its own worker file, a V8 heap cap, and patched network entry points that throw before a connection is created.

| Threat or limit | Result |
|---|---|
| input/output bytes | hard parent and child limits |
| pages/objects/declared stream length | hard structural limits |
| Flate decompression bytes and ratio | bounded inflate with maximum output |
| timeout/cancellation | forced termination; no partial result publication |
| JavaScript, actions or launch behavior | rejected |
| embedded files/XFA | rejected |
| external URI/remote GoTo | rejected |
| encryption | rejected |
| executable/ZIP or trailing polyglot | rejected |
| malformed object/xref structure | rejected |
| path traversal, absolute/UNC paths, Windows ADS/device names and case collision | rejected before private copy |
| symlink/reparse point or hardlink | rejected by lstat/realpath/link-count checks |
| network canary | denied before connection construction |

The screener does not execute PDF content and never writes parser output to the corpus. Passing it means only that bounded technical screening completed; it is not legal, provenance or activation review.

## Atomicity and residual risks

File contents are synced before process-level atomic hardlink publication. The tests prove process interruption and atomic visibility on the exercised local filesystem. They do **not** prove directory-entry fsync, controller cache flush, survival of sudden power loss, filesystem firmware behavior or cross-device atomicity. Node's portable APIs and the present Windows environment cannot establish those guarantees.

Other residual risks remain explicit:

- the local PID lock is not safe for distributed writers or unreliable network filesystems;
- reparse, ACL and file-identity checks reduce but cannot eliminate privileged same-host races;
- the Node permission model does not supply a network namespace, so network denial is implemented by a minimal worker plus patched built-in entry points, not an OS firewall proof;
- the V8 heap cap is not a complete native RSS or kernel resource sandbox;
- the bounded screener is conservative and is not a complete validating implementation of every PDF grammar revision;
- keeping a private recovery copy and local journal is not durable, replicated or immutable evidence custody;
- no production incident response, key management, retention or deletion policy has been authorized or tested.

## Future authorized storage and replication design note

An authorized durable-custody task should use a private content-addressed object store and an append-only transactional metadata database, both tenant- and purpose-isolated. Publication should require a transaction record binding request, receipt, content hash, storage generation and immutable object version before a separate reviewed selector can reference it. The design should include object lock/WORM retention where legally approved, encryption with managed keys and rotation, least-privilege service identities, quorum or multi-region replication, checksummed backups, restore drills, tamper-evident audit events, signed handoff receipts, distributed idempotency keys and explicit retention/deletion governance. Power-loss and failover claims must be supported by provider guarantees and destructive recovery drills in a disposable environment. None of that storage exists or is claimed by this worker.

## Verification

Focused suites cover every journal transition, recovery replay, local lock concurrency and stale takeover, identity/hash conflicts, filesystem attacks, parser hostile inputs, decompression/resource limits, timeout, cancellation, partial output and the network canary. `scripts/wave2-controlled-import/verify.mts` writes deterministic ignored evidence beneath `output/parallel-wave-2/batch-a/controlled-import` and fails if any persistent owner entry exists.
