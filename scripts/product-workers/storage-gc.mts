import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {postgresCaseAccessDb} from '../../src/server/product/case-access/db.ts';
import {collectOrphans} from '../../src/server/product/privacy/storage-gc.ts';
if(process.env.TIVDOC_STORAGE_GC_ENABLED!=='true')throw new Error('STORAGE_GC_DISABLED');
const execute=process.argv.includes('--execute');
if(execute&&process.env.TIVDOC_STORAGE_GC_DELETE_ENABLED!=='true')throw new Error('STORAGE_GC_DELETE_DISABLED');
const databaseUrl=process.env.TIVDOC_WORKER_POSTGRES_URL,url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!databaseUrl||!url||!key)throw new Error('STORAGE_GC_CONFIGURATION_MISSING');
const pool=new pg.Client({connectionString:databaseUrl,application_name:'tivdoc_storage_gc',connectionTimeoutMillis:15000});await pool.connect();
try{const db=postgresCaseAccessDb(pool);const objects=(await db.rpc<{value:{path:string;createdAt:string}[]}>('case_documents_gc_pending',{target_limit:100}))[0]?.value;if(!Array.isArray(objects))throw new Error('GC_INVENTORY_UNAVAILABLE');const bucket=createClient(url,key,{auth:{persistSession:false}}).storage.from('salary-documents');
 const result=await collectOrphans({db,objects,execute,storage:{remove:async path=>{const response=await bucket.remove([path]);if(response.error)throw new Error('GC_STORAGE_REMOVE_FAILED');}}});
 const drafts=execute?(await db.rpc<{value:number}>('case_privacy_draft_sweep',{target_limit:100}))[0]?.value:0;
 console.log(JSON.stringify({worker:'storage_gc',mode:execute?'execute':'mark_only',...result,draftsDeleted:drafts}));
 if(result.failed)process.exitCode=1;
}finally{await pool.end();}
