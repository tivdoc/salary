// L4-6 / D4 (BL-17), rebuilt by L8-2 / D1. Proof rows belong on the synthetic
// proof tenant, and this is the check that keeps them there.
//
// The rule is not "no script mentions the reference tenant" — several must, and
// one of them exists precisely to prove that the reference tenant refuses
// things. The rule is an inventory: every script that writes governance state,
// the tenant it writes to and, when that tenant is the real catalogue, the
// reason it cannot be anywhere else.
//
// Until long run 8 the tenant column was hand-written beside the reason, and
// the checks read only what was hand-written. That let a false pass stand:
// `draft-shadow-run-v1.mts` re-seeds the reference tenant's system session
// through an imported constant, and the inventory said `synthetic-proof`. The
// original comment here argued that inferring the tenant statically "would be
// guessing". It was half right: a guard that guesses waves things through, and
// so does a guard that asks the author. So the tenant column is now DERIVED —
// `writer-inventory.mjs` follows every write to the tenant expression and that
// expression through one import hop — and a tenant it cannot decide fails the
// suite instead of being filed under whatever the author believed. Only the
// reason stays hand-written, because a reason is a judgement.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  OWN, PARAMETERISED, REFERENCE, SYNTHETIC, UNDECIDABLE,
  deriveWriterInventory, inventoryFindings,
} from "./writer-inventory.mjs";

const DIRECTORY = path.join("scripts", "legal-review-projection");

/**
 * Why each reference-tenant writer cannot move. This is the only hand-written
 * column: which files write to the reference tenant is derived, and a file
 * that starts doing so fails the suite until a reason is written here.
 */
const REASONS = Object.freeze({
  "decision-sensitivity-run.mts":
    "Superseded by v3 and kept unchanged as the artifact that produced report v2. It is not re-run.",
  // L8-2: reclassified. The false pass long run 7 recorded — listed synthetic,
  // derived reference — is corrected here, not by editing the script.
  "draft-shadow-run-v1.mts":
    "Re-seeds the reference tenant's own system-import session idempotently before executing, the recovery procedure identity-session-recovery.mts documents; its traces go to the synthetic proof tenant.",
  "identity-session-recovery.mts":
    "Rewrites the reference tenant's own system-import session idempotently, which is the recovery procedure it documents.",
  "instrument-selection.mts":
    "Registers real draft instrument selections on the reference tenant: the boundary a selected figure's citation carries and its attestation attests.",
  "identity-session-revocation.mts":
    "Revokes residue sessions on the reference tenant. The residue is there; revoking it elsewhere would revoke nothing.",
  // L11-2 / D2: the six owner-recorded resolutions are real rows on the
  // reference tenant; every refusal case runs on the synthetic proof tenant.
  // L11-5 / D3.6: the BL-24 attribution correction is an annotation appended
  // against the real daily-threshold decision on the reference tenant.
  "bl24-attribution-annotation.mts":
    "Appends the corrected BL-24 attribution against the real working_time_daily_threshold decision on the reference tenant, through the annotate path.",
  "legal-decision-resolutions.mts":
    "Records the six owner-recorded resolutions on the reference tenant from the lawyer-approved opinion's pinned hashes; its refusal cases run on the synthetic proof tenant.",
  "legal-open-decision-withdrawal.mts":
    "Carries one real record — the vacation withdrawal and its correction — alongside its synthetic cases.",
  "legal-reference-tenant-guards.mts":
    "Exists to prove the reference tenant refuses things. Moving it would delete the guard it checks.",
  // L8-2: the second inventory gap. `register` creates the owner's real
  // reviewer identity on the reference tenant, at a keyboard only; `prove`
  // runs the same path on the synthetic proof tenant.
  "owner-reviewer-identity.mts":
    "Its register command creates the owner's real reviewer identity on the reference tenant, at a keyboard only; keygen and prove create nothing real.",
  "parameter-supersession-proof.mts":
    "Supersedes real Pool P rows and counts the real legal decisions. Its synthetic fixtures are flagged at registration.",
  "pool-p-batch-1-minimum-wage.mts": "Real draft parameters, the minimum-wage catalogue.",
  "pool-p-batch-2-youth.mts": "Real draft parameters, the youth and apprentice rates.",
  "pool-p-batch-3-working-time.mts": "Real draft parameters, the working-time thresholds.",
  "pool-p-batch-4-pension-travel.mts": "Real draft parameters, the pension cap and the travel cap.",
  "pool-p-batch-5-convalescence-vacation-sick.mts": "Real draft parameters for convalescence, vacation and sick pay.",
  "pool-p-batch-6-vacation-current-table.mts": "Real draft parameters, the current vacation table.",
  "pool-p-batch-7-vacation-amendment-15-scope.mts": "Real draft parameters, Amendment 15's scope correction.",
  "pool-p-batch-8-table-aware.mts":
    "Real draft parameters, and the supersession of three real revisions whose citations moved to the table-aware chunks.",
  "pool-p-batch-9-lexicon.mts": "Real draft parameters, the figures the law states as words, bound through the numeral lexicon.",
  "pool-p-batch-10-selections.mts": "Real draft parameters, the figures inside the three instrument selections.",
  "pool-p-batch-17-average-wage.mts": "Real draft parameters, the two average-wage figures: §1 for the minimum-wage base, §2 benefits for the pension cap.",
  "pool-p-batch-18-havraa-year.mts": "Real draft parameter, the convalescence-year reading of the 2026 rate as its own version and branch.",
  "pool-p-batch-19-rest-day-daily-threshold.mts": "Registers one real open decision on the reference tenant, the rest day's own threshold, with no parameter.",
  "pool-p-batch-11-visual.mts": "Real draft parameters, the 1951 premiums read from the page image (inferred_visual).",
  "pool-p-batch-12-composition-decision.mts": "One real open decision, the rest-day overtime composition; no parameters.",
  "pool-p-batch-13-pension-visual.mts":
    "Real draft parameters, the 2016 pension order's shares read from the page image, the 2014 rows re-registered on the precedence decision, and the supersession of the 2014.1.0 rows.",
  "pool-p-batch-14-convalescence-bands.mts": "Real draft parameters, the 1988 order's seniority bands.",
  "pool-p-batch-15-threshold-visual.mts": "Real draft parameter, the 2025 threshold read from the typeset page (inferred_visual).",
  "pool-p-batch-16-daily-threshold.mts": "Real draft parameter, §2's eight hours through the lexicon, and the daily-threshold decision (L7-9 / D6).",
  "pool-p-parameter-import.mts":
    "Owns the reference tenant constant and the import path. Every real draft parameter and open decision goes through it, as its default target.",
  "rulespec-trace-replay.mts":
    "R-14's durable trace proof, whose fixtures predate the synthetic tenant and whose ids are already recorded in the frozen matrix.",
});

/**
 * The derived classification, pinned. A file that changes class — a proof
 * that starts reaching the catalogue, a batch that stops — fails here until
 * the pin is moved, and moving the pin is the review.
 */
const EXPECTED = Object.freeze({
  "decision-sensitivity-run.mts": REFERENCE,
  "decision-sensitivity-run-v3.mts": SYNTHETIC,
  "decision-sensitivity-run-v4.mts": SYNTHETIC,
  "decision-sensitivity-run-v5.mts": SYNTHETIC,
  "decision-sensitivity-run-v6.mts": SYNTHETIC,
  // L8-8: v7 is v6 rebuilt on the fifteen-spec shadow; reads the catalogue, writes its traces to the proof tenant.
  "decision-sensitivity-run-v7.mts": SYNTHETIC,
  "draft-shadow-run-v1.mts": REFERENCE,
  "dynamic-matrix.mts": OWN,
  "grant-execution-proof.mts": OWN,
  "ground-truth-matrix.mts": OWN,
  "ground-truth-queue-map.mts": OWN,
  "identity-negative-matrix.mts": OWN,
  "identity-session-recovery.mts": REFERENCE,
  "identity-session-revocation.mts": REFERENCE,
  "instrument-selection.mts": REFERENCE,
  "bl24-attribution-annotation.mts": REFERENCE,
  "legal-decision-resolutions.mts": REFERENCE,
  "legal-open-decision-withdrawal.mts": REFERENCE,
  "legal-reference-tenant-guards.mts": REFERENCE,
  "observation-supersede.mts": OWN,
  "owner-reviewer-identity.mts": REFERENCE,
  "parameter-decision-matrix.mts": OWN,
  "parameter-supersession-proof.mts": REFERENCE,
  "pool-p-batch-1-minimum-wage.mts": REFERENCE,
  "pool-p-batch-2-youth.mts": REFERENCE,
  "pool-p-batch-3-working-time.mts": REFERENCE,
  "pool-p-batch-4-pension-travel.mts": REFERENCE,
  "pool-p-batch-5-convalescence-vacation-sick.mts": REFERENCE,
  "pool-p-batch-6-vacation-current-table.mts": REFERENCE,
  "pool-p-batch-7-vacation-amendment-15-scope.mts": REFERENCE,
  "pool-p-batch-8-table-aware.mts": REFERENCE,
  "pool-p-batch-9-lexicon.mts": REFERENCE,
  "pool-p-batch-10-selections.mts": REFERENCE,
  "pool-p-batch-17-average-wage.mts": REFERENCE,
  "pool-p-batch-18-havraa-year.mts": REFERENCE,
  "pool-p-batch-19-rest-day-daily-threshold.mts": REFERENCE,
  "pool-p-batch-11-visual.mts": REFERENCE,
  "pool-p-batch-12-composition-decision.mts": REFERENCE,
  "pool-p-batch-13-pension-visual.mts": REFERENCE,
  "pool-p-batch-14-convalescence-bands.mts": REFERENCE,
  "pool-p-batch-15-threshold-visual.mts": REFERENCE,
  "pool-p-batch-16-daily-threshold.mts": REFERENCE,
  "pool-p-dependency-hash-invalidation-proof.mts": SYNTHETIC,
  "pool-p-parameter-import.mts": REFERENCE,
  "project.mts": OWN,
  "reviewer-registration.mts": PARAMETERISED,
  "rulespec-trace-replay.mts": REFERENCE,
});

const { inventory, findings } = inventoryFindings(DIRECTORY, REASONS);

describe("proof rows stay off the reference tenant", () => {
  it("the derived inventory has no finding: no undecidable tenant, every reference writer with its reason", () => {
    expect(findings).toEqual([]);
  });

  it("the derived classification is the pinned one, file by file", () => {
    const derived = Object.fromEntries(Object.entries(inventory).map(([name, entry]) => [name, entry.classification]));
    expect(derived).toEqual(EXPECTED);
  });

  it("the false pass is closed: the draft shadow run reaches the reference tenant through an import, and the inventory says so", () => {
    const entry = inventory["draft-shadow-run-v1.mts"];
    expect(entry.classification).toBe(REFERENCE);
    const seed = entry.sites.filter((site) => site.kind === "helper" && site.name === "seedSessions");
    expect(seed.map((site) => site.tenant).sort()).toEqual([REFERENCE, SYNTHETIC]);
    // The file never spells the tenant; the resolver followed `TENANT` to the file that owns it.
    expect(readFileSync(path.join(DIRECTORY, "draft-shadow-run-v1.mts"), "utf8")).not.toContain('"legal.reference.il"');
  });

  it("the second gap is closed: the owner identity command is a reference writer through registerReviewerIdentity", () => {
    const entry = inventory["owner-reviewer-identity.mts"];
    expect(entry.classification).toBe(REFERENCE);
    expect(entry.sites.filter((site) => site.tenant === REFERENCE).map((site) => site.name)).toEqual(["registerReviewerIdentity"]);
  });

  it("every batch reaches the reference tenant through the import path's default target, not a literal", () => {
    for (const [name, entry] of Object.entries(inventory)) {
      if (!name.startsWith("pool-p-batch-")) continue;
      expect(entry.sites.some((site) => site.name === "importPoolPBatch" && site.tenant === REFERENCE), name).toBe(true);
    }
    expect(inventory["pool-p-parameter-import.mts"].sites.some((site) => site.kind === "default_parameter" && site.tenant === REFERENCE)).toBe(true);
    expect(inventory["pool-p-dependency-hash-invalidation-proof.mts"].sites.map((site) => site.tenant)).toEqual([SYNTHETIC]);
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
    const offenders = Object.keys(inventory)
      .filter((name) => !allowed.has(name))
      .filter((name) => readFileSync(path.join(DIRECTORY, name), "utf8").split("\n")
        .some((line) => line.includes('"legal.reference.il"') && !line.trimStart().startsWith("//")));
    expect(offenders).toEqual([]);
  });
});

/**
 * The guard proven by breaking it. A directory of fixture writers, built the
 * way the real ones are built: a file owns the constant, a helper takes the
 * tenant, writers reach the constant by import, by re-export, by the helper's
 * default, and by nothing the resolver can follow.
 */
describe("the derived inventory, proven by breaking it", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tivdoc-writer-inventory-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function fixture(name, files) {
    const directory = path.join(root, name);
    mkdirSync(directory, { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(path.join(directory, file), text);
    return directory;
  }

  const OWNER = 'export const TENANT = "legal.reference.il";\nexport const SYNTHETIC_PROOF_TENANT = "legal.synthetic.proof";\n';
  const HELPERS = 'export async function seedSessions(tenant: string, orgId: string, sessions: unknown[]): Promise<void> { void tenant; void orgId; void sessions; }\n'
    + 'import { TENANT } from "./owner.mts";\n'
    + 'export async function importPoolPBatch(batch: unknown, candidates: unknown[], open: unknown[] = [], target = { tenant: TENANT, session: "s", subject: "a" }): Promise<void> { void batch; void candidates; void open; void target; }\n';

  it("a writer reaching the reference tenant through an import is a reference writer, and fails without a reason", () => {
    const directory = fixture("import", {
      "owner.mts": OWNER,
      "helpers.mts": HELPERS,
      "writer.mts": 'import { TENANT } from "./owner.mts";\nimport { seedSessions } from "./helpers.mts";\nawait seedSessions(TENANT, `${TENANT}.org`, []);\n',
    });
    const { inventory: derived, findings: found } = inventoryFindings(directory, {});
    expect(derived["writer.mts"].classification).toBe(REFERENCE);
    expect(found).toEqual(["writer.mts: reference writer without a reason — helper:seedSessions@3"]);
    expect(inventoryFindings(directory, { "writer.mts": "A reason of more than forty characters that ends with a full stop, as the rule requires." }).findings).toEqual([]);
  });

  it("a re-export is one more hop, and still reaches the constant", () => {
    const directory = fixture("reexport", {
      "owner.mts": OWNER,
      "hop.mts": 'export { TENANT as REFERENCE_TENANT } from "./owner.mts";\n',
      "helpers.mts": HELPERS,
      "writer.mts": 'import { REFERENCE_TENANT } from "./hop.mts";\nimport { seedSessions } from "./helpers.mts";\nawait seedSessions(REFERENCE_TENANT, "org", []);\n',
    });
    const { inventory: derived, findings: found } = inventoryFindings(directory, {});
    expect(derived["writer.mts"].classification).toBe(REFERENCE);
    expect(found).toHaveLength(1);
  });

  it("a helper's default target binds the caller that omits it", () => {
    const directory = fixture("default", {
      "owner.mts": OWNER,
      "helpers.mts": HELPERS,
      "batch.mts": 'import { importPoolPBatch } from "./helpers.mts";\nawait importPoolPBatch({}, []);\n',
      "proof.mts": 'import { importPoolPBatch } from "./helpers.mts";\nimport { SYNTHETIC_PROOF_TENANT } from "./owner.mts";\nawait importPoolPBatch({}, [], [], { tenant: SYNTHETIC_PROOF_TENANT, session: "s", subject: "a" });\n',
    });
    const { inventory: derived } = inventoryFindings(directory, { "batch.mts": "The batch reaches the catalogue through the helper's default target, as the real ones do." });
    expect(derived["batch.mts"].classification).toBe(REFERENCE);
    expect(derived["proof.mts"].classification).toBe(SYNTHETIC);
  });

  it("a tenant the resolver cannot follow is undecidable, and undecidable fails", () => {
    const directory = fixture("undecidable", {
      "owner.mts": OWNER,
      "helpers.mts": HELPERS,
      "writer.mts": 'import { seedSessions } from "./helpers.mts";\nawait seedSessions(process.env.TENANT ?? "x", "org", []);\n',
    });
    const { inventory: derived, findings: found } = inventoryFindings(directory, {});
    expect(derived["writer.mts"].classification).toBe(UNDECIDABLE);
    expect(found).toEqual(["writer.mts: undecidable — helper:seedSessions@2"]);
  });

  it("a session write takes its tenant from the connection context set before it", () => {
    const directory = fixture("session", {
      "owner.mts": OWNER,
      "revoker.mts": 'import { TENANT } from "./owner.mts";\nasync function main(client: { query(sql: string, params?: unknown[]): Promise<unknown> }) {\n'
        + "  await client.query(\"select set_config('tivdoc.tenant_id', $1, false)\", [TENANT]);\n"
        + '  await client.query("select private.product_session_revoke($1, now())", ["session.x"]);\n}\nvoid main;\n',
      "drill.mts": 'import { SYNTHETIC_PROOF_TENANT } from "./owner.mts";\nasync function main(client: { query(sql: string, params?: unknown[]): Promise<unknown> }) {\n'
        + "  await client.query(\"select set_config('tivdoc.tenant_id', $1, false)\", [SYNTHETIC_PROOF_TENANT]);\n"
        + '  await client.query("select private.product_session_revoke($1, now())", ["session.y"]);\n}\nvoid main;\n',
    });
    const { inventory: derived } = inventoryFindings(directory, { "revoker.mts": "Revokes a session on the reference tenant, which is where the residue is and nowhere else." });
    expect(derived["revoker.mts"].classification).toBe(REFERENCE);
    expect(derived["drill.mts"].classification).toBe(SYNTHETIC);
  });

  it("a reason on a file that does not write to the reference tenant is itself a finding", () => {
    const directory = fixture("stale-reason", {
      "owner.mts": OWNER,
      "helpers.mts": HELPERS,
      "proof.mts": 'import { SYNTHETIC_PROOF_TENANT } from "./owner.mts";\nimport { seedSessions } from "./helpers.mts";\nawait seedSessions(SYNTHETIC_PROOF_TENANT, "org", []);\n',
    });
    const { findings: found } = inventoryFindings(directory, { "proof.mts": "A reason that is not needed because this file writes to the proof tenant only.", "ghost.mts": "A reason for a file that is not a writer at all, so it is stale." });
    expect(found).toEqual([
      "proof.mts: carries a reason but does not write to the reference tenant (synthetic-proof)",
      "ghost.mts: listed with a reason but is not a writer",
    ]);
  });

  // Lane B, long run 8: the three bypasses the adversarial pass found, closed.
  it("a template whose literal parts spell the reference tenant is a reference writer, not its head's namespace", () => {
    const directory = fixture("template", {
      "helpers.mts": HELPERS,
      "owner.mts": OWNER,
      "split.mts": 'import { seedSessions } from "./helpers.mts";\nconst T = `legal.${"reference.il"}`;\nawait seedSessions(T, "org", []);\n',
      "unresolved.mts": 'import { seedSessions } from "./helpers.mts";\nconst T = `legal.${process.env.PART ?? ""}`;\nawait seedSessions(T, "org", []);\n',
      "own.mts": 'import { seedSessions } from "./helpers.mts";\nconst RUN = process.env.RUN ?? "x";\nconst T = `tenant.synthetic.gt.${RUN}`;\nawait seedSessions(T, "org", []);\n',
    });
    const { inventory: derived } = inventoryFindings(directory, {});
    expect(derived["split.mts"].classification).toBe(REFERENCE);
    expect(derived["unresolved.mts"].classification).toBe(UNDECIDABLE);
    expect(derived["own.mts"].classification).toBe(OWN);
  });

  it("the object form of a query carries its parameters beside the text, and a write outside the governance convention is undecidable", () => {
    const directory = fixture("object-form", {
      "owner.mts": OWNER,
      "writer.mts": 'import { TENANT } from "./owner.mts";\nasync function main(client: { query(input: unknown): Promise<unknown> }) {\n'
        + '  await client.query({ text: "select * from private.governance_parameter_import($1,$2)", values: [TENANT, "{}"] });\n}\nvoid main;\n',
      "product.mts": 'async function main(client: { query(sql: string, params: unknown[]): Promise<unknown> }) {\n'
        + '  await client.query("select private.product_privacy_append($1,$2)", ["case.1", "x"]);\n}\nvoid main;\n',
    });
    const { inventory: derived, findings: found } = inventoryFindings(directory, {});
    expect(derived["writer.mts"].classification).toBe(REFERENCE);
    expect(derived["product.mts"].classification).toBe(UNDECIDABLE);
    expect(found).toEqual([
      "product.mts: undecidable — sql:product_privacy_append@2",
      "writer.mts: reference writer without a reason — sql:governance_parameter_import@3",
    ]);
  });

  it("a writer with a .ts or .mjs extension in the directory is scanned too", () => {
    const directory = fixture("extensions", {
      "owner.mts": OWNER,
      "helpers.mts": HELPERS,
      "sneaky.ts": 'import { TENANT } from "./owner.mts";\nimport { seedSessions } from "./helpers.mts";\nawait seedSessions(TENANT, "org", []);\n',
      "sneaky.mjs": 'import { TENANT } from "./owner.mts";\nimport { seedSessions } from "./helpers.mts";\nawait seedSessions(TENANT, "org", []);\n',
    });
    const { inventory: derived } = inventoryFindings(directory, {});
    expect(derived["sneaky.ts"].classification).toBe(REFERENCE);
    expect(derived["sneaky.mjs"].classification).toBe(REFERENCE);
  });

  it("the real directory derives with the resolver the fixtures just exercised", () => {
    expect(Object.keys(deriveWriterInventory(DIRECTORY)).length).toBeGreaterThan(30);
  });
});
