// Q-1 … Q-7, the half that only DEV can answer: every parameter the seven
// draft RuleSpecs bind really is a `draft` row in the governance database, and
// every slot they leave unbound really has nothing to bind to.
//
// A note on how this reads, because it is not obvious and it matters: the
// candidate table itself is unreadable. `private.governance_parameter_versions`
// has no SELECT grant for any login role, and its RLS policy requires a
// verified tenant that only a runtime role can install — the admin migrator is
// refused `runtime_context_install` outright (RUNTIME_CONTEXT_ROLE_FORBIDDEN),
// so there is no connectable identity in this system that can read a draft
// parameter directly. That is the control working, not a gap. The sanctioned
// read is `private.governance_aggregate_read`, which is what this uses, and
// which reports the state and — the part that matters — `activation_allowed`.
import "../production-refusal.mjs";
import { verifyDerivation } from "../../src/engine/legal-operations/derivation.ts";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  REGISTERED_DRAFT_PARAMETERS,
  buildSevenRuleSpecDrafts,
  draftBoundParameterVersionIds,
} from "../../src/engine/legal-quality/rulespec-drafts.ts";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { TENANT } from "./pool-p-parameter-import.mts";

const RECEIPT_ROOT = path.join("output", "next", "pool-q");
const SYSTEM_SESSION = { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import" };

type Case = Readonly<{ case: string; outcome: "pass" | "fail"; observed: string }>;
const results: Case[] = [];
const record = (name: string, passed: boolean, observed: string) => {
  results.push(Object.freeze({ case: name, outcome: passed ? "pass" : "fail", observed }));
};

type Aggregate = Readonly<{ state: string; revision: string; activation_allowed: boolean; content_sha256: string }>;

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const url = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!url) throw new Error("Q_PROOF_ENV_MISSING");
  const parsed = new URL(url);
  const factory = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: url, max_connections: 4, connection_timeout_ms: 20_000,
    application_name: "tivdoc_q_draft_binding_proof",
    remote_dev_target: {
      host: parsed.hostname, port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//u, ""), project_ref: env.get("TIVDOC_DEV_PROJECT_REF") ?? "",
    },
  });

  const client = await factory.acquire();
  const readAggregate = async (parameterVersionId: string): Promise<Aggregate | null> => {
    const at = parameterVersionId.lastIndexOf("@");
    const result = await client.query(statement("q_aggregate_read",
      "select state, revision, activation_allowed, content_sha256 from private.governance_aggregate_read($1,$2,$3,$4)",
      [TENANT, "parameter_approval", parameterVersionId.slice(0, at), parameterVersionId.slice(at + 1)]));
    return result.row_count === 1 ? result.rows[0] as unknown as Aggregate : null;
  };

  try {
    await client.query(statement("q_begin", "begin", []));
    await client.query(statement("q_context", "select * from private.runtime_context_install($1,$2,$3)",
      [SYSTEM_SESSION.sid, SYSTEM_SESSION.jti, `q:${randomUUID().slice(0, 8)}`]));

    // --- Case 1: every bound parameter version exists, and is draft.
    const bound = draftBoundParameterVersionIds();
    const missing: string[] = [];
    const notDraft: string[] = [];
    const activatable: string[] = [];
    for (const id of bound) {
      const aggregate = await readAggregate(id);
      if (!aggregate) { missing.push(id); continue; }
      if (aggregate.state !== "draft") notDraft.push(`${id}=${aggregate.state}`);
      if (aggregate.activation_allowed !== false) activatable.push(id);
    }
    record("every_bound_parameter_exists", missing.length === 0, `bound=${bound.length} missing=${missing.join(",") || "none"}`);
    record("every_bound_parameter_is_draft", notDraft.length === 0, notDraft.join(",") || "all draft");
    record("no_bound_parameter_is_activatable", activatable.length === 0, activatable.join(",") || "activation_allowed=false for all");

    // --- L12-1 / D1: every derived figure the drafts bind is recomputed from
    // its own stored record (inputs, assumption slot, steps, identity); a
    // record that does not reproduce is a refusal, not a binding.
    const derivationFailures: string[] = [];
    let derivationsChecked = 0;
    for (const id of bound) {
      const at = id.lastIndexOf("@");
      const content = await client.query(statement("q_aggregate_content",
        "select content_json from private.governance_aggregate_read($1,$2,$3,$4)",
        [TENANT, "parameter_approval", id.slice(0, at), id.slice(at + 1)]));
      const row = content.rows[0] as unknown as { content_json?: { provenance_grade?: string; derivation?: unknown } } | undefined;
      const json = row?.content_json;
      if (!json || (json.provenance_grade !== "derived" && json.derivation === undefined)) continue;
      derivationsChecked += 1;
      if (json.provenance_grade !== "derived" || json.derivation === undefined) { derivationFailures.push(`${id}:grade_and_record_unpaired`); continue; }
      try { verifyDerivation(json.derivation); } catch (error) { derivationFailures.push(`${id}:${(error as Error).message}`); }
    }
    record("every_derived_parameter_recomputes_from_its_record", derivationFailures.length === 0, `checked=${derivationsChecked} failed=${derivationFailures.join(",") || "none"}`);

    // --- Case 2: every slot the drafts leave unbound really has nothing to bind.
    // An unbound slot whose parameter turned out to exist would mean a draft is
    // refusing to use something that is already there.
    const unboundIds = buildSevenRuleSpecDrafts()
      .flatMap((draft) => draft.parameter_slots)
      .filter((slot) => !slot.bound)
      .map((slot) => slot.parameter_id);
    const unexpectedlyPresent: string[] = [];
    for (const parameterId of unboundIds) {
      // No version is known for an unregistered parameter, so probe the shapes
      // Pool P uses. Any hit at all is a finding.
      for (const version of ["1.0.0", "2016.1.0", "2017.1.0", "2018.1.0", "2023.1.0", "2024.1.0", "2025.1.0", "2026.1.0", "2026.2.0"]) {
        if (await readAggregate(`${parameterId}@${version}`)) unexpectedlyPresent.push(`${parameterId}@${version}`);
      }
    }
    record("unbound_slots_really_have_nothing_to_bind", unexpectedlyPresent.length === 0,
      `probed=${unboundIds.length} present=${unexpectedlyPresent.join(",") || "none"}`);

    // --- Case 3: both branches of each open decision exist and are distinct rows.
    const branchSlots = buildSevenRuleSpecDrafts()
      .flatMap((draft) => draft.parameter_slots)
      .filter((slot) => slot.bound && slot.decision_id !== null);
    const branchProblems: string[] = [];
    for (const slot of branchSlots) {
      if (!slot.bound) continue;
      const hashes = new Set<string>();
      for (const entry of slot.decision_branches) {
        const aggregate = await readAggregate(entry.parameter_version_id);
        if (!aggregate) { branchProblems.push(`missing:${entry.parameter_version_id}`); continue; }
        if (aggregate.state !== "draft") branchProblems.push(`state:${entry.parameter_version_id}=${aggregate.state}`);
        hashes.add(aggregate.content_sha256);
      }
      // Two branches of a real question must differ in content. Two branches
      // with the same content hash would mean the question was never open.
      if (hashes.size !== slot.decision_branches.length) branchProblems.push(`identical_content:${slot.slot_id}`);
    }
    record("both_branches_exist_as_distinct_draft_rows", branchProblems.length === 0,
      `slots=${branchSlots.length} problems=${branchProblems.join(",") || "none"}`);

    // --- Case 4: the decisions themselves are still open. A draft carrying two
    // branches of a decision somebody already resolved would be stale. This is
    // the reason migration 202609020024 exists: until it landed there was no
    // read path for this table from any connectable role, so this check could
    // not be made at all.
    const decisionIds = [...new Set(branchSlots.map((slot) => slot.decision_id).filter((id): id is string => id !== null))];
    const decisionRows = await client.query(statement("q_decision_read",
      "select decision_id, resolution_state, withdrawn_reason from private.legal_open_decision_read($1)", [TENANT]));
    const byId = new Map((decisionRows.rows as unknown as Array<{ decision_id: string; resolution_state: string }>)
      .map((row) => [row.decision_id, row.resolution_state]));
    const states = decisionIds.map((id) => `${id}=${byId.get(id) ?? "absent"}`);
    record("open_decisions_are_still_open",
      decisionIds.length > 0 && decisionIds.every((id) => byId.get(id) === "open"),
      states.join(" "));
    // And withdrawal is visible and distinct from resolution, which is what
    // A7-3 asked the sensitivity report to be able to show.
    const withdrawn = (decisionRows.rows as unknown as Array<{ decision_id: string; resolution_state: string }>)
      .filter((row) => row.resolution_state === "withdrawn");
    record("withdrawn_decisions_are_readable_and_separate",
      decisionRows.row_count > decisionIds.length && withdrawn.length > 0,
      `total=${decisionRows.row_count} open=${decisionIds.length} withdrawn=${withdrawn.length}`);

    // --- Case 5: the registry in code matches what is actually registered.
    const declared = REGISTERED_DRAFT_PARAMETERS
      .flatMap((entry) => entry.versions.map((version) => `${entry.parameter_id}@${version}`));
    const declaredMissing: string[] = [];
    for (const id of declared) if (!await readAggregate(id)) declaredMissing.push(id);
    record("code_registry_matches_the_database", declaredMissing.length === 0,
      `declared=${declared.length} missing=${declaredMissing.join(",") || "none"}`);

    await client.query(statement("q_rollback", "rollback", []));
  } finally {
    client.release();
  }

  const receipt = {
    schema_version: "tivdoc-q-draft-binding-proof-v0.10.14",
    tenant: TENANT,
    drafts: buildSevenRuleSpecDrafts().map((draft) => ({
      topic: draft.topic,
      draft_id: draft.draft_id,
      content_sha256: draft.content_sha256,
      bound_slots: draft.parameter_slots.filter((slot) => slot.bound).length,
      unbound_slots: draft.parameter_slots.filter((slot) => !slot.bound).length,
      state: draft.state,
      attestations: draft.attestations,
    })),
    bound_parameter_version_ids: draftBoundParameterVersionIds(),
    cases: results,
    passed: results.every((entry) => entry.outcome === "pass"),
  };
  writeFileSync(path.join(RECEIPT_ROOT, "q-draft-binding.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    passed: receipt.passed, cases: results.length,
    failed: results.filter((entry) => entry.outcome === "fail"),
  }, null, 2)}\n`);
  if (!receipt.passed) process.exitCode = 1;
}

await main();
