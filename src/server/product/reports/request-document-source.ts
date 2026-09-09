import 'server-only';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {getSupabaseAdmin} from '@/lib/supabase-admin';
import {resolveCaseAccessDb,type CaseAccessDb} from '../case-access/db';
const sourceSchema=z.object({path:z.string(),mime:z.enum(['application/pdf','image/png','image/jpeg']),size:z.number().int().positive().max(10*1024*1024),
 sha256:z.string().regex(/^[a-f0-9]{64}$/u),version:z.uuid(),page:z.number().int().positive()}).strict();
/** Resolves only an identity-authorized current source. Reused by the source
 * reader and replacement navigation; navigation never downloads salary bytes. */
export async function requestDocumentSourceMetadata(input:{caseId:string;identityId:string;requestId:string},db?:CaseAccessDb){
 z.uuid().parse(input.caseId);z.uuid().parse(input.identityId);z.uuid().parse(input.requestId);
 const store=db??await resolveCaseAccessDb();if(!store)throw Error('REQUEST_STORE_UNAVAILABLE');
 const rows=await store.rpc<{value:unknown}>('case_request_document_source',{target_case:input.caseId,target_identity:input.identityId,target_request:input.requestId});
 if(rows.length===0)return null;
 if(rows.length!==1)throw Error('REQUEST_FIELD_SOURCE_AMBIGUOUS');
 if(rows[0].value===null)return null;
 const source=sourceSchema.parse(rows[0].value),extension=source.mime==='application/pdf'?'pdf':source.mime==='image/png'?'png':'jpg';
 if(source.path!==`cases/${input.caseId}/versions/${source.version}.${extension}`)throw Error('REQUEST_FIELD_SOURCE_SCOPE');
 return {...source,extension};
}
export async function loadRequestDocumentSource(input:{caseId:string;identityId:string;requestId:string},db?:CaseAccessDb){
 const source=await requestDocumentSourceMetadata(input,db);if(!source)return null;
 const {data,error}=await getSupabaseAdmin().storage.from('salary-documents').download(source.path);
 if(error||!data||data.size!==source.size)throw Error('REQUEST_FIELD_SOURCE_MISSING');
 const bytes=Buffer.from(await data.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==source.sha256)throw Error('REQUEST_FIELD_SOURCE_CHANGED');
 return {bytes,mime:source.mime,version:source.version,extension:source.extension};
}
