import {describe,it,expect} from 'vitest';
import {reconcileLeaveLedger,type LeaveLedgerEntry} from './period-ledger';
const row:LeaveLedgerEntry={case_id:'00000000-0000-4000-8000-000000000001',employment_id:'job1',topic:'sick_leave',month:'2025-12',unit:'workdays_hundredths',opening:100,accrued:150,used:0,closing:250,evidence_ids:['doc1:p1']};
describe('leave ledger across months',()=>{
 it('carries December to January without treating balance as payment',()=>expect(reconcileLeaveLedger([row,{...row,month:'2026-01',opening:250,closing:400}]).complete).toBe(true));
 it.each([['opening',300,'ledger_arithmetic_conflict'],['closing',null,'ledger_missing_fact']] as const)('preserves %s issue', (field,value,code)=>expect(reconcileLeaveLedger([{...row,[field]:value}]).issues.map(i=>i.code)).toContain(code));
 it('retains both contradictory sources for a month',()=>{const r=reconcileLeaveLedger([row,{...row,closing:300,evidence_ids:['doc2:p1']}]);expect(r.entries).toHaveLength(2);expect(r.issues.map(i=>i.code)).toContain('ledger_duplicate_month');});
 it('rejects missing months and different units',()=>{const r=reconcileLeaveLedger([row,{...row,month:'2026-02',unit:'hours_hundredths'}]);expect(r.issues.map(i=>i.code)).toEqual(expect.arrayContaining(['ledger_missing_month','ledger_unit_conflict']));});
 it('refuses another case',()=>expect(()=>reconcileLeaveLedger([row,{...row,case_id:'00000000-0000-4000-8000-000000000002'}])).toThrow('LEDGER_SCOPE'));
});
