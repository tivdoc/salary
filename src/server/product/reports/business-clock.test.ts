import {describe,it,expect} from 'vitest';
import {elapsedServiceMs,unionIntervals} from './business-clock';
const d=(s:string)=>Date.parse(s);
describe('P06 service time',()=>{
 it('counts overlap only once',()=>{expect(unionIntervals([{start:1,end:4},{start:2,end:8},{start:10,end:12}])).toEqual([{start:1,end:8},{start:10,end:12}]);expect(elapsedServiceMs(0,20,[{start:1,end:4},{start:2,end:8}], 'automatic')).toBe(13);});
 it('clips open blockers to the observed window',()=>{expect(elapsedServiceMs(5,20,[{start:1,end:10},{start:18,end:100}],'automatic')).toBe(8);});
 it('counts a full Jerusalem summer business day and excludes the weekend',()=>{expect(elapsedServiceMs(d('2026-09-03T06:00Z'),d('2026-09-06T14:00Z'),[],'human')).toBe(16*3600000);});
 it('excludes a holiday on an otherwise working Sunday',()=>{expect(elapsedServiceMs(d('2026-09-13T06:00Z'),d('2026-09-13T14:00Z'),[],'human')).toBe(0);});
 it('uses winter offset after DST and clips partial first/last days',()=>{expect(elapsedServiceMs(d('2026-10-25T07:00Z'),d('2026-10-25T15:00Z'),[],'human')).toBe(8*3600000);expect(elapsedServiceMs(d('2026-10-25T08:00Z'),d('2026-10-25T09:00Z'),[],'human')).toBe(3600000);});
 it('does not invent holidays outside the sourced calendar',()=>{expect(()=>elapsedServiceMs(d('2027-01-01'),d('2027-01-02'),[],'human')).toThrow('SLA_CALENDAR_UNAVAILABLE');});
});
