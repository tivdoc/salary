import {it,expect} from 'vitest';
import {documentCapacity,uploadMonthOptions} from './document-capacity';
it('retains the legacy quota until the server supplies a paid scope',()=>{
 expect(documentCapacity(undefined)).toMatchObject({maxPayslips:12,maxCaseBytes:26214400,paidMonths:[]});
 expect(()=>documentCapacity({maxPayslips:600})).toThrow();
});
it('accepts server paid-period capacity while keeping batches bounded',()=>{
 const quota=documentCapacity({maxPayslips:120,maxCaseBytes:122*10485760,paidMonths:['2015-01','2015-02'],maxBatchFiles:14,maxBatchBytes:26214400});
 expect(quota.maxPayslips).toBe(120);expect(quota.maxBatchFiles).toBe(14);
 expect(uploadMonthOptions(quota,['2026-08'],['2015-02','2020-01',null])).toEqual(['2026-08','2020-01','2015-02','2015-01']);
 expect(()=>documentCapacity({...quota,maxPayslips:601})).toThrow();
 expect(()=>documentCapacity({...quota,maxBatchBytes:999999999})).toThrow();
});
