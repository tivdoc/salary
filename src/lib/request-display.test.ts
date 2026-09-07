import {afterEach,expect,it} from 'vitest';
import {formatRequestDate} from './request-display';
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
