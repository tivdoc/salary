const PREFIX='tivdoc:support:v1:';
const MAX_AGE_MS=24*60*60*1000;
export type SupportDraft={message:string;pendingId:string|null;updatedAt:number};
type Store=Pick<Storage,'getItem'|'setItem'|'removeItem'|'key'|'length'>;
export function supportDraftKey(publicId:string,threadId?:string){return `${PREFIX}${publicId}:${threadId??'new'}`;}
/** Optional tab-local recovery, not a server save or a permission credential. */
export function readSupportDraft(store:Store,key:string,now=Date.now()):SupportDraft|null{
 try{
  const raw=store.getItem(key);if(raw===null)return null;
  const d=JSON.parse(raw) as SupportDraft;
  if(!d||typeof d.message!=='string'||d.message.length>2000||!Number.isSafeInteger(d.updatedAt)||d.updatedAt>now||now-d.updatedAt>=MAX_AGE_MS||
   !(d.pendingId===null||typeof d.pendingId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(d.pendingId))||
   d.pendingId!==null&&d.message.trim().length<4){store.removeItem(key);return null;}
  return d;
 }catch{return null;}
}
export function writeSupportDraft(store:Store,key:string,draft:SupportDraft|null):boolean{
 try{if(draft===null||draft.message==='')store.removeItem(key);else store.setItem(key,JSON.stringify(draft));return true;}catch{return false;}
}
/** Touch only our recovery records; leave unrelated app/browser data intact. */
export function clearSupportDrafts(store:Store){try{for(let i=store.length-1;i>=0;i--){const key=store.key(i);if(key?.startsWith(PREFIX))store.removeItem(key);}}catch{/* storage may be disabled */}}
