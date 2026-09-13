import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import type {DocumentReviewSource} from '../../document-review/calculations.ts';
import type {NormalizedDocumentEvidence} from '../../extraction/document-evidence/contracts.ts';
import type {SavedNonPayslipEvidence} from '../../extraction/document-evidence/snapshot.ts';
import type {PensionEntitlementInput} from './contracts.ts';
import {PENSION_SOURCE_FACTS_POLICY,pensionTablePercentSchema,type PensionSourceFacts} from './source-fact-contracts.ts';

type Observation=NormalizedDocumentEvidence['observations'][number];
type TableValue=NonNullable<NonNullable<PensionSourceFacts['arrangement_table']>['value']>;
const tidy=(text:string)=>text.trim().replace(/\s+/gu,' ');
const rowRole=(text:string)=>tidy(text)==='פנסיה'?'pension':tidy(text)==='פיצויים'?'severance':null;
const columnRole=(text:string)=>/^אחוז הפרשה של (?:העובד|העובדת)$/u.test(tidy(text))?'employee':/^אחוז הפרשה של (?:המעביד|המעסיק)$/u.test(tidy(text))?'employer':null;

/** Structural source mapping, not a sum-fit or a product classification. The
 * three cells are joined only by the provider's preserved page/block/row/column
 * identities. Every label and percentage must separately have an identified
 * reading. A blank employee severance cell is never a zero contribution. */
export function pensionTableSources(record:SavedNonPayslipEvidence,input:PensionEntitlementInput,base:Omit<DocumentReviewSource,'locator'|'label'|'page'|'reading'>){
 const e=record.extraction;if(!e)return [];
 const reads=new Map(record.readings.filter(r=>r.target.month===input.period.from.slice(0,7)).map(r=>[r.target.observation.observation_id,r]));
 const text=(o:Observation)=>{const r=reads.get(o.observation_id);return r?.state==='identified_reading'&&r.value?.kind==='text'?r.value.value:o.original.raw_value??'';};
 const groups=new Map<string,Observation[]>();
 for(const o of e.observations){const key=canonicalSha256({page:o.original.page,block:o.original.block_id});groups.set(key,[...(groups.get(key)??[]),o]);}
 const output:{fact:NonNullable<PensionSourceFacts['arrangement_table']>;pending:string[]}[]=[];
 for(const [groupKey,group]of groups){
  const labels=group.filter(o=>['source_label','clause_text'].includes(o.original.semantic));
  // A corrected label cannot silently make a previously selected source vanish.
  const rows=labels.filter(o=>rowRole(text(o))||rowRole(o.original.raw_value??''));
  const columns=labels.filter(o=>columnRole(text(o))||columnRole(o.original.raw_value??''));
  if(!rows.some(o=>rowRole(text(o))==='pension'||rowRole(o.original.raw_value??'')==='pension')||!rows.some(o=>rowRole(text(o))==='severance'||rowRole(o.original.raw_value??'')==='severance')||!columns.length)continue;
  const row=(role:'pension'|'severance')=>rows.filter(o=>rowRole(text(o))===role);
  const column=(role:'employee'|'employer')=>columns.filter(o=>columnRole(text(o))===role);
  const p=row('pension'),s=row('severance'),employee=column('employee'),employer=column('employer');
  let conflict=p.length!==1||s.length!==1||employee.length!==1||employer.length!==1||rows.length!==2||columns.length!==2;
  const cell=(r:Observation|undefined,c:Observation|undefined)=>!r||!c?[]:group.filter(o=>o.original.semantic==='percentage'&&o.original.row_id===r.original.row_id&&o.original.cell_id===c.original.cell_id);
  const ec=cell(p[0],employee[0]),mc=cell(p[0],employer[0]),sc=cell(s[0],employer[0]);
  conflict ||= !p[0]?.original.row_id||!s[0]?.original.row_id||p[0]?.original.row_id===s[0]?.original.row_id||employee[0]?.original.cell_id===employer[0]?.original.cell_id||[ec,mc,sc].some(c=>c.length!==1);
  const dates=group.filter(o=>['effective_from','effective_to'].includes(o.original.semantic));
  const selected=[...new Map([...rows,...columns,...ec,...mc,...sc,...dates].map(o=>[o.observation_id,o])).values()];
  conflict ||= selected.some(o=>o.issues.includes('duplicate_source_cell')||o.original.state==='conflict');
  const pending=selected.filter(o=>!reads.has(o.observation_id)&&o.original.state==='present'&&o.original.raw_value!==null).map(o=>o.observation_id);
  const negative=selected.map(o=>reads.get(o.observation_id)).filter(r=>r&&r.state!=='identified_reading');
  const identified=(o:Observation)=>reads.get(o.observation_id)?.state==='identified_reading';
  const labelsValid=[...rows,...columns].every(o=>{const r=reads.get(o.observation_id);return r?.state==='identified_reading'&&r.value?.kind==='text'&&!!(rowRole(r.value.value)||columnRole(r.value.value));});
  const percent=(o:Observation|undefined)=>{const r=o?reads.get(o.observation_id):null;return r?.state==='identified_reading'&&r.value?.kind==='percentage'&&pensionTablePercentSchema.safeParse(r.value.value).success?r.value.value:null;};
  const percentages=[percent(ec[0]),percent(mc[0]),percent(sc[0])];
  const numericIdentified=[...ec,...mc,...sc].every(identified);
  if(numericIdentified&&percentages.some(v=>v===null))conflict=true;
  const sourceGroup=canonicalSha256({groupKey,observations:selected.map(o=>({observation:o,reading:reads.get(o.observation_id)??null}))});
  const source:DocumentReviewSource={...base,page:group[0].original.page,locator:JSON.stringify({schema_version:PENSION_SOURCE_FACTS_POLICY,association:'identified_pension_table',block_id:group[0].original.block_id,source_group_sha256:sourceGroup}),
   label:'טבלת שיעורי הפרשה: כותרות שורות ועמודות ותאים מדויקים; המוצר הפנסיוני אינו מזוהה',reading:conflict||pending.length||negative.length||!labelsValid||!numericIdentified?'provider_extraction':'identified_document_reading'};
  const state=conflict?'conflict':negative.some(r=>r?.state==='unreadable')?'unreadable':pending.length||negative.length||!labelsValid||!numericIdentified?'unknown':'observed';
  if(state!=='observed'){output.push({fact:{state,value:null,source},pending:conflict?[]:pending});continue;}
  let period:{from:string;to:string}|null=null,temporal:TableValue['temporal_association']='unresolved';
  let temporalFact:string|null=null;
  const starts=dates.filter(o=>o.original.semantic==='effective_from'),ends=dates.filter(o=>o.original.semantic==='effective_to');
  const date=(o:Observation|undefined)=>{const r=o?reads.get(o.observation_id):null;return r?.state==='identified_reading'&&r.value?.kind==='iso_date'?r.value.value:null;};
  const from=date(starts[0]),to=date(ends[0]);
  if(dates.length){if(starts.length!==1||ends.length!==1||!from||!to||from>input.period.from||to<input.period.to)temporal='conflict';else{period={from,to};temporal='identified_source_dates';}}
  else{
   const f=input.product_facts?.contract_terms_changed;
   if(f){temporalFact=canonicalSha256(f);if(['observed','declared'].includes(f.state)&&f.source&&typeof f.value==='boolean'){
     // A date-specific factual answer stays a declaration. Source admission
     // verifies its exact period/file target; it grants no legal applicability.
     if(f.state!=='declared'||f.source.reading!=='customer_declaration')temporal='conflict';
     else if(f.value)temporal='change_reported';else{period={...input.period};temporal='declared_no_change';}
    }else if(['unknown','unreadable','stale','expired','conflict'].includes(f.state))temporal=f.state as 'unknown'|'unreadable'|'stale'|'expired'|'conflict';}
  }
  // A communicated change is not negated by a printed date range in the old
  // document. It stays visible even if later source reads identify those dates.
  const change=input.product_facts?.contract_terms_changed;
  if(change?.state==='declared'&&change.source?.reading==='customer_declaration'&&change.value===true){period=null;temporal='change_reported';temporalFact=canonicalSha256(change);}
  output.push({pending:[],fact:{state:'observed',source,value:{employee_percent:percentages[0]!,employer_percent:percentages[1]!,severance_percent:percentages[2]!,product:'unspecified_pension_product',source_group_sha256:sourceGroup,period,temporal_association:temporal,temporal_fact_sha256:temporalFact}}});
 }
 return output;
}
