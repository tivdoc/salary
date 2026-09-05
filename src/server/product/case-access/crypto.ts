// UX Run 1 / U1–U2. Tokens, codes, sessions and contacts as the database
// sees them: hashed. Nothing here is logged; nothing here is a query string.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** 128 random bits, base64url: 22 characters, a path segment, never a query parameter. */
export function createOpaqueToken(): string {
  return randomBytes(16).toString("base64url");
}

export const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

export function isOpaqueToken(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_TOKEN_PATTERN.test(value);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashToken(token: string): string {
  return sha256Hex(`case-access-token|${token}`);
}

export function hashSession(session: string): string {
  return sha256Hex(`case-access-session|${session}`);
}

/** Six digits from a CSPRNG, leading zeros kept. */
export function createAccessCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export const ACCESS_CODE_PATTERN = /^[0-9]{6}$/u;

/** The code hashed with the identity it was issued to: a code is never valid for another identity. */
export function hashAccessCode(identityId: string, code: string): string {
  return sha256Hex(`case-access-code|${identityId}|${code}`);
}

export type ContactChannel = "email" | "phone";

export type NormalizedContact = Readonly<{ channel: ContactChannel; normalized: string; hash: string }>;

/**
 * A contact as one identity: an email lower-cased and trimmed, a phone as its
 * digits with an Israeli leading zero folded into +972. Returns null for a
 * value that is neither; the caller answers as if a code was sent.
 */
export function normalizeContact(raw: unknown): NormalizedContact | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length < 3 || value.length > 180) return null;
  if (value.includes("@")) {
    const email = value.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u.test(email)) return null;
    return { channel: "email", normalized: email, hash: sha256Hex(`email|${email}`) };
  }
  const digits = value.replace(/[^0-9+]/gu, "");
  if (!/^\+?[0-9]{9,15}$/u.test(digits)) return null;
  let phone = digits.startsWith("+") ? digits : digits.startsWith("0") ? `+972${digits.slice(1)}` : `+${digits}`;
  phone = phone.replace(/^\+9720/u, "+972");
  return { channel: "phone", normalized: phone, hash: sha256Hex(`phone|${phone}`) };
}

/** A requester's IP as the rate-limit ledger stores it: hashed with the product secret, never the address. */
export function hashRequesterIp(request: Request, secret: string): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || request.headers.get("x-real-ip")?.trim() || null;
  if (!ip) return null;
  return sha256Hex(`case-access-ip|${secret}|${ip}`);
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
