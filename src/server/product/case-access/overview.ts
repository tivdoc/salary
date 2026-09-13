import {listCaseRequests,type StoredRequest} from '../reports/case-requests';
import {customerReports,type CustomerReports} from '../reports/customer-reports';
import {requestReadingCoverageIds} from '@/lib/request-reading-coverage';
import {realAiServiceCustomerEnabled,realAiServiceCustomerReports} from '../reports/real-ai-service-customer';
type RealReports=Awaited<ReturnType<typeof realAiServiceCustomerReports>>;
export type CaseOverview={requestsAvailable:boolean;openRequests:number|null;blocking:{id:string;question:string}|null;reportsAvailable:boolean;publishedReports:number|null;period:string|null};
export function overviewFrom(requests:PromiseSettledResult<readonly StoredRequest[]>,reports:PromiseSettledResult<CustomerReports>,now:number,realReports?:PromiseSettledResult<RealReports>):CaseOverview{
 const open=requests.status==='fulfilled'?requests.value.filter(r=>r.answered_at===null&&r.source_current!==false&&!r.not_required_for_current_review&&requestReadingCoverageIds(r).length===0&&!(r.document_upload_state?.state==='satisfied'&&r.document_upload_state.information_satisfied)&&Date.parse(r.expires_at)>now):null;
 const blocking=open?.find(r=>r.blocking)??null;
 const reportsAvailable=reports.status==='fulfilled'&&realReports?.status!=='rejected';
 const current=realReports?.status==='fulfilled'?realReports.value.filter(report=>report.current):[];
 const periods=new Set(current.map(report=>report.from.slice(0,7)===report.to.slice(0,7)?report.from.slice(0,7):null));
 // Discovery is metadata only. Every subsequent HTML/PDF read revalidates its
 // own authority; expired history is never counted as an available report.
 const publishedReports=reportsAvailable&&reports.status==='fulfilled'
  ?new Set([...reports.value.reports.map(report=>report.id),...current.map(report=>report.report_id)]).size:null;
 return {requestsAvailable:open!==null,openRequests:open?.length??null,blocking:blocking?{id:blocking.id,question:blocking.question}:null,
  reportsAvailable,publishedReports,period:reportsAvailable&&reports.status==='fulfilled'
   ?current.length?(periods.size===1?[...periods][0]:null):reports.value.checkPeriodMonth:null};
}
export async function loadCaseOverview(item:{case_id:string;public_id:string},identityId:string,sessionToken?:string|null){
 const realEnabled=realAiServiceCustomerEnabled();
 const [requests,reports,realReports]=await Promise.allSettled([
  listCaseRequests(item.case_id,undefined,identityId,sessionToken),customerReports(item.case_id,identityId,item.public_id),
  realEnabled?(async()=>{
   if(!sessionToken)throw Error('REAL_SERVICE_SESSION_REQUIRED');
   return realAiServiceCustomerReports({caseId:item.case_id,identityId,sessionToken});
  })():Promise.resolve([]),
 ]);
 return overviewFrom(requests,reports,Date.now(),realEnabled?realReports:undefined);
}
