import {afterEach,expect,it} from 'vitest';
import {formatRequestDate,formatRequestMonth} from './request-display';
const originalZone=process.env.TZ;
afterEach(()=>{if(originalZone===undefined)delete process.env.TZ;else process.env.TZ=originalZone;});
it('renders the Israeli calendar day identically on a UTC server and an Israeli browser across midnight',()=>{
 process.env.TZ='UTC';
 const server=formatRequestDate('2026-09-07T21:30:00Z');
 process.env.TZ='Asia/Jerusalem';
 const browser=formatRequestDate('2026-09-07T21:30:00Z');
 expect(server).toBe(browser);
 expect(server).toContain('8');
});

it('renders the saved month without changing precision or accepting an invalid month',()=>{
 process.env.TZ='Pacific/Honolulu';const west=formatRequestMonth('2025-01');
 process.env.TZ='Asia/Jerusalem';expect(formatRequestMonth('2025-01')).toBe(west);
 expect(west).toContain('2025');expect(()=>formatRequestMonth('2025-13')).toThrow('REQUEST_MONTH_INVALID');
});
