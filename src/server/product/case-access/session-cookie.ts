// UX Run 1 / U2 (D-1.3). The identity session cookie: opaque, httpOnly, thirty
// days, bound to the identity in the store. The pre-payment funnel keeps its
// own `tivdoc_salary_case` cookie; after payment this one supersedes it.
import "server-only";
import { cookies } from "next/headers";

export const CASE_SESSION_COOKIE = "tivdoc_case_session";

export async function setCaseSessionCookie(session: string, maxAgeSeconds: number): Promise<void> {
  const store = await cookies();
  store.set(CASE_SESSION_COOKIE, session, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

export async function readCaseSessionCookie(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(CASE_SESSION_COOKIE)?.value ?? null;
  return value && /^[A-Za-z0-9_-]{22}$/u.test(value) ? value : null;
}

export async function clearCaseSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(CASE_SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 });
}
