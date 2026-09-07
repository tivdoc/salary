import {describe,it,expect} from 'vitest';import {summarizeMonitor} from './monitor';import {SERVICE_CALENDAR_2026} from './business-clock';
const empty={schema_version:'tivdoc-monitor-v1',observed_at:'2026-09-07T10:00:00Z',population:'all_operational_records_including_qa',alerts:[],clocks:[],clocks_total:0,storage_integrity:'not_measured',provider_cost:'not_measured'};
describe('operational monitor',()=>{
 it('rejects missing DB evidence instead of claiming healthy',()=>{expect(()=>summarizeMonitor(null,{})).toThrow();});
 it('subtracts overlapping SLA pauses only once',()=>{const result=summarizeMonitor({...empty,clocks_total:1,clocks:[{order_id:'11111111-1111-4111-8111-111111111111',started_at:'2026-09-07T09:00:00Z',track:'automatic',budget_ms:45*60000,calendar:SERVICE_CALENDAR_2026,pauses:[{start:'2026-09-07T09:05:00Z',end:'2026-09-07T09:15:00Z'},{start:'2026-09-07T09:10:00Z',end:'2026-09-07T09:20:00Z'}]}]},{});expect(result.clocks.overdue).toBe(1);});
 it('keeps unknown calendar and bounded scan explicit',()=>{const result=summarizeMonitor({...empty,observed_at:'2027-01-04T10:00:00Z',clocks_total:2,clocks:[{order_id:'11111111-1111-4111-8111-111111111111',started_at:'2027-01-04T09:00:00Z',track:'human',budget_ms:3600000,calendar:SERVICE_CALENDAR_2026,pauses:[]}]},{});expect(result.clocks).toMatchObject({unknown:1,complete:false,overdue:0});});
});
