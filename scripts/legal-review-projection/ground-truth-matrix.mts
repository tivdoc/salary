// Wave 5 (G-3, G-4, G-5, G-6, G-7, G-8, G-9). The durable ground-truth workflow,
// proven on DEV as the operations runtime role, with zero ground-truth content
// produced and no lock left behind.
//
// The durable schema already existed (202609010004) and is product-reachable
// through PostgresGroundTruthRepository. What had never been done is to run it
// against DEV and show which rules the database enforces on its own — as
// opposed to rules the in-memory TrustedGroundTruthWorkflow enforced in
// process. Every assertion below is a refusal or an acceptance observed from
// the database through the product's own repositories over the real runtime
// role, or — for the two identity rules — through the definer called directly,
// past the port's validator, so the refusal is the database's and not the
// port's. Nothing here is a real annotation, reviewer, key or document: the
// trust organisation, reviewers and Ed25519 keys are generated for this run,
// the document digest is derived from the run id, and every manifest is the
// engine's synthetic fixture re-attributed to this run's reviewers.
// HUMAN_GROUND_TRUTH_LOCKED stays 0: no manifest reaches locked_ground_truth.
//
// Running it for real settled the actor model the definers impose, which the
// in-process workflow never had to state. Every mutation is attributed to a
// named actor and the guard admits only the verified session subject: work
// items are attributed to `governance.queue`, claims and key registrations to
// the reviewer, the unsigned disagreement to `ground.truth.system`, and a
// signed manifest to the reviewer whose decision was admitted. So the matrix
// holds one fixture session per subject and runs each command under the
// session whose subject it names — which is the shape a real deployment must
// take too. Each run is its own synthetic tenant because the work queue hands
// a claimant the oldest eligible item tenant-wide.
//
// The first real calls also surfaced three defects, all fixed in the tree:
// governance_trust_policy_append raised 42702 on its first invocation (a
// PL/pgSQL variable shadowed a column; 202609020014); the port parsed a
// ground-truth aggregate version "1" with the id schema, which requires three
// characters, so no manifest below revision 100 could be admitted; and the
// lock and correction branches of governance_gt_manifest_append raised the
// same 42702 (`document_sha256` shadowed the lock tables' column;
// 202609020016) — the annotation branches never read those tables, which is
// why the first ten observations passed over the defect. A history read
// definer (202609020015) was added because no runtime role could read a
// manifest's revision chain.
//
// The lock is observed inside a transaction that is then discarded: revision
// 5, status locked, a second lock refused while one is active — and the
// committed chain still ends at revision 4. The one lock path not exercised is
// correction_started superseding an active lock, which needs a committed lock.
// Race and restart are proven on the queue: two concurrent claims yield one
// winner, a reclaim advances the fencing token, the stale token is fenced
// out, and after every connection is closed and reopened the durable claim
// still acts.
//
// One boundary is stated rather than proven. The database checks that every
// identity is trusted for its role at signing time and that annotators and
// adjudicator are distinct, but it does not verify the Ed25519 signature —
// pgcrypto has no Ed25519, so the cryptographic check lives in the TypeScript
// verification port. "Enforced in the database" is true of identity
// distinctness and trust windows, and not of signature authenticity.

import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildSyntheticGroundTruthWorkflow } from "../../src/engine/extraction-ground-truth/synthetic-fixtures.ts";
import type { GroundTruthManifest } from "../../src/engine/wave2/contracts.ts";
import {
  TRUSTED_GT_SCHEMA, trustedGroundTruthActionPayload,
} from "../../src/engine/extraction-ground-truth/trusted-contracts.ts";
import type { GroundTruthAction } from "../../src/engine/extraction-ground-truth/trusted-contracts.ts";
import { calculateLockedGroundTruthSha256 } from "../../src/engine/extraction-ground-truth/validation.ts";
import {
  humanDecisionEnvelopeSha256, humanDecisionSignatureSha256, type VerifiedHumanDecision,
} from "../../src/engine/legal-operations/human-trust.ts";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import type { PostgresTransactionContext } from "../../src/server/platform/persistence/postgres/contracts.ts";
import {
  PostgresGovernanceWorkRepository, PostgresGroundTruthRepository, PostgresReviewerTrustRepository,
} from "../../src/server/platform/persistence/postgres/governance/repositories.ts";
import {
  NodePostgresConnectionFactory,
} from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import {
  createReviewerTrustPolicy, createTrustOrganization, createTrustedReviewer,
} from "../../src/server/platform/trust/reviewer-trust-store.ts";
import {
  generateEd25519TestKey, signHumanDecision, signKeyPossessionChallenge,
} from "../../src/server/platform/trust/test-support.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "v4";
const RECEIPT_ROOT = path.join("output", WAVE, "audit");
const RUN = process.env.TIVDOC_GT_RUN_ID ?? randomUUID().replaceAll("-", "").slice(0, 12);
// Each run is its own synthetic tenant. The work queue hands a claimant the
// oldest eligible item tenant-wide, with no way to skip one (a released item
// returns to the same queue), so two runs sharing a tenant would claim each
// other's leftovers and fail the claim binding. The trust stack, sessions and
// manifests are all tenant-scoped, so nothing of one run is visible to another.
const TENANT = `tenant.synthetic.gt.${RUN}`;
// One fixture session per subject. The work-claim, key-register and signed GT
// append definers attribute to the reviewer; enqueue to `governance.queue`; the
// unsigned disagreement to the system actor. Each runs under its subject's session.
const SESSION_SLOTS = ["system", "queue", "a", "b", "c", "l"] as const;
type SessionSlot = (typeof SESSION_SLOTS)[number];
// Session ids are run-scoped as well: the sessions table is keyed by sid alone.
const sessionFor = (slot: SessionSlot) => ({ sid: `session.gt.${slot}.${RUN}`, jti: `token.gt.${slot}.${RUN}` });
const ORG = `synthetic.gt.org.${RUN}`;
// The system actor. The trust-stack definers admit only an actor named in the
// organisation's `policy_admin_ids`, the unsigned disagreement append attributes
// to `ground.truth.system`, and the actor guard admits only the verified session
// subject (the worker-role carve-out does not apply to the operations role), so
// the system session's subject, the policy admin and every trust-stack actor
// are this one name. Signed GT appends attribute to the admitted reviewer and
// therefore run under that reviewer's own session.
const TRUST_ADMIN = "ground.truth.system";
// The fixture names one fixed synthetic document; the append definer keys a
// chain by document, so a re-run must not collide with an earlier run's chain.
const DOCUMENT_SHA256 = createHash("sha256").update(`synthetic-document:${RUN}`, "utf8").digest("hex");
const NOW = new Date();
const iso = (offsetSeconds: number) => new Date(NOW.getTime() + offsetSeconds * 1_000).toISOString();
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
// The trust port binds a key by the digest of its SPKI DER bytes, not of the PEM text.
const spkiSha256 = (pem: string) => createHash("sha256").update(createPublicKey(pem).export({ type: "spki", format: "der" })).digest("hex");

type Case = Readonly<{ case: string; outcome: "pass" | "fail"; observed: string }>;
const results: Case[] = [];
const record = (name: string, passed: boolean, observed: string) => {
  results.push(Object.freeze({ case: name, outcome: passed ? "pass" : "fail", observed }));
};

/**
 * The engine's synthetic workflow, re-attributed to this run's reviewers. The
 * fixture names fixed synthetic identities; the matrix needs identities that
 * exist in the durable trust stack, so every author and role id is remapped
 * while annotation ids, values and the section layout stay the fixture's.
 */
function reattributed(a1: string, a2: string, adj: string) {
  const fixture = buildSyntheticGroundTruthWorkflow();
  const ids = new Map<string, string>([
    [fixture.annotation_1.annotator_1_id, a1],
    [fixture.annotation_2.annotator_2_id ?? "", a2],
    [fixture.human_adjudication.adjudicator_id ?? "", adj],
  ]);
  const swap = (value: string | null) => (value === null ? null : (ids.get(value) ?? value));
  const remap = (manifest: GroundTruthManifest): GroundTruthManifest => Object.freeze({
    ...manifest,
    document_sha256: DOCUMENT_SHA256,
    annotator_1_id: swap(manifest.annotator_1_id) as string,
    annotator_2_id: swap(manifest.annotator_2_id),
    adjudicator_id: swap(manifest.adjudicator_id),
    annotations: manifest.annotations.map((annotation) => Object.freeze({
      ...annotation, author_id: swap(annotation.author_id) as string, document_sha256: DOCUMENT_SHA256,
    })),
  }) as GroundTruthManifest;
  return Object.freeze({
    annotation_1: remap(fixture.annotation_1),
    annotation_2: remap(fixture.annotation_2),
    disagreement: remap(fixture.disagreement),
    human_adjudication: remap(fixture.human_adjudication),
    locked_ground_truth: remap(fixture.locked_ground_truth),
  });
}

type Reviewer = Readonly<{ id: string; role: string; key: ReturnType<typeof generateEd25519TestKey>; key_id: string; slot: SessionSlot }>;

// Four reviewers: two annotators, one adjudicator, one lock reviewer. Keys are
// generated per run and never leave the process.
const reviewers: Record<Exclude<SessionSlot, "system" | "queue">, Reviewer> = {
  a: { id: `synthetic.gt.annotator.a.${RUN}`, role: "human_ground_truth_annotator", key: generateEd25519TestKey(), key_id: `key.a.${RUN}`, slot: "a" },
  b: { id: `synthetic.gt.annotator.b.${RUN}`, role: "human_ground_truth_annotator", key: generateEd25519TestKey(), key_id: `key.b.${RUN}`, slot: "b" },
  c: { id: `synthetic.gt.adjudicator.c.${RUN}`, role: "human_ground_truth_adjudicator", key: generateEd25519TestKey(), key_id: `key.c.${RUN}`, slot: "c" },
  l: { id: `synthetic.gt.lock.l.${RUN}`, role: "human_ground_truth_lock_reviewer", key: generateEd25519TestKey(), key_id: `key.l.${RUN}`, slot: "l" },
};
// The enqueue definer attributes every work item to `governance.queue`.
const QUEUE_ACTOR = "governance.queue";
const subjectFor = (slot: SessionSlot): string =>
  slot === "system" ? TRUST_ADMIN : slot === "queue" ? QUEUE_ACTOR : reviewers[slot].id;

/**
 * Runs one governance transaction as the operations role under the named
 * subject's session. `"rollback"` runs the operation to completion and then
 * discards it — used to observe what a lock does without leaving one behind.
 */
async function transaction<T>(
  factory: NodePostgresConnectionFactory,
  slot: SessionSlot,
  operation: (context: PostgresTransactionContext) => Promise<T>,
  mode: "commit" | "rollback" = "commit",
): Promise<T> {
  const client = await factory.acquire();
  const session = sessionFor(slot);
  try {
    await client.query(statement("gt_begin", "begin", []));
    await client.query(statement("gt_context",
      "select * from private.runtime_context_install($1,$2,$3)", [session.sid, session.jti, `gt:${RUN}:${slot}`]));
    const value = await operation({ client, transaction_id: `gt:${RUN}:${randomUUID().slice(0, 8)}` });
    await client.query(statement(mode === "commit" ? "gt_commit" : "gt_discard", mode, []));
    return value;
  } catch (error) {
    await client.query(statement("gt_rollback", "rollback", [])).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Every refusal is observed as a SQLSTATE plus message, never inferred. */
async function refusal(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "accepted";
  } catch (error) {
    // The SQLSTATE sits on the raw pg error, on the canonical error (`sqlstate`),
    // or on a repository error's cause; the first one found wins.
    let code: string | null = null;
    for (let cause: unknown = error; cause && !code; cause = (cause as { cause?: unknown }).cause) {
      const candidate = cause as { origin_sqlstate?: string | null; sqlstate?: string | null; code?: string };
      code = candidate.origin_sqlstate ?? candidate.sqlstate ?? (/^[0-9A-Z]{5}$/u.test(candidate.code ?? "") ? candidate.code! : null);
    }
    code ??= (error as { code?: string }).code ?? "unknown";
    // The canonical Postgres error redacts the message but keeps a trusted
    // domain token from a definer raise; surface it from wherever it sits.
    let domain: string | null = null;
    for (let cause: unknown = error; cause && !domain; cause = (cause as { cause?: unknown }).cause) {
      domain = (cause as { domain_code?: string | null }).domain_code ?? null;
    }
    return `${code}:${String((error as Error).message).slice(0, 90)}${domain ? `:${domain}` : ""}`;
  }
}

function verified(envelope: ReturnType<typeof signHumanDecision>, purpose: VerifiedHumanDecision["purpose"]): VerifiedHumanDecision {
  return Object.freeze({
    envelope,
    organization_id: envelope.organization_id,
    organization_version: envelope.organization_version,
    policy_version: envelope.policy_version,
    reviewer_id: envelope.reviewer_id,
    reviewer_identity_version: envelope.reviewer_identity_version,
    reviewer_role: envelope.reviewer_role,
    key_id: envelope.key_id,
    purpose,
    valid_at_signing_time: true as const,
    currently_trusted: true,
    // The canonical digests the port re-derives and compares; the verifier
    // that normally produces this record is bypassed here on purpose (see the
    // header: signature verification is a TS-port concern, not a DB one).
    envelope_sha256: humanDecisionEnvelopeSha256(envelope),
    signature_sha256: humanDecisionSignatureSha256(envelope.signature_base64),
  }) as unknown as VerifiedHumanDecision;
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const adminUrl = env.get("TIVDOC_DEV_DATABASE_URL");
  const operationsUrl = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  const projectRef = env.get("TIVDOC_DEV_PROJECT_REF");
  if (!adminUrl || !operationsUrl || !projectRef) throw new Error("GT_MATRIX_ENV_MISSING");
  const { default: pg } = await import("pg");

  // Fixture sessions for the runtime context, one per subject, all carrying
  // this run's organisation so the reviewer-role guard can match it.
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
  await admin.connect();
  try {
    await admin.query("select set_config('tivdoc.tenant_id', $1, false)", [TENANT]);
    for (const slot of SESSION_SLOTS) {
      const session = sessionFor(slot);
      const subject = subjectFor(slot);
      await admin.query(
        `insert into public.product_identity_sessions(
           tenant_id, sid, subject, current_jti, rotation_counter, valid_after,
           expires_at, revoked_at, reviewer_org_id, session_sha256, created_at
         ) values ($1,$2,$3,$4,1,to_timestamp($5),to_timestamp($6),null,$7,$8,to_timestamp($5))
         on conflict (tenant_id, sid) do update set
           subject = excluded.subject, session_sha256 = excluded.session_sha256,
           current_jti = excluded.current_jti, valid_after = excluded.valid_after,
           expires_at = excluded.expires_at, reviewer_org_id = excluded.reviewer_org_id`,
        [TENANT, session.sid, subject, session.jti, Math.floor(NOW.getTime() / 1_000) - 5,
          Math.floor(NOW.getTime() / 1_000) + 3_600, ORG,
          sha256(`${TENANT}|${session.sid}|${subject}|${session.jti}`)],
      );
    }
  } finally {
    await admin.end().catch(() => undefined);
  }

  const parsed = new URL(operationsUrl);
  const openFactory = () => NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: operationsUrl, max_connections: 4, connection_timeout_ms: 20_000,
    application_name: "tivdoc_ground_truth_matrix",
    remote_dev_target: { host: parsed.hostname, port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//u, ""), project_ref: projectRef },
  });
  let factory = openFactory();

  let failure: string | null = null;
  try {
    // --- Trust stack: one organisation, one policy, four reviewers, four keys.
    const meta = (key: string) => ({ idempotency_key: `${key}.${RUN}`, occurred_at: iso(0) });
    const challenges = new Map<SessionSlot, Parameters<PostgresReviewerTrustRepository["appendKeyChallenge"]>[0]>();

    await transaction(factory, "system", async (context) => {
      const trust = new PostgresReviewerTrustRepository(context, TENANT);
      await trust.appendOrganization(createTrustOrganization({
        schema_version: "tivdoc-reviewer-trust-v0.10.0", organization_id: ORG, organization_version: "1.0.0",
        valid_from: iso(-3_600), expires_at: null, policy_admin_ids: [TRUST_ADMIN],
      }), TRUST_ADMIN, meta("org"));
      await trust.appendPolicy(createReviewerTrustPolicy({
        schema_version: "tivdoc-reviewer-trust-v0.10.0", organization_id: ORG, organization_version: "1.0.0",
        policy_version: "1.0.0", effective_from: iso(-3_600), expires_at: null, max_envelope_ttl_seconds: 3_600,
        grants: [
          { reviewer_role: "human_ground_truth_annotator", purposes: ["ground_truth_annotation"] },
          { reviewer_role: "human_ground_truth_adjudicator", purposes: ["ground_truth_adjudication"] },
          { reviewer_role: "human_ground_truth_lock_reviewer", purposes: ["ground_truth_lock"] },
        ],
      }), TRUST_ADMIN, meta("policy"));
      for (const reviewer of Object.values(reviewers)) {
        await trust.appendReviewer(createTrustedReviewer({
          schema_version: "tivdoc-reviewer-trust-v0.10.0", organization_id: ORG, organization_version: "1.0.0",
          reviewer_id: reviewer.id, reviewer_identity_version: "1.0.0", reviewer_roles: [reviewer.role],
          valid_from: iso(-3_600), expires_at: iso(86_400), identity_evidence_sha256: sha256(`evidence:${reviewer.id}`),
        }), TRUST_ADMIN, meta(`reviewer.${reviewer.id}`));
        const challenge = {
          schema_version: "tivdoc-key-possession-challenge-v0.10.0" as const,
          challenge_id: `challenge.${reviewer.key_id}`, organization_id: ORG, organization_version: "1.0.0",
          reviewer_id: reviewer.id, reviewer_identity_version: "1.0.0", key_id: reviewer.key_id,
          public_key_spki_pem: reviewer.key.public_key_spki_pem,
          public_key_sha256: spkiSha256(reviewer.key.public_key_spki_pem),
          valid_from: iso(0), expires_at: iso(86_400), replaces_key_id: null,
          nonce: `nonce-${RUN}-${reviewer.key_id}`.replaceAll(".", "-"),
          // The definer requires occurred_at = issued_at and issued_at <= valid_from.
          issued_at: iso(0), challenge_expires_at: iso(3_600),
        };
        await trust.appendKeyChallenge(challenge, TRUST_ADMIN, meta(`challenge.${reviewer.key_id}`));
        challenges.set(reviewer.slot, challenge);
      }
    });
    // Possession is proven by the reviewer: the register definer attributes the
    // event to the challenge's reviewer, so it runs under that reviewer's session.
    for (const reviewer of Object.values(reviewers)) {
      const challenge = challenges.get(reviewer.slot);
      if (!challenge) throw new Error(`GT_MATRIX_CHALLENGE_MISSING:${reviewer.slot}`);
      await transaction(factory, reviewer.slot, async (context) => {
        const trust = new PostgresReviewerTrustRepository(context, TENANT);
        await trust.registerProvenKey({
          challenge, proof_signature_base64: signKeyPossessionChallenge(challenge, reviewer.key.private_key),
          registered_at: iso(0), metadata: meta(`register.${reviewer.key_id}`),
        });
      });
    }
    record("trust_stack_durable", true, "organisation, policy, four reviewers, four keys proven by their reviewers, all as the runtime role");

    // --- Work items and claims: one per pass, claimed by its reviewer.
    const manifestId = `SYNTHETIC_GT_MANIFEST_${RUN}`;
    const rename = (source: GroundTruthManifest, patch: Partial<GroundTruthManifest> = {}): GroundTruthManifest =>
      Object.freeze({ ...source, manifest_id: manifestId, ...patch }) as GroundTruthManifest;
    const forged = (a1: string, a2: string, adj: string) => reattributed(a1, a2, adj);
    const workflow = forged(reviewers.a.id, reviewers.b.id, reviewers.c.id);

    // The queue is fed by the queue identity; the claim is taken by the reviewer
    // in their own session, because the claim definer asserts actor = claimant
    // and checks the claimed role against the durable reviewer record.
    const claimFor = async (reviewer: Reviewer, workKind: string, suffix: string) => {
      const itemId = `gt.work.${suffix}.${RUN}`;
      await transaction(factory, "queue", async (context) => {
        await new PostgresGovernanceWorkRepository(context, TENANT).enqueue({
          work_item_id: itemId, workflow_kind: "ground_truth", aggregate_id: manifestId, aggregate_version: "1",
          work_kind: workKind, required_role: reviewer.role, document_sha256: DOCUMENT_SHA256,
          // ground_truth work must name an exact-byte object version; synthetic here.
          object_version_id: `synthetic.object.${RUN}`, input_sha256: sha256(`input:${itemId}`), payload: { synthetic: true },
          idempotency_key: `enqueue.${itemId}`, created_at: iso(0),
        });
      });
      // The queue hands out the oldest eligible item for (kind, role), not a
      // named one. Within a run that is the item just enqueued, or an earlier
      // one of this run bound to the same manifest, document and role — either
      // satisfies the append's claim binding.
      return transaction(factory, reviewer.slot, async (context) => {
        const claim = await new PostgresGovernanceWorkRepository(context, TENANT).claim({
          workflow_kind: "ground_truth", work_kind: workKind, claimant_id: reviewer.id,
          reviewer_role: reviewer.role, now: iso(0), lease_seconds: 600,
        });
        if (!claim) throw new Error(`GT_MATRIX_CLAIM_MISSING:${itemId}`);
        if (claim.aggregate_id !== manifestId) throw new Error(`GT_MATRIX_FOREIGN_WORK_ITEM:${claim.work_item_id}`);
        return { work_item_id: claim.work_item_id, claimant_id: claim.claimant_id, fencing_token: claim.fencing_token };
      });
    };

    // Signs exactly what the port binds: the trusted action payload derived from
    // (action, prior, next), under the trusted-GT payload schema.
    const sign = (reviewer: Reviewer, action: GroundTruthAction, prior: GroundTruthManifest | null,
      next: GroundTruthManifest, suffix: string) => {
      const purpose: VerifiedHumanDecision["purpose"] = action === "lock" ? "ground_truth_lock"
        : action === "human_adjudication" ? "ground_truth_adjudication" : "ground_truth_annotation";
      return verified(signHumanDecision({
        envelope_id: `env.${suffix}.${RUN}`, organization_id: ORG, organization_version: "1.0.0", policy_version: "1.0.0",
        reviewer_id: reviewer.id, reviewer_identity_version: "1.0.0", reviewer_role: reviewer.role, key_id: reviewer.key_id,
        purpose, payload_schema_version: TRUSTED_GT_SCHEMA,
        payload: trustedGroundTruthActionPayload(action, prior, next), issued_at: iso(0), expires_at: iso(1_800),
        private_key: reviewer.key.private_key,
      }), purpose);
    };

    const a1 = rename(workflow.annotation_1);
    const a2 = rename(workflow.annotation_2);
    const dis = rename(workflow.disagreement);
    const adj = rename(workflow.human_adjudication);

    // annotation_1 by A — accepted.
    // The claim and envelope are kept: G-8 replays this exact command later.
    const a1Claim = await claimFor(reviewers.a, "ground_truth_annotation", "a1");
    const a1Verification = sign(reviewers.a, "annotation_1", null, a1, "a1");
    await transaction(factory, reviewers.a.slot, async (context) => {
      const gt = new PostgresGroundTruthRepository(context, TENANT);
      await gt.appendManifest({
        event_kind: "annotation_1_signed", prior_manifest: null, manifest: a1, expected_workflow_revision: 0,
        claim: a1Claim, verification: a1Verification, metadata: meta("append.a1"),
      });
    });
    record("annotation_1_accepted", true, "annotator A, workflow revision 0 -> 1");

    // G-4: annotation_2 by the SAME identity — must be refused by the database.
    const same = rename(forged(reviewers.a.id, reviewers.a.id, reviewers.c.id).annotation_2);
    const sameIdentity = await refusal(async () => {
      const claim = await claimFor(reviewers.a, "ground_truth_annotation", "a2same");
      await transaction(factory, reviewers.a.slot, async (context) => {
        const gt = new PostgresGroundTruthRepository(context, TENANT);
      await gt.appendManifest({
        event_kind: "annotation_2_signed", prior_manifest: a1, manifest: same, expected_workflow_revision: 1,
        claim, verification: sign(reviewers.a, "annotation_2", a1, same, "a2same"), metadata: meta("append.a2same"),
      });
      });
    });
    record("G4_same_identity_cannot_annotate_twice", sameIdentity !== "accepted", sameIdentity);
    // The port's validator refused above; the database has its own guard
    // (annotator_1_id = annotator_2_id -> GOVERNANCE_GT_ANNOTATION_2_TRANSITION_INVALID),
    // proven here by handing the same manifest straight to the definer as A,
    // past the validator. The message exceeds the canonical error's 32-character
    // domain-token limit, so only the SQLSTATE is observable from the port; the
    // chain staying at revision 1 (B's append below lands as 1 -> 2) is the rest.
    const sameAtDatabase = await refusal(() => transaction(factory, reviewers.a.slot, async (context) => {
      await context.client.query(statement("gt_append_same_identity_direct",
        "select * from private.governance_gt_manifest_append($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11)",
        [TENANT, "annotation_2_signed", JSON.stringify(same), 1, `gt.work.none.${RUN}`, reviewers.a.id, 1,
          `env.none.${RUN}`, `direct.a2same.${RUN}`, sha256(`direct:a2same:${RUN}`), iso(0)]));
    }));
    record("G4_database_guard_same_identity", sameAtDatabase.startsWith("P0001"), sameAtDatabase);

    // annotation_2 by B — accepted.
    await (async () => {
      const claim = await claimFor(reviewers.b, "ground_truth_annotation", "a2");
      await transaction(factory, reviewers.b.slot, async (context) => {
        const gt = new PostgresGroundTruthRepository(context, TENANT);
      await gt.appendManifest({
        event_kind: "annotation_2_signed", prior_manifest: a1, manifest: a2, expected_workflow_revision: 1,
        claim, verification: sign(reviewers.b, "annotation_2", a1, a2, "a2"), metadata: meta("append.a2"),
      });
      });
    })();
    record("G4_second_distinct_identity_accepted", true, "annotator B, workflow revision 1 -> 2");

    // G-5: disagreement recorded, unsigned, deterministic from the two passes.
    await transaction(factory, "system", async (context) => {
      const gt = new PostgresGroundTruthRepository(context, TENANT);
      await gt.appendManifest({
        event_kind: "disagreement_recorded", prior_manifest: a2, manifest: dis, expected_workflow_revision: 2,
        claim: null, verification: null, metadata: meta("append.dis"),
      });
    });
    record("G5_disagreement_recorded", true, "workflow revision 2 -> 3, no envelope, status disagreement");

    // G-6: adjudication by an annotator — refused; by a third identity — accepted.
    const byB = rename(forged(reviewers.a.id, reviewers.b.id, reviewers.b.id).human_adjudication);
    const adjByAnnotator = await refusal(async () => {
      const claim = await claimFor(reviewers.b, "ground_truth_adjudication", "adjb");
      await transaction(factory, reviewers.b.slot, async (context) => {
        const gt = new PostgresGroundTruthRepository(context, TENANT);
      await gt.appendManifest({
        event_kind: "adjudication_signed", prior_manifest: dis, manifest: byB, expected_workflow_revision: 3,
        claim, verification: sign(reviewers.b, "human_adjudication", dis, byB, "adjb"), metadata: meta("append.adjb"),
      });
      });
    });
    record("G6_annotator_cannot_adjudicate", adjByAnnotator !== "accepted", adjByAnnotator);
    // Same shape for the third-identity rule: the definer refuses an adjudicator
    // who is either annotator (GOVERNANCE_GT_ADJUDICATION_TRANSITION_INVALID)
    // before it looks at any claim or envelope.
    const adjByAnnotatorAtDatabase = await refusal(() => transaction(factory, reviewers.b.slot, async (context) => {
      await context.client.query(statement("gt_append_adjudicate_by_annotator_direct",
        "select * from private.governance_gt_manifest_append($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11)",
        [TENANT, "adjudication_signed", JSON.stringify(byB), 3, `gt.work.none.${RUN}`, reviewers.b.id, 1,
          `env.none.${RUN}`, `direct.adjb.${RUN}`, sha256(`direct:adjb:${RUN}`), iso(0)]));
    }));
    record("G6_database_guard_annotator_adjudicates", adjByAnnotatorAtDatabase.startsWith("P0001"), adjByAnnotatorAtDatabase);
    await (async () => {
      const claim = await claimFor(reviewers.c, "ground_truth_adjudication", "adj");
      await transaction(factory, reviewers.c.slot, async (context) => {
        const gt = new PostgresGroundTruthRepository(context, TENANT);
      await gt.appendManifest({
        event_kind: "adjudication_signed", prior_manifest: dis, manifest: adj, expected_workflow_revision: 3,
        claim, verification: sign(reviewers.c, "human_adjudication", dis, adj, "adj"), metadata: meta("append.adj"),
      });
      });
    })();
    record("G6_third_identity_adjudicates", true, "adjudicator C, workflow revision 3 -> 4");

    // A lock manifest is the adjudicated manifest with its status and locked
    // digest set; the digest is computed by the engine's own function.
    const lockOf = (source: GroundTruthManifest): GroundTruthManifest => {
      const unlocked = Object.freeze({ ...source, status: "locked_ground_truth", locked_sha256: null }) as GroundTruthManifest;
      return Object.freeze({ ...unlocked, locked_sha256: calculateLockedGroundTruthSha256(unlocked) }) as GroundTruthManifest;
    };
    const locked = lockOf(adj);

    // G-3: a manifest whose chain is broken — sections changed against the
    // adjudicated prior — is refused. Its locked digest is valid for what it
    // carries, so the port's validator passes it and the refusal is the
    // database's chain guard (GOVERNANCE_GT_IMMUTABLE_CHAIN_MISMATCH), observed
    // through the port and then again with the definer called directly.
    const tampered = lockOf(Object.freeze({
      ...adj,
      sections: [{ section_id: "synthetic.section.tampered", page_from: 1, page_to: 1 }],
      annotations: adj.annotations.map((entry) => Object.freeze({ ...entry, section: "synthetic.section.tampered" })),
    }) as GroundTruthManifest);
    const lockBrokenClaim = await claimFor(reviewers.l, "ground_truth_lock", "lockbroken");
    const brokenChain = await refusal(() => transaction(factory, reviewers.l.slot, async (context) => {
      await new PostgresGroundTruthRepository(context, TENANT).appendManifest({
        event_kind: "ground_truth_locked", prior_manifest: adj, manifest: tampered, expected_workflow_revision: 4,
        claim: lockBrokenClaim, verification: sign(reviewers.l, "lock", adj, tampered, "lockbroken"), metadata: meta("append.lockbroken"),
      });
    }));
    record("G3_broken_chain_refused", brokenChain !== "accepted", brokenChain);
    const brokenChainAtDatabase = await refusal(() => transaction(factory, reviewers.l.slot, async (context) => {
      await context.client.query(statement("gt_append_broken_chain_direct",
        "select * from private.governance_gt_manifest_append($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11)",
        [TENANT, "ground_truth_locked", JSON.stringify(tampered), 4, lockBrokenClaim.work_item_id, reviewers.l.id,
          lockBrokenClaim.fencing_token, `env.none.${RUN}`, `direct.lockbroken.${RUN}`, sha256(`direct:lockbroken:${RUN}`), iso(0)]));
    }));
    record("G3_database_guard_broken_chain", brokenChainAtDatabase.startsWith("P0001"), brokenChainAtDatabase);

    // G-8: replaying the annotation_1 command — same claim, same envelope, same
    // idempotency key — is answered from the idempotency ledger and adds nothing.
    // (A fresh claim would be a different command, and is refused as one.)
    const replay = await refusal(async () => {
      await transaction(factory, reviewers.a.slot, async (context) => {
        const gt = new PostgresGroundTruthRepository(context, TENANT);
        const receipt = await gt.appendManifest({
          event_kind: "annotation_1_signed", prior_manifest: null, manifest: a1, expected_workflow_revision: 0,
          claim: a1Claim, verification: a1Verification, metadata: meta("append.a1"),
        });
        if (!receipt.idempotent_replay) throw new Error("GT_MATRIX_REPLAY_NOT_IDEMPOTENT");
      });
    });
    record("G8_replay_is_idempotent", replay === "accepted", replay === "accepted" ? "same key, idempotent_replay true, revision unchanged" : replay);

    // --- G-7: lock semantics, proven without leaving a lock behind.
    // The definer refuses a lock whose claimant is an annotator or the
    // adjudicator before it looks at any claim or envelope.
    const lockByAnnotator = await refusal(() => transaction(factory, reviewers.a.slot, async (context) => {
      await context.client.query(statement("gt_append_lock_by_annotator_direct",
        "select * from private.governance_gt_manifest_append($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11)",
        [TENANT, "ground_truth_locked", JSON.stringify(locked), 4, `gt.work.none.${RUN}`, reviewers.a.id, 1,
          `env.none.${RUN}`, `direct.locka.${RUN}`, sha256(`direct:locka:${RUN}`), iso(0)]));
    }));
    record("G7_lock_by_annotator_refused_at_database", lockByAnnotator.startsWith("P0001"), lockByAnnotator);

    // The lock itself: claimed and signed by L, appended through the port, and
    // observed inside the transaction — revision 5, status locked, a second
    // lock on the same document refused — before the transaction is discarded.
    // Nothing is committed; HUMAN_GROUND_TRUTH_LOCKED cannot move.
    const lockClaim = await claimFor(reviewers.l, "ground_truth_lock", "lock");
    const lockProbe = await transaction(factory, reviewers.l.slot, async (context) => {
      const receipt = await new PostgresGroundTruthRepository(context, TENANT).appendManifest({
        event_kind: "ground_truth_locked", prior_manifest: adj, manifest: locked, expected_workflow_revision: 4,
        claim: lockClaim, verification: sign(reviewers.l, "lock", adj, locked, "lock"), metadata: meta("append.lock"),
      });
      const inside = await context.client.query(statement("gt_history_inside_lock",
        "select workflow_revision::text as workflow_revision, status from private.governance_gt_manifest_history_read($1, $2)",
        [TENANT, manifestId]));
      const chainInside = inside.rows.map((row) => `${String(row.workflow_revision)}:${String(row.status)}`).join(" ");
      await context.client.query(statement("gt_savepoint", "savepoint second_lock", []));
      const secondLock = await refusal(() => context.client.query(statement("gt_append_second_lock_direct",
        "select * from private.governance_gt_manifest_append($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11)",
        [TENANT, "ground_truth_locked", JSON.stringify(locked), 5, lockClaim.work_item_id, reviewers.l.id,
          lockClaim.fencing_token, `env.none.${RUN}`, `direct.lock2.${RUN}`, sha256(`direct:lock2:${RUN}`), iso(0)])));
      await context.client.query(statement("gt_savepoint_undo", "rollback to savepoint second_lock", []));
      return { revision: receipt.revision, state: receipt.state, chainInside, secondLock };
    }, "rollback");
    record("G7_lock_by_third_identity_accepted_in_discarded_probe",
      lockProbe.revision === 5 && lockProbe.state === "locked_ground_truth"
        && lockProbe.chainInside.endsWith(" 5:locked_ground_truth"),
      `revision ${lockProbe.revision} ${lockProbe.state}; chain inside: ${lockProbe.chainInside}`);
    record("G7_second_lock_while_active_refused", lockProbe.secondLock.startsWith("P0001"), lockProbe.secondLock);
    const afterProbe = await transaction(factory, "system", async (context) => {
      const rows = await context.client.query(statement("gt_history_after_probe",
        "select workflow_revision::text as workflow_revision, status from private.governance_gt_manifest_history_read($1, $2)",
        [TENANT, manifestId]));
      return rows.rows.map((row) => `${String(row.workflow_revision)}:${String(row.status)}`).join(" ");
    });
    record("G7_lock_probe_discarded_nothing_locked",
      afterProbe === "1:annotation_1 2:annotation_2 3:disagreement 4:human_adjudication", afterProbe);

    // --- G-9: race and restart on the durable queue.
    // One item on an otherwise empty lane; two annotators claim it at once.
    const raceItem = `gt.work.race.${RUN}`;
    await transaction(factory, "queue", async (context) => {
      await new PostgresGovernanceWorkRepository(context, TENANT).enqueue({
        work_item_id: raceItem, workflow_kind: "ground_truth", aggregate_id: manifestId, aggregate_version: "1",
        work_kind: "ground_truth_visual_eligibility", required_role: reviewers.a.role, document_sha256: DOCUMENT_SHA256,
        object_version_id: `synthetic.object.${RUN}`, input_sha256: sha256(`input:${raceItem}`), payload: { synthetic: true },
        idempotency_key: `enqueue.${raceItem}`, created_at: iso(0),
      });
    });
    const claimRace = (reviewer: Reviewer) => transaction(factory, reviewer.slot, async (context) =>
      new PostgresGovernanceWorkRepository(context, TENANT).claim({
        workflow_kind: "ground_truth", work_kind: "ground_truth_visual_eligibility", claimant_id: reviewer.id,
        reviewer_role: reviewer.role, now: iso(0), lease_seconds: 600,
      }));
    const [raceA, raceB] = await Promise.all([claimRace(reviewers.a), claimRace(reviewers.b)]);
    const winners = [raceA, raceB].filter((claim) => claim !== null);
    record("G9_concurrent_claims_single_winner",
      winners.length === 1 && winners[0]!.work_item_id === raceItem,
      `A:${raceA?.fencing_token ?? "null"} B:${raceB?.fencing_token ?? "null"}`);
    const first = winners[0]!;
    const holder = raceA !== null ? reviewers.a : reviewers.b;
    const other = raceA !== null ? reviewers.b : reviewers.a;
    const release = (reviewer: Reviewer, token: number, next: "pending" | "released", key: string) =>
      transaction(factory, reviewer.slot, async (context) => {
        await new PostgresGovernanceWorkRepository(context, TENANT).release({
          work_item_id: raceItem, claimant_id: reviewer.id, fencing_token: token, next_state: next,
          reason_code: "GT_MATRIX_RACE_RELEASE", occurred_at: iso(0), idempotency_key: `release.${key}.${RUN}`,
        });
      });
    // The holder gives the item back; the other claims it and the fence advances.
    await release(holder, first.fencing_token, "pending", "race.1");
    const second = await claimRace(other);
    record("G9_reclaim_advances_fencing_token", second !== null && second.fencing_token === first.fencing_token + 1,
      `first ${first.fencing_token} -> second ${second?.fencing_token ?? "null"}`);
    // A release with the stale token by the previous holder is fenced out.
    const stale = await refusal(() => release(holder, first.fencing_token, "pending", "race.stale"));
    record("G9_stale_fencing_token_refused", stale.startsWith("P0001"), stale);
    // Restart: every connection is closed and a new pool opened; the claim and
    // its token live in the database, so the current holder can still act.
    await factory.close();
    factory = openFactory();
    const afterRestart = await refusal(() => release(other, second!.fencing_token, "released", "race.2"));
    record("G9_claim_survives_process_restart", afterRestart === "accepted",
      afterRestart === "accepted" ? `released with token ${second!.fencing_token} after reconnect` : afterRestart);

    // Observed state, read back rather than inferred, both as the runtime role:
    // the current aggregate through the port, the full revision chain through
    // the history-read definer (the versions table itself is visible to no
    // runtime role and to no non-owner, by design).
    const current = await transaction(factory, "system", async (context) =>
      new PostgresGroundTruthRepository(context, TENANT).readCurrent("ground_truth", manifestId, "1"));
    const currentObserved = `${current.receipt.revision}:${current.receipt.state}`;
    record("workflow_current_via_port", currentObserved === "4:human_adjudication", currentObserved);
    const chain = await transaction(factory, "system", async (context) => {
      const rows = await context.client.query(statement("gt_history",
        "select workflow_revision::text as workflow_revision, status, envelope_id"
        + " from private.governance_gt_manifest_history_read($1, $2)", [TENANT, manifestId]));
      return rows.rows.map((row) => `${String(row.workflow_revision)}:${String(row.status)}`).join(" ");
    });
    record("workflow_chain_observed", chain === "1:annotation_1 2:annotation_2 3:disagreement 4:human_adjudication", chain);
    // The chain is unreadable without a verified tenant: the same definer,
    // called outside any runtime context, refuses rather than returning rows.
    const unverified = await refusal(async () => {
      const client = await factory.acquire();
      try {
        await client.query(statement("gt_history_unverified",
          "select * from private.governance_gt_manifest_history_read($1, $2)", [TENANT, manifestId]));
      } finally {
        client.release();
      }
    });
    record("workflow_chain_requires_verified_tenant", unverified.startsWith("42501"), unverified);
  } catch (error) {
    failure = `${(error as { code?: string }).code ?? (error as Error).name}: ${String((error as Error).message).slice(0, 240)}`;
    record("matrix_completed", false, failure);
    // Stack to stderr only; the receipt carries the message.
    process.stderr.write(`${String((error as Error).stack ?? "")}
`);
    for (let cause = (error as { cause?: unknown }).cause; cause; cause = (cause as { cause?: unknown }).cause) {
      const domain = (cause as { domain_code?: string | null }).domain_code;
      process.stderr.write(`  cause: ${String((cause as Error).message ?? cause).slice(0, 200)}${domain ? ` domain=${domain}` : ""}
`);
    }
  } finally {
    await factory.close().catch(() => undefined);
  }

  const failed = results.filter((entry) => entry.outcome === "fail");
  writeFileSync(path.join(RECEIPT_ROOT, "ground-truth-matrix.json"), `${JSON.stringify({
    schema_version: "tivdoc-ground-truth-matrix-wave5", run_id: RUN, tenant: TENANT,
    human_ground_truth_locked: 0, content_created: "none: synthetic fixture manifests only",
    signature_verification_in_database: false,
    not_exercised: [
      "G-7 correction_started supersession of an active lock: requires a committed lock; HUMAN_GROUND_TRUTH_LOCKED stays 0",
    ],
    cases: results.length, passed: results.length - failed.length, failed: failed.length, failure, results,
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`cases=${results.length} passed=${results.length - failed.length} failed=${failed.length}`
    + `${failed.length > 0 ? ` failing=${failed.map((f) => f.case).join(",")}` : ""}\n`);
  for (const entry of results) process.stdout.write(`  ${entry.outcome} ${entry.case} :: ${entry.observed}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
