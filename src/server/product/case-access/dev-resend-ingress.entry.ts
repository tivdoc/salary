import type {IncomingMessage,ServerResponse} from 'node:http';
import {handleDevResendIngress} from './dev-resend-ingress.ts';
/** Build only into the separate public DEV ingress project. */
export default async function handler(req:IncomingMessage,res:ServerResponse){
 try{
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){const bytes=Buffer.from(chunk);size+=bytes.length;
   if(size>65536){res.writeHead(413,{'content-type':'application/json','cache-control':'no-store'});res.end('{"code":"body_too_large"}');return;}chunks.push(bytes);}
  const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);
  const method=req.method??'GET';
  const result=await handleDevResendIngress(new Request(`https://dev-ingress.invalid${req.url??'/'}`,{
   method,headers,...(!['GET','HEAD'].includes(method)?{body:Buffer.concat(chunks)}:{}),
  }),process.env);
  res.writeHead(result.status,Object.fromEntries(result.headers.entries()));res.end(await result.text());
 }catch{res.writeHead(503,{'content-type':'application/json','cache-control':'no-store'});res.end('{"code":"ingress_unavailable"}');}
}
