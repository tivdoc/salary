import {createServer} from 'node:http';
import {readFileSync,appendFileSync} from 'node:fs';
import {handleLocalDevResendIngress} from '../../src/server/product/case-access/dev-resend-ingress';

if(process.env.VERCEL||process.env.VERCEL_ENV||process.env.NODE_ENV!=='development')throw Error('LOCAL_DEV_ONLY');
// A config allowlist does not remove inherited authority from the process.
// The launcher must construct a minimal environment; reject accidental secret
// inheritance without printing either variable names or their values.
const sensitiveEnvironment=/(?:^|_)(?:DB|DATABASE|POSTGRES(?:QL)?|SUPABASE|OPENAI|RESEND|REDIS|SQLSERVER)(?:_|$)|^PG[A-Z_]+$|(?:AUTOMATION|PROTECTION).*BYPASS|NOTIFICATION.*ENCRYPTION|(?:^|_)(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS?)(?:_|$)/iu;
if(Object.keys(process.env).some(key=>sensitiveEnvironment.test(key)))throw Error('RELAY_INHERITED_AUTHORITY');
const config=JSON.parse(readFileSync(process.env.TIVDOC_DEV_RELAY_CONFIG_FILE??'','utf8')) as Record<string,string>;
const allowed=['RESEND_WEBHOOK_SECRET','TIVDOC_DEV_PREVIEW_SHARE_SECRET','TIVDOC_DEV_PREVIEW_ORIGIN',
 'TIVDOC_DEV_PREVIEW_SHARE_EXPIRES','TIVDOC_DEV_LOCAL_INGRESS_EXPIRES','TIVDOC_DEV_LOCAL_INGRESS_ENABLED'];
if(Object.keys(config).some(key=>!allowed.includes(key)))throw Error('RELAY_EXCESS_AUTHORITY');
const expires=Date.parse(config.TIVDOC_DEV_LOCAL_INGRESS_EXPIRES);
if(!Number.isFinite(expires)||expires<=Date.now()||expires>Date.now()+4*3600000)throw Error('RELAY_EXPIRY_REQUIRED');
let received=0,active=0,stopping=false;
const shutdown=new AbortController();
const transport:typeof fetch=(target,options)=>fetch(target,{...options,
 signal:AbortSignal.any([shutdown.signal,...(options?.signal?[options.signal]:[])]),
});
const stop=()=>{
 if(stopping)return;stopping=true;
 shutdown.abort();
 // close() alone drains active HTTP requests and can leave a share exchange
 // alive beyond the advertised TTL. Abort outbound calls and force-close the
 // inbound sockets before terminating this disposable process.
 server.close();server.closeAllConnections();process.exit(0);
};
const server=createServer(async(req,res)=>{
 if(Date.now()>=expires){stop();return;}
 if(received++>=100||active>=2){res.writeHead(429).end();return;}
 active++;
 try{
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>65536){res.writeHead(413).end();return;}chunks.push(chunk);}
  const headers=new Headers();for(const name of ['content-type','svix-id','svix-timestamp','svix-signature']){
   const value=req.headers[name];if(typeof value==='string')headers.set(name,value);
  }
  const request=new Request(new URL(req.url??'/','http://127.0.0.1:18763'),{method:req.method,headers,
   ...(req.method!=='GET'&&req.method!=='HEAD'?{body:Buffer.concat(chunks)}:{})});
  const result=await handleLocalDevResendIngress(request,{...config,NODE_ENV:process.env.NODE_ENV},transport);
  const text=await result.text();
  appendFileSync(process.env.TIVDOC_DEV_RELAY_RECEIPTS_FILE??'',JSON.stringify({at:new Date().toISOString(),status:result.status,
   eventId:typeof req.headers['svix-id']==='string'&&/^msg_[A-Za-z0-9]+$/.test(req.headers['svix-id'])?req.headers['svix-id']:null,
   accepted:result.status===200&&text.includes('"accepted":true')})+'\n');
  res.writeHead(result.status,{'content-type':'application/json','cache-control':'no-store'}).end(text);
 }catch{res.writeHead(500).end();}finally{active--;}
});
server.requestTimeout=10000;server.headersTimeout=10000;
server.listen(18763,'127.0.0.1',()=>console.log('LOCAL_DEV_RELAY_LISTENING'));
setTimeout(stop,Math.max(0,expires-Date.now()));
