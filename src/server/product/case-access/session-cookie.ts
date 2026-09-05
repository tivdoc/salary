// UX Run 1 / U2 (D-1.3). The identity session cookie: opaque, httpOnly, thirty
// days, bound to the identity in the store. The pre-payment funnel keeps its
// own `tivdoc_salary_case` cookie; after payment this one supersedes it.
//
// External review #1, finding 8: the link is exchanged once for a short
// challenge cookie, so the token appears in one request only and the code
// screen is served at the case id.
import "server-only";
import { cookies } from "next/headers";

export const CASE_SESSION_COOKIE = "tivdoc_case_session";
export const CASE_CHALLENGE_COOKIE = "tivdoc_case_challenge";

const OPAQUE = /^[A-Za-z0-9_-]{22}$/u;

function attributes(maxAgeSeconds: number) {
  return { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: maxAgeSeconds };
}

export async function setCaseSessionCookie(session: string, maxAgeSeconds: number): Promise<void> {
  (await cookies()).set(CASE_SESSION_COOKIE, session, attributes(maxAgeSeconds));
}

export async function readCaseSessionCookie(): Promise<string | null> {
  const value = (await cookies()).get(CASE_SESSION_COOKIE)?.value ?? null;
  return value && OPAQUE.test(value) ? value : null;
}

export async function clearCaseSessionCookie(): Promise<void> {
  (await cookies()).set(CASE_SESSION_COOKIE, "", attributes(0));
}

export async function setCaseChallengeCookie(challenge: string, maxAgeSeconds: number): Promise<void> {
  (await cookies()).set(CASE_CHALLENGE_COOKIE, challenge, attributes(maxAgeSeconds));
}

export async function readCaseChallengeCookie(): Promise<string | null> {
  const value = (await cookies()).get(CASE_CHALLENGE_COOKIE)?.value ?? null;
  return value && OPAQUE.test(value) ? value : null;
}

export async function clearCaseChallengeCookie(): Promise<void> {
  (await cookies()).set(CASE_CHALLENGE_COOKIE, "", attributes(0));
}
