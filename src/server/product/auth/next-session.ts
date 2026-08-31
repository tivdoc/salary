import "./server-boundary.ts";

import { cookies, headers } from "next/headers";
import type { ProductAudience, VerifiedProductSession } from "./hermetic-session.ts";
import { PRODUCT_SESSION_COOKIE, runtimeHermeticSessionManager } from "./hermetic-session.ts";

export async function productPageSession(audience: ProductAudience): Promise<VerifiedProductSession | null> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const token = cookieStore.get(PRODUCT_SESSION_COOKIE)?.value;
  const host = headerStore.get("host");
  if (!token || !host || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host)) return null;
  const forwardedProtocol = headerStore.get("x-forwarded-proto");
  const protocol = forwardedProtocol === "https" ? "https" : "http";
  const request = new Request(`${protocol}://${host}/${audience}`, {
    headers: { cookie: `${PRODUCT_SESSION_COOKIE}=${token}` },
  });
  return runtimeHermeticSessionManager().verify(request, audience, false);
}
