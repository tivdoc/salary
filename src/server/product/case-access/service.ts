// UX Run 1 / U2–U4 (design authority v1.1, D-1.1..D-1.5). The access service:
// the link a verified payment sends, the code a link or a contact asks for,
// the session a code opens, and what a session may see. product_runtime only:
// it imports nothing from the engine, the reference tenant, Pool P, the
// selection registrar or the shadow; it reads configuration for every limit.
//
// Two rules hold everywhere here. A contact's existence is never revealed:
// every request answers "accepted" whether or not a contact exists, and the
// per-identity limit is enforced silently. The token appears in the message
// and in the link's path segment, and nowhere else — not in a log line, not
// in a query string, not in an analytics payload; the store holds its hash.
import "server-only";
import { productOffer } from "@/lib/product-offer";
import {
  ACCESS_CODE_PATTERN, createAccessCode, createOpaqueToken, hashAccessCode, hashRequesterIp, hashSession, hashToken,
  isOpaqueToken, normalizeContact, type ContactChannel, type NormalizedContact,
} from "./crypto.ts";
import { resolveCaseAccessDb, type CaseAccessDb } from "./db.ts";
import {
  renderAccessCode, renderCaseLink, renderReportReady, sendNotification, type NotificationOutcome, type NotificationTemplate,
} from "./notifications.ts";

const DAY = 86_400;

export type LinkPurpose = "payment_verified" | "resend" | "report_ready";

export type SendLinkResult = Readonly<{
  case_id: string;
  outcome: "sent" | "already_sent" | "send_failed" | "no_contact" | "no_store";
  token_id: string | null;
  provider: string | null;
  error_code: string | null;
}>;

export type RequestCodeResult = Readonly<{
  accepted: true;
  // What the caller may say: nothing that distinguishes an unknown contact from a known one.
  masked_channel: ContactChannel | null;
  masked_to: string | null;
  refused: "ip_rate_limited" | null;
}>;

export type VerifyCodeResult =
  | Readonly<{ outcome: "ok"; session: string; session_ttl_seconds: number; identity_id: string; next: string }>
  | Readonly<{ outcome: "invalid" | "expired" | "locked" | "none" | "link_invalid" | "request_invalid" }>;

export type IdentitySession = Readonly<{
  session_id: string;
  identity_id: string;
  channel: ContactChannel;
  contact_normalized: string;
  expires_at: string;
}>;

export type IdentityCase = Readonly<{
  case_id: string;
  public_id: string;
  status: string;
  payment_status: string;
  created_at: string;
  payment_verified: boolean;
}>;

type TokenResolution = Readonly<{
  token_id: string; case_id: string; identity_id: string; channel: ContactChannel; contact_normalized: string; public_id: string; valid: boolean;
}>;

function secret(): string {
  const value = process.env.CASE_TOKEN_SECRET;
  if (!value || value.length < 32) throw new Error("CASE_TOKEN_SECRET must contain at least 32 characters");
  return value;
}

/** The public origin a link is built on; production names it, the local runtime names its loopback. */
export function publicOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim() || process.env.TIVDOC_LOCAL_PRODUCT_ALLOWED_ORIGIN?.trim();
  if (configured) return configured.replace(/\/$/u, "");
  const vercel = process.env.VERCEL_URL?.trim();
  return vercel ? `https://${vercel}` : "http://localhost:3000";
}

/** A contact shown back to its owner: "d***@example.com", "+972-5*-***-1234". */
export function maskContact(contact: NormalizedContact): string {
  if (contact.channel === "email") {
    const [local = "", domain = ""] = contact.normalized.split("@");
    return `${local.slice(0, 1)}***@${domain}`;
  }
  const digits = contact.normalized.replace(/\D/gu, "");
  return `${contact.normalized.slice(0, 5)}*-***-${digits.slice(-4)}`;
}

async function contactOfCase(db: CaseAccessDb, caseId: string): Promise<Readonly<{ public_id: string; first_name: string | null; contact: NormalizedContact; payment_verified: boolean }> | null> {
  const rows = await db.rpc<{ case_id: string; public_id: string; email: string | null; phone: string | null; first_name: string | null; payment_verified: boolean }>("case_access_case_contact", { target_case: caseId });
  const row = rows[0];
  if (!row) return null;
  // The channel on file: email first, phone when there is no usable email.
  const contact = normalizeContact(row.email) ?? normalizeContact(row.phone);
  if (!contact) return null;
  return { public_id: row.public_id, first_name: row.first_name, contact, payment_verified: row.payment_verified };
}

async function ensureIdentity(db: CaseAccessDb, contact: NormalizedContact, caseId: string | null): Promise<string> {
  const rows = await db.rpc<{ value: string }>("case_access_identity_upsert", {
    target_channel: contact.channel, target_contact_hash: contact.hash, target_contact_normalized: contact.normalized,
  });
  const identityId = rows[0]?.value;
  if (!identityId) throw new Error("CASE_ACCESS_IDENTITY_UPSERT_EMPTY");
  if (caseId) await db.rpc("case_access_identity_link", { target_identity: identityId, target_case: caseId });
  return identityId;
}

async function recordNotification(db: CaseAccessDb, input: Readonly<{ case_id: string | null; identity_id: string | null; channel: ContactChannel; template: NotificationTemplate; outcome: NotificationOutcome }>): Promise<void> {
  await db.rpc("case_notification_record", {
    target_case: input.case_id, target_identity: input.identity_id, target_channel: input.channel, target_template: input.template,
    target_state: input.outcome.state, target_provider: input.outcome.provider, target_payload_sha256: input.outcome.payload_sha256,
    target_error_code: input.outcome.error_code,
  });
}

/**
 * U4. Issues the case link once per verified payment and sends it. Idempotent
 * under the reconcile cron: the partial unique index makes the second issue a
 * no-op, and a token already sent is never sent again; a token whose send
 * failed is retried by the sweep. Never throws into the payment path.
 */
export async function issueAndSendCaseLink(caseId: string, purpose: LinkPurpose = "payment_verified", db?: CaseAccessDb | null): Promise<SendLinkResult> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return { case_id: caseId, outcome: "no_store", token_id: null, provider: null, error_code: "no_store_configured" };
  const found = await contactOfCase(store, caseId);
  if (!found) return { case_id: caseId, outcome: "no_contact", token_id: null, provider: null, error_code: "contact_missing" };
  const identityId = await ensureIdentity(store, found.contact, caseId);
  const offer = productOffer();
  const ttlSeconds = offer.access.link_token_ttl_days * DAY;

  // The existing payment_verified token, if any, decides between "already sent" and "retry the send".
  if (purpose === "payment_verified") {
    const existing = (await store.rpc<{ token_id: string; send_state: string; send_attempts: number }>("case_access_token_for_case", { target_case: caseId, target_purpose: purpose }))[0];
    if (existing?.send_state === "sent") return { case_id: caseId, outcome: "already_sent", token_id: existing.token_id, provider: null, error_code: null };
    if (existing && existing.send_state !== "sent") {
      // A token whose send failed is superseded by a fresh one on retry: the failed token is revoked below by expiry of use, and its row keeps the failure.
      const token = createOpaqueToken();
      const reissued = (await store.rpc<{ token_id: string; issued: boolean }>("case_access_token_issue", {
        target_case: caseId, target_identity: identityId, target_purpose: "resend", target_token_hash: hashToken(token), target_ttl_seconds: ttlSeconds,
      }))[0];
      if (!reissued) return { case_id: caseId, outcome: "send_failed", token_id: existing.token_id, provider: null, error_code: "token_reissue_failed" };
      const outcome = await deliverLink(store, { caseId, identityId, contact: found.contact, firstName: found.first_name, publicId: found.public_id, token, ttlDays: offer.access.link_token_ttl_days });
      await store.rpc("case_access_token_mark_send", { target_token: reissued.token_id, target_state: outcome.state, target_error_code: outcome.error_code });
      // The payment_verified row records the same outcome so the sweep stops retrying once a resend went out.
      await store.rpc("case_access_token_mark_send", { target_token: existing.token_id, target_state: outcome.state, target_error_code: outcome.error_code });
      return { case_id: caseId, outcome: outcome.state === "sent" ? "sent" : "send_failed", token_id: reissued.token_id, provider: outcome.provider, error_code: outcome.error_code };
    }
  }

  const token = createOpaqueToken();
  const issued = (await store.rpc<{ token_id: string; issued: boolean }>("case_access_token_issue", {
    target_case: caseId, target_identity: identityId, target_purpose: purpose, target_token_hash: hashToken(token), target_ttl_seconds: ttlSeconds,
  }))[0];
  if (!issued) return { case_id: caseId, outcome: "send_failed", token_id: null, provider: null, error_code: "token_issue_failed" };
  if (!issued.issued) {
    // Lost the race to a concurrent verification: that one sends.
    return { case_id: caseId, outcome: "already_sent", token_id: issued.token_id, provider: null, error_code: null };
  }
  const outcome = await deliverLink(store, { caseId, identityId, contact: found.contact, firstName: found.first_name, publicId: found.public_id, token, ttlDays: offer.access.link_token_ttl_days });
  await store.rpc("case_access_token_mark_send", { target_token: issued.token_id, target_state: outcome.state, target_error_code: outcome.error_code });
  return { case_id: caseId, outcome: outcome.state === "sent" ? "sent" : "send_failed", token_id: issued.token_id, provider: outcome.provider, error_code: outcome.error_code };
}

async function deliverLink(db: CaseAccessDb, input: Readonly<{ caseId: string; identityId: string; contact: NormalizedContact; firstName: string | null; publicId: string; token: string; ttlDays: number }>): Promise<NotificationOutcome> {
  const linkUrl = `${publicOrigin()}/case/${input.token}`;
  const rendered = renderCaseLink({ firstName: input.firstName, publicId: input.publicId, linkUrl, expiresInDays: input.ttlDays });
  const outcome = await sendNotification({ template: "case_link", channel: input.contact.channel, to: input.contact.normalized, ...rendered });
  await recordNotification(db, { case_id: input.caseId, identity_id: input.identityId, channel: input.contact.channel, template: "case_link", outcome });
  return outcome;
}

/** U4. The catch-up sweep the reconcile cron runs: every verified payment without a sent link gets exactly one. */
export async function sweepPendingCaseLinks(limit = 50, db?: CaseAccessDb | null): Promise<Readonly<{ examined: number; sent: number; failed: number; already_sent: number }>> {
  const store = db ?? await resolveCaseAccessDb();
  const summary = { examined: 0, sent: 0, failed: 0, already_sent: 0 };
  if (!store) return summary;
  const pending = await store.rpc<{ case_id: string }>("case_access_pending_links", { target_limit: limit });
  for (const row of pending) {
    summary.examined += 1;
    const result = await issueAndSendCaseLink(row.case_id, "payment_verified", store);
    if (result.outcome === "sent") summary.sent += 1;
    else if (result.outcome === "already_sent") summary.already_sent += 1;
    else summary.failed += 1;
  }
  return summary;
}

/** U5. A resend from the funnel's own case (the case cookie): a fresh link, limited per case. */
export async function resendCaseLink(caseId: string, db?: CaseAccessDb | null): Promise<SendLinkResult | Readonly<{ outcome: "resend_limited" | "not_verified" }>> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return { case_id: caseId, outcome: "no_store", token_id: null, provider: null, error_code: "no_store_configured" };
  const found = await contactOfCase(store, caseId);
  if (!found) return { case_id: caseId, outcome: "no_contact", token_id: null, provider: null, error_code: "contact_missing" };
  if (!found.payment_verified) return { outcome: "not_verified" };
  const counts = (await store.rpc<{ sent: number; failed: number }>("case_notification_count", { target_case: caseId, target_template: "case_link" }))[0];
  if ((counts?.sent ?? 0) >= productOffer().access.resend_limit_per_case) return { outcome: "resend_limited" };
  return issueAndSendCaseLink(caseId, "resend", store);
}

/** The site brief's second template: the report is ready. Fired by report_published once S3.2 exists; by hand from /operations until then (S6). */
export async function sendReportReadyNotification(caseId: string, db?: CaseAccessDb | null): Promise<SendLinkResult> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return { case_id: caseId, outcome: "no_store", token_id: null, provider: null, error_code: "no_store_configured" };
  const found = await contactOfCase(store, caseId);
  if (!found) return { case_id: caseId, outcome: "no_contact", token_id: null, provider: null, error_code: "contact_missing" };
  const identityId = await ensureIdentity(store, found.contact, caseId);
  const token = createOpaqueToken();
  const issued = (await store.rpc<{ token_id: string; issued: boolean }>("case_access_token_issue", {
    target_case: caseId, target_identity: identityId, target_purpose: "report_ready", target_token_hash: hashToken(token), target_ttl_seconds: productOffer().access.link_token_ttl_days * DAY,
  }))[0];
  if (!issued) return { case_id: caseId, outcome: "send_failed", token_id: null, provider: null, error_code: "token_issue_failed" };
  const rendered = renderReportReady({ publicId: found.public_id, linkUrl: `${publicOrigin()}/case/${token}` });
  const outcome = await sendNotification({ template: "report_ready", channel: found.contact.channel, to: found.contact.normalized, ...rendered });
  await recordNotification(store, { case_id: caseId, identity_id: identityId, channel: found.contact.channel, template: "report_ready", outcome });
  await store.rpc("case_access_token_mark_send", { target_token: issued.token_id, target_state: outcome.state, target_error_code: outcome.error_code });
  return { case_id: caseId, outcome: outcome.state === "sent" ? "sent" : "send_failed", token_id: issued.token_id, provider: outcome.provider, error_code: outcome.error_code };
}

async function resolveToken(db: CaseAccessDb, token: string): Promise<TokenResolution | null> {
  const rows = await db.rpc<TokenResolution>("case_access_token_resolve", { target_token_hash: hashToken(token) });
  return rows[0] ?? null;
}

/**
 * U2. Requests a code, for a link token (the challenge the link opens) or for
 * a contact (login and recovery). Always "accepted": an unknown contact, an
 * invalid token and a silently rate-limited identity all read the same; only
 * the per-IP ceiling answers differently, uniformly for everyone.
 */
export async function requestAccessCode(input: Readonly<{ token?: unknown; contact?: unknown; request: Request }>, db?: CaseAccessDb | null): Promise<RequestCodeResult> {
  const store = db ?? await resolveCaseAccessDb();
  const accepted = { accepted: true as const, masked_channel: null, masked_to: null, refused: null };
  if (!store) return accepted;
  const offer = productOffer().access;
  const ipHash = hashRequesterIp(input.request, secret());
  let identityId: string | null = null;
  let contact: NormalizedContact | null = null;
  let tokenId: string | null = null;
  if (isOpaqueToken(input.token)) {
    const resolved = await resolveToken(store, input.token);
    if (resolved?.valid) {
      identityId = resolved.identity_id;
      tokenId = resolved.token_id;
      contact = normalizeContact(resolved.contact_normalized);
    }
  } else {
    const normalized = normalizeContact(input.contact);
    if (normalized) {
      const found = (await store.rpc<{ identity_id: string; contact_normalized: string }>("case_access_identity_find", { target_channel: normalized.channel, target_contact_hash: normalized.hash }))[0];
      if (found) {
        identityId = found.identity_id;
        contact = normalized;
      }
    }
  }
  if (!identityId || !contact) {
    // Nothing to send to. The per-IP ceiling still applies to an unknown contact (identity_limit 0 stops the call before any row is written), so an enumeration is throttled like a real request and answered the same.
    if (ipHash) {
      const recent = await store.rpc<{ code_id: string | null; refused: string | null }>("case_access_code_issue", {
        target_identity: null, target_token: null, target_code_hash: "0".repeat(64), target_ttl_seconds: 1, target_max_attempts: 1, target_ip_hash: ipHash,
        identity_limit: 0, identity_window_seconds: 1, ip_limit: offer.request_limit_per_ip, ip_window_seconds: offer.request_window_minutes * 60,
      }).catch(() => [] as ReadonlyArray<{ code_id: string | null; refused: string | null }>);
      if (recent[0]?.refused === "ip_rate_limited") return { ...accepted, refused: "ip_rate_limited" };
    }
    return accepted;
  }
  const code = createAccessCode();
  const issued = (await store.rpc<{ code_id: string | null; refused: string | null }>("case_access_code_issue", {
    target_identity: identityId, target_token: tokenId, target_code_hash: hashAccessCode(identityId, code),
    target_ttl_seconds: offer.code_ttl_minutes * 60, target_max_attempts: offer.code_max_attempts, target_ip_hash: ipHash,
    identity_limit: offer.request_limit_per_identity, identity_window_seconds: offer.request_window_minutes * 60,
    ip_limit: offer.request_limit_per_ip, ip_window_seconds: offer.request_window_minutes * 60,
  }))[0];
  if (issued?.refused === "ip_rate_limited") return { ...accepted, refused: "ip_rate_limited" };
  if (issued?.refused || !issued?.code_id) return { ...accepted, masked_channel: contact.channel, masked_to: maskContact(contact) };
  const rendered = renderAccessCode({ code, expiresInMinutes: offer.code_ttl_minutes });
  const outcome = await sendNotification({ template: "access_code", channel: contact.channel, to: contact.normalized, ...rendered });
  await recordNotification(store, { case_id: null, identity_id: identityId, channel: contact.channel, template: "access_code", outcome });
  return { ...accepted, masked_channel: contact.channel, masked_to: maskContact(contact) };
}

/** U2. A code becomes a session. The session is opaque; the store holds its hash. */
export async function verifyAccessCode(input: Readonly<{ token?: unknown; contact?: unknown; code: unknown }>, db?: CaseAccessDb | null): Promise<VerifyCodeResult> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return { outcome: "none" };
  if (typeof input.code !== "string" || !ACCESS_CODE_PATTERN.test(input.code)) return { outcome: "request_invalid" };
  let identityId: string | null = null;
  let tokenId: string | null = null;
  let landing: string | null = null;
  if (isOpaqueToken(input.token)) {
    const resolved = await resolveToken(store, input.token);
    if (!resolved?.valid) return { outcome: "link_invalid" };
    identityId = resolved.identity_id;
    tokenId = resolved.token_id;
    landing = `/case/${resolved.public_id}`;
  } else {
    const normalized = normalizeContact(input.contact);
    if (!normalized) return { outcome: "request_invalid" };
    const found = (await store.rpc<{ identity_id: string }>("case_access_identity_find", { target_channel: normalized.channel, target_contact_hash: normalized.hash }))[0];
    // An unknown contact verifies like a wrong code: nothing distinguishes them.
    if (!found) return { outcome: "invalid" };
    identityId = found.identity_id;
  }
  const verified = (await store.rpc<{ outcome: "ok" | "invalid" | "expired" | "locked" | "none"; code_id: string | null; token_id: string | null }>("case_access_code_verify", {
    target_identity: identityId, target_code_hash: hashAccessCode(identityId, input.code),
  }))[0];
  if (!verified || verified.outcome !== "ok") {
    const outcome = verified?.outcome;
    return { outcome: outcome === undefined || outcome === "ok" ? "none" : outcome };
  }
  const offer = productOffer().access;
  const session = createOpaqueToken();
  const ttl = offer.session_ttl_days * DAY;
  await store.rpc("case_access_session_create", { target_identity: identityId, target_session_hash: hashSession(session), target_ttl_seconds: ttl });
  if (tokenId) await store.rpc("case_access_token_mark_used", { target_token: tokenId });
  if (!landing) {
    const cases = await listIdentityCases(identityId, store);
    landing = cases.length === 1 && cases[0] ? `/case/${cases[0].public_id}` : "/cases";
  }
  return { outcome: "ok", session, session_ttl_seconds: ttl, identity_id: identityId, next: landing };
}

export async function resolveIdentitySession(session: string | null, db?: CaseAccessDb | null): Promise<IdentitySession | null> {
  if (!session) return null;
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return null;
  const offer = productOffer().access;
  const rows = await store.rpc<IdentitySession>("case_access_session_resolve", {
    target_session_hash: hashSession(session), target_ttl_seconds: offer.session_ttl_days * DAY, rolling_after_seconds: offer.session_roll_after_hours * 3_600,
  });
  return rows[0] ?? null;
}

export async function listIdentityCases(identityId: string, db?: CaseAccessDb | null): Promise<readonly IdentityCase[]> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return [];
  return store.rpc<IdentityCase>("case_access_identity_cases", { target_identity: identityId });
}

/** The public id a link resolves to, for the challenge screen: the case is named, the token is not echoed. */
export async function describeLinkToken(token: string, db?: CaseAccessDb | null): Promise<Readonly<{ valid: boolean; public_id: string | null; masked_to: string | null; channel: ContactChannel | null }>> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store || !isOpaqueToken(token)) return { valid: false, public_id: null, masked_to: null, channel: null };
  const resolved = await resolveToken(store, token);
  if (!resolved?.valid) return { valid: false, public_id: null, masked_to: null, channel: null };
  const contact = normalizeContact(resolved.contact_normalized);
  return { valid: true, public_id: resolved.public_id, masked_to: contact ? maskContact(contact) : null, channel: resolved.channel };
}

export const caseAccessService = Object.freeze({
  issueAndSendCaseLink, sweepPendingCaseLinks, resendCaseLink, sendReportReadyNotification,
  requestAccessCode, verifyAccessCode, resolveIdentitySession, listIdentityCases, describeLinkToken,
});
