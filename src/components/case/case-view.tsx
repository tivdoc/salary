import type {CaseOverview} from "@/server/product/case-access/overview";
import Link from "next/link";
import { productOffer } from "@/lib/product-offer";
import type { IdentityCase } from "@/server/product/case-access/service";

// The next action is derived from saved requests and published reports.
const STATUS_HE: Readonly<Record<string, string>> = Object.freeze({
  awaiting_document: "ממתינים למסמך",
  started: "הבדיקה התחילה",
  questionnaire_completed: "השאלון הושלם",
  documents_uploaded: "המסמכים התקבלו",
  payment_pending: "ממתינים לאימות התשלום",
  paid: "התשלום אומת",
  under_review: "הבדיקה בעבודה",
  completed: "הבדיקה הושלמה",
});


export function CaseView({ item, otherCases, overview }: { item: IdentityCase; otherCases: number; overview?:CaseOverview }) {
  const offer = productOffer();
  const state = STATUS_HE[item.status] ?? 'מצב התיק בבירור';
  const base = `/case/${item.public_id}`;
  const action = overview?.blocking ? {href:`${base}/thread#request-${overview.blocking.id}`,label:'השלמת הפרט החסר'}
    : (overview?.publishedReports ?? 0)>0 ? {href:`${base}/reports`,label:'לצפייה בדוחות שפורסמו'}
    : {href:`${base}/thread`,label:'להודעות ולעדכונים בתיק'};
  return <div className="received-card">
    <span className="mono">תיק {item.public_id}</span><h1>{state}</h1>
    <p>{item.payment_verified ? 'התשלום בתיק אומת.' : 'טרם התקבל אימות תשלום לתיק. אם שילמת, אין צורך לשלם שוב לפני בירור.'}</p>
    {overview?.period ? <p>חודש הבדיקה: <bdi>{overview.period}</bdi></p> : null}
    {!overview?.requestsAvailable ? <p role="alert">לא ניתן לטעון את מצב בקשות ההשלמה כרגע.</p> : overview.blocking ? <div className="received-card__next"><b>נדרשת השלמה כדי להתקדם</b><span>{overview.blocking.question}</span></div> : <p>{overview.openRequests ? `${overview.openRequests} בקשות פתוחות מופיעות בהודעות.` : 'אין כרגע בקשות השלמה פתוחות.'}</p>}
    {!overview?.reportsAvailable ? <p role="alert">לא ניתן לטעון את מצב הדוחות כרגע.</p> : overview.publishedReports ? <p>{overview.publishedReports} דוחות שפורסמו זמינים לצפייה. מצב המשלוח נפרד ממצב הפרסום.</p> : <p>עדיין לא פורסם דוח לתיק. מצב התיק או התשלום לבדם אינם אישור שהדוח מוכן.</p>}
    <Link className="button button--primary" href={action.href}>{action.label}</Link>
    <div className="received-card__next"><b>היקף הבדיקה הראשונית</b><span>חודש אחד ועד שלושה נושאים שנבדקו. מידע חסר או ודאות נמוכה אינם מוצגים כסכום או כטווח.</span></div>
    <p>נפתח: <bdi>{new Date(item.created_at).toLocaleDateString('he-IL')}</bdi></p>
    <p className="payment-note">{offer.second_product_sentence}</p>
    <p><Link href={`${base}/orders`}>הזמנות, תשלומים ורכישת דוח מלא</Link></p>
    {otherCases>0?<Link href="/cases">כל התיקים שלי ({otherCases+1})</Link>:null}
  </div>;
}
