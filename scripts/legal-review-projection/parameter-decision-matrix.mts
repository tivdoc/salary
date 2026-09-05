// Addendum 6 (A6-2), unit P-0. Proves the draft state, the durable
// legal_open_decisions record, and the decision-resolution rule
// (202609020018/202609020019) against DEV as the operations runtime role.
// Every candidate here is synthetic money on a made-up currency; nothing is
// a real parameter, nothing is attested by a real reviewer identity, and
// nothing ever reaches activation_allowed: true — every receipt this script
// reads back carries activation_allowed: false, which the type system pins
// as a literal, not merely a convention.
import "../production-refusal.mjs";
import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { legalOperationsSha256 } from "../../src/engine/legal-operations/canonical.ts";
import { parameterCandidateSchema, type ParameterAttestation } from "../../src/engine/legal-operations/contracts.ts";
import { humanDecisionEnvelopeSha256, humanDecisionSignatureSha256, payloadWithoutEmbeddedSignature, type VerifiedHumanDecision } from "../../src/engine/legal-operations/human-trust.ts";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import type { PostgresTransactionContext } from "../../src/server/platform/persistence/postgres/contracts.ts";
import {
  PostgresGovernanceWorkRepository, PostgresParameterApprovalRepository, PostgresReviewerTrustRepository,
} from "../../src/server/platform/persistence/postgres/governance/repositories.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { createReviewerTrustPolicy, createTrustOrganization, createTrustedReviewer } from "../../src/server/platform/trust/reviewer-trust-store.ts";
import { generateEd25519TestKey, signHumanDecision, signKeyPossessionChallenge } from "../../src/server/platform/trust/test-support.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "next";
const RECEIPT_ROOT = path.join("output", WAVE, "audit");
const RUN = process.env.TIVDOC_P0_RUN_ID ?? randomUUID().replaceAll("-", "").slice(0, 12);
const TENANT = `tenant.synthetic.p0.${RUN}`;
const ORG = `synthetic.p0.org.${RUN}`;
const SYSTEM_ACTOR = "system_import";
const NOW = new Date();
const iso = (offsetSeconds: number) => new Date(NOW.getTime() + offsetSeconds * 1_000).toISOString();
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const spkiSha256 = (pem: string) => createHash("sha256").update(createPublicKey(pem).export({ type: "spki", format: "der" })).digest("hex");

type Case = Readonly<{ case: string; outcome: "pass" | "fail"; observed: string }>;
const results: Case[] = [];
const record = (name: string, passed: boolean, observed: string) => {
  results.push(Object.freeze({ case: name, outcome: passed ? "pass" : "fail", observed }));
};

type Reviewer = Readonly<{ id: string; key: ReturnType<typeof generateEd25519TestKey>; key_id: string; sid: string; jti: string }>;

function reviewer(name: string): Reviewer {
  return Object.freeze({
    id: `synthetic.p0.reviewer.${name}.${RUN}`, key: generateEd25519TestKey(), key_id: `key.${name}.${RUN}`,
    sid: `session.p0.${name}.${RUN}`, jti: `token.p0.${name}.${RUN}`,
  });
}
const REVIEWERS = { r1: reviewer("r1"), r2: reviewer("r2"), r3: reviewer("r3"), r4: reviewer("r4") };
const SYSTEM_SESSION = { sid: `session.p0.system.${RUN}`, jti: `token.p0.system.${RUN}` };
// governance_work_enqueue attributes every item to 'governance.queue'; the
// actor guard admits it only under a session whose subject is that name.
const QUEUE_ACTOR = "governance.queue";
const QUEUE_SESSION = { sid: `session.p0.queue.${RUN}`, jti: `token.p0.queue.${RUN}` };

async function transaction<T>(
  factory: NodePostgresConnectionFactory, session: { sid: string; jti: string },
  operation: (context: PostgresTransactionContext) => Promise<T>,
): Promise<T> {
  const client = await factory.acquire();
  try {
    await client.query(statement("p0_begin", "begin", []));
    await client.query(statement("p0_context", "select * from private.runtime_context_install($1,$2,$3)",
      [session.sid, session.jti, `p0:${RUN}:${randomUUID().slice(0, 8)}`]));
    const value = await operation({ client, transaction_id: `p0:${RUN}:${randomUUID().slice(0, 8)}` });
    await client.query(statement("p0_commit", "commit", []));
    return value;
  } catch (error) {
    await client.query(statement("p0_rollback", "rollback", [])).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function refusal(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "accepted";
  } catch (error) {
    let code: string | null = null;
    for (let cause: unknown = error; cause && !code; cause = (cause as { cause?: unknown }).cause) {
      const candidate = cause as { origin_sqlstate?: string | null; sqlstate?: string | null; code?: string };
      code = candidate.origin_sqlstate ?? candidate.sqlstate ?? (/^[0-9A-Z]{5}$/u.test(candidate.code ?? "") ? candidate.code! : null);
    }
    code ??= (error as { code?: string }).code ?? "unknown";
    return `${code}:${String((error as Error).message).slice(0, 100)}`;
  }
}

function verified(envelope: ReturnType<typeof signHumanDecision>): VerifiedHumanDecision {
  return Object.freeze({
    envelope, organization_id: envelope.organization_id, organization_version: envelope.organization_version,
    policy_version: envelope.policy_version, reviewer_id: envelope.reviewer_id,
    reviewer_identity_version: envelope.reviewer_identity_version, reviewer_role: envelope.reviewer_role,
    key_id: envelope.key_id, purpose: envelope.purpose, valid_at_signing_time: true as const, currently_trusted: true,
    envelope_sha256: humanDecisionEnvelopeSha256(envelope), signature_sha256: humanDecisionSignatureSha256(envelope.signature_base64),
  }) as unknown as VerifiedHumanDecision;
}

function candidateFor(parameterId: string, decisionId: string | null, branch: string | null, minorUnits: number, extra: Record<string, unknown> = {}) {
  const seed = {
    ...extra,
    schema_version: "tivdoc-parameter-candidate-v0.6.0" as const,
    parameter_id: parameterId, parameter_version: "1.0.0", topic: "minimum_wage" as const,
    value: { kind: "money" as const, value: { currency: "ZZZ", minor_units: minorUnits } },
    unit: "currency.zzz", rounding_policy: "exact" as const,
    effective_from: "2026-01-01", effective_to: null,
    sectors: ["general"], populations: ["general"], operative_source_version_ids: [`synthetic.source.${RUN}`],
    support_roles: ["primary_binding" as const],
    bindings: {
      source_bytes_sha256: sha256(`bytes:${parameterId}`), citations_sha256: sha256(`citations:${parameterId}`),
      interval_sha256: sha256(`interval:${parameterId}`), scope_sha256: sha256(`scope:${parameterId}`),
      parameter_set_sha256: sha256(`set:${parameterId}`), rule_spec_sha256: sha256(`rule:${parameterId}`),
      golden_cases_sha256: sha256(`golden:${parameterId}`), reviewer_decisions_sha256: sha256(`decisions:${parameterId}`),
    },
    decision_id: decisionId, branch,
  };
  return parameterCandidateSchema.parse({ ...seed, candidate_sha256: legalOperationsSha256(seed) });
}

function attestationFor(candidate: ReturnType<typeof candidateFor>, reviewerId: string, suffix: string, extra: Record<string, unknown> = {}): ParameterAttestation {
  const seed = {
    ...extra,
    schema_version: "tivdoc-parameter-attestation-v0.6.0" as const,
    attestation_id: `attestation.${suffix}.${RUN}`, candidate_id: candidate.parameter_id,
    candidate_version: candidate.parameter_version, candidate_sha256: candidate.candidate_sha256,
    reviewer_id: reviewerId, reviewer_role: "human_parameter_reviewer" as const,
    value: candidate.value, unit: candidate.unit, rounding_policy: candidate.rounding_policy,
    operative_source_version_ids: candidate.operative_source_version_ids,
    bindings_sha256: legalOperationsSha256(candidate.bindings),
    decision: "approved" as const, attested_at: iso(0), signature_sha256: "0".repeat(64),
  };
  return { ...seed, signature_sha256: sha256(`placeholder:${suffix}`) } as unknown as ParameterAttestation;
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const adminUrl = env.get("TIVDOC_DEV_DATABASE_URL");
  const operationsUrl = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  const projectRef = env.get("TIVDOC_DEV_PROJECT_REF");
  if (!adminUrl || !operationsUrl || !projectRef) throw new Error("P0_MATRIX_ENV_MISSING");
  const { default: pg } = await import("pg");

  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
  await admin.connect();
  try {
    await admin.query("select set_config('tivdoc.tenant_id', $1, false)", [TENANT]);
    const seedSession = async (sid: string, jti: string, subject: string) => admin.query(
      `insert into public.product_identity_sessions(
         tenant_id, sid, subject, current_jti, rotation_counter, valid_after,
         expires_at, revoked_at, reviewer_org_id, session_sha256, created_at
       ) values ($1,$2,$3,$4,1,to_timestamp($5),to_timestamp($6),null,$7,$8,to_timestamp($5))
       on conflict (tenant_id, sid) do update set
         subject = excluded.subject, session_sha256 = excluded.session_sha256,
         current_jti = excluded.current_jti, valid_after = excluded.valid_after,
         expires_at = excluded.expires_at, reviewer_org_id = excluded.reviewer_org_id`,
      [TENANT, sid, subject, jti, Math.floor(NOW.getTime() / 1_000) - 5, Math.floor(NOW.getTime() / 1_000) + 3_600,
        ORG, sha256(`${TENANT}|${sid}|${subject}|${jti}`)],
    );
    await seedSession(SYSTEM_SESSION.sid, SYSTEM_SESSION.jti, SYSTEM_ACTOR);
    await seedSession(QUEUE_SESSION.sid, QUEUE_SESSION.jti, QUEUE_ACTOR);
    for (const r of Object.values(REVIEWERS)) await seedSession(r.sid, r.jti, r.id);
  } finally {
    await admin.end().catch(() => undefined);
  }

  const parsed = new URL(operationsUrl);
  const factory = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: operationsUrl, max_connections: 4, connection_timeout_ms: 20_000,
    application_name: "tivdoc_parameter_decision_matrix",
    remote_dev_target: { host: parsed.hostname, port: Number(parsed.port), database: parsed.pathname.replace(/^\//u, ""), project_ref: projectRef },
  });

  let failure: string | null = null;
  try {
    const meta = (key: string) => ({ idempotency_key: `${key}.${RUN}`, occurred_at: iso(0) });

    // --- Trust stack: one organisation, one policy, four reviewers, four keys.
    const challenges = new Map<string, Parameters<PostgresReviewerTrustRepository["appendKeyChallenge"]>[0]>();
    await transaction(factory, SYSTEM_SESSION, async (context) => {
      const trust = new PostgresReviewerTrustRepository(context, TENANT);
      await trust.appendOrganization(createTrustOrganization({
        schema_version: "tivdoc-reviewer-trust-v0.10.0", organization_id: ORG, organization_version: "1.0.0",
        valid_from: iso(-3_600), expires_at: null, policy_admin_ids: [SYSTEM_ACTOR],
      }), SYSTEM_ACTOR, meta("org"));
      await trust.appendPolicy(createReviewerTrustPolicy({
        schema_version: "tivdoc-reviewer-trust-v0.10.0", organization_id: ORG, organization_version: "1.0.0",
        policy_version: "1.0.0", effective_from: iso(-3_600), expires_at: null, max_envelope_ttl_seconds: 3_600,
        grants: [{ reviewer_role: "human_parameter_reviewer", purposes: ["parameter_attestation"] }],
      }), SYSTEM_ACTOR, meta("policy"));
      for (const r of Object.values(REVIEWERS)) {
        await trust.appendReviewer(createTrustedReviewer({
          schema_version: "tivdoc-reviewer-trust-v0.10.0", organization_id: ORG, organization_version: "1.0.0",
          reviewer_id: r.id, reviewer_identity_version: "1.0.0", reviewer_roles: ["human_parameter_reviewer"],
          valid_from: iso(-3_600), expires_at: iso(86_400), identity_evidence_sha256: sha256(`evidence:${r.id}`),
        }), SYSTEM_ACTOR, meta(`reviewer.${r.id}`));
        const challenge = {
          schema_version: "tivdoc-key-possession-challenge-v0.10.0" as const, challenge_id: `challenge.${r.key_id}`,
          organization_id: ORG, organization_version: "1.0.0", reviewer_id: r.id, reviewer_identity_version: "1.0.0",
          key_id: r.key_id, public_key_spki_pem: r.key.public_key_spki_pem, public_key_sha256: spkiSha256(r.key.public_key_spki_pem),
          valid_from: iso(0), expires_at: iso(86_400), replaces_key_id: null,
          nonce: `nonce-${RUN}-${r.key_id}`.replaceAll(".", "-"), issued_at: iso(0), challenge_expires_at: iso(3_600),
        };
        await trust.appendKeyChallenge(challenge, SYSTEM_ACTOR, meta(`challenge.${r.key_id}`));
        challenges.set(r.id, challenge);
      }
    });
    for (const r of Object.values(REVIEWERS)) {
      const challenge = challenges.get(r.id)!;
      await transaction(factory, r, async (context) => {
        await new PostgresReviewerTrustRepository(context, TENANT).registerProvenKey({
          challenge, proof_signature_base64: signKeyPossessionChallenge(challenge, r.key.private_key),
          registered_at: iso(0), metadata: meta(`register.${r.key_id}`),
        });
      });
    }
    record("trust_stack_durable", true, "organisation, policy, four reviewers, four keys, all as the runtime role");

    // --- Register the open decision and two sibling candidates.
    const decisionId = `DEC-SYNTHETIC-P0-${RUN}`;
    await transaction(factory, SYSTEM_SESSION, async (context) => {
      await context.client.query(statement("p0_decision_register",
        "select * from private.governance_legal_open_decision_register($1,$2::jsonb,$3,$4,$5)",
        [TENANT, JSON.stringify({ decision_id: decisionId, topic: "minimum_wage", question: "182 or 186 hours?", dossier_anchor: "synthetic dossier anchor" }),
          `decision.${RUN}`, sha256(`decision:${RUN}`), iso(0)]));
    });
    record("decision_registered_open", true, decisionId);

    const paramA = `PARAM-SYNTHETIC-P0-A-${RUN}`;
    const paramB = `PARAM-SYNTHETIC-P0-B-${RUN}`;
    const candidateA = candidateFor(paramA, decisionId, "182", 3_540);
    const candidateB = candidateFor(paramB, decisionId, "186", 3_464);
    const importOne = (candidate: ReturnType<typeof candidateFor>, suffix: string) =>
      transaction(factory, SYSTEM_SESSION, (context) =>
        new PostgresParameterApprovalRepository(context, TENANT).importCandidate(candidate, meta(`import.${suffix}`)));
    const importA = await importOne(candidateA, "a");
    const importB = await importOne(candidateB, "b");
    record("both_branches_imported_as_draft",
      importA.state === "draft" && importB.state === "draft" && importA.activation_allowed === false && importB.activation_allowed === false,
      `A:${importA.state} B:${importB.state}`);

    // Draft is unreadable by any operative path, proved three ways.
    // No runtime role holds any grant at all on this table — a direct insert
    // (even one trying to set activation_allowed: true) is refused before
    // anything else, including the CHECK constraint
    // (governance_parameter_versions_activation_allowed_check:
    // CHECK (NOT activation_allowed), unconditional on every row regardless
    // of state) ever gets a chance to run. Every path that could write this
    // table is a definer, and every definer hardcodes activation_allowed:
    // false — the constraint is a second, independent lock on the same door.
    const directInsert = await refusal(() => transaction(factory, SYSTEM_SESSION, (context) =>
      context.client.query(statement("p0_activation_allowed_direct_insert_refused",
        "insert into private.governance_parameter_versions(tenant_id, parameter_id, parameter_version, revision, state, candidate_json, candidate_sha256, bindings_sha256, activation_allowed, recorded_at) values ($1,$2,'9.9.9',999,'draft','{}'::jsonb,$3,$3,true,$4)",
        [TENANT, `PARAM-P0-NEVER-${RUN}`, "a".repeat(64), iso(0)]))));
    record("runtime_role_has_no_grant_on_the_table_at_all", directInsert.startsWith("42501"), directInsert);
    const directSelect = await refusal(() => transaction(factory, SYSTEM_SESSION, (context) =>
      context.client.query(statement("p0_direct_select_refused", "select 1 from private.governance_parameter_versions limit 1", []))));
    record("runtime_role_cannot_select_table_directly", directSelect.startsWith("42501"), directSelect);
    const currentA = await transaction(factory, SYSTEM_SESSION, (context) =>
      new PostgresParameterApprovalRepository(context, TENANT).readCurrent("parameter_approval", paramA, "1.0.0"));
    record("readback_activation_allowed_always_false", currentA.receipt.activation_allowed === false, String(currentA.receipt.activation_allowed));

    // --- The cross-branch refusal: r1 attests A, then tries to attest sibling B.
    const claimFor = async (reviewer: Reviewer, targetId: string, suffix: string) => {
      const itemId = `p0.work.${suffix}.${RUN}`;
      await transaction(factory, QUEUE_SESSION, (context) => new PostgresGovernanceWorkRepository(context, TENANT).enqueue({
        work_item_id: itemId, workflow_kind: "parameter_approval", aggregate_id: targetId, aggregate_version: "1.0.0",
        work_kind: "parameter_attestation", required_role: "human_parameter_reviewer", document_sha256: null,
        object_version_id: null, input_sha256: sha256(`input:${itemId}`), payload: { synthetic: true },
        idempotency_key: `enqueue.${itemId}`, created_at: iso(0),
      }));
      return transaction(factory, reviewer, async (context) => {
        const claim = await new PostgresGovernanceWorkRepository(context, TENANT).claim({
          workflow_kind: "parameter_approval", work_kind: "parameter_attestation", claimant_id: reviewer.id,
          reviewer_role: "human_parameter_reviewer", now: iso(0), lease_seconds: 600,
        });
        if (!claim) throw new Error(`P0_CLAIM_MISSING:${itemId}`);
        return { work_item_id: claim.work_item_id, claimant_id: claim.claimant_id, fencing_token: claim.fencing_token };
      });
    };
    const attestOnce = async (reviewer: Reviewer, candidate: ReturnType<typeof candidateFor>, expectedRevision: number, suffix: string, extra: Record<string, unknown> = {}) => {
      const claim = await claimFor(reviewer, candidate.parameter_id, suffix);
      const attestation = attestationFor(candidate, reviewer.id, suffix, extra);
      const payload = payloadWithoutEmbeddedSignature(attestation);
      const envelope = signHumanDecision({
        envelope_id: `env.${suffix}.${RUN}`, organization_id: ORG, organization_version: "1.0.0", policy_version: "1.0.0",
        reviewer_id: reviewer.id, reviewer_identity_version: "1.0.0", reviewer_role: "human_parameter_reviewer", key_id: reviewer.key_id,
        purpose: "parameter_attestation", payload_schema_version: attestation.schema_version, payload,
        issued_at: attestation.attested_at, expires_at: iso(1_800), private_key: reviewer.key.private_key,
      });
      const signed = { ...attestation, signature_sha256: humanDecisionSignatureSha256(envelope.signature_base64) } as ParameterAttestation;
      return transaction(factory, reviewer, (context) => new PostgresParameterApprovalRepository(context, TENANT).appendAttestation({
        candidate, attestation: signed, expected_revision: expectedRevision, claim, verification: verified(envelope), metadata: meta(`attest.${suffix}`),
      }));
    };

    const firstOnA = await attestOnce(REVIEWERS.r1, candidateA, 1, "r1a");
    record("first_attestation_awaiting_second", firstOnA.state === "awaiting_second_attestation" && firstOnA.activation_allowed === false, firstOnA.state);

    // --- L6-2 / D1: a figure read from a page image is attested only by
    // someone who says they looked, at the very page and reading the candidate
    // carries; and a candidate with no such reading refuses a confirmation of
    // nothing. Four cases, on a synthetic candidate with synthetic hashes.
    const visualBindings = [{ page_pdf_sha256: sha256(`page:${RUN}`), visual_reading: "1¼" }];
    const paramV = `PARAM-SYNTHETIC-P0-V-${RUN}`;
    const candidateV = candidateFor(paramV, null, null, 3_600, { provenance_grade: "inferred_visual", visual_bindings: visualBindings });
    const importV = await importOne(candidateV, "v");
    record("visual_candidate_imported_as_draft_with_grade", importV.state === "draft", importV.state);
    const visualUnconfirmed = await refusal(() => attestOnce(REVIEWERS.r3, candidateV, 1, "r3v-unconfirmed"));
    record("visual_attestation_without_confirmation_refused", visualUnconfirmed.startsWith("P0001"), visualUnconfirmed);
    const visualWrongPage = await refusal(() => attestOnce(REVIEWERS.r3, candidateV, 1, "r3v-wrongpage",
      { visual_confirmed: true, visual_bindings: [{ page_pdf_sha256: sha256(`other-page:${RUN}`), visual_reading: "1¼" }] }));
    record("visual_attestation_naming_another_page_refused", visualWrongPage.startsWith("P0001"), visualWrongPage);
    const visualWrongReading = await refusal(() => attestOnce(REVIEWERS.r3, candidateV, 1, "r3v-wrongreading",
      { visual_confirmed: true, visual_bindings: [{ page_pdf_sha256: visualBindings[0].page_pdf_sha256, visual_reading: "1½" }] }));
    record("visual_attestation_naming_another_reading_refused", visualWrongReading.startsWith("P0001"), visualWrongReading);
    const visualConfirmed = await attestOnce(REVIEWERS.r3, candidateV, 1, "r3v-confirmed", { visual_confirmed: true, visual_bindings: visualBindings });
    record("visual_attestation_confirmed_reaches_awaiting_second", visualConfirmed.state === "awaiting_second_attestation" && visualConfirmed.activation_allowed === false, visualConfirmed.state);
    const confirmationOfNothing = await refusal(() => attestOnce(REVIEWERS.r4, candidateB, 1, "r4b-visual-on-text",
      { visual_confirmed: true, visual_bindings: visualBindings }));
    record("visual_confirmation_on_a_text_candidate_refused", confirmationOfNothing.startsWith("P0001"), confirmationOfNothing);

    // Confirmed by hand against DEV's own logs (message text is redacted by
    // the canonical wrapper by the time it reaches the port; only the
    // SQLSTATE survives, the same as every other direct-definer refusal in
    // this codebase): this raises exactly
    // GOVERNANCE_PARAMETER_DECISION_CROSS_BRANCH_ATTESTATION_FORBIDDEN.
    const crossBranch = await refusal(() => attestOnce(REVIEWERS.r1, candidateB, 1, "r1b"));
    record("cross_branch_attestation_by_same_reviewer_refused", crossBranch.startsWith("P0001"), crossBranch);

    // E2-2. The plainest way to fake two independent reviewers is to be one
    // reviewer twice on the same candidate, so that is proven refused directly
    // rather than inferred from the cross-branch case above — which is a
    // different rule about a different mistake. The definer counts prior
    // attestations and rejects any whose reviewer_id is already present
    // (GOVERNANCE_PARAMETER_REVIEWER_SEPARATION_REQUIRED).
    const sameReviewerTwice = await refusal(() => attestOnce(REVIEWERS.r1, candidateA, 2, "r1a-again"));
    record("same_identity_attesting_twice_refused", sameReviewerTwice.startsWith("P0001"), sameReviewerTwice);
    // And the candidate did not move because of the refused attempt: it is
    // still awaiting a second, distinct reviewer.
    const afterRefusal = await transaction(factory, SYSTEM_SESSION, (context) =>
      new PostgresParameterApprovalRepository(context, TENANT).readCurrent("parameter_approval", paramA, "1.0.0"));
    record("refused_second_attestation_left_state_untouched",
      afterRefusal.receipt.state === "awaiting_second_attestation" && afterRefusal.receipt.activation_allowed === false,
      `${afterRefusal.receipt.state} activation_allowed=${afterRefusal.receipt.activation_allowed}`);

    const secondOnA = await attestOnce(REVIEWERS.r2, candidateA, 2, "r2a");
    record("second_distinct_reviewer_resolves_decision",
      secondOnA.state === "dual_attested_inactive" && secondOnA.activation_allowed === false, secondOnA.state);

    // legal_open_decisions is also owner-only, no runtime-role read path; the
    // resolution is observed indirectly, through the sibling candidate it
    // must have rejected.
    const siblingAfter = await transaction(factory, SYSTEM_SESSION, (context) =>
      new PostgresParameterApprovalRepository(context, TENANT).readCurrent("parameter_approval", paramB, "1.0.0"));
    record("sibling_branch_rejected_by_decision", siblingAfter.receipt.state === "rejected_by_decision", siblingAfter.receipt.state);

    // --- Disagreement: two different reviewers, two different fresh branches, resolves nothing.
    const decisionId2 = `DEC-SYNTHETIC-P0-DISAGREE-${RUN}`;
    await transaction(factory, SYSTEM_SESSION, (context) => context.client.query(statement("p0_decision2_register",
      "select * from private.governance_legal_open_decision_register($1,$2::jsonb,$3,$4,$5)",
      [TENANT, JSON.stringify({ decision_id: decisionId2, topic: "minimum_wage", question: "x or y?", dossier_anchor: "synthetic dossier anchor 2" }),
        `decision2.${RUN}`, sha256(`decision2:${RUN}`), iso(0)])));
    const paramC = `PARAM-SYNTHETIC-P0-C-${RUN}`;
    const paramD = `PARAM-SYNTHETIC-P0-D-${RUN}`;
    const candidateC = candidateFor(paramC, decisionId2, "x", 100);
    const candidateD = candidateFor(paramD, decisionId2, "y", 200);
    await importOne(candidateC, "c");
    await importOne(candidateD, "d");
    const onC = await attestOnce(REVIEWERS.r3, candidateC, 1, "r3c");
    const onD = await attestOnce(REVIEWERS.r4, candidateD, 1, "r4d");
    record("disagreement_resolves_neither_branch",
      onC.state === "awaiting_second_attestation" && onD.state === "awaiting_second_attestation", `C:${onC.state} D:${onD.state}`);

    // --- legal_open_decisions append-only guard.
    const forbiddenUpdate = await refusal(() => transaction(factory, SYSTEM_SESSION, (context) =>
      context.client.query(statement("p0_decision_forbidden_update",
        "update private.legal_open_decisions set question = 'tampered' where tenant_id = $1 and decision_id = $2", [TENANT, decisionId2]))));
    record("legal_open_decisions_forbidden_field_update_refused", forbiddenUpdate.startsWith("42501"), forbiddenUpdate);
    const forbiddenDelete = await refusal(() => transaction(factory, SYSTEM_SESSION, (context) =>
      context.client.query(statement("p0_decision_forbidden_delete",
        "delete from private.legal_open_decisions where tenant_id = $1 and decision_id = $2", [TENANT, decisionId2]))));
    record("legal_open_decisions_delete_refused", forbiddenDelete.startsWith("42501"), forbiddenDelete);
  } catch (error) {
    failure = `${(error as { code?: string }).code ?? (error as Error).name}: ${String((error as Error).message).slice(0, 240)}`;
    record("matrix_completed", false, failure);
    process.stderr.write(`${String((error as Error).stack ?? "")}\n`);
    for (let cause = (error as { cause?: unknown }).cause; cause; cause = (cause as { cause?: unknown }).cause) {
      process.stderr.write(`  cause: ${String((cause as Error).message ?? cause).slice(0, 200)}\n`);
    }
  } finally {
    await factory.close().catch(() => undefined);
  }

  const failed = results.filter((entry) => entry.outcome === "fail");
  writeFileSync(path.join(RECEIPT_ROOT, "parameter-decision-matrix.json"), `${JSON.stringify({
    schema_version: "tivdoc-parameter-decision-matrix-p0", run_id: RUN, tenant: TENANT,
    real_parameters_active: 0, content_created: "none: synthetic candidates on a made-up currency only",
    cases: results.length, passed: results.length - failed.length, failed: failed.length, failure, results,
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`cases=${results.length} passed=${results.length - failed.length} failed=${failed.length}`
    + `${failed.length > 0 ? ` failing=${failed.map((f) => f.case).join(",")}` : ""}\n`);
  for (const entry of results) process.stdout.write(`  ${entry.outcome} ${entry.case} :: ${entry.observed}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
