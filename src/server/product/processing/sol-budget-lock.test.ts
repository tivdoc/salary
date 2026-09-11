import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {acquireSolBudgetLock,recoverStaleSolBudgetLock} from './sol-budget-lock';
import {newSolComparisonLedger,reserveSolRequest} from './live-extraction-sol-comparison-budget';
vi.mock('server-only',()=>({}));
const owned:string[]=[];const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
afterEach(()=>{for(const directory of owned.splice(0)){expect(path.dirname(path.resolve(directory))).toBe(path.resolve(tmpdir()));expect(path.basename(directory)).toMatch(/^tivdoc-sol-lock-/u);rmSync(directory,{recursive:true,force:true});}});
function fixture(){
 const directory=mkdtempSync(path.join(tmpdir(),'tivdoc-sol-lock-'));owned.push(directory);const ledgerPath=path.join(directory,'ledger.json');
 writeFileSync(ledgerPath,JSON.stringify(newSolComparisonLedger()));
 const options={ledgerPath,codeRevision:'a'.repeat(40),expiresAt:new Date(Date.now()+60000).toISOString()};
 const dead=spawnSync(process.execPath,['-e','process.exit(0)'],{windowsHide:true});expect(dead.status).toBe(0);
 const metadata={version:'sol-budget-lock-v1',pid:dead.pid,nonce:randomUUID(),createdAt:new Date().toISOString(),expiresAt:options.expiresAt,codeRevision:options.codeRevision,ledgerPathSha256:hash(path.resolve(ledgerPath))};
 const paused=vi.fn();
 const stale=()=>writeFileSync(ledgerPath+'.lock',JSON.stringify(metadata));
 const recover=()=>recoverStaleSolBudgetLock({ledgerPath,expectedLockSha256:hash(readFileSync(ledgerPath+'.lock')),expectedLedgerSha256:hash(readFileSync(ledgerPath)),assertOwnerPaused:paused});
 return {directory,ledgerPath,options,metadata,paused,stale,recover};
}
describe('explicit Sol budget lock ownership and owner recovery',()=>{
 it('persists process/nonce/expiry and releases only its own lock without changing the ledger',()=>{
  const f=fixture(),before=readFileSync(f.ledgerPath),lock=acquireSolBudgetLock(f.options),stored=JSON.parse(readFileSync(f.ledgerPath+'.lock','utf8'));
  expect(stored).toMatchObject({version:'sol-budget-lock-v1',pid:process.pid,expiresAt:f.options.expiresAt});expect(stored.nonce).toBe(lock.metadata.nonce);
  expect(()=>acquireSolBudgetLock(f.options)).toThrow();lock.close();lock.close();expect(existsSync(f.ledgerPath+'.lock')).toBe(false);expect(readFileSync(f.ledgerPath)).toEqual(before);
 });
 it('does not remove another nonce when a caller loses lock ownership',()=>{
  const f=fixture(),lock=acquireSolBudgetLock(f.options),foreign={...lock.metadata,nonce:randomUUID()};writeFileSync(f.ledgerPath+'.lock',JSON.stringify(foreign));
  expect(()=>lock.close()).toThrow('SOL_LEDGER_LOCK_OWNERSHIP_CHANGED');expect(JSON.parse(readFileSync(f.ledgerPath+'.lock','utf8'))).toEqual(foreign);
 });
 it('allows a hash-bound dead-owner recovery only with the package paused and preserves every ledger byte',()=>{
  const f=fixture();f.stale();const before=readFileSync(f.ledgerPath),result=f.recover();
  expect(result).toMatchObject({state:'recovered',previousPid:f.metadata.pid,ledgerChanged:false,providerCalls:0});expect(f.paused).toHaveBeenCalledTimes(2);
  expect(readFileSync(f.ledgerPath)).toEqual(before);expect(existsSync(f.ledgerPath+'.lock')).toBe(false);expect(readdirSync(f.directory).some(name=>name.includes('.recovered-'))).toBe(true);
 });
 it('refuses a live owner, even if the lock time has expired',()=>{
  const f=fixture();f.metadata.pid=process.pid;f.metadata.expiresAt='2000-01-01T00:00:00Z';f.stale();
  expect(()=>f.recover()).toThrow('SOL_LEDGER_OWNER_STILL_RUNNING');expect(existsSync(f.ledgerPath+'.lock')).toBe(true);
 });
 it('retains an unknown reservation after process death for provider reconciliation',()=>{
  const f=fixture();f.stale();const ledger=reserveSolRequest({ledger:newSolComparisonLedger(),kind:'input_tokens',sourceSha256:'b'.repeat(64),requestSha256:'c'.repeat(64),codeRevision:'a'.repeat(40),attempt:1,now:'2026-09-11T00:30:00Z'});writeFileSync(f.ledgerPath,JSON.stringify(ledger));
  const before=readFileSync(f.ledgerPath);expect(()=>f.recover()).toThrow('SOL_UNKNOWN_OUTCOME_REQUIRES_REVIEW');expect(readFileSync(f.ledgerPath)).toEqual(before);expect(existsSync(f.ledgerPath+'.lock')).toBe(true);
 });
 it('refuses stale observed hashes and a package re-enabled during recovery',()=>{
  const f=fixture();f.stale();expect(()=>recoverStaleSolBudgetLock({ledgerPath:f.ledgerPath,expectedLockSha256:'f'.repeat(64),expectedLedgerSha256:hash(readFileSync(f.ledgerPath)),assertOwnerPaused:f.paused})).toThrow('SOL_LEDGER_RECOVERY_HASH_MISMATCH');
  f.paused.mockImplementationOnce(()=>{}).mockImplementationOnce(()=>{throw Error('OWNER_NOT_PAUSED');});expect(()=>f.recover()).toThrow('OWNER_NOT_PAUSED');expect(existsSync(f.ledgerPath+'.lock')).toBe(true);
 });
 it('does not acquire a new processing lock while an owner recovery gate exists',()=>{
  const f=fixture();writeFileSync(f.ledgerPath+'.lock.recovery','retained-owner-recovery');
  expect(()=>acquireSolBudgetLock(f.options)).toThrow('SOL_LEDGER_RECOVERY_ACTIVE');expect(readFileSync(f.ledgerPath+'.lock.recovery','utf8')).toBe('retained-owner-recovery');
 });
});
