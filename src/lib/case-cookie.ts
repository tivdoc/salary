import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

const CASE_COOKIE = "tivdoc_salary_case";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 14;

function getSecret() {
  const secret = process.env.CASE_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("CASE_TOKEN_SECRET must contain at least 32 characters");
  }
  return secret;
}

function sign(caseId: string) {
  return createHmac("sha256", getSecret()).update(caseId).digest("base64url");
}

function verify(caseId: string, signature: string) {
  const expected = Buffer.from(sign(caseId));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function setCaseCookie(caseId: string) {
  const cookieStore = await cookies();
  cookieStore.set(CASE_COOKIE, `${caseId}.${sign(caseId)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

export async function readCaseIdFromCookie() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(CASE_COOKIE)?.value;
  if (!raw) return null;

  const separator = raw.lastIndexOf(".");
  if (separator < 1) return null;
  const caseId = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);

  try {
    return verify(caseId, signature) ? caseId : null;
  } catch {
    return null;
  }
}
