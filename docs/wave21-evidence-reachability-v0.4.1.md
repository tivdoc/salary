# Wave 2.1 W1 — Evidence and canonical reachability audit

This worker adds offline audit and verification tooling only. It does not change legal-source, parser, Rule Input, Ground Truth, persistence, review, activation, or runtime behavior.

## Deterministic outputs

Run with network disabled:

```powershell
$env:TIVDOC_LEGAL_NETWORK_DISABLED='1'
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/wave21-evidence-audit/run-all.mts
```

The Git-ignored output is `output/parallel-wave-2.1/workers/w1-evidence-reachability`.

The independent Python verifier does not import the V0.4 package generator. It validates the pinned ZIP and manifest hashes, exactly 115 members/114 covered members, manifest self-exclusion, portable paths, regular-file types, byte hashes, nested evidence manifests, command stdout/stderr hashes, Git object reachability, and base-to-head file inventories. Extraction succeeds only into a new path.

## Audit boundaries

- Counts keep URL observations, returned-byte observations, unique byte objects, registered corpus artifacts, staged files, and ledger entries as separate populations.
- Static reachability starts from the four entrypoints frozen in the V0.4.1 execution contract. Root-barrel exposure does not count as runtime reachability.
- Runtime probes use synthetic, legally neutral inputs only.
- Rule Input and Ground Truth matrices replay existing canonical validators and workflows without creating real legal values or human attestations.
- The report preserves `LEGAL_SOURCE_CORPUS_INCOMPLETE` and records canonical integration gaps rather than masking them.
