import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CaseShell } from "@/components/case/case-shell";
import { listIdentityCases, resolveIdentitySession } from "@/server/product/case-access/service";
import { readCaseSessionCookie } from "@/server/product/case-access/session-cookie";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

export const metadata: Metadata = {
  title: "התיקים שלי | Tivdoc",
  robots: { index: false, follow: false },
};

const STATUS_HE: Readonly<Record<string, string>> = Object.freeze({
  started: "התחילה", questionnaire_completed: "שאלון הושלם", documents_uploaded: "מסמכים התקבלו",
  payment_pending: "ממתין לאימות תשלום", paid: "שולם", under_review: "בעבודה", completed: "הושלמה",
});

// UX Run 1 / U3 (D-1.5). Rendered only when the identity holds more than one
// case; one case goes straight to it; no session goes to /login.
export default async function CasesPage() {
  await guardStableAppEntrypoint("CEP-098");
  const session = await resolveIdentitySession(await readCaseSessionCookie());
  if (!session) redirect("/login");
  const cases = await listIdentityCases(session.identity_id);
  if (cases.length === 1 && cases[0]) redirect(`/case/${cases[0].public_id}`);
  return (
    <CaseShell eyebrow="התיקים שלי">
      <div className="received-card">
        <h1>{cases.length === 0 ? "עדיין אין תיקים על הזהות הזו." : "התיקים שלך"}</h1>
        {cases.length === 0 ? <p>תיק נפתח בבדיקה; אחרי אימות התשלום הוא מופיע כאן.</p> : null}
        <ul className="cases-list">
          {cases.map((item) => (
            <li key={item.case_id}>
              <Link href={`/case/${item.public_id}`}>
                <span className="mono">{item.public_id}</span>
                <span>{STATUS_HE[item.status] ?? item.status}</span>
                <span className="mono">{new Date(item.created_at).toLocaleDateString("he-IL")}</span>
              </Link>
            </li>
          ))}
        </ul>
        <Link className="button button--secondary" href="/check">בדיקה חדשה</Link>
      </div>
    </CaseShell>
  );
}
