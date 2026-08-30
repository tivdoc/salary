# Evidence Epoch 2 tooling (V0.5.0)

This worker supplies post-integration tooling for `TIVDOC_EVIDENCE_EPOCH_2_V0.5.0`. The epoch deliberately has no parent trust root. Historical V0.4, V0.4.1, and V0.4.2 identities are incident/disposition references only and cannot satisfy current admission.

## Trust model

- Authoritative current files are enumerated from the requested final commit with `git ls-tree` and read with `git cat-file blob`; checkout bytes never enter the package.
- Git blob SHA-1, content SHA-256, package SHA-256, and decision SHA-256 remain explicitly separate namespaces.
- The builder rejects a stale requested HEAD, dirty tracked state, an untracked file below an authoritative prefix, unsupported Git modes, non-blob entries, case-folded or unsafe paths, and `filter`, `working-tree-encoding`, or `diff` attributes. Text/EOL attributes are recorded as checkout-only diagnostics.
- Worker and orchestrator outputs supplied through `--claim-root label=path` are copied as `derived_post_commit_evidence`; they are not relabeled as committed source bytes.
- The package is store-only ZIP with lexical member order, fixed timestamp, fixed regular-file metadata, an exact manifest, scanner report, and current claim/Git-object inventories.

The default authoritative prefixes cover Wave 2.3 tracked code, scripts, and documentation plus canonical readiness. Add an integration-specific prefix only with a repeated `--include-prefix`; every added path receives the same Git-object and attribute checks.

## Post-integration run

Run only after W1, W2, and the orchestrator commit are present and the tracked tree is clean. Replace the example claim roots with the ignored evidence roots created by those runs.

```powershell
$FinalHead = git rev-parse HEAD
python scripts/wave23-evidence-epoch/epoch_builder.py build --repo . --head $FinalHead --claim-root w1=output/parallel-wave-2.3/workers/w1-evidence-incident --claim-root w2=output/parallel-wave-2.3/workers/w2-corpus-trust --claim-root orchestrator=output/parallel-wave-2.3/orchestrator --output output/parallel-wave-2.3/review-package-v0.5.0-a.zip --result output/parallel-wave-2.3/build-a-result.json
python scripts/wave23-evidence-epoch/epoch_builder.py build --repo . --head $FinalHead --claim-root w1=output/parallel-wave-2.3/workers/w1-evidence-incident --claim-root w2=output/parallel-wave-2.3/workers/w2-corpus-trust --claim-root orchestrator=output/parallel-wave-2.3/orchestrator --output output/parallel-wave-2.3/review-package-v0.5.0-b.zip --result output/parallel-wave-2.3/build-b-result.json
python scripts/wave23-evidence-epoch/verify_epoch_python.py verify --package output/parallel-wave-2.3/review-package-v0.5.0-a.zip --repo . --output output/parallel-wave-2.3/python-verifier-v0.5.0.json
node scripts/wave23-evidence-epoch/verify_epoch_ts.mts verify --package output/parallel-wave-2.3/review-package-v0.5.0-a.zip --repo . --output output/parallel-wave-2.3/typescript-verifier-v0.5.0.json
python scripts/wave23-evidence-epoch/epoch_builder.py receipt --package output/parallel-wave-2.3/review-package-v0.5.0-a.zip --python-report output/parallel-wave-2.3/python-verifier-v0.5.0.json --typescript-report output/parallel-wave-2.3/typescript-verifier-v0.5.0.json --output output/parallel-wave-2.3/verification-receipt-v0.5.0.json --result output/parallel-wave-2.3/receipt-build-result.json
python scripts/wave23-evidence-epoch/verify_epoch_python.py verify-receipt --receipt output/parallel-wave-2.3/verification-receipt-v0.5.0.json --package output/parallel-wave-2.3/review-package-v0.5.0-a.zip --python-report output/parallel-wave-2.3/python-verifier-v0.5.0.json --typescript-report output/parallel-wave-2.3/typescript-verifier-v0.5.0.json
node scripts/wave23-evidence-epoch/verify_epoch_ts.mts verify-receipt --receipt output/parallel-wave-2.3/verification-receipt-v0.5.0.json --package output/parallel-wave-2.3/review-package-v0.5.0-a.zip --python-report output/parallel-wave-2.3/python-verifier-v0.5.0.json --typescript-report output/parallel-wave-2.3/typescript-verifier-v0.5.0.json
git status --short
```

Hash both builds and require byte equality before promoting build A to the final review-package filename. The detached receipt binds the selected package bytes and size, manifest, final HEAD/tree, verifier source hashes, both verifier reports, scanner rules/scope, command ledger, and zero-invariant report.

## Independent verification

`verify_epoch_python.py` uses only the Python standard library. `verify_epoch_ts.mts` uses Node buffers and its own manual ZIP parser and CRC implementation. Neither imports the builder, the other verifier, or generated expected hashes. Both independently enforce ZIP safety, manifest membership, committed object reachability, exact bytes and modes, claim identities, immutable historical disposition, corrected lifecycle and transition totals, delegate identity, synthetic-vs-real readiness separation, reporting reconciliations, command-ledger results, scanner scope, and all fourteen zero invariants.

Run the synthetic matrix with:

```powershell
python scripts/wave23-evidence-epoch/adversarial_self_test.py --source-repo . --output-root output/parallel-wave-2.3/workers/w3-evidence-epoch
```

It proves deterministic builds and receipt verification, then exercises historical fallback, missing quarantine, crosswalk-as-recovery, incident omission, stale HEAD, claim tampering, alternate delegates, production-reachable READY fixtures, newline substitution, missing/swapped same-basename Git objects, unsafe/duplicate archive names, symlinks, dirty and uncommitted authoritative state, Git mode mismatch, stale/swapped receipt bindings, and a Git filter anomaly. All fixtures and paths are synthetic.

## Assurance boundary

This tooling creates an engineering evidence baseline only. It does not repair historical roots, import owner evidence, activate official sources or legal rules, run customer documents, enable production or Shadow Mode, establish OS sandboxing, persistence, or durable replicated custody, or replace human legal and Ground Truth review.
