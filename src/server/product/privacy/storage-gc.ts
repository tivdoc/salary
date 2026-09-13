import type {CaseAccessDb} from '../case-access/db.ts';
export type GcStorage={remove(path:string):Promise<void>};
/** The database fence survives a process crash between Storage remove and acknowledgment.
 * Only immutable version paths selected by the server may enter this worker. */
export async function collectOrphans(input:{db:CaseAccessDb;storage:GcStorage;objects:readonly {path:string;createdAt:string}[];execute:boolean}){
 const result={examined:0,marked:0,retained:0,deleted:0,notDue:0,failed:0};
 for(const object of input.objects){result.examined++;try{
  const mark=(await input.db.rpc<{value:string}>('case_documents_gc_mark',{target_path:object.path,target_created:object.createdAt}))[0]?.value;
  if(mark?.startsWith('retained:')){result.retained++;continue;}if(mark!=='marked')throw new Error('GC_MARK_UNKNOWN');result.marked++;
  if(!input.execute)continue;
  const claim=(await input.db.rpc<{value:string}>('case_documents_gc_claim',{target_path:object.path}))[0]?.value;
  if(claim==='not_due'){result.notDue++;continue;}if(claim?.startsWith('retained:')){result.retained++;continue;}if(claim==='deleted'){result.deleted++;continue;}if(claim!=='deleting')throw new Error('GC_CLAIM_UNKNOWN');
  await input.storage.remove(object.path);await input.db.rpc('case_documents_gc_finish',{target_path:object.path});result.deleted++;
 }catch{result.failed++;}}
 return result;
}
