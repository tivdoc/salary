import "./server-boundary.ts";

import { cookies, headers } from "next/headers";
import type { ProductAudience, VerifiedProductSession } from "./hermetic-session.ts";
import { resolveProductSessionBoundary } from "./runtime.ts";

const FORWARDED_SESSION_COOKIES = Object.freeze([
  "__Host-tivdoc_identity",
  "tivdoc_csrf",
  "tivdoc_hermetic_session",
]);

export async function productPageSession(audience: ProductAudience): Promise<VerifiedProductSession | null> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const boundary = resolveProductSessionBoundary();
  if (!boundary) return null;
  const cookie = FORWARDED_SESSION_COOKIES.flatMap((name) => {
    const value = cookieStore.get(name)?.value;
    return value ? [`${name}=${value}`] : [];
  }).join("; ");
  const host = headerStore.get("host");
  if (!cookie || !host || !/^[A-Za-z0-9.:-]{1,255}$/.test(host)) return null;
  const protocol = boundary.proof_class === "DURABLE_CRYPTOGRAPHIC_SESSION" ? "https" : "http";
  const request = new Request(`${protocol}://${host}/${audience}`, {
    headers: { cookie },
  });
  return boundary.verify(request, audience, false);
}
