# Wave 2 A1 — Wave 1 evidence audit and reconciliation V0.4

This worker is an offline, read-only audit of the Wave 1 checkpoint. It does not change a legal source, source role, review state, activation state, legal relation, parameter, rule, or customer result. It does not construct an OpenAI client, connect to Supabase, open a customer path, apply a migration, deploy, or emit a Finding.

## Frozen evidence inputs

- Original Git ancestor: `e978ae5cee4a92f20dcc7db448b275170b8bf724`.
- Wave 1 integrated checkpoint: `bb9a61eae55d49529d7cd633a2c9c2615a8d842e`.
- Wave 2 Batch A contract: `2478e28eb4f31d282dac4b6f8f1fb488fb9b5bca`.
- Canonical Wave 1 review ZIP SHA-256: `fe7c5ffe6d3e8cdb3f8bc87e8e6e7268b7df48dfc52e3218c82cc2aef11f980b`.
- Tracked Working Time inventories from the repository.
- Existing legal-only ignored evidence under `C:\dev\tivdoc\salary\eval\legal-knowledge` and `C:\dev\tivdoc\salary\output`.
- Preserved Wave 1 Working Time source pack under `C:\dev\tivdoc-wave1-working-time-permits\output\legal-knowledge\wave1-working-time-permits`.

The path guard rejects `customer-payslip-data-only-v3`, customer-evaluation roots, and case/document paths. No customer path is an audit input.

## Evidence products

Run from the repository root with the offline canary set:

```powershell
$env:TIVDOC_LEGAL_NETWORK_DISABLED='1'
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/wave2-evidence-audit/run-all.mts
```

Generated evidence is restricted to the ignored directory:

`output/parallel-wave-2/batch-a/evidence-audit`

The run produces:

- `wave1-git-audit.json`: first-parent commits, every parent, worker bases and commit counts, file/status/numstat records, worker allowlist checks, stable patch IDs, and per-path worker/cherry-pick blob equivalence.
- `wave1-artifact-crosswalk.json`: 20 publication records, 58 permit records, all 88 distinct artifact URLs, 72 verified acquired files, 15 separate 403 gaps, one separate 404 gap, and corpus/source-pack/ledger/quarantine/change partitions.
- `full-diff-scope-scan.json`: every changed path in `e978ae5..HEAD`, including documentation, tests, scripts, `package.json`, lockfiles when changed, and executable configuration. A classification never removes a path from the inventory.
- `topic-readiness-diagnostic.json`: diagnostic `not_ready` with exit semantics `0`.
- `topic-readiness-strict-gate.json`: the same fail-closed evidence with strict exit semantics `2`.
- `wave1-review-package-verification.json`: two byte-identical clean reconstructions plus adversarial and recovery evidence.
- `evidence-manifest.json` and `result.json`: hashes and the compact worker result.

No package-script wiring is added by this worker. Direct diagnostic and strict commands are:

```powershell
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/wave2-evidence-audit/topic-readiness.mts status
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/wave2-evidence-audit/topic-readiness.mts gate
```

The first is allowed to exit `0` while reporting `not_ready`. The second must exit nonzero until every required gate is satisfied.

## Count reconciliation

The count categories are intentionally non-interchangeable:

- 20 Working Time publication records have 20 official publication URLs.
- 58 permit catalog records map to 68 unique permit-attachment URLs.
- The reported 68 URLs refer only to permit attachments, not to the 20 law-publication URLs. The combined distinct URL count is 88.
- The source pack contains 72 acquired PDFs: all 20 publication files and 52 permit files. Sixteen permit files remain absent: 15 HTTP 403 observations and the single HTTP 404 catalog value `premit-8753`.
- Only the original 1951 publication from this source pack exactly matches a selected registered corpus artifact. Fetching the other 71 files did not register, review, activate, consolidate, or legally classify them.
- The current fetch state contains 23 observation rows and one separate failure row, or 24 combined attempts. Three observation rows are 505-byte HTML challenge bodies. Together with the separate unavailable attempt they form the four-item quarantine/unavailable partition.
- Five diff detections comprise three `unreviewed_byte_change` candidates and two `rejected_challenge_observation` detections. The third 505-byte challenge is the rejected initial challenge baseline and is not an additional byte-change candidate.
- The persistent owner-import ledger has zero entries. The Wave 1 test-only ledger was temporary, was cleaned, and has zero retained entries; it is not owner-import evidence.

The crosswalk hashes every acquired file at its source-pack location, checks PDF magic and declared media type, compares it byte-for-byte with the canonical V0.3 package member, and records the member as immutable evidence under the pinned ZIP hash. Its `ACQOBS:WAVE1:*` identifier is explicitly an audit-derived deterministic reference, not a claim that Wave 1 originally assigned an observation ID.

## Why 140 / 139 / 133 is correct

- 140 is the number of ZIP members and includes `package-manifest.json`.
- 139 is the number of manifest entries. The manifest excludes itself to avoid a recursive self-hash.
- 133 is the number of copied worker and central evidence files in `input-output-inventory.json`.
- The remaining seven files are six generated audit/index/scan files plus the manifest itself.

The verifier checks the canonical ZIP hash before extraction, rejects unsafe or duplicate member paths, validates every manifest hash and byte count, reconstructs twice with the original fixed ZIP metadata, and requires both rebuilt ZIPs to equal the canonical hash. Adversarial coverage includes a forced source-hash mismatch, corrupt manifest, changed member, unexpected member, traversal member, stale output, simulated interruption, and deterministic recovery.

## Runtime denial proof

Static proof scans additions for direct OpenAI or external Supabase client construction, prohibited customer paths, migration/deploy execution, and Finding emission. Documentation, denial tests, the frozen boundary contract, and scanner declarations are retained with explicit non-executable dispositions.

Runtime canaries invoke the denial boundary for every prohibited capability and prove that the supplied side-effect callback is called zero times. This proof applies to the Wave 2 evidence-audit modules; it is not a repository-wide claim about unrelated product code that predates the audited range.

## Verification

Focused verification:

```powershell
npm test -- --run src/engine/wave2/evidence-audit
npx eslint src/engine/wave2/evidence-audit scripts/wave2-evidence-audit
npx tsc --noEmit
git diff --check
```

The integrated orchestrator must add package wiring, if desired, and the tracked `/output/parallel-wave-2/` ignore rule. It must rerun `run-all.mts` at the integrated Batch A HEAD so that the full-diff inventory includes every A1, A2, A3 and orchestrator path.
