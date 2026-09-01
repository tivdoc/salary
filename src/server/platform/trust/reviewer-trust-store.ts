import { createHash, createPublicKey, randomBytes, verify as verifySignature, type KeyObject } from "node:crypto";
import { z } from "zod";
import { isoTimestampSchema } from "../../../engine/domain/primitives.ts";
import {
  humanDecisionEnvelopeBody,
  humanDecisionEnvelopeSha256,
  humanDecisionPayloadSha256,
  humanDecisionSignatureBytes,
  humanDecisionSignatureSha256,
  humanDecisionSigningBytes,
  humanTrustIdSchema,
  signedHumanDecisionEnvelopeSchema,
  type HumanTrustVerificationPort,
  type HumanTrustVerificationRequest,
  type SignedHumanDecisionEnvelope,
  type VerifiedHumanDecision,
} from "../../../engine/legal-operations/human-trust.ts";
import { frozen, legalOperationsSha256 } from "../../../engine/legal-operations/canonical.ts";
import { legalOperationsSha256Schema } from "../../../engine/legal-operations/contracts.ts";
import {
  KEY_REGISTRATION_CHALLENGE_SCHEMA,
  keyPossessionChallengeSchema,
  keyPossessionSigningBytes,
  REVIEWER_TRUST_SCHEMA_VERSION,
  reviewerTrustPolicySchema,
  trustedReviewerSchema,
  trustOrganizationSchema,
  type KeyPossessionChallenge,
  type ReviewerTrustPolicy,
  type TrustedReviewer,
  type TrustOrganization,
} from "./reviewer-trust-contracts.ts";

export * from "./reviewer-trust-contracts.ts";

const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{2,99}$/);

type TrustedKey = Readonly<{
  challenge: KeyPossessionChallenge;
  registered_at: string;
  proof_signature_sha256: string;
}>;

export type ReviewerTrustAuditEvent = Readonly<{
  schema_version: typeof REVIEWER_TRUST_SCHEMA_VERSION;
  sequence: number;
  event_id: string;
  event_kind:
    | "organization_registered"
    | "policy_published"
    | "reviewer_registered"
    | "key_challenge_issued"
    | "key_registered"
    | "key_rotated"
    | "key_revoked"
    | "envelope_admitted"
    | "envelope_historically_verified"
    | "envelope_rejected";
  subject_id: string;
  actor_id: string;
  occurred_at: string;
  detail_sha256: string;
  prior_event_sha256: string | null;
  event_sha256: string;
}>;

type StoreOptions = Readonly<{
  root_admin_ids: readonly string[];
  clock?: () => string;
  random_bytes?: (length: number) => Uint8Array;
}>;

function unsignedWithHash<T extends Record<string, unknown>>(value: T, hashField: keyof T): Record<string, unknown> {
  const result: Record<string, unknown> = { ...value };
  delete result[String(hashField)];
  return result;
}

function milliseconds(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

function activeAt(from: string, to: string | null, at: string): boolean {
  return from <= at && (to === null || at < to);
}

function publicKeyFromPem(pem: string): Readonly<{ key: KeyObject; canonical_pem: string; sha256: string }> {
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new Error("TRUST_PUBLIC_KEY_INVALID");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("TRUST_PUBLIC_KEY_ALGORITHM_FORBIDDEN");
  const der = key.export({ type: "spki", format: "der" });
  const canonicalPem = key.export({ type: "spki", format: "pem" }).toString();
  return frozen({ key, canonical_pem: canonicalPem, sha256: createHash("sha256").update(der).digest("hex") });
}

export function createTrustOrganization(candidate: Omit<TrustOrganization, "organization_record_sha256">): TrustOrganization {
  const content = { ...candidate };
  return frozen(trustOrganizationSchema.parse({ ...content, organization_record_sha256: legalOperationsSha256(content) }));
}

export function createReviewerTrustPolicy(candidate: Omit<ReviewerTrustPolicy, "policy_sha256">): ReviewerTrustPolicy {
  const content = { ...candidate };
  return frozen(reviewerTrustPolicySchema.parse({ ...content, policy_sha256: legalOperationsSha256(content) }));
}

export function createTrustedReviewer(candidate: Omit<TrustedReviewer, "reviewer_record_sha256">): TrustedReviewer {
  const content = { ...candidate };
  return frozen(trustedReviewerSchema.parse({ ...content, reviewer_record_sha256: legalOperationsSha256(content) }));
}

export class InMemoryReviewerTrustStore implements HumanTrustVerificationPort {
  readonly #rootAdmins: ReadonlySet<string>;
  readonly #clock: () => string;
  readonly #randomBytes: (length: number) => Uint8Array;
  readonly #organizations = new Map<string, TrustOrganization>();
  readonly #organizationOrder = new Map<string, string[]>();
  readonly #policies = new Map<string, ReviewerTrustPolicy>();
  readonly #policyOrder = new Map<string, string[]>();
  readonly #reviewers = new Map<string, TrustedReviewer>();
  readonly #reviewerOrder = new Map<string, string[]>();
  readonly #challenges = new Map<string, KeyPossessionChallenge>();
  readonly #usedChallenges = new Set<string>();
  readonly #keys = new Map<string, TrustedKey>();
  readonly #rotations = new Map<string, Readonly<{ rotated_at: string; replacement_key_id: string }>>();
  readonly #revocations = new Map<string, Readonly<{ effective_at: string; recorded_at: string; reason_code: string }>>();
  readonly #events: ReviewerTrustAuditEvent[] = [];

  constructor(options: StoreOptions) {
    if (options.root_admin_ids.length === 0) throw new Error("TRUST_ROOT_ADMIN_REQUIRED");
    this.#rootAdmins = new Set(options.root_admin_ids.map((id) => humanTrustIdSchema.parse(id)));
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#randomBytes = options.random_bytes ?? ((length) => randomBytes(length));
  }

  registerOrganization(candidate: unknown, actorId: string): TrustOrganization {
    this.#assertRoot(actorId);
    const organization = trustOrganizationSchema.parse(candidate);
    if (legalOperationsSha256(unsignedWithHash(organization, "organization_record_sha256")) !== organization.organization_record_sha256) throw new Error("TRUST_ORGANIZATION_HASH_MISMATCH");
    const key = this.#organizationKey(organization.organization_id, organization.organization_version);
    const existing = this.#organizations.get(key);
    if (existing) {
      if (legalOperationsSha256(existing) !== legalOperationsSha256(organization)) throw new Error("TRUST_ORGANIZATION_APPEND_ONLY_MUTATION_REJECTED");
      return existing;
    }
    this.#organizations.set(key, organization);
    const order = this.#organizationOrder.get(organization.organization_id) ?? [];
    order.push(organization.organization_version);
    this.#organizationOrder.set(organization.organization_id, order);
    this.#append("organization_registered", organization.organization_id, actorId, this.#now(), organization.organization_record_sha256);
    return frozen(organization);
  }

  publishPolicy(candidate: unknown, actorId: string): ReviewerTrustPolicy {
    const policy = reviewerTrustPolicySchema.parse(candidate);
    const organization = this.#organization(policy.organization_id, policy.organization_version);
    this.#assertOrganizationAdmin(organization, actorId);
    if (legalOperationsSha256(unsignedWithHash(policy, "policy_sha256")) !== policy.policy_sha256) throw new Error("TRUST_POLICY_HASH_MISMATCH");
    if (!activeAt(organization.valid_from, organization.expires_at, policy.effective_from)) throw new Error("TRUST_POLICY_OUTSIDE_ORGANIZATION_VALIDITY");
    if (policy.expires_at !== null && organization.expires_at !== null && policy.expires_at > organization.expires_at) throw new Error("TRUST_POLICY_OUTSIDE_ORGANIZATION_VALIDITY");
    const key = this.#policyKey(policy.organization_id, policy.organization_version, policy.policy_version);
    const existing = this.#policies.get(key);
    if (existing) {
      if (legalOperationsSha256(existing) !== legalOperationsSha256(policy)) throw new Error("TRUST_POLICY_APPEND_ONLY_MUTATION_REJECTED");
      return existing;
    }
    this.#policies.set(key, policy);
    const orderKey = this.#organizationKey(policy.organization_id, policy.organization_version);
    const order = this.#policyOrder.get(orderKey) ?? [];
    order.push(policy.policy_version);
    this.#policyOrder.set(orderKey, order);
    this.#append("policy_published", `${policy.organization_id}@${policy.policy_version}`, actorId, this.#now(), policy.policy_sha256);
    return frozen(policy);
  }

  registerReviewer(candidate: unknown, actorId: string): TrustedReviewer {
    const reviewer = trustedReviewerSchema.parse(candidate);
    const organization = this.#organization(reviewer.organization_id, reviewer.organization_version);
    this.#assertOrganizationAdmin(organization, actorId);
    if (actorId === reviewer.reviewer_id) throw new Error("TRUST_REVIEWER_SELF_REGISTRATION_FORBIDDEN");
    if (legalOperationsSha256(unsignedWithHash(reviewer, "reviewer_record_sha256")) !== reviewer.reviewer_record_sha256) throw new Error("TRUST_REVIEWER_HASH_MISMATCH");
    if (!activeAt(organization.valid_from, organization.expires_at, reviewer.valid_from) || (organization.expires_at !== null && reviewer.expires_at > organization.expires_at)) throw new Error("TRUST_REVIEWER_OUTSIDE_ORGANIZATION_VALIDITY");
    const policy = this.#currentPolicy(reviewer.organization_id, reviewer.organization_version, reviewer.valid_from);
    const grantedRoles = new Set(policy.grants.map((grant) => grant.reviewer_role));
    if (reviewer.reviewer_roles.some((role) => !grantedRoles.has(role))) throw new Error("TRUST_REVIEWER_ROLE_NOT_GRANTED_BY_POLICY");
    const key = this.#reviewerKey(reviewer.reviewer_id, reviewer.reviewer_identity_version);
    const existing = this.#reviewers.get(key);
    if (existing) {
      if (legalOperationsSha256(existing) !== legalOperationsSha256(reviewer)) throw new Error("TRUST_REVIEWER_APPEND_ONLY_MUTATION_REJECTED");
      return existing;
    }
    this.#reviewers.set(key, reviewer);
    const order = this.#reviewerOrder.get(reviewer.reviewer_id) ?? [];
    order.push(reviewer.reviewer_identity_version);
    this.#reviewerOrder.set(reviewer.reviewer_id, order);
    this.#append("reviewer_registered", reviewer.reviewer_id, actorId, this.#now(), reviewer.reviewer_record_sha256);
    return frozen(reviewer);
  }

  issueKeyPossessionChallenge(input: Readonly<{
    challenge_id: string;
    reviewer_id: string;
    reviewer_identity_version: string;
    key_id: string;
    public_key_spki_pem: string;
    valid_from: string;
    expires_at: string;
    replaces_key_id: string | null;
    actor_id: string;
  }>): KeyPossessionChallenge {
    if (this.#challenges.has(input.challenge_id)) throw new Error("TRUST_KEY_CHALLENGE_ID_REUSED");
    const reviewer = this.#reviewer(input.reviewer_id, input.reviewer_identity_version);
    const organization = this.#organization(reviewer.organization_id, reviewer.organization_version);
    if (input.replaces_key_id === null) this.#assertOrganizationAdmin(organization, input.actor_id);
    else if (input.actor_id !== reviewer.reviewer_id && !this.#isOrganizationAdmin(organization, input.actor_id)) throw new Error("TRUST_KEY_ROTATION_ACTOR_FORBIDDEN");
    if (this.#keys.has(input.key_id)) throw new Error("TRUST_KEY_ID_REUSED");
    const publicKey = publicKeyFromPem(input.public_key_spki_pem);
    if (input.valid_from < reviewer.valid_from || input.expires_at > reviewer.expires_at) throw new Error("TRUST_KEY_OUTSIDE_REVIEWER_VALIDITY");
    const issuedAt = this.#now();
    if (input.valid_from < issuedAt) throw new Error("TRUST_KEY_VALIDITY_CANNOT_PREDATE_POSSESSION_CHALLENGE");
    const challenge = keyPossessionChallengeSchema.parse({
      schema_version: KEY_REGISTRATION_CHALLENGE_SCHEMA,
      challenge_id: input.challenge_id,
      organization_id: reviewer.organization_id,
      organization_version: reviewer.organization_version,
      reviewer_id: reviewer.reviewer_id,
      reviewer_identity_version: reviewer.reviewer_identity_version,
      key_id: input.key_id,
      public_key_spki_pem: publicKey.canonical_pem,
      public_key_sha256: publicKey.sha256,
      valid_from: input.valid_from,
      expires_at: input.expires_at,
      replaces_key_id: input.replaces_key_id,
      nonce: Buffer.from(this.#randomBytes(24)).toString("base64url"),
      issued_at: issuedAt,
      challenge_expires_at: new Date(milliseconds(issuedAt, "TRUST_CLOCK_INVALID") + 10 * 60_000).toISOString(),
    });
    this.#challenges.set(challenge.challenge_id, challenge);
    this.#append("key_challenge_issued", challenge.key_id, input.actor_id, issuedAt, legalOperationsSha256(challenge));
    return frozen(challenge);
  }

  registerProvenKey(input: Readonly<{ challenge: unknown; proof_signature_base64: string; rotation_authorization_signature_base64?: string }>): Readonly<{ key_id: string; public_key_sha256: string; registered_at: string }> {
    const challenge = keyPossessionChallengeSchema.parse(input.challenge);
    const stored = this.#challenges.get(challenge.challenge_id);
    if (!stored || legalOperationsSha256(stored) !== legalOperationsSha256(challenge)) throw new Error("TRUST_KEY_CHALLENGE_UNKNOWN_OR_MUTATED");
    if (this.#usedChallenges.has(challenge.challenge_id)) throw new Error("TRUST_KEY_CHALLENGE_ALREADY_USED");
    const now = this.#now();
    if (now > challenge.challenge_expires_at) throw new Error("TRUST_KEY_CHALLENGE_EXPIRED");
    const publicKey = publicKeyFromPem(challenge.public_key_spki_pem);
    const proof = humanDecisionSignatureBytes(input.proof_signature_base64);
    if (!verifySignature(null, keyPossessionSigningBytes(challenge), publicKey.key, proof)) throw new Error("TRUST_KEY_PROOF_OF_POSSESSION_INVALID");
    if (challenge.replaces_key_id !== null) {
      const previous = this.#key(challenge.replaces_key_id);
      if (previous.challenge.reviewer_id !== challenge.reviewer_id || previous.challenge.organization_id !== challenge.organization_id) throw new Error("TRUST_KEY_ROTATION_REVIEWER_MISMATCH");
      if (this.#rotations.has(challenge.replaces_key_id)) throw new Error("TRUST_KEY_ALREADY_ROTATED");
      if (this.#revokedAt(challenge.replaces_key_id, now)) throw new Error("TRUST_REVOKED_KEY_CANNOT_AUTHORIZE_ROTATION");
      if (!input.rotation_authorization_signature_base64) throw new Error("TRUST_KEY_ROTATION_AUTHORIZATION_REQUIRED");
      const authorization = humanDecisionSignatureBytes(input.rotation_authorization_signature_base64);
      const previousPublicKey = publicKeyFromPem(previous.challenge.public_key_spki_pem);
      if (!verifySignature(null, keyPossessionSigningBytes(challenge), previousPublicKey.key, authorization)) throw new Error("TRUST_KEY_ROTATION_AUTHORIZATION_INVALID");
    }
    this.#usedChallenges.add(challenge.challenge_id);
    const record = frozen({ challenge, registered_at: now, proof_signature_sha256: humanDecisionSignatureSha256(input.proof_signature_base64) });
    this.#keys.set(challenge.key_id, record);
    this.#append("key_registered", challenge.key_id, challenge.reviewer_id, now, legalOperationsSha256({ public_key_sha256: challenge.public_key_sha256, proof_signature_sha256: record.proof_signature_sha256 }));
    if (challenge.replaces_key_id !== null) {
      this.#rotations.set(challenge.replaces_key_id, frozen({ rotated_at: challenge.valid_from, replacement_key_id: challenge.key_id }));
      this.#append("key_rotated", challenge.replaces_key_id, challenge.reviewer_id, now, legalOperationsSha256({ replacement_key_id: challenge.key_id, rotated_at: challenge.valid_from }));
    }
    return frozen({ key_id: challenge.key_id, public_key_sha256: challenge.public_key_sha256, registered_at: now });
  }

  revokeKey(input: Readonly<{ key_id: string; effective_at: string; reason_code: string; actor_id: string }>): void {
    const key = this.#key(input.key_id);
    const organization = this.#organization(key.challenge.organization_id, key.challenge.organization_version);
    this.#assertOrganizationAdmin(organization, input.actor_id);
    reasonCode.parse(input.reason_code);
    isoTimestampSchema.parse(input.effective_at);
    if (this.#revocations.has(input.key_id)) throw new Error("TRUST_KEY_REVOCATION_ALREADY_RECORDED");
    const now = this.#now();
    this.#revocations.set(input.key_id, frozen({ effective_at: input.effective_at, recorded_at: now, reason_code: input.reason_code }));
    this.#append("key_revoked", input.key_id, input.actor_id, now, legalOperationsSha256({ effective_at: input.effective_at, reason_code: input.reason_code }));
  }

  verifyForAdmission(input: HumanTrustVerificationRequest): VerifiedHumanDecision {
    return this.#verify(input, false);
  }

  verifyHistorically(input: HumanTrustVerificationRequest): VerifiedHumanDecision {
    return this.#verify(input, true);
  }

  auditEvents(): readonly ReviewerTrustAuditEvent[] {
    return frozen(this.#events.map((event) => ({ ...event })));
  }

  verifyAuditChain(): Readonly<{ valid: boolean; event_count: number; tail_sha256: string | null }> {
    let prior: string | null = null;
    for (const event of this.#events) {
      const { event_sha256: expected, ...body } = event;
      if (body.prior_event_sha256 !== prior || legalOperationsSha256(body) !== expected) return frozen({ valid: false, event_count: this.#events.length, tail_sha256: prior });
      prior = event.event_sha256;
    }
    return frozen({ valid: true, event_count: this.#events.length, tail_sha256: prior });
  }

  #verify(input: HumanTrustVerificationRequest, historical: boolean): VerifiedHumanDecision {
    let envelope: SignedHumanDecisionEnvelope | null = null;
    const auditAt = this.#now();
    const admittedAt = input.admitted_at ?? auditAt;
    try {
      isoTimestampSchema.parse(admittedAt);
      envelope = signedHumanDecisionEnvelopeSchema.parse(input.envelope);
      if (envelope.purpose !== input.purpose) throw new Error("HUMAN_TRUST_PURPOSE_MISMATCH");
      if (envelope.reviewer_role !== input.required_reviewer_role) throw new Error("HUMAN_TRUST_ROLE_MISMATCH");
      if (humanDecisionPayloadSha256(input.payload) !== envelope.payload_sha256) throw new Error("HUMAN_TRUST_PAYLOAD_HASH_MISMATCH");
      const organization = this.#organization(envelope.organization_id, envelope.organization_version);
      const policy = this.#policy(envelope.organization_id, envelope.organization_version, envelope.policy_version);
      const reviewer = this.#reviewer(envelope.reviewer_id, envelope.reviewer_identity_version);
      const key = this.#key(envelope.key_id);
      if (reviewer.organization_id !== envelope.organization_id || reviewer.organization_version !== envelope.organization_version) throw new Error("HUMAN_TRUST_REVIEWER_ORGANIZATION_MISMATCH");
      if (!reviewer.reviewer_roles.includes(envelope.reviewer_role)) throw new Error("HUMAN_TRUST_REVIEWER_ROLE_NOT_REGISTERED");
      const envelopeReviewerRole = envelope.reviewer_role;
      const grant = policy.grants.find((entry) => entry.reviewer_role === envelopeReviewerRole);
      if (!grant?.purposes.includes(envelope.purpose)) throw new Error("HUMAN_TRUST_PURPOSE_NOT_GRANTED");
      if (key.challenge.reviewer_id !== envelope.reviewer_id || key.challenge.reviewer_identity_version !== envelope.reviewer_identity_version || key.challenge.organization_id !== envelope.organization_id || key.challenge.organization_version !== envelope.organization_version) throw new Error("HUMAN_TRUST_KEY_IDENTITY_BINDING_MISMATCH");
      if (!activeAt(organization.valid_from, organization.expires_at, envelope.issued_at)) throw new Error("HUMAN_TRUST_ORGANIZATION_NOT_VALID_AT_SIGNATURE");
      if (!activeAt(policy.effective_from, policy.expires_at, envelope.issued_at)) throw new Error("HUMAN_TRUST_POLICY_NOT_VALID_AT_SIGNATURE");
      if (!activeAt(reviewer.valid_from, reviewer.expires_at, envelope.issued_at)) throw new Error("HUMAN_TRUST_REVIEWER_NOT_VALID_AT_SIGNATURE");
      if (!activeAt(key.challenge.valid_from, key.challenge.expires_at, envelope.issued_at)) throw new Error("HUMAN_TRUST_KEY_NOT_VALID_AT_SIGNATURE");
      if (envelope.issued_at < key.registered_at) throw new Error("HUMAN_TRUST_SIGNATURE_PREDATES_KEY_REGISTRATION");
      if (envelope.expires_at > key.challenge.expires_at || envelope.expires_at > reviewer.expires_at || (policy.expires_at !== null && envelope.expires_at > policy.expires_at) || (organization.expires_at !== null && envelope.expires_at > organization.expires_at)) throw new Error("HUMAN_TRUST_ENVELOPE_EXCEEDS_TRUST_VALIDITY");
      if (milliseconds(envelope.expires_at, "HUMAN_TRUST_ENVELOPE_EXPIRY_INVALID") - milliseconds(envelope.issued_at, "HUMAN_TRUST_ENVELOPE_ISSUED_AT_INVALID") > policy.max_envelope_ttl_seconds * 1000) throw new Error("HUMAN_TRUST_ENVELOPE_TTL_EXCEEDED");
      const rotation = this.#rotations.get(envelope.key_id);
      if (rotation && rotation.rotated_at <= envelope.issued_at) throw new Error("HUMAN_TRUST_KEY_ROTATED_BEFORE_SIGNATURE");
      const revocation = this.#revocations.get(envelope.key_id);
      if (revocation && revocation.effective_at <= envelope.issued_at) throw new Error("HUMAN_TRUST_KEY_REVOKED_AT_SIGNATURE");
      const publicKey = publicKeyFromPem(key.challenge.public_key_spki_pem);
      if (!verifySignature(null, humanDecisionSigningBytes(humanDecisionEnvelopeBody(envelope)), publicKey.key, humanDecisionSignatureBytes(envelope.signature_base64))) throw new Error("HUMAN_TRUST_SIGNATURE_INVALID");
      const currentlyTrusted = this.#currentlyTrusted(envelope, admittedAt);
      if (!historical && !currentlyTrusted) throw new Error("HUMAN_TRUST_NOT_CURRENTLY_ADMISSIBLE");
      const verification = frozen({
        envelope,
        envelope_sha256: humanDecisionEnvelopeSha256(envelope),
        signature_sha256: humanDecisionSignatureSha256(envelope.signature_base64),
        organization_id: envelope.organization_id,
        organization_version: envelope.organization_version,
        policy_version: envelope.policy_version,
        reviewer_id: envelope.reviewer_id,
        reviewer_identity_version: envelope.reviewer_identity_version,
        reviewer_role: envelope.reviewer_role,
        key_id: envelope.key_id,
        purpose: envelope.purpose,
        valid_at_signing_time: true as const,
        currently_trusted: currentlyTrusted,
      }) satisfies VerifiedHumanDecision;
      this.#append(historical ? "envelope_historically_verified" : "envelope_admitted", envelope.envelope_id, envelope.reviewer_id, admittedAt, legalOperationsSha256({ envelope_sha256: verification.envelope_sha256, currently_trusted: currentlyTrusted }));
      return verification;
    } catch (error) {
      const message = error instanceof Error ? error.message : "HUMAN_TRUST_VERIFICATION_FAILED";
      const rejectionAt = isoTimestampSchema.safeParse(admittedAt).success ? admittedAt : auditAt;
      this.#append("envelope_rejected", envelope?.envelope_id ?? "trust.envelope.unparseable", envelope?.reviewer_id ?? "trust.actor.unknown", rejectionAt, legalOperationsSha256({ rejection_code: message }));
      throw error;
    }
  }

  #currentlyTrusted(envelope: SignedHumanDecisionEnvelope, admittedAt: string): boolean {
    if (admittedAt < envelope.issued_at || admittedAt >= envelope.expires_at) return false;
    const organizationVersions = this.#organizationOrder.get(envelope.organization_id) ?? [];
    const currentOrganizationVersion = [...organizationVersions].reverse().find((organizationVersion) => {
      const organization = this.#organization(envelope.organization_id, organizationVersion);
      return activeAt(organization.valid_from, organization.expires_at, admittedAt);
    });
    if (currentOrganizationVersion !== envelope.organization_version) return false;
    let currentPolicy: ReviewerTrustPolicy;
    try {
      currentPolicy = this.#currentPolicy(envelope.organization_id, envelope.organization_version, admittedAt);
    } catch {
      return false;
    }
    if (currentPolicy.policy_version !== envelope.policy_version) return false;
    const reviewerVersions = this.#reviewerOrder.get(envelope.reviewer_id) ?? [];
    const currentReviewerVersion = [...reviewerVersions].reverse().find((reviewerVersion) => {
      const reviewer = this.#reviewer(envelope.reviewer_id, reviewerVersion);
      return activeAt(reviewer.valid_from, reviewer.expires_at, admittedAt);
    });
    if (currentReviewerVersion !== envelope.reviewer_identity_version) return false;
    const rotation = this.#rotations.get(envelope.key_id);
    if (rotation && rotation.rotated_at <= admittedAt) return false;
    if (this.#revokedAt(envelope.key_id, admittedAt)) return false;
    return true;
  }

  #revokedAt(keyId: string, at: string): boolean {
    const revocation = this.#revocations.get(keyId);
    return Boolean(revocation && revocation.effective_at <= at);
  }

  #now(): string {
    return isoTimestampSchema.parse(this.#clock());
  }

  #append(kind: ReviewerTrustAuditEvent["event_kind"], subjectId: string, actorId: string, occurredAt: string, detailSha256: string) {
    const prior = this.#events.at(-1)?.event_sha256 ?? null;
    const body = {
      schema_version: REVIEWER_TRUST_SCHEMA_VERSION,
      sequence: this.#events.length + 1,
      event_id: `trust.event.${String(this.#events.length + 1).padStart(8, "0")}`,
      event_kind: kind,
      subject_id: humanTrustIdSchema.parse(subjectId),
      actor_id: humanTrustIdSchema.parse(actorId),
      occurred_at: isoTimestampSchema.parse(occurredAt),
      detail_sha256: legalOperationsSha256Schema.parse(detailSha256),
      prior_event_sha256: prior,
    } as const;
    const event = frozen({ ...body, event_sha256: legalOperationsSha256(body) }) as ReviewerTrustAuditEvent;
    this.#events.push(event);
    return event;
  }

  #assertRoot(actorId: string) {
    if (!this.#rootAdmins.has(actorId)) throw new Error("TRUST_ROOT_ADMIN_REQUIRED");
  }

  #isOrganizationAdmin(organization: TrustOrganization, actorId: string): boolean {
    return this.#rootAdmins.has(actorId) || organization.policy_admin_ids.includes(actorId);
  }

  #assertOrganizationAdmin(organization: TrustOrganization, actorId: string) {
    if (!this.#isOrganizationAdmin(organization, actorId)) throw new Error("TRUST_ORGANIZATION_ADMIN_REQUIRED");
  }

  #organizationKey(id: string, organizationVersion: string) { return `${id}@${organizationVersion}`; }
  #policyKey(id: string, organizationVersion: string, policyVersion: string) { return `${id}@${organizationVersion}#${policyVersion}`; }
  #reviewerKey(id: string, reviewerVersion: string) { return `${id}@${reviewerVersion}`; }

  #organization(id: string, organizationVersion: string): TrustOrganization {
    const record = this.#organizations.get(this.#organizationKey(id, organizationVersion));
    if (!record) throw new Error("TRUST_ORGANIZATION_NOT_FOUND");
    return record;
  }

  #policy(id: string, organizationVersion: string, policyVersion: string): ReviewerTrustPolicy {
    const record = this.#policies.get(this.#policyKey(id, organizationVersion, policyVersion));
    if (!record) throw new Error("TRUST_POLICY_NOT_FOUND");
    return record;
  }

  #currentPolicy(id: string, organizationVersion: string, at: string): ReviewerTrustPolicy {
    const versions = this.#policyOrder.get(this.#organizationKey(id, organizationVersion)) ?? [];
    const current = [...versions].reverse().map((policyVersion) => this.#policy(id, organizationVersion, policyVersion)).find((policy) => activeAt(policy.effective_from, policy.expires_at, at));
    if (!current) throw new Error("TRUST_ACTIVE_POLICY_NOT_FOUND");
    return current;
  }

  #reviewer(id: string, reviewerVersion: string): TrustedReviewer {
    const record = this.#reviewers.get(this.#reviewerKey(id, reviewerVersion));
    if (!record) throw new Error("TRUST_REVIEWER_NOT_FOUND");
    return record;
  }

  #key(id: string): TrustedKey {
    const record = this.#keys.get(id);
    if (!record) throw new Error("TRUST_KEY_NOT_FOUND");
    return record;
  }
}
