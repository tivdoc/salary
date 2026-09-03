HEAD 761a63bedeb16a36968b8722e8de201d9e8f2119 (matches expected 761a63b)

CEP-006 | both_wrong | resolveCanonicalOperationsService | caller: src/app/operations/page.tsx:18 | Route calls resolver; managed identity unproven
CEP-007 | both_wrong | resolveCanonicalPortalService | caller: src/app/portal/page.tsx:18 | Route calls resolver; managed identity unproven
CEP-013 | checker_wrong | startCanonicalApplicationPostgres | caller: src/server/product/runtime/durable-local-runtime.ts:128 | Startup root calls it, route doesn't
CEP-014 | checker_wrong | startCanonicalApplicationPostgres | caller: src/server/product/runtime/durable-local-runtime.ts:128 | Startup root calls it, route doesn't
CEP-015 | checker_wrong | startCanonicalApplicationPostgres | caller: src/server/product/runtime/durable-local-runtime.ts:128 | Startup root calls it, route doesn't
CEP-016 | checker_wrong | SupabasePrivateBlobProvider | caller: NONE | Provider class constructed nowhere in tree
CEP-017 | checker_wrong | SupabasePrivateBlobProvider | caller: NONE | Provider class constructed nowhere in tree
CEP-020 | both_wrong | resolveCanonicalOperationsService | caller: src/app/api/operations/[...segments]/route.ts:20 | Route calls resolver; managed identity unproven
CEP-025 | both_wrong | resolveCanonicalPortalService | caller: src/app/api/portal/[[...resource]]/route.ts:19 | Route calls resolver; managed identity unproven
CEP-027 | checker_wrong | PostgresJobsOutboxAuditRepository | caller: src/server/platform/composition/canonical-postgres.ts:273 | Repository built, but no resident worker
CEP-028 | checker_wrong | PostgresJobsOutboxAuditRepository | caller: src/server/platform/composition/canonical-postgres.ts:273 | No worker; external delivery gate blocked
CEP-078 | claim_wrong | installCanonicalProductApplicationComposition | caller: src/server/product/runtime/durable-local-runtime.ts:231 | Non-test composition root installs it now
CEP-079 | claim_wrong | DurableProductPostgresApplication | caller: src/server/product/routes/durable-registration.ts:89 | Stable routes resolve installed durable application
CEP-080 | checker_wrong | InternalOpsService | caller: src/server/product/internal-ops/runtime.ts:22 | Orphan file; walker hardcodes it entrypoint
CEP-081 | checker_wrong | CustomerPortalService | caller: NONE | Only harness and fixtures construct it
