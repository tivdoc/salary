import { notFound, redirect } from "next/navigation";
import { AccessChallenge } from "@/components/case/access-challenge";
import { CaseShell } from "@/components/case/case-shell";
import { CaseView } from "@/components/case/case-view";
import { productOffer } from "@/lib/product-offer";
import { isOpaqueToken } from "@/server/product/case-access/crypto";
import { LinkExchange } from "@/components/case/link-exchange";
import { describeChallenge, listIdentityCases, peekLinkToken, resolveIdentitySession } from "@/server/product/case-access/service";
import { readCaseChallengeCookie, readCaseSessionCookie } from "@/server/product/case-access/session-cookie";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

// UX Run 1 / U3 (D-1.2, D-1.5), corrected by the external review #1,
// finding 8. One segment, two readings. A 22-character link token is
// exchanged ONCE by the request route (token spent, code sent, a short
// challenge cookie set) and the customer moved to the case id — so the token
// appears in the link's request and the exchange's body, in no query string,
// and in no later Referer. A case id shows the case to a
// verified identity session, the code screen to a live challenge cookie,
// and sends everyone else to /login. The token is never placed in a query
// string and never logged.
export default async function CaseAccessPage({ params }: { params: Promise<{ token: string }> }) {
  await guardStableAppEntrypoint("CEP-096");
  const { token } = await params;
  const offer = productOffer();

  if (isOpaqueToken(token)) {
    // The exchange itself happens in the request route (a cookie cannot be set while a page renders): this page shows
    // the used-or-expired screen from a read-only peek, or nothing but the component that performs the exchange.
    const peeked = await peekLinkToken(token);
    if (!peeked.valid) {
      return (
        <CaseShell eyebrow="כניסה לתיק">
          <div className="received-card received-card--error">
            <h1>הקישור אינו תקף, נוצל כבר או שפג תוקפו.</h1>
            <p>קישור לתיק נפתח פעם אחת ותקף {offer.access.link_token_ttl_hours} שעות. אפשר להיכנס בכל רגע עם הטלפון או האימייל שאימתת.</p>
            <a className="button button--primary" href="/login">כניסה עם טלפון או אימייל</a>
          </div>
        </CaseShell>
      );
    }
    return (
      <CaseShell eyebrow="כניסה לתיק">
        <meta name="referrer" content="no-referrer" />
        <LinkExchange token={token} fallbackHref="/login" />
      </CaseShell>
    );
  }

  if (!/^TV-[A-Z0-9]{8}$/u.test(token)) notFound();
  const session = await resolveIdentitySession(await readCaseSessionCookie());
  if (session) {
    const cases = await listIdentityCases(session.identity_id);
    const item = cases.find((candidate) => candidate.public_id === token);
    if (!item) notFound();
    return (
      <CaseShell eyebrow={`תיק ${item.public_id}`}>
        <CaseView item={item} otherCases={cases.length - 1} />
      </CaseShell>
    );
  }
  const challenge = await describeChallenge(await readCaseChallengeCookie());
  if (challenge.live && challenge.public_id === token) {
    return (
      <CaseShell eyebrow="כניסה לתיק">
        <meta name="referrer" content="no-referrer" />
        <AccessChallenge mode="challenge" publicId={token} maskedTo={challenge.masked_to} channel={challenge.channel} codeTtlMinutes={offer.access.code_ttl_minutes} />
      </CaseShell>
    );
  }
  redirect("/login");
}
