import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CaseShell } from "@/components/case/case-shell";
import { LoginForm } from "@/components/case/login-form";
import { productOffer } from "@/lib/product-offer";
import { listIdentityCases, resolveIdentitySession } from "@/server/product/case-access/service";
import { readCaseSessionCookie } from "@/server/product/case-access/session-cookie";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

export const metadata: Metadata = {
  title: "כניסה לתיק | Tivdoc",
  robots: { index: false, follow: false },
};

// UX Run 1 / U3 (D-1.4). Login and recovery are one route. A live session
// skips the form: one case goes to the case, more than one to the list.
export default async function LoginPage() {
  await guardStableAppEntrypoint("CEP-097");
  const session = await resolveIdentitySession(await readCaseSessionCookie());
  if (session) {
    const cases = await listIdentityCases(session.identity_id);
    redirect(cases.length === 1 && cases[0] ? `/case/${cases[0].public_id}` : "/cases");
  }
  return (
    <CaseShell eyebrow="כניסה לתיק">
      <LoginForm codeTtlMinutes={productOffer().access.code_ttl_minutes} />
    </CaseShell>
  );
}
