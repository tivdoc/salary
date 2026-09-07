import {listCaseRequests,type StoredRequest} from '../reports/case-requests';
import {customerReports,type CustomerReports} from '../reports/customer-reports';
export type CaseOverview={requestsAvailable:boolean;openRequests:number|null;blocking:{id:string;question:string}|null;reportsAvailable:boolean;publishedReports:number|null;period:string|null};
export function overviewFrom(requests:PromiseSettledResult<readonly StoredRequest[]>,reports:PromiseSettledResult<CustomerReports>,now:number):CaseOverview{
 const open=requests.status==='fulfilled'?requests.value.filter(r=>r.answered_at===null&&Date.parse(r.expires_at)>now):null;
 const blocking=open?.find(r=>r.blocking)??null;
 return {requestsAvailable:open!==null,openRequests:open?.length??null,blocking:blocking?{id:blocking.id,question:blocking.question}:null,reportsAvailable:reports.status==='fulfilled',publishedReports:reports.status==='fulfilled'?reports.value.reports.length:null,period:reports.status==='fulfilled'?reports.value.checkPeriodMonth:null};
}
export async function loadCaseOverview(item:{case_id:string;public_id:string},identityId:string){const [requests,reports]=await Promise.allSettled([listCaseRequests(item.case_id),customerReports(item.case_id,identityId,item.public_id)]);return overviewFrom(requests,reports,Date.now());}
