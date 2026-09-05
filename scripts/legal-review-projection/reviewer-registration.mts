// L4-5 / D3. The registration sequence itself, in one place, so that the proof
// and the owner's real command run the same code and not two things that look
// alike.
//
// A reviewer identity is four durable records and one signature:
//
//   organisation -> policy -> reviewer -> key challenge -> proven key
//
// The first three are appended by the policy admin. The fourth is issued by the
// admin and names the public key. The fifth is the only step the key holder
// performs: it signs the challenge's canonical bytes and the database verifies
// that signature against the public key it was issued for. The private half is
// read once, held in memory, and never printed, logged, returned or written.
//
// Nothing here decides who a reviewer is. It records that a named person holds
// a named key, which is the mechanical half of an identity; the human half is
// the owner deciding to run the command.
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from "node:crypto";
import pg from "pg";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import type { PostgresTransactionContext } from "../../src/server/platform/persistence/postgres/contracts.ts";
import { PostgresReviewerTrustRepository } from "../../src/server/platform/persistence/postgres/governance/repositories.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { createReviewerTrustPolicy, createTrustOrganization, createTrustedReviewer, keyPossessionSigningBytes } from "../../src/server/platform/trust/reviewer-trust-store.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

/**
 * D3 / D4. Proof rows belong here and nowhere else. A tenant whose name says
 * "synthetic proof" cannot be mistaken for the reference catalogue by anyone
 * reading a table, which is the failure this exists to prevent.
 */
export const SYNTHETIC_PROOF_TENANT = "legal.synthetic.proof";

export const REVIEWER_ROLE = "human_parameter_reviewer" as const;
export const REVIEWER_PURPOSE = "parameter_attestation" as const;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
/** The trust port binds a key by the digest of its SPKI DER bytes, not of the PEM text. */
const spkiSha256 = (pem: string) => createHash("sha256").update(createPublicKey(pem).export({ type: "spki", format: "der" })).digest("hex");

export type SessionRef = Readonly<{ sid: string; jti: string; subject: string }>;

export type RegistrationRequest = Readonly<{
  tenant: string;
  organization_id: string;
  /** The policy admin. Must differ from `reviewer_id` — the database refuses self-registration. */
  admin_actor: string;
  admin_session: SessionRef;
  reviewer_id: string;
  reviewer_session: SessionRef;
  public_key_spki_pem: string;
  /** Read from the ignored env file by the caller and never leaves this process. */
  private_key: KeyObject;
  identity_evidence_sha256: string;
  run_id: string;
}>;

export type RegistrationReceipt = Readonly<{
  tenant: string;
  organization_id: string;
  reviewer_id: string;
  reviewer_role: string;
  key_id: string;
  challenge_id: string;
  public_key_sha256: string;
  proof_signature_sha256: string;
  registered_at: string;
  private_key_printed: false;
}>;

/** The proof of possession: the challenge's canonical bytes, signed by the key holder. */
export function signChallenge(challenge: Parameters<typeof keyPossessionSigningBytes>[0], privateKey: KeyObject): string {
  return sign(null, keyPossessionSigningBytes(challenge), privateKey).toString("base64");
}

export function ownerPrivateKey(pem: string): KeyObject {
  return createPrivateKey(pem.replaceAll("\\n", "\n"));
}

/**
 * Seeds the runtime session rows the operations role needs. This is an admin
 * INSERT because `product_identity_session_register` refuses the reference
 * tenant outright (the A7-1 guard), and because a session is infrastructure
 * rather than an identity claim — the identity claim is the reviewer record.
 */
// External review #1, finding 8: this upsert never SHORTENS a session (it used to; see system-session-lifetime-proof.mts).
export async function seedSessions(tenant: string, organizationId: string, sessions: readonly SessionRef[]): Promise<void> {
  const env = readDevEnvFile();
  const adminUrl = env.get("TIVDOC_DEV_DATABASE_URL");
  if (!adminUrl) throw new Error("L45_ADMIN_URL_MISSING");
  const now = new Date();
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
  await admin.connect();
  try {
    await admin.query("select set_config('tivdoc.tenant_id', $1, false)", [tenant]);
    for (const session of sessions) {
      await admin.query(
        `insert into public.product_identity_sessions(
           tenant_id, sid, subject, current_jti, rotation_counter, valid_after,
           expires_at, revoked_at, reviewer_org_id, session_sha256, created_at
         ) values ($1,$2,$3,$4,1,to_timestamp($5),to_timestamp($6),null,$7,$8,to_timestamp($5))
         on conflict (tenant_id, sid) do update set
           subject = excluded.subject, session_sha256 = excluded.session_sha256,
           current_jti = excluded.current_jti, valid_after = least(public.product_identity_sessions.valid_after, excluded.valid_after),
           expires_at = greatest(public.product_identity_sessions.expires_at, excluded.expires_at), reviewer_org_id = excluded.reviewer_org_id`,
        [tenant, session.sid, session.subject, session.jti,
          Math.floor(now.getTime() / 1_000) - 5, Math.floor(now.getTime() / 1_000) + 3_600,
          organizationId, sha256(`${tenant}|${session.sid}|${session.subject}|${session.jti}`)],
      );
    }
  } finally {
    await admin.end().catch(() => undefined);
  }
}

function openFactory(applicationName: string): NodePostgresConnectionFactory {
  const env = readDevEnvFile();
  const url = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!url) throw new Error("L45_OPERATIONS_URL_MISSING");
  const parsed = new URL(url);
  return NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: url, max_connections: 2, connection_timeout_ms: 20_000,
    application_name: applicationName,
    remote_dev_target: {
      host: parsed.hostname, port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//u, ""), project_ref: env.get("TIVDOC_DEV_PROJECT_REF") ?? "",
    },
  });
}

async function transaction<T>(
  factory: NodePostgresConnectionFactory,
  session: SessionRef,
  label: string,
  work: (context: PostgresTransactionContext) => Promise<T>,
): Promise<T> {
  const client = await factory.acquire();
  try {
    await client.query(statement(`${label}_begin`, "begin", []));
    await client.query(statement(`${label}_context`, "select * from private.runtime_context_install($1,$2,$3)",
      [session.sid, session.jti, `${label}:${randomUUID().slice(0, 8)}`]));
    const value = await work({ client, transaction_id: `${label}:${randomUUID().slice(0, 8)}` });
    await client.query(statement(`${label}_commit`, "commit", []));
    return value;
  } catch (error) {
    await client.query(statement(`${label}_rollback`, "rollback", [])).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The organisation and its policy are appended with a STABLE idempotency key
 * and a fixed valid-from, so a second registration against the same
 * organisation replays them instead of colliding.
 *
 * The first version of this read the table first to decide whether to append.
 * It could not: those tables force RLS with `tenant_id =
 * runtime_verified_tenant()`, so an admin connection with no runtime context
 * sees nothing and concludes the organisation does not exist. The append then
 * failed on a unique violation — which the proof counted as a refusal, and was
 * not one. Idempotency is the mechanism the database already provides for
 * this, and it does not depend on being able to read anything.
 */
const TRUST_EPOCH = "2026-01-01T00:00:00.000Z";

export async function registerReviewerIdentity(request: RegistrationRequest): Promise<RegistrationReceipt> {
  if (request.reviewer_id === request.admin_actor) throw new Error("L45_REVIEWER_MAY_NOT_REGISTER_ITSELF");
  await seedSessions(request.tenant, request.organization_id, [request.admin_session, request.reviewer_session]);

  const now = new Date();
  const iso = (offsetSeconds: number) => new Date(now.getTime() + offsetSeconds * 1_000).toISOString();
  const meta = (key: string) => ({ idempotency_key: `${key}.${request.run_id}`, occurred_at: iso(0) });
  const keyId = `key.${request.reviewer_id}.${request.run_id}`;
  const challengeId = `challenge.${keyId}`;
  const publicKeySha256 = spkiSha256(request.public_key_spki_pem);
  const factory = openFactory("tivdoc_l45_reviewer_registration");

  const challenge = {
    schema_version: "tivdoc-key-possession-challenge-v0.10.0" as const,
    challenge_id: challengeId,
    organization_id: request.organization_id,
    organization_version: "1.0.0",
    reviewer_id: request.reviewer_id,
    reviewer_identity_version: "1.0.0",
    key_id: keyId,
    public_key_spki_pem: request.public_key_spki_pem,
    public_key_sha256: publicKeySha256,
    valid_from: iso(0),
    expires_at: iso(86_400),
    replaces_key_id: null,
    nonce: `nonce-${request.run_id}`.replaceAll(".", "-"),
    // The definer requires occurred_at = issued_at and issued_at <= valid_from.
    issued_at: iso(0),
    challenge_expires_at: iso(3_600),
  };

  try {
    await transaction(factory, request.admin_session, "l45_admin", async (context) => {
      const trust = new PostgresReviewerTrustRepository(context, request.tenant);
      const stable = (key: string) => ({ idempotency_key: key, occurred_at: TRUST_EPOCH });
      await trust.appendOrganization(createTrustOrganization({
        schema_version: "tivdoc-reviewer-trust-v0.10.0",
        organization_id: request.organization_id, organization_version: "1.0.0",
        valid_from: TRUST_EPOCH, expires_at: null, policy_admin_ids: [request.admin_actor],
      }), request.admin_actor, stable(`org.${request.organization_id}`));
      await trust.appendPolicy(createReviewerTrustPolicy({
        schema_version: "tivdoc-reviewer-trust-v0.10.0",
        organization_id: request.organization_id, organization_version: "1.0.0",
        policy_version: "1.0.0", effective_from: TRUST_EPOCH, expires_at: null,
        max_envelope_ttl_seconds: 3_600,
        grants: [{ reviewer_role: REVIEWER_ROLE, purposes: [REVIEWER_PURPOSE] }],
      }), request.admin_actor, stable(`policy.${request.organization_id}`));
      await trust.appendReviewer(createTrustedReviewer({
        schema_version: "tivdoc-reviewer-trust-v0.10.0",
        organization_id: request.organization_id, organization_version: "1.0.0",
        reviewer_id: request.reviewer_id, reviewer_identity_version: "1.0.0",
        reviewer_roles: [REVIEWER_ROLE],
        valid_from: iso(-3_600), expires_at: iso(86_400),
        identity_evidence_sha256: request.identity_evidence_sha256,
      }), request.admin_actor, meta(`reviewer.${request.reviewer_id}`));
      await trust.appendKeyChallenge(challenge, request.admin_actor, meta(`challenge.${keyId}`));
    });

    // Possession is proven by the key holder, in the key holder's own session:
    // the register definer attributes the event to the challenge's reviewer.
    const proofSignature = signChallenge(challenge, request.private_key);
    await transaction(factory, request.reviewer_session, "l45_prove", async (context) => {
      await new PostgresReviewerTrustRepository(context, request.tenant).registerProvenKey({
        challenge, proof_signature_base64: proofSignature,
        registered_at: iso(0), metadata: meta(`register.${keyId}`),
      });
    });

    return Object.freeze({
      tenant: request.tenant,
      organization_id: request.organization_id,
      reviewer_id: request.reviewer_id,
      reviewer_role: REVIEWER_ROLE,
      key_id: keyId,
      challenge_id: challengeId,
      public_key_sha256: publicKeySha256,
      // The signature's digest, not the signature — a receipt is evidence that
      // possession was proven, not a second copy of the proof.
      proof_signature_sha256: createHash("sha256").update(proofSignature, "utf8").digest("hex"),
      registered_at: iso(0),
      private_key_printed: false,
    });
  } finally {
    await factory.shutdown?.();
  }
}
