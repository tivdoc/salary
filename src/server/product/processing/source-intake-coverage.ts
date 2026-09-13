import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import type {LegacyPaidScope} from '../orders/legacy-paid-receipt';
import {sourceIntakeFullMonths,type SavedLegacySourceIntake} from './saved-legacy-source-intake';

/** Diagnostic projection of authenticated readings. It grants no monthly scope
 * and deliberately leaves historical period-evidence/assessment bytes intact. */
export function sourceIntakeReadingCoverage(saved:SavedLegacySourceIntake,scope:LegacyPaidScope){
 if(scope.case_id!==saved.case_id||!saved.scopes.some(s=>s.id===scope.id&&s.receipt_sha256===scope.receipt_sha256))throw Error('SOURCE_INTAKE_SCOPE');
 return deepFreeze(saved.documents.map(d=>{
  const readings=saved.readings.filter(r=>r.target.order_id===scope.id&&r.target.order_receipt_sha256===scope.receipt_sha256
   &&r.target.product_document_id===d.id&&r.target.version_id===d.version_id&&r.target.source_sha256===d.sha256);
  const pin={document_id:d.id,version_id:d.version_id,source_sha256:d.sha256,reading_sha256s:readings.map(r=>r.reading_sha256).sort()};
  const common={schema_version:'source-intake-coverage-v1' as const,...pin};
  if(!readings.length)return {...common,state:'reading_required' as const,period:null,months:[],kind:null};
  if(new Set(readings.map(r=>canonicalSha256(r.answer))).size!==1)return {...common,state:'conflict' as const,period:null,months:[],kind:null};
  const answer=readings[0].answer;
  if(answer.action!=='correct')return {...common,state:answer.action,period:null,months:[],kind:null};
  const {period,document_kind:kind}=answer.value;
  const months=period?sourceIntakeFullMonths(period):[];
  const state=kind!=='payslip'&&kind!=='attendance'?'nonfinancial_source':!period?'period_not_printed':!months.length?'partial_period'
   :kind!==d.type&&kind!=='payslip'?'kind_dispatch_required':months.length!==1?'multi_month_dispatch_required':'single_month_identified';
  return {...common,state,period,months,kind};
 }));
}
export type SourceIntakeCoverage=ReturnType<typeof sourceIntakeReadingCoverage>[number];
