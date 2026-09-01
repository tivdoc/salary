import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { RLS_SECURITY_DEFINER_SERVICE_EXPECTATIONS } from "./rls.mts";

describe("V0.10.2 RLS regression expectations", () => {
  it("keeps service_role only on the narrow maintenance and legacy payment surfaces", () => {
    expect(RLS_SECURITY_DEFINER_SERVICE_EXPECTATIONS.size).toBe(79);
    expect([...RLS_SECURITY_DEFINER_SERVICE_EXPECTATIONS.entries()]
      .filter(([, executable]) => executable)
      .map(([name]) => name)
      .sort()).toEqual([
      "private.claim_controlled_import_recovery",
      "private.controlled_import_publish",
      "private.controlled_import_reject",
      "private.controlled_import_reserve",
      "private.controlled_import_stage_exact_bytes",
      "private.open_controlled_import_published_bytes",
      "private.product_identity_session_register",
      "private.product_session_revoke",
      "private.product_session_rotate",
      "private.resolve_engine_case_id",
      "public.claim_salary_ga4_purchase",
      "public.claim_salary_meta_purchase",
      "public.claim_salary_payment_completed",
      "public.complete_salary_ga4_purchase",
      "public.complete_salary_meta_purchase",
      "public.release_salary_ga4_purchase",
      "public.release_salary_meta_purchase",
      "public.verify_salary_payment",
    ]);
  });

  it("recognizes service, verified-runtime, owner, and context policy families separately", async () => {
    const source = await readFile(new URL("./rls.mts", import.meta.url), "utf8");
    for (const policy of [
      "tivdoc_service_tenant_scope",
      "tivdoc_runtime_verified_tenant",
      "tivdoc_owner_verified_tenant",
      "tivdoc_runtime_context_session_lookup",
    ]) expect(source).toContain(policy);
    expect(source).toContain("EXPECTED_RUNTIME_OWNER_POLICY_TABLES.length + 1");
  });
});
