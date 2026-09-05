import { notFound, redirect } from "next/navigation";
import { AccessChallenge } from "@/components/case/access-challenge";
import { CaseShell } from "@/components/case/case-shell";
import { CaseView } from "@/components/case/case-view";
import { productOffer } from "@/lib/product-offer";
import { isOpaqueToken } from "@/server/product/case-access/crypto";
import { describeLinkToken, listIdentityCases, resolveIdentitySession } from "@/server/product/case-access/service";
import { readCaseSessionCookie } from "@/server/product/case-access/session-cookie";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

// UX Run 1 / U3 (D-1.2, D-1.5). One segment, two readings: a 22-character
// link token opens the code challenge; a case id (TV-XXXXXXXX) shows the
// case to a verified identity session and sends everyone else to /login.
// The token is read from the path and handed to a client component's props;
// it is never placed in a query string and never logged.
export default async function CaseAccessPage({ params }: { params: Promise<{ token: string }> }) {
  await guardStableAppEntrypoint("CEP-096");
  const { token } = await params;
  const offer = productOffer();

  if (isOpaqueToken(token)) {
    const described = await describeLinkToken(token);
    if (!described.valid || !described.public_id) {
      return (
        <CaseShell eyebrow="כניסה לתיק">
          <div className="received-card received-card--error">
            <h1>הקישור אינו תקף או שפג תוקפו.</h1>
            <p>קישור לתיק תקף {offer.access.link_token_ttl_days} ימים. אפשר להיכנס בכל רגע עם הטלפון או האימייל שמסרת.</p>
            <a className="button button--primary" href="/login">כניסה עם טלפון או אימייל</a>
          </div>
        </CaseShell>
      );
    }
    return (
      <CaseShell eyebrow="כניסה לתיק">
        <AccessChallenge token={token} publicId={described.public_id} maskedTo={described.masked_to} channel={described.channel} codeTtlMinutes={offer.access.code_ttl_minutes} />
      </CaseShell>
    );
  }

  if (!/^TV-[A-Z0-9]{8}$/u.test(token)) notFound();
  const session = await resolveIdentitySession(await readCaseSessionCookie());
  if (!session) redirect("/login");
  const cases = await listIdentityCases(session.identity_id);
  const item = cases.find((candidate) => candidate.public_id === token);
  if (!item) notFound();
  return (
    <CaseShell eyebrow={`תיק ${item.public_id}`}>
      <CaseView item={item} otherCases={cases.length - 1} />
    </CaseShell>
  );
}
