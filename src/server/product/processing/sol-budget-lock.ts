import {createHash,randomUUID} from 'node:crypto';
import {openSync,closeSync,writeFileSync,readFileSync,unlinkSync,fsyncSync,existsSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {parseSolComparisonLedger} from './live-extraction-sol-comparison-budget';

const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const lockSchema=z.object({version:z.literal('sol-budget-lock-v1'),pid:z.number().int().positive(),nonce:z.uuid(),
 createdAt:z.iso.datetime(),expiresAt:z.iso.datetime({offset:true}),codeRevision:z.string().regex(/^[a-f0-9]{40}$/u),ledgerPathSha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
function processAlive(pid:number){try{process.kill(pid,0);return true;}catch(error){return !(error!==null&&typeof error==='object'&&'code' in error&&error.code==='ESRCH');}}

export function acquireSolBudgetLock(input:{ledgerPath:string;codeRevision:string;expiresAt?:string}){
 const file=input.ledgerPath+'.lock';
 if(existsSync(file+'.recovery'))throw Error('SOL_LEDGER_RECOVERY_ACTIVE');
 const metadata=lockSchema.parse({version:'sol-budget-lock-v1',pid:process.pid,nonce:randomUUID(),createdAt:new Date().toISOString(),
  expiresAt:input.expiresAt??new Date(Date.now()+4*3600000).toISOString(),codeRevision:input.codeRevision,ledgerPathSha256:hash(path.resolve(input.ledgerPath))});
 const fd=openSync(file,'wx');let closed=false;
 try{writeFileSync(fd,JSON.stringify(metadata)+'\n');fsyncSync(fd);}catch(error){closeSync(fd);throw error;}
 return {metadata,close(){
  if(closed)return;closed=true;closeSync(fd);
  const current=lockSchema.parse(JSON.parse(readFileSync(file,'utf8')));
  if(current.nonce!==metadata.nonce||current.pid!==process.pid||current.ledgerPathSha256!==metadata.ledgerPathSha256)throw Error('SOL_LEDGER_LOCK_OWNERSHIP_CHANGED');
  unlinkSync(file);
 }};
}

/** Explicit owner operation only. The caller rechecks its disabled private
 * package before mutation. A recovery gate serializes other owner recoveries
 * and blocks new lock acquisition while the old lock is being inspected.
 * Unknown provider outcomes are never made retryable by deleting a lock. */
export function recoverStaleSolBudgetLock(input:{ledgerPath:string;expectedLockSha256:string;expectedLedgerSha256:string;assertOwnerPaused:()=>void}){
 const digest=z.string().regex(/^[a-f0-9]{64}$/u);digest.parse(input.expectedLockSha256);digest.parse(input.expectedLedgerSha256);
 input.assertOwnerPaused();
 const file=input.ledgerPath+'.lock',gate=file+'.recovery',nonce=randomUUID(),fd=openSync(gate,'wx');
 const gateBody=JSON.stringify({pid:process.pid,nonce});
 try{
  writeFileSync(fd,gateBody);fsyncSync(fd);
  const lockBytes=readFileSync(file),ledgerBytes=readFileSync(input.ledgerPath);
  if(hash(lockBytes)!==input.expectedLockSha256||hash(ledgerBytes)!==input.expectedLedgerSha256)throw Error('SOL_LEDGER_RECOVERY_HASH_MISMATCH');
  const lock=lockSchema.parse(JSON.parse(lockBytes.toString('utf8')));
  if(lock.ledgerPathSha256!==hash(path.resolve(input.ledgerPath)))throw Error('SOL_LEDGER_RECOVERY_PATH_MISMATCH');
  if(processAlive(lock.pid))throw Error('SOL_LEDGER_OWNER_STILL_RUNNING');
  const ledger=parseSolComparisonLedger(JSON.parse(ledgerBytes.toString('utf8')));
  if(ledger.reservations.some(row=>row.outcome==='reserved_unknown'))throw Error('SOL_UNKNOWN_OUTCOME_REQUIRES_REVIEW');
  input.assertOwnerPaused();
  if(!readFileSync(file).equals(lockBytes)||!readFileSync(input.ledgerPath).equals(ledgerBytes))throw Error('SOL_LEDGER_RECOVERY_HASH_MISMATCH');
  const receipt={version:'sol-budget-lock-recovery-v1',at:new Date().toISOString(),previousPid:lock.pid,previousNonce:lock.nonce,
   lockSha256:input.expectedLockSha256,ledgerSha256:input.expectedLedgerSha256,ledgerChanged:false,providerCalls:0};
  // Retain the reviewed metadata before releasing the stale lock. No ledger
  // byte, provider reservation or source receipt is rewritten.
  writeFileSync(file+'.recovered-'+nonce+'.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});unlinkSync(file);
  return {state:'recovered' as const,...receipt};
 }finally{
  closeSync(fd);try{if(readFileSync(gate,'utf8')===gateBody)unlinkSync(gate);}catch{/* Changed gate ownership remains blocked. */}
 }
}
