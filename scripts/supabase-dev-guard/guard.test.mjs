import { describe, expect, it } from "vitest";

import {
  assertSupabaseDevTarget,
  DENIED_PROJECT_REFS,
  evaluateSupabaseDevGuard,
  SUPABASE_DEV_GUARD_SCHEMA,
  TIVDOC_DEV_LABEL,
  TIVDOC_DEV_PROJECT_REF,
} from "./guard.mts";

describe("V0.10.8 Supabase DEV guard", () => {
  it("allows only the Tivdoc DEV project ref", () => {
    const outcome = evaluateSupabaseDevGuard({ project_ref: TIVDOC_DEV_PROJECT_REF });
    expect(outcome.schema_version).toBe(SUPABASE_DEV_GUARD_SCHEMA);
    expect(outcome.allowed).toBe(true);
    expect(outcome.refusal_code).toBeNull();
  });

  it("refuses every other observed project as potentially production", () => {
    expect(DENIED_PROJECT_REFS.length).toBeGreaterThan(0);
    for (const ref of DENIED_PROJECT_REFS) {
      const outcome = evaluateSupabaseDevGuard({ project_ref: ref });
      expect(outcome.allowed).toBe(false);
      expect(outcome.refusal_code).toBe("PROJECT_REF_DENYLISTED");
    }
  });

  it("refuses a missing, blank or malformed ref rather than defaulting", () => {
    for (const ref of [undefined, null, "", "   ", "SHORT", "not-a-ref", `${TIVDOC_DEV_PROJECT_REF}x`]) {
      expect(evaluateSupabaseDevGuard({ project_ref: ref }).allowed).toBe(false);
    }
    expect(evaluateSupabaseDevGuard({ project_ref: undefined }).refusal_code).toBe("PROJECT_REF_MISSING");
    expect(evaluateSupabaseDevGuard({ project_ref: "not-a-ref" }).refusal_code).toBe("PROJECT_REF_MALFORMED");
  });

  it("refuses an unknown but well-formed ref", () => {
    const outcome = evaluateSupabaseDevGuard({ project_ref: "abcdefghijklmnopqrst" });
    expect(outcome.allowed).toBe(false);
    expect(outcome.refusal_code).toBe("PROJECT_REF_NOT_TIVDOC_DEV");
  });

  it("refuses the right ref carrying the wrong label", () => {
    const outcome = evaluateSupabaseDevGuard({
      project_ref: TIVDOC_DEV_PROJECT_REF, dev_label: "PRODUCTION",
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.refusal_code).toBe("DEV_LABEL_MISSING");
  });

  it("never returns a secret, only a ref", () => {
    const outcome = evaluateSupabaseDevGuard({ project_ref: TIVDOC_DEV_PROJECT_REF });
    expect(Object.keys(outcome).sort()).toEqual(["allowed", "project_ref", "refusal_code", "schema_version"]);
  });

  it("asserts against an environment and throws fail-closed", () => {
    expect(assertSupabaseDevTarget({
      SUPABASE_PROJECT_REF: TIVDOC_DEV_PROJECT_REF, SUPABASE_PROJECT_LABEL: TIVDOC_DEV_LABEL,
    })).toBe(TIVDOC_DEV_PROJECT_REF);
    expect(() => assertSupabaseDevTarget({})).toThrow(/PROJECT_REF_MISSING/u);
    expect(() => assertSupabaseDevTarget({ SUPABASE_PROJECT_REF: DENIED_PROJECT_REFS[0] }))
      .toThrow(/PROJECT_REF_DENYLISTED/u);
    expect(() => assertSupabaseDevTarget({
      SUPABASE_PROJECT_REF: TIVDOC_DEV_PROJECT_REF, SUPABASE_PROJECT_LABEL: "PROD",
    })).toThrow(/DEV_LABEL_MISSING/u);
  });
});
