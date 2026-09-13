import {beforeEach,describe,it,expect, vi } from 'vitest';
// Server adapter marker is mocked only in this hermetic test module.
vi.mock('server-only',()=>({}));
const ports=vi.hoisted(()=>({requests:vi.fn(),reports:vi.fn(),realEnabled:vi.fn(),realReports:vi.fn()}));
vi.mock('../reports/case-requests',()=>({listCaseRequests:ports.requests}));
vi.mock('../reports/customer-reports',()=>({customerReports:ports.reports}));
vi.mock('../reports/real-ai-service-customer',()=>({realAiServiceCustomerEnabled:ports.realEnabled,realAiServiceCustomerReports:ports.realReports}));
import {overviewFrom,loadCaseOverview} from './overview';
import type {StoredRequest} from '../reports/case-requests';
const now=Date.parse('2026-09-07T09:00:00Z');
const request={id:'synthetic-request',case_id:'synthetic-case',code:'regular_day_hours_unknown',question:'Synthetic question',answer_kind:'number',field_crop:null,blocking:true,opened_at:'2026-09-01T09:00:00Z',expires_at:'2026-09-08T09:00:00Z',answered_at:null,answer_text:null} satisfies StoredRequest;
const emptyReports={status:'fulfilled' as const,value:{caseId:'synthetic-case',publicId:'TV-SYNTH001',checkPeriodMonth:'2026-06',reports:[]}};
describe('saved case overview',()=>{
 it('counts both individual readings and no extra action for their fully covered generic question',()=>{
  const fields=[request,{...request,id:'second'}];
  const result=overviewFrom({status:'fulfilled',value:[...fields,{...request,id:'generic',covered_by_field_request_ids:fields.map(r=>r.id)}]},emptyReports,now);
  expect(result.openRequests).toBe(2);
  expect(overviewFrom({status:'fulfilled',value:[...fields,{...request,id:'generic',covered_by_field_request_ids:[]}]},emptyReports,now).openRequests).toBe(3);
 });
 it('counts one actionable cell instead of its covered duplicate or a retained question not required by the current review',()=>{
  const result=overviewFrom({status:'fulfilled',value:[request,{...request,id:'duplicate',covered_by_field_request_id:request.id},{...request,id:'deferred',not_required_for_current_review:true}]},emptyReports,now);
  expect(result.openRequests).toBe(1);expect(result.blocking?.id).toBe(request.id);
 });
 it('retains historical source questions without counting them as awaiting a response',()=>{expect(overviewFrom({status:'fulfilled',value:[{...request,source_current:false}]},{...emptyReports,value:{...emptyReports.value,reports:[]}},now).openRequests).toBe(0);});
 it('keeps a failed report read distinct from a successful empty list',()=>{expect(overviewFrom({status:'fulfilled',value:[]},{status:'rejected',reason:new Error('offline')},now).publishedReports).toBeNull();expect(overviewFrom({status:'fulfilled',value:[]},{...emptyReports,value:{...emptyReports.value,reports:[]}},now).publishedReports).toBe(0);});
 it('links the exact open blocking request and excludes expired or answered requests',()=>{const result=overviewFrom({status:'fulfilled',value:[{...request,id:'expired',expires_at:'2026-09-06T09:00:00Z'},{...request,id:'answered',answered_at:'2026-09-06T09:00:00Z'},request]},{...emptyReports,value:{...emptyReports.value,reports:[]}},now);expect(result.blocking?.id).toBe(request.id);expect(result.openRequests).toBe(1);});
 it('does not claim no requests when the store failed',()=>{const result=overviewFrom({status:'rejected',reason:new Error('store')},{...emptyReports,value:{...emptyReports.value,reports:[]}},now);expect(result.requestsAvailable).toBe(false);expect(result.openRequests).toBeNull();});
});

describe('authenticated REAL report overview',()=>{
 const item={case_id:'22222222-2222-4222-8222-222222222222',public_id:'TV-SYNTH001'};
 const identityId='11111111-1111-4111-8111-111111111111',sessionToken='synthetic-private-session-token';
 const report={report_id:'33333333-3333-4333-8333-333333333333',analysis_run_id:'private-synthetic-run',
  published_at:'2026-09-07T09:00:00Z',from:'2026-06-01',to:'2026-06-30',current:true,reason:null};
 beforeEach(()=>{
  vi.clearAllMocks();ports.requests.mockResolvedValue([]);ports.reports.mockResolvedValue(emptyReports.value);
  ports.realEnabled.mockReturnValue(true);ports.realReports.mockResolvedValue([report]);
 });
 it('uses the same authenticated case and cookie for current REAL metadata and exposes only its availability',async()=>{
  const result=await loadCaseOverview(item,identityId,sessionToken);
  expect(ports.realReports).toHaveBeenCalledExactlyOnceWith({caseId:item.case_id,identityId,sessionToken});
  expect(ports.requests).toHaveBeenCalledExactlyOnceWith(item.case_id,undefined,identityId,sessionToken);
  expect(result).toMatchObject({reportsAvailable:true,publishedReports:1,period:'2026-06'});
  const serialized=JSON.stringify(result);
  for(const privateValue of [sessionToken,report.report_id,report.analysis_run_id,item.case_id,identityId])expect(serialized).not.toContain(privateValue);
 });
 it.each(['absent','stale'] as const)('does not claim an available report for %s REAL metadata',async state=>{
  ports.realReports.mockResolvedValue(state==='absent'?[]:[{...report,current:false,reason:'revoked'}]);
  expect(await loadCaseOverview(item,identityId,sessionToken)).toMatchObject({reportsAvailable:true,publishedReports:0});
 });
 it.each(['database unavailable','REAL_SERVICE_SESSION_FORBIDDEN'] as const)('keeps failed or foreign REAL lookup unavailable: %s',async reason=>{
  ports.realReports.mockRejectedValue(Error(reason));
  const result=await loadCaseOverview(item,identityId,sessionToken);
  expect(result).toMatchObject({requestsAvailable:true,openRequests:0,reportsAvailable:false,publishedReports:null,period:null});
  expect(JSON.stringify(result)).not.toContain(reason);
 });
 it('does not substitute identity membership for a missing durable cookie',async()=>{
  expect(await loadCaseOverview(item,identityId,null)).toMatchObject({reportsAvailable:false,publishedReports:null});
  expect(ports.realReports).not.toHaveBeenCalled();
 });
 it('preserves historical behavior with REAL disabled without reading REAL data',async()=>{
  ports.realEnabled.mockReturnValue(false);
  expect(await loadCaseOverview(item,identityId)).toMatchObject({reportsAvailable:true,publishedReports:0,period:'2026-06'});
  expect(ports.realReports).not.toHaveBeenCalled();
 });
 it('does not count repeated current metadata twice or let stale history replace its period',async()=>{
  ports.realReports.mockResolvedValue([report,report,{...report,report_id:'44444444-4444-4444-8444-444444444444',from:'2026-05-01',to:'2026-05-31',current:false}]);
  expect(await loadCaseOverview(item,identityId,sessionToken)).toMatchObject({publishedReports:1,period:'2026-06'});
 });
 it('does not choose one month when several current REAL periods are available',async()=>{
  ports.realReports.mockResolvedValue([report,{...report,report_id:'44444444-4444-4444-8444-444444444444',from:'2026-05-01',to:'2026-05-31'}]);
  expect(await loadCaseOverview(item,identityId,sessionToken)).toMatchObject({publishedReports:2,period:null});
 });
});
