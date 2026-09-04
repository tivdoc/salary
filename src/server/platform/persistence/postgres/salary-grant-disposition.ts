// E2-5 / X-4 / H-5. Final disposition of the eight `public.*_salary_*`
// functions whose EXECUTE is granted to `service_role`.
//
// The instruction was: for each function, either move its payment-path caller
// to the runtime path and revoke `service_role`, or record
// `cannot_move: <caller, reason>`. All eight are `cannot_move`, and the reason
// is the same structural one for every one of them — but it is recorded per
// function with its own caller, because a blanket sentence is exactly how a
// function that COULD have moved gets swept along with seven that could not.
//
// Why none can move, stated once and then referenced: all eight callers reach
// Postgres through PostgREST, using a Supabase client authenticated with the
// service-role key. PostgREST picks its Postgres role from the JWT's `role`
// claim, and Supabase issues that claim only as `anon`, `authenticated` or
// `service_role`. There is no JWT that selects `tivdoc_web_runtime` or any
// other narrow role. So "move the caller to the runtime path" is not a grant
// change and not a connection-string swap: it requires either a
// PostgREST-selectable narrow role, which does not exist, or rewriting these
// four live files off `supabase.rpc` onto direct Postgres connections carrying
// their own credentials — an architecture change on the payment-completion and
// conversion-tracking paths.
//
// Revoking `service_role` without doing that first would break payment
// verification and purchase tracking in production. That is the whole reason
// this stayed open across three sessions rather than being quietly done.

export const SALARY_GRANT_BLOCK_REASON =
  "PostgREST selects its Postgres role from the Supabase JWT's role claim, which is only ever anon, authenticated or service_role. No narrow tivdoc_*_runtime role is selectable that way, so the caller cannot be moved by a grant or connection change — it would have to leave supabase.rpc for a direct Postgres connection." as const;

export type SalaryGrantDisposition = Readonly<{
  function_name: string;
  disposition: "cannot_move";
  caller_file: string;
  caller_symbol: string;
  on_payment_path: boolean;
  what_breaks_if_revoked: string;
}>;

export const SALARY_GRANT_DISPOSITIONS: readonly SalaryGrantDisposition[] = Object.freeze([
  {
    function_name: "verify_salary_payment",
    disposition: "cannot_move",
    caller_file: "src/lib/verify-payment.ts",
    caller_symbol: "verifyPendingInvoice4uPayment",
    on_payment_path: true,
    what_breaks_if_revoked: "A paid invoice would never be verified, so a customer who has paid stays blocked.",
  },
  {
    function_name: "claim_salary_payment_completed",
    disposition: "cannot_move",
    caller_file: "src/app/api/cases/status/route.ts",
    caller_symbol: "GET handler",
    on_payment_path: true,
    what_breaks_if_revoked: "The status route could not claim completion exactly once, so completion would be re-emitted or lost.",
  },
  {
    function_name: "claim_salary_meta_purchase",
    disposition: "cannot_move",
    caller_file: "src/lib/meta-purchase.ts",
    caller_symbol: "claim",
    on_payment_path: true,
    what_breaks_if_revoked: "Conversion tracking would double-send or drop, because the claim is what makes it once-only.",
  },
  {
    function_name: "complete_salary_meta_purchase",
    disposition: "cannot_move",
    caller_file: "src/lib/meta-purchase.ts",
    caller_symbol: "complete",
    on_payment_path: true,
    what_breaks_if_revoked: "A claimed conversion could never be marked sent, so it would be retried forever.",
  },
  {
    function_name: "release_salary_meta_purchase",
    disposition: "cannot_move",
    caller_file: "src/lib/meta-purchase.ts",
    caller_symbol: "release",
    on_payment_path: true,
    what_breaks_if_revoked: "A failed send could never be released, so the claim would stay stuck.",
  },
  {
    function_name: "claim_salary_ga4_purchase",
    disposition: "cannot_move",
    caller_file: "src/lib/ga4-server.ts",
    caller_symbol: "claim",
    on_payment_path: true,
    what_breaks_if_revoked: "Same once-only claim as the Meta pair, for the GA4 measurement protocol.",
  },
  {
    function_name: "complete_salary_ga4_purchase",
    disposition: "cannot_move",
    caller_file: "src/lib/ga4-server.ts",
    caller_symbol: "complete",
    on_payment_path: true,
    what_breaks_if_revoked: "A sent GA4 event could never be marked complete, so it would be retried forever.",
  },
  {
    function_name: "release_salary_ga4_purchase",
    disposition: "cannot_move",
    caller_file: "src/lib/ga4-server.ts",
    caller_symbol: "release",
    on_payment_path: true,
    what_breaks_if_revoked: "A failed GA4 send could never be released, so the claim would stay stuck.",
  },
]);

// The four files every one of those callers lives in. Named here so the test
// can check the claim directly instead of trusting this comment.
export const SALARY_GRANT_CALLER_FILES: readonly string[] = Object.freeze([
  "src/lib/verify-payment.ts",
  "src/app/api/cases/status/route.ts",
  "src/lib/meta-purchase.ts",
  "src/lib/ga4-server.ts",
]);

// What would have to exist before any of the eight can be revisited. Written as
// a precondition rather than a wish, so a later session can check it rather
// than re-derive the whole investigation.
export const SALARY_GRANT_UNBLOCK_PRECONDITION =
  "Either a Postgres role that PostgREST can select from a Supabase JWT and that has EXECUTE on exactly these eight functions and nothing else, or an agreed convention for these four files to reach Postgres directly with their own credentials instead of through supabase.rpc." as const;
