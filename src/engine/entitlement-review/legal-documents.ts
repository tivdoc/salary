import {minimumWageLegalDocuments} from './minimum-wage/index.ts';
import {convalescenceLegalDocuments} from './convalescence/index.ts';
import {TRAVEL_LEGAL_MANIFEST,TRAVEL_SOURCE_REVIEW_SHA256} from './travel/index.ts';
import {VACATION_LEGAL_MANIFEST,VACATION_SOURCE_REVIEW_SHA256} from './vacation/index.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {nightEntitlementReviewDocument,isPinnedNightEntitlementLegalDocument} from '../document-review/night-entitlement-adapter.ts';
import type {ReviewDocument} from '../document-review/contracts.ts';
import {workingTimeLegalDocuments} from './working-time/source-policy.ts';
import {PENSION_SOURCES,PENSION_SOURCE_REVIEW_SHA256} from './pension/sources.ts';

/** Compiled source pins. Shared historical law bytes retain every admitted
 * reading policy; this does not admit arbitrary source-research documents. */
export function entitlementLegalDocuments(caseId:string,topics:readonly string[]=['working_time','pension','minimum_wage','travel','vacation','convalescence']):ReviewDocument[]{
 const pension:ReviewDocument[]=Object.values(PENSION_SOURCES).map(s=>({case_id:caseId,document_id:s.document_id,
  version_id:s.version_id,file_sha256:s.file_sha256,page_count:s.page_count,kind:'other',
  label:'מקור לחישוב פנסיה — הוראות ופרמטרים לתקופה',period:null,reading_origin:'ai_document_review',reading_sha256:PENSION_SOURCE_REVIEW_SHA256}));
 const mapped=(pins:typeof TRAVEL_LEGAL_MANIFEST,reading:string,label:string):ReviewDocument[]=>pins.map(p=>({case_id:caseId,document_id:p.document_id,version_id:p.version_id,file_sha256:p.file_sha256,page_count:p.page_count,kind:'other',label,period:null,reading_origin:'ai_document_review',reading_sha256:reading}));
 const result:ReviewDocument[]=topics.includes('convalescence')?convalescenceLegalDocuments(caseId):[];
 for(const doc of [...(topics.includes('working_time')?[nightEntitlementReviewDocument(caseId),...workingTimeLegalDocuments(caseId)]:[]),...(topics.includes('pension')?pension:[]),...(topics.includes('minimum_wage')?minimumWageLegalDocuments(caseId):[]),...(topics.includes('travel')?mapped(TRAVEL_LEGAL_MANIFEST,TRAVEL_SOURCE_REVIEW_SHA256,'צו החזר הוצאות נסיעה — מקור לחישוב'):[]),...(topics.includes('vacation')?mapped(VACATION_LEGAL_MANIFEST,VACATION_SOURCE_REVIEW_SHA256,'חוק חופשה שנתית והתיקונים שנבדקו'):[])]){
  const existing=result.find(d=>d.document_id===doc.document_id);
  if(!existing){result.push(doc);continue;}
  if(existing.version_id!==doc.version_id||existing.file_sha256!==doc.file_sha256||existing.page_count!==doc.page_count)throw Error('ENTITLEMENT_COMPILED_SOURCE_COLLISION');
  existing.accepted_reading_sha256=[...new Set([existing.reading_sha256,...(existing.accepted_reading_sha256??[]),doc.reading_sha256,...(doc.accepted_reading_sha256??[])])].sort();
 }
 return result;
}
export function isPinnedEntitlementLegalDocument(candidate:unknown,caseId:string):boolean{
 return isPinnedNightEntitlementLegalDocument(candidate,caseId)||entitlementLegalDocuments(caseId).some(d=>canonicalSha256(d)===canonicalSha256(candidate));
}
