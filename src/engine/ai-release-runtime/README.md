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
# Owner-only engineering purpose

`runOwnerEngineeringRuntime` is an additive versioned projection of the same
ordinary preparation, generated RuleSpecs and execution receipts. Its policy,
configuration, admission, runtime result and case-analysis envelope have distinct
schema discriminants. Existing qualified v1 parsers reject them.

The trusted loader supplies the exact case, owner identity and enrollment plus
the existing current source, paid scope, canonical facts, build and time pins.
The engineering policy is restricted to `isolated_test`, QA and `development`.
It preserves the complete hashed `human_by_law` review. An `unresolved` review
may remain explicitly unresolved for engineering inspection; `required` still
blocks. Missing or conflicting source/interpretation/factual evidence, required
case decisions, expiry and revocation retain their ordinary blocking behavior.

Every engineering check/result sets `release_authorized`, `publication_allowed`,
`notification_allowed` and `verified_debt` to false. Totals remain null. The
distinct `owner_engineering` envelope can be retained for an authenticated owner
draft, but it is not input to a qualified publisher or notification. Those
persistence, delivery and live currentness fences must be enforced separately
by the ordinary server pipeline; this pure engine cannot authenticate an owner
session or establish database currentness.
