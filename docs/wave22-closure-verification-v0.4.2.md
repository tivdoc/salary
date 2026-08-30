# Wave 2.2 independent closure verification V0.4.2

This worker provides an independent consumer/verifier. It imports no production evidence generator, changes no legal-source state, and uses only synthetic PDF fixtures for operational checks. Historical package hashes are frozen task anchors, not values copied from a package's own generated result.

## Commands and exit semantics

Run the diagnostic command with an explicit Python executable and the frozen V0.4.1 ZIP:

```text
node scripts/wave22-closure-verification/run.mts diagnostic --python <python> --repo . --v041 <review-package-v0.4.1.zip>
```

Diagnostic mode always exits 0 after it emits a structured status. `overall=false` remains visible and does not imply closure. It runs the actual controlled-import readers, canonical crash/corruption/concurrency test files, 28 stable raw negative/security cases, archive attacks, and a fresh detached V0.4.1 checkout.

After the orchestrator creates the final package, run strict mode:

```text
node scripts/wave22-closure-verification/run.mts strict --python <python> --repo <integrated-repo> --v04 <review-package-v0.4.zip> --v04-erratum <v0.4-immutable-erratum.json> --v041 <review-package-v0.4.1.zip> --v042 <review-package-v0.4.2.zip> --expected-v042-sha256 <sha256> --expected-v042-manifest-sha256 <sha256> --expected-head <git-sha>
```

Strict mode exits 0 only when V0.4 plus its append-only erratum, V0.4.1, and V0.4.2 all pass independently. Any unresolved erratum reference, unsafe archive, missing/mismatched manifest member, unreachable Git object, evidence-to-Git byte mismatch, failed raw case, missing assurance label, or missing explicit zero-invariant object returns exit 7.

## Independent checks

The verifier extracts only to a new temporary directory. It denies traversal, absolute/device paths, backslashes, Unicode/case collisions, duplicate members, links/devices, encrypted entries, expansion abuse, undeclared members, and changed bytes. It records HEAD, tree, parents, clean status, complete manifest membership, member hashes, every structured Git object/path reference, scanner scope, and count exclusions.

Package-count exclusions are explicit:

- the outer ZIP is not a ZIP member;
- `package-manifest.json` is the only manifest-entry exclusion;
- the independent secret/PII scanner excludes the manifest and scanner report itself and scans every other member as bytes, including binary members;
- the structured source/reference scan lists every JSON member in scope and every manifest, scanner, or non-JSON exclusion by path and reason.

The independent scanner is `tivdoc-wave22-independent-secret-pii-scanner` version `1.0.0`. Its report includes the rules hash, each rule/pattern hash, exact member scope, binary-member inventory, raw finding offsets/classifications, and unresolved count.

The orchestrator can create the required scanner member after assembling staging content but before adding the manifest:

```text
python scripts/wave22-closure-verification/independent_closure_verifier.py scan-staging --staging <clean-staging> --output <clean-staging>/independent-secret-pii-scan.json
```

The command excludes only its own report and the future `package-manifest.json`; both exclusions are recorded. The manifest must then include the scanner report while continuing to exclude only itself.

## Operational denial and residual limits

The actual `readCommittedControlledArtifact` reader is exercised before and after a post-commit byte mutation. It rejects changed opened bytes, publishes no parse/citation/chunk/retrieval result, and succeeds again only after exact committed bytes are restored. A source-binding proof confirms the content is opened once, then that returned byte buffer is length/hash bound and passed to the isolated screener; the marker, record, event, identity, and journal are bound before the content open.

A non-test call to `importControlledOfficialArtifact` uses only a synthetic sentinel payload with an owner-attestation receipt. It is denied with `owner_import_disabled_parser_os_sandbox_not_verified` before artifact, event, root record, commit marker, or canonical visibility. Persistent owner-ledger count stays zero.

Assurance labels remain exact:

- `PARSER_APPLICATION_ISOLATION_VERIFIED`
- `PARSER_OS_SANDBOX_NOT_VERIFIED`
- `PERSISTENT_OWNER_IMPORTS_NOT_VERIFIED`
- `DURABLE_REPLICATED_CUSTODY_NOT_IMPLEMENTED`

The worker does not claim OS sandboxing, persistent owner import, persistence evidence, or durable replicated custody. Evidence is written only beneath ignored `output/parallel-wave-2.2/workers/w3-closure-verification`.
