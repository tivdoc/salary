# Versioned AI publication

The owner's adopted launch decisions v1.1 replace the promise that every new full report is professionally reviewed. They do not retroactively change purchased terms, authorize legal-source activation or turn an AI decision into a human signature.

| Contract | Publication behavior |
|---|---|
| Historical report document v2 | Existing policy remains. Full publication requires human approval bound to the reviewed fingerprint. |
| Report document v3 / `tivdoc-ai-publication-v1` | Explicit AI service and automation actor. Actual paid `tivdoc-order-offer-v2` must say `ai_assisted`, `human_review_required: false`, and match the document's offer hash. |
| Inactive, missing or uncertain input | No new permission is inferred. Existing source/applicability/parameter and automatic certainty gates still apply. |

`publishSavedAiReport` is an internal worker operation, not a customer or operations HTTP endpoint. It validates the saved envelope/projection and asks `private.report_ai_publish` to complete the decision. The database uses the actual installed worker SID/JTI and case identity, serializes on the case, compares the entire candidate again and checks its paid scope and active entitlement. Evidence must reference the same case's current or retained version. Current byte hashes come from the document; retained hashes come from the completed immutable upload reservation because the older version table does not itself contain a hash column.

The publication trigger keeps current-input, paid-period, evidence and immutable-history protections. New AI publications require the system AI actor and cannot pass through a forged human approval. The timestamp comes from PostgreSQL. A retry returns the original QA ID and timestamp; simultaneous first calls create one audit entry. Failure before transaction commit rolls back the decision, delivery intention and order-clock completion. Published evidence is not edited; corrections require another revision.

The customer snapshot labels this actor as automation. A shared Hebrew AI disclosure is rendered on the saved-report page and in its PDF. Historical documents are not relabelled. PDF logical text is tested; this is not a tagged PDF/UA or full assistive-technology certification.

The previous 5,000 ILS per-finding automatic ceiling is deliberately preserved until a separately evidenced accuracy-policy change. This is independent of pricing: the engine does not receive price tiers. With one initial month and at most three checked topics, the current initial automatic path cannot reach the 20,000 ILS pricing tier. That tier is defined commercially but is not currently ready for automatic operation. Missing canonical monetary evidence also keeps upgrades unavailable.

Migration `20260908162320_ai_report_publication.sql` is applied only to the isolated DEV database. Nine actual PostgreSQL assertions use independent worker/peer/web roles. They cover altered/foreign scope, byte hash, basis/ceiling and legacy human gates, candidate races, rollback, concurrent replay, customer snapshot, history and unchanged write ACL. Owner-seeded synthetic projections, document metadata and verified-payment rows are identified as fixtures. Both cases and identities were removed and the synthetic machine revoked. No actual monetary computation, provider, Storage transfer, legal attestation or customer-browser publication is implied by this proof.

Runtime INSERT on `case_report_projections` remains unavailable. The trusted monetary composer, activation evidence and canonical projection writer must be completed before this publisher can deliver actual engine output. No source or accuracy gate was opened to manufacture that dependency. Managed worker orchestration, provider reconciliation, published-report regeneration and the remaining acceptance work continue independently.
