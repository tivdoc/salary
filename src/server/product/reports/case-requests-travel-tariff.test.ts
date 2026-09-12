import {it,expect,vi} from 'vitest';
import {listCaseRequests} from './case-requests';
import {documentTravelTariffTarget} from './document-travel-tariff';
import type {CaseAccessDb} from '../case-access/db';
vi.mock('server-only',()=>({}));
const uuid=(n:number)=>`99999999-9999-4999-8999-${String(n).padStart(12,'0')}`;
function fixture(current=true){
 const source={document:{case_id:uuid(1),document_id:uuid(2),version_id:uuid(3),file_sha256:'a'.repeat(64),page_count:3,month:'2026-06',
  document_type:'other' as const,evidence_purpose:'travel_tariff' as const,purpose_sha256:'e'.repeat(64)},group:{page:2,locator:'Synthetic route and ticket section'}};
 const target=documentTravelTariffTarget({source,subject:'ticket_inventory'}),requestId=uuid(4),identityId=uuid(5),calls:string[]=[];
 const row={id:requestId,case_id:source.document.case_id,code:'document_field:'+target.target_sha256,question:'Synthetic tariff source question',answer_kind:'choice',options:null,
  field_crop:null,blocking:false,opened_at:'2026-09-12T00:00:00Z',expires_at:'2030-01-01T00:00:00Z',answered_at:null,answer_text:null};
 const responses:Record<string,unknown[]>={case_request_list:[row],case_request_revision_list:[],case_request_field_states:[{request_id:requestId,source_current:current}],case_request_field_reading_targets:[{request_id:requestId,target}]};
 const db:CaseAccessDb={provider:'fake',async rpc<T>(name:string){calls.push(name);if(!(name in responses))throw Error('UNEXPECTED_RPC:'+name);return responses[name] as T[];}};
 return {source,target,requestId,identityId,db,calls,responses};
}
it.each([true,false])('projects tariff page and subject from the protected stored target with currentness %s',async current=>{
 const f=fixture(current),[request]=await listCaseRequests(f.target.case_id,f.db,f.identityId);
 expect(request.source_current).toBe(current);expect(request.reading_display).toMatchObject({field:'travel_tariff.ticket_inventory',raw_value:null,page:2,
  tariff_context:{subject:'ticket_inventory',page:2,locator:f.source.group.locator},bounding_box:null});
 const json=JSON.stringify(request);
 for(const hidden of ['purpose_sha256','source_group_sha256','policy_version','tariff-transcription-v1',f.source.document.file_sha256,f.source.document.purpose_sha256])expect(json).not.toContain(hidden);
 expect(f.calls).toEqual(['case_request_list','case_request_revision_list','case_request_field_states','case_request_field_reading_targets']);
});
it('does not expose tariff controls without an identity, or accept a source target from another case',async()=>{
 const f=fixture(),[request]=await listCaseRequests(f.target.case_id,f.db);expect(request.reading_display).toBeUndefined();
 expect(f.calls).toEqual(['case_request_list','case_request_revision_list']);
 await expect(listCaseRequests(uuid(99),f.db,f.identityId)).rejects.toThrow('REQUEST_FIELD_STATE_UNAVAILABLE');
});
it('refuses a missing or duplicate currentness receipt rather than offering active tariff controls',async()=>{
 for(const states of [[],[{request_id:uuid(4),source_current:true},{request_id:uuid(4),source_current:true}]]){
  const f=fixture();f.responses.case_request_field_states=states;
  await expect(listCaseRequests(f.target.case_id,f.db,f.identityId)).rejects.toThrow('REQUEST_FIELD_STATE_UNAVAILABLE');
 }
});
