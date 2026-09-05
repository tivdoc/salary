// UX Run 1 / U2–U4 (design authority v1.1, D-1.1..D-1.5), corrected by the
// external review #1 (5.9.2026), findings 1 and 8. The access service:
//
// - the funnel verifies the channel BEFORE any document binds and before any
//   payment: a code to the typed contact, verified with the case cookie, is
//   what links an identity to a case (finding 1); an address typed by mistake
//   never grants its owner anyone else's payslip, because nothing links until
//   the person holding the case cookie proves the channel;
// - the link a verified payment sends goes only to a verified contact, and it
//   is exchanged ONCE: the exchange marks the token used, opens a challenge
//   bound to a short cookie, and the customer is redirected to the case id at
//   once, so the token appears in exactly one request (finding 8);
// - a code opens a rolling identity session; `/login` reaches only cases an
//   identity was linked to by verification.
//
// product_runtime only: it imports nothing from the engine, the reference
// tenant, Pool P, the selection registrar or the shadow; every limit is read
// from configuration. Two rules hold everywhere: a contact's existence is
// never revealed, and the token and the code live in the message and the
// store's hashes alone — never in a log line, a query string or an analytics
// payload.
// Relative imports only: scripts/dev-runtime/access-journey.mts runs this module under node, where no alias exists.
import { productOffer } from "../../../lib/product-offer.ts";
import {
  ACCESS_CODE_PATTERN, createAccessCode, createOpaqueToken, hashAccessCode, hashRequesterIp, hashSession, hashToken,
  isOpaqueToken, normalizeContact, type ContactChannel, type NormalizedContact,
} from "./crypto.ts";
import { resolveCaseAccessDb, type CaseAccessDb } from "./db.ts";
import {
  renderAccessCode, renderCaseLink, renderReportReady, sendNotification, type NotificationOutcome, type NotificationTemplate,
} from "./notifications.ts";

const DAY = 86_400;
const HOUR = 3_600;

export type LinkPurpose = "payment_verified" | "resend" | "report_ready";

export type SendLinkResult = Readonly<{
  case_id: string;
  outcome: "sent" | "already_sent" | "send_failed" | "no_contact" | "contact_unverified" | "no_store";
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

export type ExchangeResult =
  | Readonly<{ outcome: "challenge"; challenge: string; challenge_ttl_seconds: number; public_id: string }>
  | Readonly<{ outcome: "invalid" | "no_store" }>;

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

type CaseContact = Readonly<{ case_id: string; public_id: string; first_name: string | null; contact: NormalizedContact; payment_verified: boolean; contact_verified: boolean }>;

type CodeIssue = Readonly<{ code_id: string | null; refused: string | null }>;

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

function limits(ipHash: string) {
  const offer = productOffer().access;
  return {
    target_ttl_seconds: offer.code_ttl_minutes * 60, target_max_attempts: offer.code_max_attempts, target_ip_hash: ipHash,
    identity_limit: offer.request_limit_per_identity, identity_window_seconds: offer.request_window_minutes * 60,
    ip_limit: offer.request_limit_per_ip, ip_window_seconds: offer.request_window_minutes * 60,
  };
}

async function contactOfCase(db: CaseAccessDb, caseId: string, preferred: ContactChannel | null = null): Promise<CaseContact | null> {
  const rows = await db.rpc<{ case_id: string; public_id: string; email: string | null; phone: string | null; first_name: string | null; payment_verified: boolean; contact_verified: boolean; contact_verified_channel: ContactChannel | null }>("case_access_case_contact", { target_case: caseId });
  const row = rows[0];
  if (!row) return null;
  // The channel on file: the verified one when there is one, the preferred one when asked, email first otherwise.
  const email = normalizeContact(row.email);
  const phone = normalizeContact(row.phone);
  const wanted = row.contact_verified_channel ?? preferred;
  const contact = (wanted === "phone" ? phone ?? email : email ?? phone) ?? null;
  if (!contact) return null;
  return { case_id: row.case_id, public_id: row.public_id, first_name: row.first_name, contact, payment_verified: row.payment_verified, contact_verified: row.contact_verified };
}

/** The identity row for a contact, created unverified when absent. Never links a case: only verification does. */
async function identityOf(db: CaseAccessDb, contact: NormalizedContact): Promise<string> {
  const rows = await db.rpc<{ value: string }>("case_access_identity_upsert", {
    target_channel: contact.channel, target_contact_hash: contact.hash, target_contact_normalized: contact.normalized,
  });
  const identityId = rows[0]?.value;
  if (!identityId) throw new Error("CASE_ACCESS_IDENTITY_UPSERT_EMPTY");
  return identityId;
}

async function recordNotification(db: CaseAccessDb, input: Readonly<{ case_id: string | null; identity_id: string | null; channel: ContactChannel; template: NotificationTemplate; outcome: NotificationOutcome }>): Promise<void> {
  await db.rpc("case_notification_record", {
    target_case: input.case_id, target_identity: input.identity_id, target_channel: input.channel, target_template: input.template,
    target_state: input.outcome.state, target_provider: input.outcome.provider, target_payload_sha256: input.outcome.payload_sha256,
    target_error_code: input.outcome.error_code,
  });
}

async function sendCode(db: CaseAccessDb, input: Readonly<{ caseId: string | null; identityId: string; contact: NormalizedContact; code: string }>): Promise<NotificationOutcome> {
  const rendered = renderAccessCode({ code: input.code, expiresInMinutes: productOffer().access.code_ttl_minutes });
  const outcome = await sendNotification({ template: "access_code", channel: input.contact.channel, to: input.contact.normalized, ...rendered });
  await recordNotification(db, { case_id: input.caseId, identity_id: input.identityId, channel: input.contact.channel, template: "access_code", outcome });
  return outcome;
}

// ---------------------------------------------------------------------------
// The funnel: verify the channel before anything binds (finding 1).
// ---------------------------------------------------------------------------

/**
 * A code to the case's own contact, for the person holding the case cookie.
 * `contact` replaces the typed contact while it is still unverified — the
 * correction path for a typo — and `channel` picks email or phone.
 */
export async function requestFunnelCode(input: Readonly<{ caseId: string; contact?: unknown; channel?: unknown; request: Request }>, db?: CaseAccessDb | null): Promise<RequestCodeResult & Readonly<{ case_found: boolean; already_verified: boolean }>> {
  const store = db ?? await resolveCaseAccessDb();
  const base = { accepted: true as const, masked_channel: null, masked_to: null, refused: null, case_found: false, already_verified: false };
  if (!store) return base;
  const ipHash = hashRequesterIp(input.request, secret());
  const replacement = normalizeContact(input.contact);
  if (replacement) {
    await store.rpc("case_access_funnel_contact_update", { target_case: input.caseId, target_channel: replacement.channel, target_value: replacement.channel === "email" ? replacement.normalized : replacement.normalized });
  }
  const preferred: ContactChannel | null = replacement?.channel ?? (input.channel === "phone" ? "phone" : input.channel === "email" ? "email" : null);
  const found = await contactOfCase(store, input.caseId, preferred);
  if (!found) return base;
  if (found.contact_verified) return { ...base, case_found: true, already_verified: true, masked_channel: found.contact.channel, masked_to: maskContact(found.contact) };
  const identityId = await identityOf(store, found.contact);
  const code = createAccessCode();
  const issued = (await store.rpc<CodeIssue>("case_access_code_issue", {
    target_identity: identityId, target_token: null, target_code_hash: hashAccessCode(identityId, code), ...limits(ipHash),
  }))[0];
  if (issued?.refused === "ip_rate_limited") return { ...base, case_found: true, refused: "ip_rate_limited" };
  const hint = { masked_channel: found.contact.channel, masked_to: maskContact(found.contact) };
  if (issued?.refused || !issued?.code_id) return { ...base, case_found: true, ...hint };
  await sendCode(store, { caseId: input.caseId, identityId, contact: found.contact, code });
  return { ...base, case_found: true, ...hint };
}

/** The verification: the case is marked, the identity is linked, a session opens, and the funnel continues to the upload. */
export async function verifyFunnelCode(input: Readonly<{ caseId: string; code: unknown }>, db?: CaseAccessDb | null): Promise<VerifyCodeResult> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return { outcome: "none" };
  if (typeof input.code !== "string" || !ACCESS_CODE_PATTERN.test(input.code)) return { outcome: "request_invalid" };
  const found = await contactOfCase(store, input.caseId);
  if (!found) return { outcome: "none" };
  const identityId = await identityOf(store, found.contact);
  const verified = (await store.rpc<{ outcome: "ok" | "invalid" | "expired" | "locked" | "none" }>("case_access_code_verify", {
    target_identity: identityId, target_code_hash: hashAccessCode(identityId, input.code),
  }))[0];
  if (!verified || verified.outcome !== "ok") return failedCode(verified?.outcome);
  await store.rpc("case_access_funnel_verify", { target_case: input.caseId, target_identity: identityId, target_channel: found.contact.channel });
  const session = await openSession(store, identityId);
  return { outcome: "ok", session: session.session, session_ttl_seconds: session.ttl, identity_id: identityId, next: "/check/upload" };
}

/** What the funnel pages ask before rendering: is there a case, and is its contact verified. */
export async function funnelCaseState(caseId: string, db?: CaseAccessDb | null): Promise<Readonly<{ exists: boolean; contact_verified: boolean; public_id: string | null }>> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return { exists: false, contact_verified: false, public_id: null };
  const found = await contactOfCase(store, caseId);
  return found ? { exists: true, contact_verified: found.contact_verified, public_id: found.public_id } : { exists: false, contact_verified: false, public_id: null };
}

// ---------------------------------------------------------------------------
// The link a verified payment sends (U4), to a verified contact only.
// ---------------------------------------------------------------------------

export async function issueAndSendCaseLink(caseId: string, purpose: LinkPurpose = "payment_verified", db?: CaseAccessDb | null): Promise<SendLinkResult> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return { case_id: caseId, outcome: "no_store", token_id: null, provider: null, error_code: "no_store_configured" };
  const found = await contactOfCase(store, caseId);
  if (!found) return { case_id: caseId, outcome: "no_contact", token_id: null, provider: null, error_code: "contact_missing" };
  // Finding 1: an unverified contact receives nothing — the address may not be the payer's.
  if (!found.contact_verified) return { case_id: caseId, outcome: "contact_unverified", token_id: null, provider: null, error_code: "contact_unverified" };
  const identityId = await identityOf(store, found.contact);
  const ttlSeconds = productOffer().access.link_token_ttl_hours * HOUR;

  if (purpose === "payment_verified") {
    const existing = (await store.rpc<{ token_id: string; send_state: string; send_attempts: number }>("case_access_token_for_case", { target_case: caseId, target_purpose: purpose }))[0];
    if (existing?.send_state === "sent") return { case_id: caseId, outcome: "already_sent", token_id: existing.token_id, provider: null, error_code: null };
    if (existing && existing.send_state !== "sent") {
      // A token whose send failed is superseded by a fresh one on retry; the payment_verified row records the same outcome so the sweep stops once a resend went out.
      const token = createOpaqueToken();
      const reissued = (await store.rpc<{ token_id: string; issued: boolean }>("case_access_token_issue", {
        target_case: caseId, target_identity: identityId, target_purpose: "resend", target_token_hash: hashToken(token), target_ttl_seconds: ttlSeconds,
      }))[0];
      if (!reissued) return { case_id: caseId, outcome: "send_failed", token_id: existing.token_id, provider: null, error_code: "token_reissue_failed" };
      const outcome = await deliverLink(store, { caseId, identityId, contact: found.contact, firstName: found.first_name, publicId: found.public_id, token, ttlHours: productOffer().access.link_token_ttl_hours });
      await store.rpc("case_access_token_mark_send", { target_token: reissued.token_id, target_state: outcome.state, target_error_code: outcome.error_code });
      await store.rpc("case_access_token_mark_send", { target_token: existing.token_id, target_state: outcome.state, target_error_code: outcome.error_code });
      return { case_id: caseId, outcome: outcome.state === "sent" ? "sent" : "send_failed", token_id: reissued.token_id, provider: outcome.provider, error_code: outcome.error_code };
    }
  }

  const token = createOpaqueToken();
  const issued = (await store.rpc<{ token_id: string; issued: boolean }>("case_access_token_issue", {
    target_case: caseId, target_identity: identityId, target_purpose: purpose, target_token_hash: hashToken(token), target_ttl_seconds: ttlSeconds,
  }))[0];
  if (!issued) return { case_id: caseId, outcome: "send_failed", token_id: null, provider: null, error_code: "token_issue_failed" };
  if (!issued.issued) return { case_id: caseId, outcome: "already_sent", token_id: issued.token_id, provider: null, error_code: null };
  const outcome = await deliverLink(store, { caseId, identityId, contact: found.contact, firstName: found.first_name, publicId: found.public_id, token, ttlHours: productOffer().access.link_token_ttl_hours });
  await store.rpc("case_access_token_mark_send", { target_token: issued.token_id, target_state: outcome.state, target_error_code: outcome.error_code });
  return { case_id: caseId, outcome: outcome.state === "sent" ? "sent" : "send_failed", token_id: issued.token_id, provider: outcome.provider, error_code: outcome.error_code };
}

async function deliverLink(db: CaseAccessDb, input: Readonly<{ caseId: string; identityId: string; contact: NormalizedContact; firstName: string | null; publicId: string; token: string; ttlHours: number }>): Promise<NotificationOutcome> {
  const linkUrl = `${publicOrigin()}/case/${input.token}`;
  const rendered = renderCaseLink({ firstName: input.firstName, publicId: input.publicId, linkUrl, expiresInHours: input.ttlHours });
  const outcome = await sendNotification({ template: "case_link", channel: input.contact.channel, to: input.contact.normalized, ...rendered });
  await recordNotification(db, { case_id: input.caseId, identity_id: input.identityId, channel: input.contact.channel, template: "case_link", outcome });
  return outcome;
}

/** U4. The catch-up sweep the reconcile cron runs: every verified payment of a verified contact without a sent link gets exactly one. */
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
  if (!found.contact_verified) return { case_id: caseId, outcome: "contact_unverified", token_id: null, provider: null, error_code: "contact_unverified" };
  const identityId = await identityOf(store, found.contact);
  const token = createOpaqueToken();
  const issued = (await store.rpc<{ token_id: string; issued: boolean }>("case_access_token_issue", {
    target_case: caseId, target_identity: identityId, target_purpose: "report_ready", target_token_hash: hashToken(token), target_ttl_seconds: productOffer().access.link_token_ttl_hours * HOUR,
  }))[0];
  if (!issued) return { case_id: caseId, outcome: "send_failed", token_id: null, provider: null, error_code: "token_issue_failed" };
  const rendered = renderReportReady({ publicId: found.public_id, linkUrl: `${publicOrigin()}/case/${token}` });
  const outcome = await sendNotification({ template: "report_ready", channel: found.contact.channel, to: found.contact.normalized, ...rendered });
  await recordNotification(store, { case_id: caseId, identity_id: identityId, channel: found.contact.channel, template: "report_ready", outcome });
  await store.rpc("case_access_token_mark_send", { target_token: issued.token_id, target_state: outcome.state, target_error_code: outcome.error_code });
  return { case_id: caseId, outcome: outcome.state === "sent" ? "sent" : "send_failed", token_id: issued.token_id, provider: outcome.provider, error_code: outcome.error_code };
}

// ---------------------------------------------------------------------------
// The one-time exchange and the challenge (finding 8).
// ---------------------------------------------------------------------------

async function resolveToken(db: CaseAccessDb, token: string): Promise<TokenResolution | null> {
  const rows = await db.rpc<TokenResolution>("case_access_token_resolve", { target_token_hash: hashToken(token) });
  return rows[0] ?? null;
}

/**
 * The link's only request: a valid token is spent here — marked used, its
 * code sent, a challenge opened on a short cookie — and the caller redirects
 * to the case id. A used, expired or unknown token is invalid, uniformly.
 */
export async function exchangeLinkToken(input: Readonly<{ token: unknown; request: Request }>, db?: CaseAccessDb | null): Promise<ExchangeResult> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return { outcome: "no_store" };
  if (!isOpaqueToken(input.token)) return { outcome: "invalid" };
  const resolved = await resolveToken(store, input.token);
  if (!resolved?.valid) return { outcome: "invalid" };
  const contact = normalizeContact(resolved.contact_normalized);
  if (!contact) return { outcome: "invalid" };
  const offer = productOffer().access;
  const challenge = createOpaqueToken();
  const code = createAccessCode();
  const opened = (await store.rpc<CodeIssue>("case_access_challenge_open", {
    target_identity: resolved.identity_id, target_token: resolved.token_id, target_case: resolved.case_id,
    target_code_hash: hashAccessCode(resolved.identity_id, code), target_challenge_hash: hashSession(challenge),
    ...limits(hashRequesterIp(input.request, secret())),
  }))[0];
  if (!opened?.code_id) {
    // Rate-limited at the exchange: the token stays valid for a later try; nothing is sent.
    return { outcome: "invalid" };
  }
  await sendCode(store, { caseId: resolved.case_id, identityId: resolved.identity_id, contact, code });
  return { outcome: "challenge", challenge, challenge_ttl_seconds: offer.challenge_cookie_minutes * 60, public_id: resolved.public_id };
}

/** Read-only: may this token still be exchanged? For the page's used-or-expired screen; the exchange itself is the route handler's. */
export async function peekLinkToken(token: unknown, db?: CaseAccessDb | null): Promise<Readonly<{ valid: boolean; public_id: string | null }>> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store || !isOpaqueToken(token)) return { valid: false, public_id: null };
  const resolved = await resolveToken(store, token);
  return resolved?.valid ? { valid: true, public_id: resolved.public_id } : { valid: false, public_id: null };
}

export async function describeChallenge(challenge: string | null, db?: CaseAccessDb | null): Promise<Readonly<{ live: boolean; public_id: string | null; masked_to: string | null; channel: ContactChannel | null }>> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store || !challenge || !isOpaqueToken(challenge)) return { live: false, public_id: null, masked_to: null, channel: null };
  const row = (await store.rpc<{ code_id: string; identity_id: string; case_id: string | null; public_id: string | null; channel: ContactChannel; contact_normalized: string; live: boolean }>("case_access_challenge_resolve", { target_challenge_hash: hashSession(challenge) }))[0];
  if (!row) return { live: false, public_id: null, masked_to: null, channel: null };
  const contact = normalizeContact(row.contact_normalized);
  return { live: row.live, public_id: row.public_id, masked_to: contact ? maskContact(contact) : null, channel: row.channel };
}

/** A fresh code for a live challenge: the same cookie, a new code, the old one superseded. */
export async function resendChallengeCode(input: Readonly<{ challenge: string | null; request: Request }>, db?: CaseAccessDb | null): Promise<RequestCodeResult> {
  const store = db ?? await resolveCaseAccessDb();
  const accepted = { accepted: true as const, masked_channel: null, masked_to: null, refused: null };
  if (!store || !input.challenge || !isOpaqueToken(input.challenge)) return accepted;
  const row = (await store.rpc<{ identity_id: string; case_id: string | null; contact_normalized: string }>("case_access_challenge_resolve", { target_challenge_hash: hashSession(input.challenge) }))[0];
  if (!row) return accepted;
  const contact = normalizeContact(row.contact_normalized);
  if (!contact) return accepted;
  const code = createAccessCode();
  const opened = (await store.rpc<CodeIssue>("case_access_challenge_open", {
    target_identity: row.identity_id, target_token: null, target_case: row.case_id,
    target_code_hash: hashAccessCode(row.identity_id, code), target_challenge_hash: hashSession(input.challenge),
    ...limits(hashRequesterIp(input.request, secret())),
  }))[0];
  if (opened?.refused === "ip_rate_limited") return { ...accepted, refused: "ip_rate_limited" };
  const hint = { masked_channel: contact.channel, masked_to: maskContact(contact) };
  if (!opened?.code_id) return { ...accepted, ...hint };
  await sendCode(store, { caseId: row.case_id, identityId: row.identity_id, contact, code });
  return { ...accepted, ...hint };
}

export async function verifyChallengeCode(input: Readonly<{ challenge: string | null; code: unknown }>, db?: CaseAccessDb | null): Promise<VerifyCodeResult> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return { outcome: "none" };
  if (typeof input.code !== "string" || !ACCESS_CODE_PATTERN.test(input.code)) return { outcome: "request_invalid" };
  if (!input.challenge || !isOpaqueToken(input.challenge)) return { outcome: "link_invalid" };
  const row = (await store.rpc<{ identity_id: string; public_id: string | null; live: boolean }>("case_access_challenge_resolve", { target_challenge_hash: hashSession(input.challenge) }))[0];
  if (!row) return { outcome: "link_invalid" };
  const verified = (await store.rpc<{ outcome: "ok" | "invalid" | "expired" | "locked" | "none" }>("case_access_code_verify", {
    target_identity: row.identity_id, target_code_hash: hashAccessCode(row.identity_id, input.code),
  }))[0];
  if (!verified || verified.outcome !== "ok") return failedCode(verified?.outcome);
  const session = await openSession(store, row.identity_id);
  const landing = row.public_id ? `/case/${row.public_id}` : await landingOf(store, row.identity_id);
  return { outcome: "ok", session: session.session, session_ttl_seconds: session.ttl, identity_id: row.identity_id, next: landing };
}

// ---------------------------------------------------------------------------
// Login and recovery by contact (D-1.4): reaches only verified links.
// ---------------------------------------------------------------------------

/**
 * U2. Requests a code for a contact (login and recovery). Always "accepted":
 * an unknown contact and a silently rate-limited identity read the same; only
 * the per-IP ceiling answers differently, uniformly for everyone. A typed
 * contact never learns whether it exists (Lane B).
 */
export async function requestAccessCode(input: Readonly<{ contact?: unknown; request: Request }>, db?: CaseAccessDb | null): Promise<RequestCodeResult> {
  const store = db ?? await resolveCaseAccessDb();
  const accepted = { accepted: true as const, masked_channel: null, masked_to: null, refused: null };
  if (!store) return accepted;
  const ipHash = hashRequesterIp(input.request, secret());
  const normalized = normalizeContact(input.contact);
  const found = normalized
    ? (await store.rpc<{ identity_id: string; contact_normalized: string }>("case_access_identity_find", { target_channel: normalized.channel, target_contact_hash: normalized.hash }))[0]
    : undefined;
  if (!normalized || !found) {
    // Nothing to send to. The request is still written to the ledger and the per-IP ceiling still applies, so an
    // enumeration pays the same price as a real request and is answered the same (refused 'unknown_identity' inside).
    const noted = (await store.rpc<CodeIssue>("case_access_code_issue", { target_identity: null, target_token: null, target_code_hash: "0".repeat(64), ...limits(ipHash) }))[0];
    if (noted?.refused === "ip_rate_limited") return { ...accepted, refused: "ip_rate_limited" };
    return accepted;
  }
  const code = createAccessCode();
  const issued = (await store.rpc<CodeIssue>("case_access_code_issue", {
    target_identity: found.identity_id, target_token: null, target_code_hash: hashAccessCode(found.identity_id, code), ...limits(ipHash),
  }))[0];
  if (issued?.refused === "ip_rate_limited") return { ...accepted, refused: "ip_rate_limited" };
  if (issued?.refused || !issued?.code_id) return accepted;
  await sendCode(store, { caseId: null, identityId: found.identity_id, contact: normalized, code });
  return accepted;
}

/** U2. A code becomes a session; the landing is the one case or the list. By contact, "no live code" answers like a wrong code. */
export async function verifyAccessCode(input: Readonly<{ contact?: unknown; code: unknown }>, db?: CaseAccessDb | null): Promise<VerifyCodeResult> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return { outcome: "none" };
  if (typeof input.code !== "string" || !ACCESS_CODE_PATTERN.test(input.code)) return { outcome: "request_invalid" };
  const normalized = normalizeContact(input.contact);
  if (!normalized) return { outcome: "request_invalid" };
  const found = (await store.rpc<{ identity_id: string }>("case_access_identity_find", { target_channel: normalized.channel, target_contact_hash: normalized.hash }))[0];
  if (!found) return { outcome: "invalid" };
  const verified = (await store.rpc<{ outcome: "ok" | "invalid" | "expired" | "locked" | "none" }>("case_access_code_verify", {
    target_identity: found.identity_id, target_code_hash: hashAccessCode(found.identity_id, input.code),
  }))[0];
  if (!verified || verified.outcome !== "ok") {
    const outcome = verified?.outcome;
    if (outcome === undefined || outcome === "none") return { outcome: "invalid" };
    return { outcome: outcome === "ok" ? "invalid" : outcome };
  }
  const session = await openSession(store, found.identity_id);
  return { outcome: "ok", session: session.session, session_ttl_seconds: session.ttl, identity_id: found.identity_id, next: await landingOf(store, found.identity_id) };
}

function failedCode(outcome: string | undefined): VerifyCodeResult {
  return { outcome: outcome === "invalid" || outcome === "expired" || outcome === "locked" ? outcome : "none" };
}

async function openSession(db: CaseAccessDb, identityId: string): Promise<Readonly<{ session: string; ttl: number }>> {
  const session = createOpaqueToken();
  const ttl = productOffer().access.session_ttl_days * DAY;
  await db.rpc("case_access_session_create", { target_identity: identityId, target_session_hash: hashSession(session), target_ttl_seconds: ttl });
  return { session, ttl };
}

async function landingOf(db: CaseAccessDb, identityId: string): Promise<string> {
  const cases = await listIdentityCases(identityId, db);
  return cases.length === 1 && cases[0] ? `/case/${cases[0].public_id}` : "/cases";
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

export const caseAccessService = Object.freeze({
  requestFunnelCode, verifyFunnelCode, funnelCaseState,
  issueAndSendCaseLink, sweepPendingCaseLinks, resendCaseLink, sendReportReadyNotification,
  exchangeLinkToken, peekLinkToken, describeChallenge, resendChallengeCode, verifyChallengeCode,
  requestAccessCode, verifyAccessCode, resolveIdentitySession, listIdentityCases,
});
