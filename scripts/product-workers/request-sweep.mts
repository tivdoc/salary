// Explicit worker command, suitable for the deployment's scheduled runner.
// No mail is sent: durable reminder intentions are delivered by the outbox lane.
import pg from 'pg';
if(process.env.TIVDOC_REQUEST_SWEEP_ENABLED!=='true')throw new Error('REQUEST_SWEEP_DISABLED');
const url=process.env.TIVDOC_WORKER_POSTGRES_URL;if(!url)throw new Error('WORKER_DATABASE_UNAVAILABLE');
const db=new pg.Client({connectionString:url,connectionTimeoutMillis:15000,statement_timeout:20000,application_name:'tivdoc_request_sweep'});
await db.connect();
try{
 const result=await db.query('select public.case_request_sweep(clock_timestamp(),100) processed');
 console.log(JSON.stringify({worker:'request_sweep',processed:result.rows[0].processed,delivery:'queued_intentions_only'}));
}finally{await db.end();}
