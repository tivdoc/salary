# Wave 2.2 W1 — Historical evidence byte forensics

This worker is append-only audit tooling. It does not alter either historical evidence ZIP, legal behavior, source state, persistence, parsing, customer data, or runtime decisions.

## Commands

Diagnostic reporting always returns exit `0` when the audit itself completes:

```powershell
node --experimental-strip-types scripts/wave22-evidence-forensics/diagnostic.mts
```

The independent strict gate reads the diagnostic output and returns `0` only when every reference is validly resolved; otherwise it returns `6`:

```powershell
node --experimental-strip-types scripts/wave22-evidence-forensics/strict.mts
```

Evidence is written under the Git-ignored directory `output/parallel-wave-2.2/workers/w1-evidence-forensics`.

## Resolution policy

The V0.4 inventory generator hashed checked-out files rather than immutable Git blobs. The erratum does not guess unknown line-ending patterns or introduce permissive transformations. An original reference is strict-resolved only when its exact bytes are recovered from a preserved registered worktree and Git's configured clean filter binds those bytes to the V0.4 canonical blob, or when an explicitly configured repository transform reproduces the exact claim.

Unrecovered references remain `non_authoritative_unresolved`, force `overall=false`, and keep the strict gate at exit `6`. Canonical Git bytes are recorded as the authoritative replacement for future use, but their existence alone does not retroactively validate an unreachable historical worktree hash.

The tracked declaration `src/engine/wave22/evidence-forensics/v0.4-erratum.v0.4.2.json` binds all 11 original JSON pointers, seven repository paths, claimed hashes and lengths, canonical V0.4 Git bytes, root-cause classes, and expected resolution status. Recovered bytes are retained only in ignored evidence with their original hash and worktree provenance.
