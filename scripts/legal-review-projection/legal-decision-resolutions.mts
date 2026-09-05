// L11-2 / D2 (run 11). Records the six owner-recorded resolutions and proves
// what a resolution cannot do.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/legal-decision-resolutions.mts
//
// Three parts, one receipt. First the refusals, on the synthetic proof tenant
// against decisions registered and flagged synthetic for the purpose: a
// second resolution of the same decision, an unknown decision, a withdrawn
// decision, a synthetic flag that disagrees with the decision row, a payload
// asking for `attested` or naming an approver, a direct update or delete from
// the runtime role, an insert born attested, and the guard's own text —
// refusing UPDATE and DELETE by name — read from the catalogue (a runtime role
// cannot reach a row to update, and there is deliberately no definer function
// that updates one, so the guard's update branch can only be shown, not run).
// Then the six real rows on the reference tenant, from the registry in
// src/engine/legal-quality/decision-resolutions.ts, idempotently. Then the
// read-back: every row equals the registry, every decision it names is still
// `open` with no resolved branch, and `attested` is zero.
//
// The runtime role's connection is used directly (node-postgres, one
// transaction per call, the runtime context installed first) so that the
// database's refusal messages are on the receipt by name.
//
// Nothing here attests, activates, reviews or registers an identity.
import "../production-refusal.mjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { OWNER_RECORDED_RESOLUTIONS, resolutionSha256, type OwnerRecordedResolution } from "../../src/engine/legal-quality/decision-resolutions.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { TENANT } from "./pool-p-parameter-import.mts";
import { seedSessions, SYNTHETIC_PROOF_TENANT } from "./reviewer-registration.mts";

const RECEIPT_ROOT = path.join("output", "next", "pool-q");
const SYSTEM_SESSION = { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import" };
const PROOF_SESSION = { sid: "session.synthetic.proof.resolutions", jti: "token.synthetic.proof.resolutions", subject: "system_import" };
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type Case = Readonly<{ case: string; outcome: "pass" | "fail"; observed: string }>;
const results: Case[] = [];
const record = (name: string, passed: boolean, observed: string) => results.push(Object.freeze({ case: name, outcome: passed ? "pass" : "fail", observed }));
const refusalOf = (error: unknown) => `${(error as { code?: string }).code ?? "?"}:${String((error as Error).message ?? "").slice(0, 160)}`;

type Session = Readonly<{ sid: string; jti: string }>;

function payloadOf(resolution: OwnerRecordedResolution, synthetic: boolean): Record<string, unknown> {
  return {
    decision_id: resolution.decision_id,
    decision_key: resolution.decision_key,
    selected_branch: resolution.selected_branch,
    basis: resolution.basis,
    evidence_sha256: resolution.evidence_sha256,
    approval_record_sha256: resolution.approval_record_sha256,
    approved_on: resolution.approved_on,
    mapping_note: resolution.mapping_note,
    resolution_sha256: resolutionSha256(resolution),
    synthetic,
  };
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const url = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  const adminUrl = env.get("TIVDOC_DEV_DATABASE_URL");
  if (!url || !adminUrl) throw new Error("L112_ENV_MISSING");
  // Sessions live an hour from their seed; both are rewritten idempotently
  // the way the recovery drill does it.
  await seedSessions(SYNTHETIC_PROOF_TENANT, `${SYNTHETIC_PROOF_TENANT}.no-attestation-placeholder`, [PROOF_SESSION]);
  await seedSessions(TENANT, `${TENANT}.no-attestation-placeholder`, [{ ...SYSTEM_SESSION, subject: "system_import" }]);

  const ops = new pg.Client({ connectionString: url, connectionTimeoutMillis: 20_000, application_name: "tivdoc_l112_resolutions" });
  await ops.connect();
  async function tx<T>(session: Session, work: (client: pg.Client) => Promise<T>): Promise<T> {
    await ops.query("begin");
    try {
      await ops.query("select * from private.runtime_context_install($1,$2,$3)", [session.sid, session.jti, `l112:${randomUUID().slice(0, 8)}`]);
      const value = await work(ops);
      await ops.query("commit");
      return value;
    } catch (error) {
      await ops.query("rollback").catch(() => undefined);
      throw error;
    }
  }
  const recordResolution = (tenant: string, session: Session, payload: Record<string, unknown>, key: string, command: string) =>
    tx(session, (client) => client.query(
      "select * from private.governance_legal_decision_resolution_record($1,$2::jsonb,$3,$4,$5::timestamptz)",
      [tenant, JSON.stringify(payload), key, command, new Date().toISOString()]));

  try {
    // -------------------------------------------------------------------
    // Part 1: refusals, on the synthetic proof tenant.
    // -------------------------------------------------------------------
    const proof = { tenant: SYNTHETIC_PROOF_TENANT, session: PROOF_SESSION };
    const fixtureId = `${SYNTHETIC_PROOF_TENANT}.decision.resolution_fixture.${randomUUID().slice(0, 12)}`;
    const registerFixture = async (decisionId: string) => {
      await tx(proof.session, (client) => client.query(
        "select * from private.governance_legal_open_decision_register($1,$2::jsonb,$3,$4,$5)",
        [proof.tenant, JSON.stringify({ decision_id: decisionId, topic: "test", question: "Proof fixture: which branch does a resolution select?", dossier_anchor: "proof fixture, not a real dossier anchor" }),
          `l112.register.${decisionId}`, sha256(`register:${decisionId}`), new Date().toISOString()]));
      await tx(proof.session, (client) => client.query(
        "select * from private.governance_legal_open_decision_mark_synthetic($1,$2,$3,$4,$5,$6::timestamptz)",
        [proof.tenant, decisionId, "Fixture registered by the L11-2 resolution proof to exercise the resolution record. Flagged at creation so it can never appear in a legal export.",
          `l112.synthetic.${decisionId}`, sha256(`synthetic:${decisionId}`), new Date().toISOString()]));
    };
    await registerFixture(fixtureId);
    const fixture: OwnerRecordedResolution = { ...OWNER_RECORDED_RESOLUTIONS[0], decision_id: fixtureId, decision_key: "resolution_fixture", selected_branch: "a" };
    const fixturePayload = payloadOf(fixture, true);
    const fixtureKey = `l112.fixture.${fixtureId}`;
    const fixtureCommand = sha256(`resolve:${fixtureId}`);

    // 1. A resolution of an open synthetic decision records as owner_recorded.
    try {
      const result = await recordResolution(proof.tenant, proof.session, fixturePayload, fixtureKey, fixtureCommand);
      const row = result.rows[0] as { state?: string; idempotent_replay?: boolean };
      record("resolution_records_as_owner_recorded", row?.state === "owner_recorded" && row.idempotent_replay === false, `state=${row?.state} replay=${row?.idempotent_replay}`);
    } catch (error) {
      record("resolution_records_as_owner_recorded", false, `unexpected refusal ${refusalOf(error)}`);
    }
    // 2. The same key and command replay idempotently.
    try {
      const result = await recordResolution(proof.tenant, proof.session, fixturePayload, fixtureKey, fixtureCommand);
      const row = result.rows[0] as { idempotent_replay?: boolean };
      record("resolution_idempotent_replay", row?.idempotent_replay === true, `idempotent_replay=${row?.idempotent_replay}`);
    } catch (error) {
      record("resolution_idempotent_replay", false, `unexpected refusal ${refusalOf(error)}`);
    }
    // 3. A second resolution of the same decision under a new key is refused.
    try {
      await recordResolution(proof.tenant, proof.session, { ...fixturePayload, selected_branch: "b" }, `${fixtureKey}.again`, sha256(`resolve-again:${fixtureId}`));
      record("second_resolution_of_same_decision_refused", false, "accepted");
    } catch (error) {
      record("second_resolution_of_same_decision_refused", refusalOf(error).includes("GOVERNANCE_LEGAL_DECISION_RESOLUTION_EXISTS"), refusalOf(error));
    }
    // 4. A decision that does not exist is refused.
    try {
      await recordResolution(proof.tenant, proof.session, { ...fixturePayload, decision_id: `${fixtureId}.missing` }, `${fixtureKey}.missing`, sha256(`missing:${fixtureId}`));
      record("unknown_decision_refused", false, "accepted");
    } catch (error) {
      record("unknown_decision_refused", refusalOf(error).includes("GOVERNANCE_LEGAL_OPEN_DECISION_UNKNOWN"), refusalOf(error));
    }
    // 5. A payload asking for `attested` is refused by name.
    const secondId = `${fixtureId}.second`;
    await registerFixture(secondId);
    try {
      await recordResolution(proof.tenant, proof.session, { ...payloadOf({ ...fixture, decision_id: secondId }, true), status: "attested" }, `${fixtureKey}.attested`, sha256(`attested:${secondId}`));
      record("payload_status_attested_refused", false, "accepted");
    } catch (error) {
      record("payload_status_attested_refused", refusalOf(error).includes("ATTESTATION_NOT_A_CODE_PATH"), refusalOf(error));
    }
    // 6. A payload naming an approver identity is refused by name.
    try {
      await recordResolution(proof.tenant, proof.session, { ...payloadOf({ ...fixture, decision_id: secondId }, true), approver_identity: "reviewer.someone" }, `${fixtureKey}.approver`, sha256(`approver:${secondId}`));
      record("payload_approver_identity_refused", false, "accepted");
    } catch (error) {
      record("payload_approver_identity_refused", refusalOf(error).includes("ATTESTATION_NOT_A_CODE_PATH"), refusalOf(error));
    }
    // 7. A synthetic flag that disagrees with the decision row is refused.
    try {
      await recordResolution(proof.tenant, proof.session, payloadOf({ ...fixture, decision_id: secondId }, false), `${fixtureKey}.synthetic`, sha256(`synthetic-mismatch:${secondId}`));
      record("synthetic_flag_mismatch_refused", false, "accepted");
    } catch (error) {
      record("synthetic_flag_mismatch_refused", refusalOf(error).includes("SYNTHETIC_MISMATCH"), refusalOf(error));
    }
    // 8. A withdrawn decision cannot be resolved.
    try {
      await tx(proof.session, (client) => client.query(
        "select * from private.governance_legal_open_decision_withdraw($1,$2,$3,$4,$5,$6,$7::timestamptz)",
        [proof.tenant, secondId, "Proof fixture withdrawn so a resolution of a withdrawn decision can be refused.", "proof-fixture-locator#l112",
          `l112.withdraw.${secondId}`, sha256(`withdraw:${secondId}`), new Date().toISOString()]));
      await recordResolution(proof.tenant, proof.session, payloadOf({ ...fixture, decision_id: secondId }, true), `${fixtureKey}.withdrawn`, sha256(`withdrawn:${secondId}`));
      record("withdrawn_decision_cannot_be_resolved", false, "accepted");
    } catch (error) {
      record("withdrawn_decision_cannot_be_resolved", refusalOf(error).includes("DECISION_NOT_OPEN"), refusalOf(error));
    }
    // 9. The runtime role cannot update, delete or insert into the table directly.
    for (const [name, sql] of [
      ["runtime_role_cannot_update_directly", "update private.legal_decision_resolutions set status = 'attested', approver_identity = 'x', attested_at = now() where tenant_id = $1 and decision_id = $2"],
      ["runtime_role_cannot_delete_directly", "delete from private.legal_decision_resolutions where tenant_id = $1 and decision_id = $2"],
      ["runtime_role_cannot_insert_directly", "insert into private.legal_decision_resolutions (tenant_id, decision_id, decision_key, selected_branch, basis, evidence_sha256, approval_record_sha256, approved_on, approver_identity, status, recorded_by, recorded_at, attested_at, mapping_note, resolution_sha256, synthetic) values ($1, $2 || '.direct', 'resolution_fixture', 'a', 'lawyer_approved_opinion', repeat('0', 64), repeat('0', 64), '2026-09-05', null, 'owner_recorded', 'owner_action', now(), null, 'direct insert, must be refused', repeat('0', 64), true)"],
    ] as const) {
      try {
        await tx(proof.session, (client) => client.query(sql, [proof.tenant, fixtureId]));
        record(name, false, "accepted");
      } catch (error) {
        record(name, (error as { code?: string }).code === "42501", refusalOf(error));
      }
    }
    // 10. As the database owner, where no grant stands in the way: an insert born
    // attested is refused by the guard before the row exists (a BEFORE trigger
    // runs ahead of the policy check); the guard's UPDATE and DELETE branches
    // are read from the catalogue, since no row is reachable to update — the
    // policy hides every row from a connection without a verified tenant, and
    // no definer function updates one, by design.
    const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
    await admin.connect();
    try {
      try {
        await admin.query("begin");
        await admin.query(`insert into private.legal_decision_resolutions (tenant_id, decision_id, decision_key, selected_branch, basis, evidence_sha256, approval_record_sha256, approved_on, approver_identity, status, recorded_by, recorded_at, attested_at, mapping_note, resolution_sha256, synthetic)
          values ($1, $2 || '.born', 'resolution_fixture', 'a', 'lawyer_approved_opinion', repeat('0', 64), repeat('0', 64), '2026-09-05', 'reviewer.someone', 'attested', 'owner_action', now(), now(), 'born attested, must be refused', repeat('0', 64), true)`, [proof.tenant, fixtureId]);
        await admin.query("rollback");
        record("guard_refuses_insert_born_attested", false, "accepted");
      } catch (error) {
        await admin.query("rollback").catch(() => undefined);
        record("guard_refuses_insert_born_attested", String((error as Error).message).includes("GOVERNANCE_LEGAL_DECISION_RESOLUTION_BORN_ATTESTED"), refusalOf(error));
      }
      const trigger = await admin.query(`select pg_get_triggerdef(t.oid) as definition, pg_get_functiondef(t.tgfoid) as body
        from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'private' and c.relname = 'legal_decision_resolutions' and not t.tgisinternal`);
      const definition = String(trigger.rows[0]?.definition ?? "");
      const body = String(trigger.rows[0]?.body ?? "");
      const updateBranch = /TG_OP = 'UPDATE' then\s*(?:--[^\n]*\n\s*)*raise exception using errcode = 'P0001', message = 'GOVERNANCE_APPEND_ONLY'/u.test(body);
      const deleteBranch = /TG_OP = 'DELETE' then\s*raise exception using errcode = 'P0001', message = 'GOVERNANCE_APPEND_ONLY'/u.test(body);
      record("guard_is_before_insert_update_delete", /BEFORE INSERT OR DELETE OR UPDATE/u.test(definition) && definition.includes("governance_legal_decision_resolution_guard()"), definition.slice(0, 160));
      record("guard_text_refuses_update_and_delete", updateBranch && deleteBranch, `update_branch=${updateBranch} delete_branch=${deleteBranch}`);
      const definers = await admin.query(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.prosecdef and pg_get_functiondef(p.oid) ilike '%update private.legal_decision_resolutions%'`);
      record("no_definer_function_updates_resolutions", Number(definers.rows[0]?.n) === 0, `functions_updating_the_table=${definers.rows[0]?.n}`);
    } finally {
      await admin.end().catch(() => undefined);
    }
    // 11. Read-back on the proof tenant, and the decision row untouched.
    try {
      const rows = await tx(proof.session, async (client) => {
        const resolutions = await client.query("select * from private.legal_decision_resolution_read($1)", [proof.tenant]);
        const decisions = await client.query("select * from private.legal_open_decision_read($1)", [proof.tenant]);
        return { resolutions: resolutions.rows as Array<Record<string, unknown>>, decisions: decisions.rows as Array<Record<string, unknown>> };
      });
      const mine = rows.resolutions.find((row) => row.decision_id === fixtureId);
      const decision = rows.decisions.find((row) => row.decision_id === fixtureId);
      record("proof_row_reads_back_owner_recorded_without_approver",
        mine?.status === "owner_recorded" && mine?.approver_identity === null && mine?.synthetic === true,
        `status=${mine?.status} approver=${mine?.approver_identity} synthetic=${mine?.synthetic}`);
      record("resolved_decision_row_stays_open", decision?.resolution_state === "open" && decision?.resolved_branch === null,
        `resolution_state=${decision?.resolution_state} resolved_branch=${decision?.resolved_branch}`);
    } catch (error) {
      record("proof_row_reads_back_owner_recorded_without_approver", false, `unexpected ${refusalOf(error)}`);
    }

    // -------------------------------------------------------------------
    // Part 2: the six real rows on the reference tenant.
    // -------------------------------------------------------------------
    const recorded: Array<Record<string, unknown>> = [];
    for (const resolution of OWNER_RECORDED_RESOLUTIONS) {
      const key = `l112.resolution.${resolution.decision_key}`;
      try {
        const result = await recordResolution(TENANT, SYSTEM_SESSION, payloadOf(resolution, false), key, resolutionSha256(resolution));
        const row = result.rows[0] as { state?: string; idempotent_replay?: boolean; content_sha256?: string };
        recorded.push({ decision_key: resolution.decision_key, decision_id: resolution.decision_id, selected_branch: resolution.selected_branch, state: row?.state, idempotent_replay: row?.idempotent_replay, content_sha256: row?.content_sha256 });
      } catch (error) {
        recorded.push({ decision_key: resolution.decision_key, decision_id: resolution.decision_id, error: refusalOf(error) });
      }
    }
    record("six_resolutions_recorded", recorded.every((row) => row.state === "owner_recorded"), recorded.map((row) => `${row.decision_key}=${row.state ?? row.error}${row.idempotent_replay ? "(replay)" : ""}`).join(", "));

    // -------------------------------------------------------------------
    // Part 3: read-back equals the registry; decisions stay open; attested 0.
    // -------------------------------------------------------------------
    const readBack = await tx(SYSTEM_SESSION, async (client) => {
      const resolutions = await client.query("select * from private.legal_decision_resolution_read($1)", [TENANT]);
      const decisions = await client.query("select * from private.legal_open_decision_read($1)", [TENANT]);
      return { resolutions: resolutions.rows as Array<Record<string, unknown>>, decisions: decisions.rows as Array<Record<string, unknown>> };
    });
    const legal = readBack.resolutions.filter((row) => row.synthetic !== true);
    const mismatches: string[] = [];
    for (const resolution of OWNER_RECORDED_RESOLUTIONS) {
      const row = legal.find((entry) => entry.decision_id === resolution.decision_id);
      if (!row) { mismatches.push(`${resolution.decision_key}:missing`); continue; }
      for (const [field, expected] of [
        ["decision_key", resolution.decision_key], ["selected_branch", resolution.selected_branch], ["basis", resolution.basis],
        ["evidence_sha256", resolution.evidence_sha256], ["approval_record_sha256", resolution.approval_record_sha256],
        ["status", "owner_recorded"], ["recorded_by", "owner_action"], ["resolution_sha256", resolutionSha256(resolution)],
      ] as const) {
        if (row[field] !== expected) mismatches.push(`${resolution.decision_key}:${field}=${String(row[field])}`);
      }
      if (row.approver_identity !== null) mismatches.push(`${resolution.decision_key}:approver_identity=${String(row.approver_identity)}`);
      const approvedOn = row.approved_on instanceof Date
        ? `${row.approved_on.getFullYear()}-${String(row.approved_on.getMonth() + 1).padStart(2, "0")}-${String(row.approved_on.getDate()).padStart(2, "0")}`
        : String(row.approved_on).slice(0, 10);
      if (approvedOn !== resolution.approved_on) mismatches.push(`${resolution.decision_key}:approved_on=${approvedOn}`);
      const decision = readBack.decisions.find((entry) => entry.decision_id === resolution.decision_id);
      if (!decision) mismatches.push(`${resolution.decision_key}:decision_missing`);
      else if (decision.resolution_state !== "open" || decision.resolved_branch !== null) mismatches.push(`${resolution.decision_key}:decision_${String(decision.resolution_state)}`);
    }
    record("read_back_equals_registry", mismatches.length === 0, mismatches.join(", ") || `rows=${legal.length}`);
    record("six_decision_rows_still_open", mismatches.filter((entry) => entry.includes("decision_")).length === 0, "resolution_state=open, resolved_branch=null for all six");
    const attested = readBack.resolutions.filter((row) => row.status === "attested").length;
    record("attested_is_zero", attested === 0, `attested=${attested}`);
    record("legal_resolutions_are_six", legal.length === 6, `legal=${legal.length} synthetic=${readBack.resolutions.length - legal.length}`);

    const failed = results.filter((row) => row.outcome === "fail");
    const receipt = {
      schema_version: "tivdoc-legal-decision-resolutions-v1",
      unit: "L11-2 / D2",
      tenant: TENANT,
      proof_tenant: SYNTHETIC_PROOF_TENANT,
      proof_fixtures: [fixtureId, secondId],
      results,
      recorded,
      resolutions: legal.map((row) => ({
        decision_id: row.decision_id, decision_key: row.decision_key, selected_branch: row.selected_branch, basis: row.basis,
        evidence_sha256: row.evidence_sha256, approval_record_sha256: row.approval_record_sha256, status: row.status,
        approver_identity: row.approver_identity, recorded_by: row.recorded_by, resolution_sha256: row.resolution_sha256,
      })),
      counters: { resolutions_owner_recorded: legal.length, resolutions_attested: attested, reviewer_identities_registered: 0, reviewed_sources: 0, active_parameters: 0, active_rules: 0, attestations: 0, findings: 0 },
      verdict: failed.length === 0 ? "PASS" : "FAIL",
    };
    writeFileSync(path.join(RECEIPT_ROOT, "legal-decision-resolutions.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ total: results.length, failed: failed.length, recorded: legal.length, attested, verdict: receipt.verdict }));
    for (const row of results) console.log(`${row.outcome === "pass" ? "PASS" : "FAIL"} ${row.case} — ${row.observed}`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await ops.end().catch(() => undefined);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
