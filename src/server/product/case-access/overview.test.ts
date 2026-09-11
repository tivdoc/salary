import {describe,it,expect, vi } from 'vitest';
// Server adapter marker is mocked only in this hermetic test module.
vi.mock('server-only',()=>({}));
import {overviewFrom} from './overview';
import type {StoredRequest} from '../reports/case-requests';
const now=Date.parse('2026-09-07T09:00:00Z');
const request={id:'synthetic-request',case_id:'synthetic-case',code:'regular_day_hours_unknown',question:'Synthetic question',answer_kind:'number',field_crop:null,blocking:true,opened_at:'2026-09-01T09:00:00Z',expires_at:'2026-09-08T09:00:00Z',answered_at:null,answer_text:null} satisfies StoredRequest;
const emptyReports={status:'fulfilled',value:{caseId:'synthetic-case',publicId:'TV-SYNTH001',checkPeriodMonth:'2026-06',reports:[]}} as const;
describe('saved case overview',()=>{
 it('retains historical source questions without counting them as awaiting a response',()=>{expect(overviewFrom({status:'fulfilled',value:[{...request,source_current:false}]},{...emptyReports,value:{...emptyReports.value,reports:[]}},now).openRequests).toBe(0);});
 it('keeps a failed report read distinct from a successful empty list',()=>{expect(overviewFrom({status:'fulfilled',value:[]},{status:'rejected',reason:new Error('offline')},now).publishedReports).toBeNull();expect(overviewFrom({status:'fulfilled',value:[]},{...emptyReports,value:{...emptyReports.value,reports:[]}},now).publishedReports).toBe(0);});
 it('links the exact open blocking request and excludes expired or answered requests',()=>{const result=overviewFrom({status:'fulfilled',value:[{...request,id:'expired',expires_at:'2026-09-06T09:00:00Z'},{...request,id:'answered',answered_at:'2026-09-06T09:00:00Z'},request]},{...emptyReports,value:{...emptyReports.value,reports:[]}},now);expect(result.blocking?.id).toBe(request.id);expect(result.openRequests).toBe(1);});
 it('does not claim no requests when the store failed',()=>{const result=overviewFrom({status:'rejected',reason:new Error('store')},{...emptyReports,value:{...emptyReports.value,reports:[]}},now);expect(result.requestsAvailable).toBe(false);expect(result.openRequests).toBeNull();});
});
