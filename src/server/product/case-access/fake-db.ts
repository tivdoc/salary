// UX Run 1 / U2 tests. An in-memory store that answers the same eighteen
// function names as migration 202609050001, with the same outcomes, so the
// service's logic is tested without a database. The SQL itself is proven on
// DEV by scripts/dev-runtime/access-journey.mts; this mirror is kept small and
// literal so a divergence is a diff away.
import { randomUUID } from "node:crypto";
import type { CaseAccessDb } from "./db.ts";

type Identity = { id: string; channel: string; contact_hash: string; contact_normalized: string };
type Token = { id: string; case_id: string; identity_id: string; purpose: string; token_hash: string; expires_at: number; used_at: number | null; revoked_at: number | null; send_state: string; send_attempts: number; sent_at: number | null; send_error_code: string | null; created_at: number };
type Code = { id: string; identity_id: string; token_id: string | null; code_hash: string; created_at: number; expires_at: number; attempts: number; max_attempts: number; consumed_at: number | null; locked_at: number | null; requester_ip_hash: string | null };
type Session = { id: string; identity_id: string; session_hash: string; created_at: number; expires_at: number; last_seen_at: number; revoked_at: number | null };
type RequestRow = { identity_id: string | null; requester_ip_hash: string | null; outcome: string; created_at: number };
type Notification = { case_id: string | null; identity_id: string | null; channel: string; template: string; state: string; provider: string; payload_sha256: string; error_code: string | null };

export type FakeCase = { id: string; public_id: string; email: string | null; phone: string | null; first_name: string | null; status: string; payment_status: string; created_at: string; payment_verified: boolean };

export type FakeCaseAccessDb = CaseAccessDb & Readonly<{
  cases: FakeCase[];
  identities: Identity[];
  identity_cases: Array<{ identity_id: string; case_id: string }>;
  tokens: Token[];
  codes: Code[];
  sessions: Session[];
  notifications: Notification[];
  requests: RequestRow[];
  calls: Array<{ fn: string; args: Record<string, unknown> }>;
  now: () => number;
  advance(ms: number): void;
}>;

export function fakeCaseAccessDb(cases: readonly FakeCase[] = []): FakeCaseAccessDb {
  let clock = Date.parse("2026-09-05T10:00:00.000Z");
  const state = {
    cases: [...cases], identities: [] as Identity[], identity_cases: [] as Array<{ identity_id: string; case_id: string }>,
    tokens: [] as Token[], codes: [] as Code[], sessions: [] as Session[], notifications: [] as Notification[], requests: [] as RequestRow[],
    calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  };
  const now = () => clock;
  const s = (v: unknown) => String(v);
  const n = (v: unknown) => Number(v);

  const functions: Record<string, (a: Record<string, unknown>) => unknown[]> = {
    case_access_identity_upsert(a) {
      let identity = state.identities.find((row) => row.channel === a.target_channel && row.contact_hash === a.target_contact_hash);
      if (!identity) {
        identity = { id: randomUUID(), channel: s(a.target_channel), contact_hash: s(a.target_contact_hash), contact_normalized: s(a.target_contact_normalized) };
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
      const found = state.cases.find((row) => row.id === token.case_id)!;
      return [{ token_id: token.id, case_id: token.case_id, identity_id: token.identity_id, channel: identity.channel, contact_normalized: identity.contact_normalized, public_id: found.public_id, valid: token.revoked_at === null && token.expires_at > now() }];
    },
    case_access_token_mark_used(a) {
      const token = state.tokens.find((row) => row.id === a.target_token);
      if (token) token.used_at ??= now();
      return [];
    },
    case_access_code_issue(a) {
      const ip = (a.target_ip_hash as string | null) ?? null;
      const identity = (a.target_identity as string | null) ?? null;
      const note = (outcome: string) => { state.requests.push({ identity_id: identity, requester_ip_hash: ip, outcome, created_at: now() }); };
      const ipWindow = now() - n(a.ip_window_seconds) * 1_000;
      if (ip !== null && state.requests.filter((row) => row.requester_ip_hash === ip && row.created_at > ipWindow).length >= n(a.ip_limit)) { note("ip_rate_limited"); return [{ code_id: null, refused: "ip_rate_limited" }]; }
      if (identity === null) { note("unknown_identity"); return [{ code_id: null, refused: "unknown_identity" }]; }
      const identityWindow = now() - n(a.identity_window_seconds) * 1_000;
      if (state.requests.filter((row) => row.identity_id === identity && row.created_at > identityWindow).length >= n(a.identity_limit)) { note("identity_rate_limited"); return [{ code_id: null, refused: "identity_rate_limited" }]; }
      for (const row of state.codes) if (row.identity_id === a.target_identity && row.consumed_at === null) row.consumed_at = now();
      const code: Code = { id: randomUUID(), identity_id: s(a.target_identity), token_id: (a.target_token as string | null) ?? null, code_hash: s(a.target_code_hash), created_at: now(), expires_at: now() + n(a.target_ttl_seconds) * 1_000, attempts: 0, max_attempts: n(a.target_max_attempts), consumed_at: null, locked_at: null, requester_ip_hash: (a.target_ip_hash as string | null) ?? null };
      state.codes.push(code);
      note("issued");
      return [{ code_id: code.id, refused: null }];
    },
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
        .map((row) => state.cases.find((found) => found.id === row.case_id)!)
        .sort((left, right) => (left.created_at < right.created_at ? 1 : -1))
        .map((found) => ({ case_id: found.id, public_id: found.public_id, status: found.status, payment_status: found.payment_status, created_at: found.created_at, payment_verified: found.payment_verified }));
    },
    case_access_case_contact(a) {
      const found = state.cases.find((row) => row.id === a.target_case);
      return found ? [{ case_id: found.id, public_id: found.public_id, email: found.email, phone: found.phone, first_name: found.first_name, payment_verified: found.payment_verified }] : [];
    },
    case_access_pending_links(a) {
      return state.cases.filter((found) => found.payment_verified && !state.tokens.some((token) => token.case_id === found.id && token.purpose === "payment_verified" && token.send_state === "sent"))
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
