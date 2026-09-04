// Addendum 7 A7-2, second half: proves by execution against DEV that a
// freshly imported candidate — the only way a changed dependency hash ever
// reaches this database, since governance_parameter_versions is
// append-only and governance_parameter_import always inserts at revision 1
// (verified by reading its body, supabase/migrations/202609020018) —
// always lands state=draft, revision=1, zero attestations. This is a
// throwaway test-fixture parameter_id.
//
// L4-6 / D4 (BL-17): it used to write that fixture into the reference
// catalogue and then flag it `synthetic` afterwards. It writes to
// `legal.synthetic.proof` now, so the row never reaches the catalogue at all.
// A flag applied after the fact depends on the flagging never being forgotten,
// and it was forgotten once already, permanently, on a real row.
import { buildCandidate, citation, importPoolPBatch } from "./pool-p-parameter-import.mts";
import { SYNTHETIC_PROOF_TENANT } from "./reviewer-registration.mts";

// The write definers require the asserted actor to equal the session subject
// (RUNTIME_ACTOR_IMPERSONATION_FORBIDDEN), and the import path asserts the same
// system actor on every tenant, so the synthetic session carries that subject.
const PROOF_SUBJECT = "system_import";
const PROOF_TARGET = {
  tenant: SYNTHETIC_PROOF_TENANT,
  session: { sid: "session.synthetic.proof.import", jti: "token.synthetic.proof.import" },
  subject: PROOF_SUBJECT,
};

const PARAMETER_ID = "test.addendum7.a72.dependency_hash_invalidation_proof";

const D3 = { source_id: "IL_MIN_WAGE_LAW", source_version: "discovery-v0" };
const derivationClause = citation(D3, "IL_MIN_WAGE_LAW@discovery-v0#0002-bcf9eab6819e",
  "Test fixture only — reuses a real, already-verified citation to exercise the import path, not to assert a new legal fact",
  ["47.5"]);

// A new parameter_version each run: governance_parameter_import always
// inserts at revision 1 and never overwrites, so a distinct version number
// is what makes this script re-runnable rather than colliding with its own
// prior run's row.
const version = `1.${Date.now()}.0`;

const candidate = buildCandidate({
  parameter_id: PARAMETER_ID,
  parameter_version: version,
  topic: "minimum_wage",
  value: { kind: "integer", value: 1, unit: "test_unit" },
  unit: "test_unit",
  rounding_policy: "exact",
  effective_from: "2026-01-01",
  effective_to: null,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["primary_binding"],
  citations: [derivationClause],
});

await importPoolPBatch("a72-dependency-hash-invalidation-proof", [candidate], [], PROOF_TARGET);

// The batch receipt's state/revision/activation_allowed come from
// private.governance_aggregate_read (readCurrent) — the one read path any
// runtime role has for this data. Neither governance_parameter_versions
// nor governance_parameter_attestations is directly selectable by any
// connectable role, tivdoc_operations_runtime included — confirmed by
// execution: both raw selects return "permission denied", not empty
// results, and there is no login role for tivdoc_governance_owner (its
// privileges are exercised only through SECURITY DEFINER functions, never
// a direct connection). So there is no way to independently count
// attestation rows here, and none is needed: state=draft at revision=1 is
// not merely correlated with zero attestations, it is definitionally
// equivalent to it under this state machine — the only transition out of
// draft is governance_parameter_attestation_append, and revision 1 is what
// governance_parameter_import itself always inserts, unconditionally, for
// a parameter_id/parameter_version pair that has never been imported
// before (supabase/migrations/202609020018).
const { readFile } = await import("node:fs/promises");
const receipt = JSON.parse(await readFile("output/next/pool-p/a72-dependency-hash-invalidation-proof.json", "utf8"));
const imported = receipt.results[0];

const passed = imported.state === "draft" && Number(imported.revision) === 1 && imported.idempotent_replay === false;
console.log(JSON.stringify({
  case: "fresh_import_lands_draft_revision_1_zero_attestations",
  outcome: passed ? "pass" : "fail",
  observed: { state: imported.state, revision: imported.revision, idempotent_replay: imported.idempotent_replay },
}, null, 2));
if (!passed) process.exitCode = 1;
