import {canonicalSha256} from '../rule-runtime/canonical.ts';
import type {NormalizedPayslipExtraction} from './payslip.ts';
import type {CustomerSourceStructureReading} from './source-structure.ts';
import {parseSourceStructureReadingValue,sourceStructureRef,type SourceStructureSelector} from './source-structure-resolution.ts';
import {mappedRowCellCandidate} from './reading-resolution.ts';

type Ref={kind:'field'|'component';id:string};
/** Reads separately authenticated metadata. It never rewrites a provider
 * SourceScope, confirms a number, or overrides an explicit conflicting label. */
export function payslipSourcePeriod(input:{original:NormalizedPayslipExtraction;structureReadings:ReadonlyMap<string,CustomerSourceStructureReading>;ref:Ref;period:{from:string;to:string}}){
 const ref=sourceStructureRef(input.original,input.ref),known=ref.source.source_scope?.period_kind;
 const matches=[...input.structureReadings.values()].filter(r=>r.subject.kind==='period_association'&&r.subject.refs.some(x=>x.kind===ref.kind&&x.id===ref.id));
 if(matches.length>1)return {state:'conflict' as const,reading:null};
 if(!matches.length)return {state:known==='current'?'current' as const:known&&known!=='unknown'?'other' as const:'missing' as const,reading:null};
 const {reading,subject,normalized_value:value}=parseSourceStructureReadingValue(matches[0]);
 if(subject.kind!=='period_association'||value.kind!=='period_association')throw Error('SOURCE_PERIOD_READING_KIND');
 const bound=subject.refs.find(r=>r.kind===ref.kind&&r.id===ref.id);
 if(!bound||canonicalSha256(bound)!==canonicalSha256(ref))throw Error('SOURCE_PERIOD_READING_REF_CHANGED');
 const current=value.period_kind==='current'&&value.period.from===input.period.from&&value.period.to===input.period.to;
 if(subject.refs.some(r=>{const label=r.source.source_scope?.period_kind;return label&&label!=='unknown'&&(label!==value.period_kind||label==='current'&&!current);}))return {state:'conflict' as const,reading};
 return {state:current?'current' as const:'other' as const,reading};
}
/** Only exact missing-metadata observations become selectable. Mapped cells
 * share a question only when the existing physical row mapper binds them. */
export function missingSourcePeriodSelector(extraction:NormalizedPayslipExtraction,ref:Ref):Extract<SourceStructureSelector,{kind:'period_association'}>|null{
 const original=sourceStructureRef(extraction,ref),kind=original.source.source_scope?.period_kind;
 if(kind&&kind!=='unknown')return null;
 if(ref.kind==='field'){
  const rows=extraction.additional_components.filter(row=>['quantity','rate','amount','percentage'].some(cell=>mappedRowCellCandidate({fields:extraction.fields,row,cell:cell as 'quantity'|'rate'|'amount'|'percentage'})?.candidate_id===ref.id));
  if(rows.length===1&&rows[0].source.page===original.source.page&&(!rows[0].source.source_scope||rows[0].source.source_scope.period_kind==='unknown'))return missingSourcePeriodSelector(extraction,{kind:'component',id:rows[0].component_id});
 }
 const refs:Ref[]=[ref];
 if(ref.kind==='component'){
  const row=extraction.additional_components.find(r=>r.component_id===ref.id)!;
  for(const cell of ['quantity','rate','amount','percentage'] as const){
   const field=mappedRowCellCandidate({fields:extraction.fields,row,cell});
   if(field&&field.source.page===original.source.page&&(!field.source.source_scope||field.source.source_scope.period_kind==='unknown'))refs.push({kind:'field',id:field.candidate_id});
  }
 }
 const unique=[...new Map(refs.map(r=>[r.kind+':'+r.id,r])).values()].sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
 return {kind:'period_association',refs:unique};
}
