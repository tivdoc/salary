# Qualified AI runtime v1

This module composes the existing entitlement source packet and runs the existing
`runDocumentReview` / `executeRuleSpec` path. It has no provider, storage, database,
queue or publication side effect.

1. Load a current, scoped `DocumentReviewInput`, the canonical facts-stage hash,
   source pins and generator pins from the server's verified build manifest.
2. `prepareAiReleaseRuntime({source, analysis_run_id, trusted_generator_pins})`
   derives family expectations for issuing an AI assessment. The family IDs are
   `entitlement.${topic}`; generator IDs are
   `tivdoc.entitlement.${topic}.generator`, version `1`.
3. Issue/persist the assessment using the policy/registry loader. Its generated
   rule, parameter and source-evidence hashes come from preparation, not a client.
4. `runAiReleaseRuntime({...preparationInput, assessment_input})` prepares again.
   It replaces `assessment_input.current.expected_generated_rules` with freshly
   derived expectations and validates policy admission. No generated function or
   transport can be injected.
5. Persist the full result in the ordinary analysis run, then apply the current
   server publication authority. This module does not publish a report.

`ai-release-generated-rules-v1` hashes a sorted list of exact check IDs, topics,
periods, RuleSpec versions and hashes, operation/binding hashes, actual case-fact
hashes and applicability-decision hashes. It also includes source-bound
nonmonetary outcomes. `ai-release-generated-parameters-v1` hashes parameter
bindings and the actual operands. `ai-release-generated-case-evidence-v1` hashes
the selected source packet, actual fact/decision manifests and nonmonetary
outcomes. These receipts cover graph changes and value/state changes separately.

The supplied build digest is a **server trust boundary**: this pure module cannot
prove that a string is the digest of its deployed files. The loader must verify
the build manifest and registry. Likewise, `current.scope.facts_sha256` is the
server's pinned canonical facts stage, while the family manifests independently
derive the actual consumed case data. Neither is substituted for the other.

Only composer-owned candidate checks receive qualified wrappers. Manual or
historical arithmetic remains in `review`, with its original flags. Actual
missing/conflicting operands, unresolved assumptions and expired case decisions
block individual checks even when the family policy is admitted. A legal source
used by a generated rule must match a reviewed source version and artifact hash.

`findings` contains qualified monetary results, including expected-only and signed
comparisons. It is **not** the legacy `Finding` contract or a debt attestation.
Inspect `outcome`; do not sum findings: expected and comparison checks can overlap,
as can working-time/rest-day or contract/bonus coverage. Nonmonetary quantities and
known unmet conditions remain separate. The ordinary publisher must preserve
these distinctions and the per-check blockers.

The embedded `review` remains `publication_authority:false`; its candidate
receipts remain `real_activation_allowed:false` with `human_attestation:null`.
The wrapper states `qualified_ai_report`, with no legal-debt total and no claim
of actual transfer. `replayAiReleaseRuntime` re-derives and compares all bytes.
Factory branding is process-local; restart requires verified-input replay.

All `.fixture.ts` and `.test.ts` inputs are synthetic unit data. They are not
receipts for active legal reviews or external application use.
