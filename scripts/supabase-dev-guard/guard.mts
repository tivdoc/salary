// V0.10.8 Supabase DEV guard.
//
// Every Supabase command in this repository must fail closed unless it is
// unambiguously targeting the isolated Tivdoc DEV project. The guard refuses a
// missing ref, a denylisted ref and any ref whose recorded label is not the DEV
// label, so a Production or customer project can never be reached by accident.
//
// It reads a ref, never a secret. Nothing here prints or returns credentials.

export const SUPABASE_DEV_GUARD_SCHEMA = "tivdoc-supabase-dev-guard-v0.10.8" as const;

/** The only project this repository may target. */
export const TIVDOC_DEV_PROJECT_REF = "cpzrbidxftzqcfeqqusu" as const;
export const TIVDOC_DEV_PROJECT_NAME = "tivdoc-engine-dev-20260902-a7f3c1" as const;
export const TIVDOC_DEV_LABEL = "DEV / SYNTHETIC ONLY / NO CUSTOMER DATA" as const;

/**
 * Refs observed in the account that are NOT the Tivdoc DEV project. They are
 * treated as potentially Production and are refused unconditionally.
 */
export const DENIED_PROJECT_REFS: readonly string[] = Object.freeze([
  "aozbgunwhafabfmuwjol",
  "fcqporzsihuqtfohqtxs",
]);

export type SupabaseGuardOutcome = Readonly<{
  schema_version: typeof SUPABASE_DEV_GUARD_SCHEMA;
  allowed: boolean;
  project_ref: string | null;
  refusal_code:
    | "PROJECT_REF_MISSING"
    | "PROJECT_REF_MALFORMED"
    | "PROJECT_REF_DENYLISTED"
    | "PROJECT_REF_NOT_TIVDOC_DEV"
    | "DEV_LABEL_MISSING"
    | null;
}>;

const REF = /^[a-z]{20}$/u;

/**
 * Fail-closed decision for one candidate ref and label. Anything unproven is a
 * refusal; there is no permissive default and no override flag.
 */
export function evaluateSupabaseDevGuard(input: Readonly<{
  project_ref: string | null | undefined;
  dev_label?: string | null;
}>): SupabaseGuardOutcome {
  const ref = typeof input.project_ref === "string" ? input.project_ref.trim() : "";
  const refuse = (code: NonNullable<SupabaseGuardOutcome["refusal_code"]>): SupabaseGuardOutcome =>
    Object.freeze({
      schema_version: SUPABASE_DEV_GUARD_SCHEMA,
      allowed: false,
      project_ref: ref === "" ? null : ref,
      refusal_code: code,
    });

  if (ref === "") return refuse("PROJECT_REF_MISSING");
  if (!REF.test(ref)) return refuse("PROJECT_REF_MALFORMED");
  if (DENIED_PROJECT_REFS.includes(ref)) return refuse("PROJECT_REF_DENYLISTED");
  if (ref !== TIVDOC_DEV_PROJECT_REF) return refuse("PROJECT_REF_NOT_TIVDOC_DEV");
  if (input.dev_label !== undefined && input.dev_label !== TIVDOC_DEV_LABEL) {
    return refuse("DEV_LABEL_MISSING");
  }
  return Object.freeze({
    schema_version: SUPABASE_DEV_GUARD_SCHEMA,
    allowed: true,
    project_ref: ref,
    refusal_code: null,
  });
}

/** Throws unless the environment names the Tivdoc DEV project. */
export function assertSupabaseDevTarget(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const outcome = evaluateSupabaseDevGuard({
    project_ref: environment.SUPABASE_PROJECT_REF,
    dev_label: environment.SUPABASE_PROJECT_LABEL ?? TIVDOC_DEV_LABEL,
  });
  if (!outcome.allowed) throw new Error(`SUPABASE_DEV_GUARD_REFUSED:${outcome.refusal_code}`);
  return outcome.project_ref as string;
}
