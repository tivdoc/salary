import {hashSession} from './crypto';
import {resolveCaseAccessDb,type CaseAccessDb} from './db';
import {resolveIdentitySession} from './service';
export function sameOriginSessionRequest(request:Request):boolean{
 const origin=request.headers.get('origin');
 return origin===new URL(request.url).origin && request.headers.get('sec-fetch-site')!=='cross-site';
}
export async function refreshSession(session:string|null,db?:CaseAccessDb|null,now=Date.now()){
 const identity=await resolveIdentitySession(session,db);if(!identity)return null;
 const ttl=Math.floor((Date.parse(identity.expires_at)-now)/1000);
 return ttl>0?{ttl}:null;
}
export async function revokeSession(session:string|null,db?:CaseAccessDb|null){
 if(!session)return;
 const store=db??await resolveCaseAccessDb();if(!store)throw new Error('SESSION_STORE_UNAVAILABLE');
 await store.rpc('case_access_session_revoke',{target_session_hash:hashSession(session)});
}
