import 'server-only';
import {z} from 'zod';
import type {CaseAccessDb} from '../case-access/db';
import {normalizeContact} from '../case-access/crypto';
import {encryptNotification} from '../case-access/notification-outbox';
import {payloadDigest,recipientRefusal,type NotificationMessage} from '../case-access/notifications';

const hash=z.string().regex(/^[a-f0-9]{64}$/u);
export const completionNotificationRoundSchema=z.object({
 round_id:hash,job_id:z.string().min(1).max(300),analysis_run_id:z.uuid(),case_id:z.uuid(),
 public_id:z.string().regex(/^TV-[A-Z0-9]{8}$/u),identity_id:z.uuid(),contact:z.email(),request_set_sha256:hash,
 questions:z.array(z.object({request_id:z.uuid(),question:z.string().min(1).max(400)}).strict()).min(1).max(40),
}).strict().refine(round=>new Set(round.questions.map(q=>q.request_id)).size===round.questions.length,'duplicate_request');
export type CompletionNotificationRound=z.infer<typeof completionNotificationRoundSchema>;

/** The SQL-owned digest pins the complete current request set, including its
 * question bytes. SQL validates it again; it is not a client assertion of READY.
 * Sorting makes delivery identity independent of query/enumerator ordering. */
export function renderCompletionNotification(value:CompletionNotificationRound,origin:string):NotificationMessage{
 const round=completionNotificationRoundSchema.parse(value),base=new URL(origin);
 if(base.protocol!=='https:'||!base.hostname.endsWith('.vercel.app'))throw Error('MANAGED_NOTIFICATION_ORIGIN');
 const thread=`${base.origin}/case/${round.public_id}/thread`;
 const questions=[...round.questions].sort((a,b)=>a.request_id.localeCompare(b.request_id));
 const message:NotificationMessage={template:'document_request',channel:'email',to:round.contact,
  subject:`Tivdoc DEV — נדרשות השלמות בתיק ${round.public_id}`,
  body:[`סבב הניתוח הסתיים. נדרשות ${questions.length} השלמות בתיק הבדיקה הסינתטי כדי להמשיך.`,
   'כל שאלה ומסמך המקור שלה זמינים לאחר כניסה באימייל המאומת. אפשר להשלים את השאלות בהדרגה.',
   ...questions.map((q,index)=>`${index+1}. ${q.question.replace(/\s+/gu,' ').trim().slice(0,180)}\n${thread}?requestId=${q.request_id}`),
   `לכל ההשלמות הפתוחות בתיק: ${thread}?completionRound=${round.round_id}`,
   'זו הודעת DEV לבדיקה סינתטית. תשובה לשאלה אינה אישור משפטי או אישור אנושי לניתוח.'].join('\n\n')};
 if(message.body.length>16000)throw Error('COMPLETION_NOTIFICATION_BODY_LIMIT');
 return message;
}

/** One intention per authenticated READY round. No grouping is invented from
 * an arbitrary list of pending requests; incomplete runs never reach this RPC.
 * Provider dispatch is separately fenced immediately before the network call. */
export async function enqueueCompletionNotifications(input:{db:CaseAccessDb;capability:string;secret:string;origin:string;enqueueEventKeys?:readonly string[];signal?:AbortSignal}){
 const rounds=z.array(completionNotificationRoundSchema).max(10).parse(await input.db.rpc('case_notification_completion_pending',{target_capability:input.capability}));
 let queued=0;
 for(const round of rounds){
  if(input.signal?.aborted)break;
  if(input.enqueueEventKeys!==undefined&&!input.enqueueEventKeys.includes(`completion:${round.round_id}`))continue;
  const contact=normalizeContact(round.contact);if(!contact||recipientRefusal(round.contact))continue;
  const message=renderCompletionNotification(round,input.origin),delivery=payloadDigest(message);
  const rows=await input.db.rpc<{value:string|null}>('case_notification_completion_enqueue',{
   target_capability:input.capability,target_round:round.round_id,target_delivery:delivery,
   target_payload:encryptNotification(message,delivery,input.secret),target_expires:new Date(Date.now()+5*3600000).toISOString(),
   expected_case:round.case_id,expected_identity:round.identity_id,expected_recipient:contact.hash,
   expected_request_set_sha256:round.request_set_sha256,expected_request_ids:round.questions.map(q=>q.request_id).sort(),
  });
  if(rows[0]?.value)queued++;
 }
 return queued;
}
