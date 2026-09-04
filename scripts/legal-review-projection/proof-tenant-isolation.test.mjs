// L4-6 / D4 (BL-17). Proof rows belong on the synthetic proof tenant, and this
// is the check that keeps them there.
//
// The rule is not "no script mentions the reference tenant" — several must, and
// one of them exists precisely to prove that the reference tenant refuses
// things. The rule is an inventory: every script that writes governance state
// is listed here with the tenant it writes to and, when that tenant is the real
// catalogue, the reason it cannot be anywhere else. A script that starts
// writing, or changes which tenant it writes to, fails this test until someone
// edits the list — and editing the list is the review.
//
// Why an inventory rather than a cleverer analysis: the tenant a call ends up
// using is decided at run time through a session, several frames from any
// literal. Anything inferring it statically would be guessing, and a guard that
// guesses eventually waves something through.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIRECTORY = path.join("scripts", "legal-review-projection");

/** Any call that changes durable governance state. */
const WRITE_MARKERS = [
  "importPoolPBatch(", "importCandidate(",
  "governance_parameter_import", "governance_parameter_supersede",
  "governance_parameter_attestation_append",
  "governance_legal_open_decision_register", "governance_legal_open_decision_withdraw",
  "governance_legal_open_decision_mark_synthetic", "governance_legal_open_decision_annotate",
  "legal_operations_execution_trace_append",
  // L5-5: instrument selections are governance state too.
  "governance_legal_instrument_selection_register", "governance_legal_instrument_selection_supersede",
  "governance_reviewer_append", "governance_key_challenge_append",
  "governance_trust_organization_append", "governance_trust_policy_append",
  "governance_reviewer_key_register", "product_session_revoke",
  // The same writes through the repository objects rather than raw SQL.
  "appendOrganization(", "appendPolicy(", "appendReviewer(", "appendKeyChallenge(",
  "registerProvenKey(", ".enqueue(",
];

const REFERENCE = "reference";
const SYNTHETIC = "synthetic-proof";
const OWN = "own-per-run-tenant";

/**
 * Every governance writer, and where it writes. `REFERENCE` entries carry the
 * reason; the others do not need one.
 */
const WRITERS = Object.freeze({
  "decision-sensitivity-run.mts": [REFERENCE,
    "Superseded by v3 and kept unchanged as the artifact that produced report v2. It is not re-run."],
  "decision-sensitivity-run-v3.mts": [SYNTHETIC, ""],
  "decision-sensitivity-run-v4.mts": [SYNTHETIC, ""],
  "decision-sensitivity-run-v5.mts": [SYNTHETIC, ""],
  "decision-sensitivity-run-v6.mts": [SYNTHETIC, ""],
  // L7-6: the draft shadow run appends one trace per executed synthetic case.
  "draft-shadow-run-v1.mts": [SYNTHETIC, ""],
  "grant-execution-proof.mts": [OWN, ""],
  "ground-truth-matrix.mts": [OWN, ""],
  "ground-truth-queue-map.mts": [OWN, ""],
  "identity-negative-matrix.mts": [OWN, ""],
  "identity-session-recovery.mts": [REFERENCE,
    "Rewrites the reference tenant's own system-import session idempotently, which is the recovery procedure it documents."],
  "instrument-selection.mts": [REFERENCE,
    "Registers real draft instrument selections on the reference tenant: the boundary a selected figure's citation carries and its attestation attests."],
  "identity-session-revocation.mts": [REFERENCE,
    "Revokes residue sessions on the reference tenant. The residue is there; revoking it elsewhere would revoke nothing."],
  "legal-open-decision-withdrawal.mts": [REFERENCE,
    "Carries one real record — the vacation withdrawal and its correction — alongside its synthetic cases."],
  "legal-reference-tenant-guards.mts": [REFERENCE,
    "Exists to prove the reference tenant refuses things. Moving it would delete the guard it checks."],
  "parameter-decision-matrix.mts": [OWN, ""],
  "parameter-supersession-proof.mts": [REFERENCE,
    "Supersedes real Pool P rows and counts the real legal decisions. Its synthetic fixtures are flagged at registration."],
  "pool-p-batch-1-minimum-wage.mts": [REFERENCE, "Real draft parameters, the minimum-wage catalogue."],
  "pool-p-batch-2-youth.mts": [REFERENCE, "Real draft parameters, the youth and apprentice rates."],
  "pool-p-batch-3-working-time.mts": [REFERENCE, "Real draft parameters, the working-time thresholds."],
  "pool-p-batch-4-pension-travel.mts": [REFERENCE, "Real draft parameters, the pension cap and the travel cap."],
  "pool-p-batch-5-convalescence-vacation-sick.mts": [REFERENCE, "Real draft parameters for convalescence, vacation and sick pay."],
  "pool-p-batch-6-vacation-current-table.mts": [REFERENCE, "Real draft parameters, the current vacation table."],
  "pool-p-batch-7-vacation-amendment-15-scope.mts": [REFERENCE, "Real draft parameters, Amendment 15's scope correction."],
  "pool-p-batch-8-table-aware.mts": [REFERENCE,
    "Real draft parameters, and the supersession of three real revisions whose citations moved to the table-aware chunks."],
  "pool-p-batch-9-lexicon.mts": [REFERENCE, "Real draft parameters, the figures the law states as words, bound through the numeral lexicon."],
  "pool-p-batch-11-visual.mts": [REFERENCE, "Real draft parameters, the 1951 premiums read from the page image (inferred_visual)."],
  "pool-p-batch-12-composition-decision.mts": [REFERENCE, "One real open decision, the rest-day overtime composition; no parameters."],
  "pool-p-batch-13-pension-visual.mts": [REFERENCE,
    "Real draft parameters, the 2016 pension order's shares read from the page image, the 2014 rows re-registered on the precedence decision, and the supersession of the 2014.1.0 rows."],
  "pool-p-batch-14-convalescence-bands.mts": [REFERENCE, "Real draft parameters, the 1988 order's seniority bands."],
  "pool-p-batch-15-threshold-visual.mts": [REFERENCE, "Real draft parameter, the 2025 threshold read from the typeset page (inferred_visual)."],
  "pool-p-batch-16-daily-threshold.mts": [REFERENCE, "Real draft parameter, §2's eight hours through the lexicon, and the daily-threshold decision (L7-9 / D6)."],
  "pool-p-batch-10-selections.mts": [REFERENCE, "Real draft parameters, the figures inside the three instrument selections."],
  "pool-p-dependency-hash-invalidation-proof.mts": [SYNTHETIC, ""],
  "pool-p-parameter-import.mts": [REFERENCE,
    "Owns the reference tenant constant and the import path. Every real draft parameter and open decision goes through it."],
  "reviewer-registration.mts": [SYNTHETIC, ""],
  "rulespec-trace-replay.mts": [REFERENCE,
    "R-14's durable trace proof, whose fixtures predate the synthetic tenant and whose ids are already recorded in the frozen matrix."],
});

function governanceWriters() {
  return readdirSync(DIRECTORY)
    .filter((name) => name.endsWith(".mts"))
    .map((name) => ({ name, source: readFileSync(path.join(DIRECTORY, name), "utf8") }))
    .filter((entry) => entry.source.split("\n").some((line) =>
      !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*")
      && WRITE_MARKERS.some((marker) => line.includes(marker))))
    .map((entry) => entry.name)
    .sort();
}

describe("proof rows stay off the reference tenant", () => {
  it("the inventory names every governance writer and nothing else", () => {
    expect(governanceWriters()).toEqual(Object.keys(WRITERS).sort());
  });

  it("every reference-tenant writer states why it cannot move", () => {
    for (const [name, [tenant, reason]] of Object.entries(WRITERS)) {
      if (tenant !== REFERENCE) {
        expect(reason, `${name} is not on the reference tenant and needs no excuse`).toBe("");
        continue;
      }
      expect(reason.length, name).toBeGreaterThan(40);
      expect(reason.endsWith("."), name).toBe(true);
    }
  });

  it("the synthetic proof tenant is one constant, exported once", () => {
    const definitions = readdirSync(DIRECTORY)
      .filter((name) => name.endsWith(".mts"))
      .filter((name) => /SYNTHETIC_PROOF_TENANT\s*=/u.test(readFileSync(path.join(DIRECTORY, name), "utf8")));
    expect(definitions).toEqual(["reviewer-registration.mts"]);
  });

  it("no writer spells the reference tenant out inline", () => {
    // A literal beside a write call is how a constant gets bypassed. The file
    // that defines it and the guard that must name it to refuse it are the only
    // places the string may appear in a writer.
    const allowed = new Set(["pool-p-parameter-import.mts", "legal-reference-tenant-guards.mts"]);
    const offenders = governanceWriters()
      .filter((name) => !allowed.has(name))
      .filter((name) => readFileSync(path.join(DIRECTORY, name), "utf8").split("\n")
        .some((line) => line.includes('"legal.reference.il"') && !line.trimStart().startsWith("//")));
    expect(offenders).toEqual([]);
  });

  it("every synthetic writer really reaches the synthetic constant", () => {
    for (const [name, [tenant]] of Object.entries(WRITERS)) {
      if (tenant !== SYNTHETIC) continue;
      expect(readFileSync(path.join(DIRECTORY, name), "utf8"), name).toContain("SYNTHETIC_PROOF_TENANT");
    }
  });
});
