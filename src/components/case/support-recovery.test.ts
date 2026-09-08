import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {readSupportDraft,writeSupportDraft,supportDraftKey,clearSupportDrafts} from './support-recovery';
function storage(){const data=new Map<string,string>();return {get length(){return data.size;},key:(i:number)=>[...data.keys()][i]??null,getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>{data.delete(k);}};}
describe('tab-local support recovery',()=>{
 it('reopens the exact pending message and id after a lost response, then clears only its acknowledgement',()=>{
  const s=storage(),a=supportDraftKey('TV-CASE0001'),b=supportDraftKey('TV-CASE0001',randomUUID());
  const pending={message:'Synthetic unknown response',pendingId:randomUUID(),updatedAt:1000};
  writeSupportDraft(s,a,pending);writeSupportDraft(s,b,{message:'Unsent independent reply',pendingId:null,updatedAt:1000});
  expect(readSupportDraft(s,a,1001)).toEqual(pending);
  writeSupportDraft(s,a,null);expect(readSupportDraft(s,a,1001)).toBeNull();expect(readSupportDraft(s,b,1001)?.message).toBe('Unsent independent reply');
 });
 it('separates another case and the new-message form from every saved thread',()=>{
  const s=storage(),key=supportDraftKey('TV-CASE0001','thread');writeSupportDraft(s,key,{message:'Private draft',pendingId:null,updatedAt:1});
  expect(readSupportDraft(s,supportDraftKey('TV-CASE0002','thread'),2)).toBeNull();expect(readSupportDraft(s,supportDraftKey('TV-CASE0001'),2)).toBeNull();
 });
 it.each([null,{}, {message:'x',pendingId:randomUUID(),updatedAt:1000},{message:'x'.repeat(2001),pendingId:null,updatedAt:1000},{message:'valid',pendingId:'not-uuid',updatedAt:1000},{message:'valid',pendingId:null,updatedAt:1002}])('refuses invalid or future recovery records %#',value=>{
  const s=storage(),key=supportDraftKey('TV-CASE0001');s.setItem(key,JSON.stringify(value));expect(readSupportDraft(s,key,1001)).toBeNull();expect(s.getItem(key)).toBeNull();
 });
 it('expires a record exactly at 24 hours without reviving its pending submission',()=>{
  const s=storage(),key=supportDraftKey('TV-CASE0001');writeSupportDraft(s,key,{message:'Expired pending',pendingId:randomUUID(),updatedAt:1000});
  expect(readSupportDraft(s,key,1000+86400000)).toBeNull();expect(s.getItem(key)).toBeNull();
 });
 it('logout clears every support form but no unrelated storage',()=>{
  const s=storage();s.setItem('other-app','keep');s.setItem('tivdoc:document-upload:v1:case','keep');
  for(const key of [supportDraftKey('TV-CASE0001'),supportDraftKey('TV-CASE0002','thread')])writeSupportDraft(s,key,{message:'Draft',pendingId:null,updatedAt:1000});
  clearSupportDrafts(s);expect(s.length).toBe(2);expect(s.getItem('other-app')).toBe('keep');
 });
 it('storage denial cannot be reported as a successful local save',()=>{
  const s=storage();s.setItem=()=>{throw new Error('QuotaExceededError');};expect(writeSupportDraft(s,supportDraftKey('TV-CASE0001'),{message:'Draft',pendingId:null,updatedAt:1000})).toBe(false);
  s.getItem=()=>{throw new Error('SecurityError');};expect(readSupportDraft(s,'key')).toBeNull();
 });
});
