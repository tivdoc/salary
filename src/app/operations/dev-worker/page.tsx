import type {Metadata} from 'next';
import {notFound} from 'next/navigation';
import {guardStableAppEntrypoint} from '@/server/platform/capabilities/stable-next-entrypoint';
import {productPageSession} from '@/server/product/auth/next-session';
import {readStableProductRouteFlags} from '@/server/product/routes/flags';
import {resolveCanonicalOperationsService} from '@/server/product/routes/runtime';
import {requireSupportOwner} from '@/server/product/reports/support';
import {readManagedDevStatus,readManagedDevHealth} from '@/server/product/processing/managed-worker-host';
import {ManagedWorkerPanel} from './managed-worker-panel';

export const dynamic='force-dynamic';
export const metadata:Metadata={title:'עובד DEV | Tivdoc',robots:{index:false,follow:false,noarchive:true}};
export default async function ManagedWorkerPage(){
 await guardStableAppEntrypoint("CEP-115");
 if(!readStableProductRouteFlags().operationsUi||!resolveCanonicalOperationsService()||process.env.TIVDOC_MANAGED_DEV_WORKER_ENABLED!=='true')notFound();
 const session=await productPageSession('operations');if(!session)notFound();
 try{requireSupportOwner(session.actor);}catch{notFound();}
 let rows:Awaited<ReturnType<typeof readManagedDevStatus>>=[];let unavailable=false;
 let health:Awaited<ReturnType<typeof readManagedDevHealth>>=null;
 try{rows=await readManagedDevStatus();}catch{unavailable=true;}
 try{health=await readManagedDevHealth();}catch{unavailable=true;}
 return <main dir="rtl" style={{maxWidth:1100,margin:'2rem auto',padding:'1rem'}}><h1>עובד הניתוח ב־DEV</h1>
  <p>תיקי בדיקה מורשים בלבד. התזמון תלוי במחשב המארח; זה אינו שירות Production.</p>
  <p>השלמת הריצה אינה אישור לניתוח לקוח אמיתי. הפעלת הכללים המשפטיים דורשת את תנאי ההפעלה המתועדים.</p>
  <ManagedWorkerPanel initial={rows} initialHealth={health} unavailable={unavailable} csrfToken={session.csrf_token}/></main>;
}
