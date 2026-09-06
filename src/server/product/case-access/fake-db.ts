// UX Run 1 / U2 tests, extended by the external review #1 corrections. An
// in-memory store that answers the same function names as migrations
// 202609050001..0003, with the same outcomes, so the service's logic is
// tested without a database. The SQL itself is proven on DEV by
// scripts/dev-runtime/access-journey.mts; this mirror is kept literal so a
// divergence is a diff away.
import { randomUUID } from "node:crypto";
import type { CaseAccessDb } from "./db.ts";

type Identity = { id: string; channel: string; contact_hash: string; contact_normalized: string; verified_at: number | null };
type Token = { id: string; case_id: string; identity_id: string; purpose: string; token_hash: string; expires_at: number; used_at: number | null; revoked_at: number | null; send_state: string; send_attempts: number; sent_at: number | null; send_error_code: string | null; created_at: number };
type Code = { id: string; identity_id: string; token_id: string | null; case_id: string | null; challenge_hash: string | null; code_hash: string; created_at: number; expires_at: number; attempts: number; max_attempts: number; consumed_at: number | null; locked_at: number | null; requester_ip_hash: string | null };
type Session = { id: string; identity_id: string; session_hash: string; created_at: number; expires_at: number; last_seen_at: number; revoked_at: number | null };
type RequestRow = { identity_id: string | null; requester_ip_hash: string | null; outcome: string; created_at: number };
type ThreadRow = { id: string; case_id: string; code: string; question: string; answer_kind: string; options: string[] | null; field_crop: string | null; blocking: boolean; opened_at: number; expires_at: string; answered_at: number | null; answer_text: string | null };
export type FakeCaseDocument = { id: string; case_id: string; document_type: string; slot: string; original_filename: string; mime_type: string; size: number; period_month: string | null; created_at: number };
type Notification = { case_id: string | null; identity_id: string | null; channel: string; template: string; state: string; provider: string; payload_sha256: string; error_code: string | null };

export type FakeCase = {
  id: string; public_id: string; email: string | null; phone: string | null; first_name: string | null; status: string; payment_status: string;
  created_at: string; payment_verified: boolean; contact_verified_at?: number | null; contact_verified_channel?: string | null;
};

export type FakeCaseAccessDb = CaseAccessDb & Readonly<{
  cases: FakeCase[];
  identities: Identity[];
  identity_cases: Array<{ identity_id: string; case_id: string }>;
  tokens: Token[];
  codes: Code[];
  sessions: Session[];
  notifications: Notification[];
  requests: RequestRow[];
  case_requests: ThreadRow[];
  case_documents: FakeCaseDocument[];
  calls: Array<{ fn: string; args: Record<string, unknown> }>;
  now: () => number;
  advance(ms: number): void;
}>;

export function fakeCaseAccessDb(cases: readonly FakeCase[] = []): FakeCaseAccessDb {
  let clock = Date.parse("2026-09-05T10:00:00.000Z");
  const state = {
    cases: cases.map((row) => ({ contact_verified_at: null, contact_verified_channel: null, ...row })), identities: [] as Identity[], identity_cases: [] as Array<{ identity_id: string; case_id: string }>,
    tokens: [] as Token[], codes: [] as Code[], sessions: [] as Session[], notifications: [] as Notification[], requests: [] as RequestRow[],
    case_requests: [] as ThreadRow[], case_documents: [] as FakeCaseDocument[],
    calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  };
  const now = () => clock;
  const s = (v: unknown) => String(v);
  const n = (v: unknown) => Number(v);
  const caseOf = (id: unknown) => state.cases.find((row) => row.id === id);

  const issueCode = (a: Record<string, unknown>): { code_id: string | null; refused: string | null } => {
    const ip = (a.target_ip_hash as string | null) ?? null;
    const identity = (a.target_identity as string | null) ?? null;
    const note = (outcome: string) => { state.requests.push({ identity_id: identity, requester_ip_hash: ip, outcome, created_at: now() }); };
    const ipWindow = now() - n(a.ip_window_seconds) * 1_000;
    if (ip !== null && state.requests.filter((row) => row.requester_ip_hash === ip && row.created_at > ipWindow).length >= n(a.ip_limit)) { note("ip_rate_limited"); return { code_id: null, refused: "ip_rate_limited" }; }
    if (identity === null) { note("unknown_identity"); return { code_id: null, refused: "unknown_identity" }; }
    const identityWindow = now() - n(a.identity_window_seconds) * 1_000;
    if (state.requests.filter((row) => row.identity_id === identity && row.created_at > identityWindow).length >= n(a.identity_limit)) { note("identity_rate_limited"); return { code_id: null, refused: "identity_rate_limited" }; }
    for (const row of state.codes) if (row.identity_id === identity && row.consumed_at === null) row.consumed_at = now();
    const code: Code = { id: randomUUID(), identity_id: identity, token_id: (a.target_token as string | null) ?? null, case_id: null, challenge_hash: null, code_hash: s(a.target_code_hash), created_at: now(), expires_at: now() + n(a.target_ttl_seconds) * 1_000, attempts: 0, max_attempts: n(a.target_max_attempts), consumed_at: null, locked_at: null, requester_ip_hash: ip };
    state.codes.push(code);
    note("issued");
    return { code_id: code.id, refused: null };
  };

  const functions: Record<string, (a: Record<string, unknown>) => unknown[]> = {
    case_access_identity_upsert(a) {
      let identity = state.identities.find((row) => row.channel === a.target_channel && row.contact_hash === a.target_contact_hash);
      if (!identity) {
        identity = { id: randomUUID(), channel: s(a.target_channel), contact_hash: s(a.target_contact_hash), contact_normalized: s(a.target_contact_normalized), verified_at: null };
        state.identities.push(identity);
      }
      return [{ value: identity.id }];
    },
    case_access_identity_find(a) {
      const identity = state.identities.find((row) => row.channel === a.target_channel && row.contact_hash === a.target_contact_hash);
      return identity ? [{ identity_id: identity.id, contact_normalized: identity.contact_normalized }] : [];
    },
    case_access_identity_link(a) {
      if (!state.identity_cases.some((row) => row.identity_id === a.target_identity && row.case_id === a.target_case)) state.identity_cases.push({ identity_id: s(a.target_identity), case_id: s(a.target_case) });
      return [];
    },
    case_access_token_issue(a) {
      if (a.target_purpose === "payment_verified") {
        const existing = state.tokens.find((row) => row.case_id === a.target_case && row.purpose === "payment_verified");
        if (existing) return [{ token_id: existing.id, issued: false }];
      }
      const token: Token = { id: randomUUID(), case_id: s(a.target_case), identity_id: s(a.target_identity), purpose: s(a.target_purpose), token_hash: s(a.target_token_hash), expires_at: now() + n(a.target_ttl_seconds) * 1_000, used_at: null, revoked_at: null, send_state: "pending", send_attempts: 0, sent_at: null, send_error_code: null, created_at: now() };
      state.tokens.push(token);
      return [{ token_id: token.id, issued: true }];
    },
    case_access_token_mark_send(a) {
      const token = state.tokens.find((row) => row.id === a.target_token);
      if (token) { token.send_state = s(a.target_state); token.send_attempts += 1; if (a.target_state === "sent") token.sent_at = now(); token.send_error_code = (a.target_error_code as string | null) ?? null; }
      return [];
    },
    case_access_token_resolve(a) {
      const token = state.tokens.find((row) => row.token_hash === a.target_token_hash);
      if (!token) return [];
      const identity = state.identities.find((row) => row.id === token.identity_id)!;
      const found = caseOf(token.case_id)!;
      return [{ token_id: token.id, case_id: token.case_id, identity_id: token.identity_id, channel: identity.channel, contact_normalized: identity.contact_normalized, public_id: found.public_id, valid: token.revoked_at === null && token.used_at === null && token.expires_at > now() }];
    },
    case_access_token_mark_used(a) {
      const token = state.tokens.find((row) => row.id === a.target_token);
      if (token) token.used_at ??= now();
      return [];
    },
    case_access_code_issue(a) { return [issueCode(a)]; },
    case_access_code_verify(a) {
      const live = [...state.codes].reverse().find((row) => row.identity_id === a.target_identity && row.consumed_at === null);
      if (!live) return [{ outcome: "none", code_id: null, token_id: null }];
      if (live.locked_at !== null || live.attempts >= live.max_attempts) { live.locked_at ??= now(); return [{ outcome: "locked", code_id: live.id, token_id: live.token_id }]; }
      live.attempts += 1;
      if (live.expires_at <= now()) return [{ outcome: "expired", code_id: live.id, token_id: live.token_id }];
      if (live.code_hash === a.target_code_hash) { live.consumed_at = now(); return [{ outcome: "ok", code_id: live.id, token_id: live.token_id }]; }
      if (live.attempts >= live.max_attempts) { live.locked_at = now(); return [{ outcome: "locked", code_id: live.id, token_id: live.token_id }]; }
      return [{ outcome: "invalid", code_id: live.id, token_id: live.token_id }];
    },
    case_access_session_create(a) {
      const session: Session = { id: randomUUID(), identity_id: s(a.target_identity), session_hash: s(a.target_session_hash), created_at: now(), expires_at: now() + n(a.target_ttl_seconds) * 1_000, last_seen_at: now(), revoked_at: null };
      state.sessions.push(session);
      return [{ value: session.id }];
    },
    case_access_session_resolve(a) {
      const live = state.sessions.find((row) => row.session_hash === a.target_session_hash && row.revoked_at === null && row.expires_at > now());
      if (!live) return [];
      if (live.last_seen_at < now() - n(a.rolling_after_seconds) * 1_000) { live.last_seen_at = now(); live.expires_at = now() + n(a.target_ttl_seconds) * 1_000; }
      const identity = state.identities.find((row) => row.id === live.identity_id)!;
      return [{ session_id: live.id, identity_id: live.identity_id, channel: identity.channel, contact_normalized: identity.contact_normalized, expires_at: new Date(live.expires_at).toISOString() }];
    },
    case_access_session_revoke(a) {
      const live = state.sessions.find((row) => row.session_hash === a.target_session_hash);
      if (live) live.revoked_at ??= now();
      return [];
    },
    case_access_identity_cases(a) {
      return state.identity_cases.filter((row) => row.identity_id === a.target_identity)
        .map((row) => caseOf(row.case_id)!)
        .sort((left, right) => (left.created_at < right.created_at ? 1 : -1))
        .map((found) => ({ case_id: found.id, public_id: found.public_id, status: found.status, payment_status: found.payment_status, created_at: found.created_at, payment_verified: found.payment_verified }));
    },
    case_access_case_contact(a) {
      const found = caseOf(a.target_case);
      return found ? [{ case_id: found.id, public_id: found.public_id, email: found.email, phone: found.phone, first_name: found.first_name, payment_verified: found.payment_verified, contact_verified: found.contact_verified_at !== null && found.contact_verified_at !== undefined, contact_verified_channel: found.contact_verified_channel ?? null }] : [];
    },
    case_access_pending_links(a) {
      return state.cases.filter((found) => found.payment_verified && found.contact_verified_at && !state.tokens.some((token) => token.case_id === found.id && token.purpose === "payment_verified" && (token.send_state === "sent" || token.send_state === "refused")))
        .slice(0, n(a.target_limit)).map((found) => ({ case_id: found.id }));
    },
    case_access_token_for_case(a) {
      const token = [...state.tokens].reverse().find((row) => row.case_id === a.target_case && row.purpose === a.target_purpose);
      return token ? [{ token_id: token.id, send_state: token.send_state, send_attempts: token.send_attempts, identity_id: token.identity_id }] : [];
    },
    case_notification_record(a) {
      state.notifications.push({ case_id: (a.target_case as string | null) ?? null, identity_id: (a.target_identity as string | null) ?? null, channel: s(a.target_channel), template: s(a.target_template), state: s(a.target_state), provider: s(a.target_provider), payload_sha256: s(a.target_payload_sha256), error_code: (a.target_error_code as string | null) ?? null });
      return [{ value: randomUUID() }];
    },
    case_notification_count(a) {
      const rows = state.notifications.filter((row) => row.case_id === a.target_case && row.template === a.target_template);
      return [{ sent: rows.filter((row) => row.state === "sent").length, failed: rows.filter((row) => row.state === "failed").length }];
    },
    // --- 202609050003: the funnel verification and the one-time exchange.
    case_access_funnel_contact_update(a) {
      const found = caseOf(a.target_case);
      if (!found || found.contact_verified_at) return [{ value: false }];
      if (a.target_channel === "email") found.email = s(a.target_value);
      else if (a.target_channel === "phone") found.phone = s(a.target_value);
      else return [{ value: false }];
      return [{ value: true }];
    },
    case_access_funnel_verify(a) {
      const found = caseOf(a.target_case);
      if (!found) return [{ value: false }];
      found.contact_verified_at ??= now();
      found.contact_verified_channel ??= s(a.target_channel);
      const identity = state.identities.find((row) => row.id === a.target_identity);
      if (identity) identity.verified_at ??= now();
      if (!state.identity_cases.some((row) => row.identity_id === a.target_identity && row.case_id === a.target_case)) state.identity_cases.push({ identity_id: s(a.target_identity), case_id: s(a.target_case) });
      return [{ value: true }];
    },
    case_access_challenge_open(a) {
      const issued = issueCode(a);
      if (!issued.code_id) return [issued];
      for (const row of state.codes) if (row.challenge_hash === a.target_challenge_hash) row.challenge_hash = null;
      const code = state.codes.find((row) => row.id === issued.code_id)!;
      code.challenge_hash = s(a.target_challenge_hash);
      code.case_id = (a.target_case as string | null) ?? null;
      if (a.target_token) { const token = state.tokens.find((row) => row.id === a.target_token); if (token) token.used_at ??= now(); }
      return [issued];
    },
    // --- 202609060004/0005: the thread and the case's documents (S3.4 / S2.3).
    case_request_list(a) {
      return state.case_requests.filter((row) => row.case_id === a.target_case).sort((left, right) => right.opened_at - left.opened_at);
    },
    case_request_open(a) {
      // The partial unique index, in the fake: one open request per code per case.
      if (state.case_requests.some((row) => row.case_id === a.target_case && row.code === a.target_code && row.answered_at === null)) return [];
      const row: ThreadRow = {
        id: randomUUID(), case_id: s(a.target_case), code: s(a.target_code), question: s(a.target_question),
        answer_kind: s(a.target_answer_kind), options: (a.target_options as string[] | null) ?? null,
        field_crop: (a.target_field_crop as string | null) ?? null, blocking: a.target_blocking === true,
        opened_at: now(), expires_at: s(a.target_expires_at), answered_at: null, answer_text: null,
      };
      state.case_requests.push(row);
      return [row];
    },
    case_request_answer(a) {
      const row = state.case_requests.find((candidate) => candidate.id === a.target_request && candidate.case_id === a.target_case && candidate.answered_at === null);
      if (!row) return [];
      row.answered_at = now();
      row.answer_text = s(a.target_answer).slice(0, 2_000);
      return [row];
    },
    case_documents_await(a) {
      // The SQL guard, mirrored: only a case still in the funnel moves.
      const found = caseOf(a.target_case);
      if (!found) return [{ value: null }];
      if (found.status === "started" || found.status === "questionnaire_completed") found.status = "awaiting_document";
      return [{ value: found.status }];
    },
    case_documents_arrived(a) {
      const open = state.case_requests.filter((row) => row.case_id === a.target_case && row.code === "document_missing" && row.answered_at === null);
      for (const row of open) { row.answered_at = now(); row.answer_text = s(a.target_answer); }
      return [{ value: open.length }];
    },
    case_documents_list(a) {
      return state.case_documents.filter((row) => row.case_id === a.target_case).sort((left, right) => left.created_at - right.created_at);
    },
    case_access_challenge_resolve(a) {
      const code = state.codes.find((row) => row.challenge_hash === a.target_challenge_hash);
      if (!code) return [];
      const identity = state.identities.find((row) => row.id === code.identity_id)!;
      const found = code.case_id ? caseOf(code.case_id) : undefined;
      return [{ code_id: code.id, identity_id: code.identity_id, case_id: code.case_id, public_id: found?.public_id ?? null, channel: identity.channel, contact_normalized: identity.contact_normalized, live: code.consumed_at === null && code.locked_at === null && code.expires_at > now() }];
    },
  };

  return Object.freeze({
    provider: "fake" as const,
    ...state,
    now,
    advance(ms: number) { clock += ms; },
    async rpc<T>(fn: string, args: Readonly<Record<string, unknown>>): Promise<readonly T[]> {
      const handler = functions[fn];
      if (!handler) throw new Error(`FAKE_CASE_ACCESS_DB_FUNCTION_UNKNOWN:${fn}`);
      state.calls.push({ fn, args: { ...args } });
      return handler({ ...args }) as T[];
    },
  }) as FakeCaseAccessDb;
}
