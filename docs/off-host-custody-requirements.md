# Off-host replicated custody — requirements for provisioning

Status: `blocked_external`. Nothing in this repository can provision the
destination this document describes, and nothing in it pretends to. The code
side is finished and waiting: `CustodyDestinationPort` and
`CustodyReplicationOutbox` in `src/server/platform/custody/replication.ts`
define the contract a destination must satisfy, `offHostCustodyCapability()`
reports `BLOCKED` with `OFF_HOST_AUDIT_CUSTODY_PENDING` and
`DURABLE_REPLICATED_CUSTODY_NOT_IMPLEMENTED` until a destination is verified,
and the local two-store proof (`LocalSyntheticCustodyStore`) shows the
replication, idempotency, restart and restore-selection mechanics working
against a synthetic destination. This document is what the person who
provisions the real destination needs, and nothing else.

## 1. Destination

- **Class**: `managed_off_host` — a storage service operated outside the host
  that produces the evidence, in a separate administrative domain (a separate
  cloud account or project, with its own credentials and its own audit trail).
- **Object model**: write-once objects addressed by an opaque locator. Every
  object is at most 8 MiB (the platform's blob ceiling); larger evidence is
  split by the source before replication and reassembled on restore.
- **Immutability**: object lock or an equivalent write-once-read-many mode,
  enforced by the service, with a retention period at least as long as the
  evidence retention class requires (`audit_record`: not less than seven
  years from `stored_at`). Overwrite and delete must be refused by the
  service during retention, not by policy on the client.
- **Encryption**: at rest with a key held by the destination's own KMS, and
  in transit by TLS 1.2 or later. The source's `key_version` in the
  replication envelope names the source-side key; the destination records its
  own.
- **Residency**: a region chosen by the owner and recorded in the destination
  registration; the destination must not replicate across regions unless the
  registration says so.
- **Access**: one write-only principal for the replicator (put, head; no
  delete, no overwrite, no list), one read-only principal for the restorer
  (get, head, list), and no shared principal. Credentials live in the
  destination's secret store, never in the repository, never in a receipt.

## 2. Replication

- **Source of truth**: the local immutable evidence store
  (`src/server/platform/custody/evidence-store.ts`) — every object replicated
  is one indexed entry, and the index entry's `sha256` and `byte_count` are
  the replication envelope's `object_sha256` and `byte_count`.
- **Envelope**: `tivdoc-custody-replication-envelope-v0.10.0` as defined in
  `replication.ts` — replication id, idempotency key, source store and object
  ids, source receipt digest, object digest, byte count, retention class, key
  version, creation time, and the envelope's own canonical digest.
- **Idempotency**: the same idempotency key with the same envelope replays the
  existing receipt; a different envelope under the same key is a refusal
  (`CUSTODY_IDEMPOTENCY_CONFLICT`), never a second object.
- **Ordering and retries**: the outbox leases a job, attempts the put, and on
  failure schedules a retry with backoff; a receipt whose digest or byte
  count disagrees with the envelope moves the job to `diverged` and stops
  retrying. A diverged job is an incident, not a retry.
- **Completeness check**: after every batch the replicator lists the
  destination (read-only principal) and reconciles against the index: every
  indexed object present with the right digest; any extra object at the
  destination is an incident.

## 3. Signed receipt

- **Content**: `tivdoc-custody-destination-receipt-v0.10.0` as defined in
  `replication.ts` — destination id and class, destination locator, envelope
  digest, object digest, byte count, stored-at time, and the receipt's own
  canonical digest — plus a **signature** over the receipt's canonical core.
- **Signer**: the destination service or a signing component in the
  destination's administrative domain, with an Ed25519 key whose public half
  is registered with the source ahead of time (the same trust shape as the
  reviewer keys: organisation, policy, key id, validity window).
- **Verification**: the source verifies the signature against the registered
  public key before it accepts the receipt into the outbox; an unsigned or
  wrongly signed receipt is a refusal, and the job stays leased for retry.
- **Storage**: receipts are appended to the local evidence store like any
  other evidence, so the chain over receipts is verified by the same walk.

## 4. Witnessed restore

- **Cadence**: on first provisioning, then at least quarterly, and after any
  change to the destination's configuration, keys or principals.
- **Procedure**: an independent operator (not the one who provisioned, and
  not the replicator's principal) selects a sample of indexed objects,
  restores each from the destination with the read-only principal to a clean
  location, hashes the restored bytes, compares them byte-for-byte to the
  index entry, and records the comparison.
- **Witness**: a second person observes the restore and countersigns the
  restore receipt; the receipt names both people, the objects, both digests
  per object, the destination locators and the time.
- **Outcome**: any mismatch is an incident that suspends the destination's
  verified status until explained; the source's capability report returns to
  `BLOCKED` for the duration.

## 5. What closes the block

The capability report can move from `BLOCKED` to verified only when all four
of the following are recorded in the repository as evidence, not asserted:

1. the destination registration (class, region, retention, principals, key
   registration), signed by the owner;
2. a full replication of the current evidence index with every receipt
   signature verified;
3. a witnessed restore receipt for a sample chosen by the witness;
4. the reconciliation listing showing the destination holds exactly the
   indexed objects.

Until then the local store is the only custody, and the receipts say so.
