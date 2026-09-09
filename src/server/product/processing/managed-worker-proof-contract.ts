import {z} from 'zod';
import path from 'node:path';
export const managedProofManifestSchema=z.object({schema_version:z.literal('managed-dev-synthetic-proof-v1'),enabled:z.boolean(),run_id:z.uuid(),git_sha:z.string().regex(/^[a-f0-9]{40}$/u),
 worker_url:z.string(),capability:z.string().min(32).max(256),storage_url:z.literal('https://cpzrbidxftzqcfeqqusu.supabase.co'),storage_key:z.string().min(1),
 case_ids:z.array(z.uuid()).min(1).max(2),inputs:z.array(z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/u),missing_hours:z.boolean()}).strict()).length(2),
 notification_secret:z.string().refine(value=>Buffer.from(value,'base64').length===32),notification_origin:z.url().refine(value=>{const u=new URL(value);return u.protocol==='https:'&&u.hostname.endsWith('.vercel.app');}),notification_hold:z.boolean(),crash_after_claim_case:z.uuid().nullable(),
 fault:z.object({version_id:z.uuid(),limit:z.number().int().min(0).max(3)}).strict().nullable(),
}).strict();
export function managedProofPaths(runId?:string){
 if(runId)z.uuid().parse(runId);
 const root=path.resolve('../release-work');
 return {manifest:path.join(root,'managed-worker-proof-control.json'),receipts:runId?path.join(root,'managed-worker-proof',runId):null};
}
