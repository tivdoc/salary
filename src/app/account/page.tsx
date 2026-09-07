import {redirect} from 'next/navigation';
import Link from 'next/link';
import {CaseShell} from '@/components/case/case-shell';
import {PrivacyControls} from '@/components/case/privacy-controls';
import {resolveIdentitySession,listIdentityCases} from '@/server/product/case-access/service';
import {readCaseSessionCookie} from '@/server/product/case-access/session-cookie';
import {resolveCaseAccessDb} from '@/server/product/case-access/db';
import {guardStableAppEntrypoint} from '@/server/platform/capabilities/stable-next-entrypoint';
type PrivacyRow={id:string;public_id:string;kind:string;state:string;created_at:string;due_at:string;resolution:string|null};
export const metadata={title:'חשבון ופרטיות | תבדוק',robots:{index:false,follow:false}};
export default async function AccountPage(){
 await guardStableAppEntrypoint("CEP-112");const session=await resolveIdentitySession(await readCaseSessionCookie());if(!session)redirect('/login');
 const cases=await listIdentityCases(session.identity_id);let requests:PrivacyRow[]|null=null;
 try{const db=await resolveCaseAccessDb();if(!db)throw new Error('store');requests=(await db.rpc<{value:PrivacyRow[]}>('case_privacy_requests',{target_identity:session.identity_id}))[0]?.value??null;}catch{}
 const states:Record<string,string>={pending:'התקבלה',in_review:'בטיפול',restricted:'הטיפול הוגבל — ראו נימוק',completed:'הטיפול הושלם'};
 return <CaseShell eyebrow="חשבון ופרטיות"><h1>חשבון ופרטיות</h1><PrivacyControls cases={cases}/><h2>הבקשות שלי</h2>{requests===null?<p role="alert">לא ניתן לטעון את הבקשות כרגע. זו אינה רשימה ריקה.</p>:requests.length===0?<p>אין בקשות פרטיות שמורות.</p>:requests.map(r=><article key={r.id}><h3>{r.kind==='deletion'?'בקשת מחיקה':r.kind==='correction'?'בקשת תיקון':'בקשת עיון'} · {r.public_id}</h3><p>{states[r.state]??'מצב בבירור'} · יעד טיפול: {new Date(r.due_at).toLocaleDateString('he-IL')}</p>{r.resolution?<p>{r.resolution}</p>:null}</article>)}<p>מסמכים הדרושים לדוח, לטיפול פעיל או לחובת שמירה עשויים להישמר גם כשנפתחה בקשת מחיקה. הסיבה תתועד בתשובה לבקשה.</p><Link href="/privacy">מדיניות הפרטיות</Link> · <Link href="/cases">התיקים שלי</Link></CaseShell>;
}
