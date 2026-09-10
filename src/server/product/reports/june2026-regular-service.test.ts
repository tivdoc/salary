import {randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {AnalysisResultBundle} from '@/engine/wave3/contracts';
import {createAdmissionTestFixture} from '@/engine/minimum-wage-june2026/evidence-admission.test-fixtures';
import {JUNE2026_COMPONENT_DECLARATIONS,JUNE2026_DECLARATION_OPTIONS} from '@/engine/minimum-wage-june2026/collection';
import {createRegularServiceTrustFixture} from '@/engine/minimum-wage-june2026/regular-service/regular-service.test-fixtures';
import {createJune2026RegularAuthority} from '@/engine/minimum-wage-june2026/regular-service/authority';
import {June2026RegularCatalog} from '@/engine/minimum-wage-june2026/regular-service/catalog';
import {June2026RegularExecutor} from '@/engine/minimum-wage-june2026/regular-service/executor';
import {June2026RegularReportBuilder} from './june2026-regular-service';
import {reportDocumentV3Schema} from './report-document';
vi.mock('server-only',()=>({}));

async function fixture(hours:string,recorded:number,reportKind?:'initial'|'full'){
 const f=createAdmissionTestFixture(false);
 for(const fact of f.facts.facts){
  if(fact.path==='work.regular_hours'&&fact.value)fact.value.amount=hours;
  if((fact.path==='compensation.base_monthly_salary'||fact.path==='compensation.gross_salary')&&fact.value)fact.value.minor_units=recorded;
 }
 for(const field of f.extraction.fields){
  if(field.field==='regular_hours')field.normalized_value={amount:hours,unit:'hours_per_month'};
  if(field.field==='base_monthly_salary'||field.field==='gross_salary')field.normalized_value={currency:'ILS',minor_units:recorded};
 }
 f.component.amount={currency:'ILS',minor_units:recorded};f.component.amount_raw=String(recorded/100);
 f.component.quantity=hours;f.component.quantity_raw=hours;
 f.component.source.text_fragment=`Synthetic documented regular pay ${recorded} minor units; ${hours} hours`;
 f.repin();const yes=JUNE2026_DECLARATION_OPTIONS[0],no=JUNE2026_DECLARATION_OPTIONS[1];
 f.addAnswer({kind:'applicability',field:'age_18_entire_month'},yes);f.addAnswer({kind:'applicability',field:'sector'},'Synthetic office employer');
 f.addAnswer({kind:'applicability',field:'hours_rest_law_applies'},'Synthetic ordinary supervised hourly worker');
 f.addAnswer({kind:'applicability',field:'no_better_minimum_wage_arrangement'},no);f.addAnswer({kind:'applicability',field:'no_adapted_minimum_wage'},no);
 f.addAnswer({kind:'applicability',field:'regular_hours_exclude_absence_overtime_rest'},yes);f.addAnswer({kind:'earnings_completeness'},yes);
 f.addAnswer({kind:'component',componentId:f.component.component_id},JUNE2026_COMPONENT_DECLARATIONS.base_salary);
 const packet=f.packet(),keys=createRegularServiceTrustFixture(),admitted=createJune2026RegularAuthority(keys.input(packet,f.facts));
 if(admitted.state!=='ready')throw Error(admitted.blockers.join(','));const authority=admitted.authority;
 const selection=await new June2026RegularCatalog(authority).resolve({mode:'synthetic_test',topic:'minimum_wage',target_date:'2026-06-30',as_of:'2026-09-10',sector:'general_private',population:'adult_general'});
 const executor=new June2026RegularExecutor({authority,packet,facts:f.facts});
 const execution=await executor.execute({selection,rule_input:packet.rule_input,execution_id:randomUUID(),calculated_at:keys.now});
 const seed:Omit<AnalysisResultBundle,'result_sha256'>={schema_version:'tivdoc-analysis-result-bundle-v0.6.0',analysis_run_id:f.facts.analysis_run_id,case_id:f.facts.case_id,
  case_revision:packet.current.input_revision,period:{start_date:'2026-06-01',end_date:'2026-06-30'},as_of:'2026-09-10',
  document_snapshot_sha256:f.checkpoint.input_sha256,extraction_snapshot_sha256:f.checkpoint.result_sha256,declared_fact_snapshot_sha256:canonicalSha256(f.collection),
  facts_snapshot_sha256:canonicalSha256(f.facts),facts:f.facts.facts,rule_inputs:[packet.rule_input],catalog_sha256:selection.catalog_sha256,
  topic_results:[{topic:'minimum_wage',status:execution.amount?'calculated':'not_applicable',blockers:[],rule_input_sha256:packet.rule_input.snapshot_sha256,
   amount:execution.amount,trace:execution.trace,legal_readiness:selection.readiness}],known_subtotal:execution.amount,coverage_complete:true};
 const bundle={...seed,result_sha256:canonicalSha256(seed)},builder=new June2026RegularReportBuilder({authority,executor,publicId:'TV-1234ABCD',offerSha256:'a'.repeat(64),reportKind});
 return {f,packet,authority,executor,bundle,builder};
}
// ActualText spans preserve their own spaces. Join directional runs on the
// same baseline directly; inserting spaces at every run invents "- 59.42".
function pdfText(bytes:Uint8Array){
 let previousY:string|null=null,text='';
 for(const match of Buffer.from(bytes).toString('latin1').matchAll(/\/ActualText <FEFF([0-9A-F]+)>[^\r\n]*?1 0 0 1 [-\d.]+ ([-\d.]+) Tm/gu)){
  if(previousY!==null&&previousY!==match[2])text+=' ';
  text+=String.fromCharCode(...match[1].match(/.{4}/gu)!.map(hex=>parseInt(hex,16)));previousY=match[2];
 }
 return text.replace(/\s+/gu,' ');
}

it.each([{hours:'100',paid:330000,expected:354058,gap:24058},{hours:'182',paid:644385,expected:644385,gap:0},{hours:'100',paid:360000,expected:354058,gap:-5942}])(
 'builds same-run ordinary envelope and exact HTML/PDF for signed gap $gap without inventing a debt for zero/negative',async vector=>{
 const f=await fixture(vector.hours,vector.paid),report=await f.builder.build(f.bundle),document=f.builder.document!;
 expect(f.executor.result!.comparison.expected.minor_units).toBe(vector.expected);expect(f.executor.result!.comparison.signed_difference.minor_units).toBe(vector.gap);
 expect(document.findings).toHaveLength(vector.gap>0?1:0);expect(document.execution_authority).toMatchObject({namespace:'isolated_test',real_legal_authority:false,
  human_report_approval:false,analysis_run_id:f.bundle.analysis_run_id,parent_facts_sha256:f.bundle.facts_snapshot_sha256});
 const json=JSON.parse(Buffer.from(report.json).toString('utf8')),html=Buffer.from(report.html).toString('utf8'),pdf=pdfText(report.pdf);
 expect(json.bundle).toEqual(f.bundle);expect(json.execution).toEqual(f.executor.result);expect(json.document).toEqual(document);
 for(const value of [f.bundle.analysis_run_id,f.authority.assessment.document_version_id,`${(vector.expected/100).toFixed(2)} ILS`,`${(vector.paid/100).toFixed(2)} ILS`,`${(vector.gap/100).toFixed(2)} ILS`]){
  expect(html).toContain(value);expect(pdf).toContain(value);
 }
 expect(html).toContain('אין אישור אדם אמיתי');expect(pdf).toContain('אין אישור אדם אמיתי');
 expect(await f.builder.build(f.bundle)).toEqual(report);
 // This validates ordinary delivery shape only; there is no DB publish call.
 expect(reportDocumentV3Schema.safeParse({...document,publication:{state:'published',approval_actor_kind:'automation',approved_input_sha256:document.input_sha256,published_at:'2026-09-10T16:00:00.000Z'}}).success).toBe(true);
 await expect(f.builder.build({...f.bundle,analysis_run_id:randomUUID()})).rejects.toThrow('REPORT_RUN_BINDING');
 expect(reportDocumentV3Schema.safeParse({...document,execution_authority:{...document.execution_authority,real_legal_authority:true}}).success).toBe(false);
 const {execution_authority:omitted,...legacy}=document;void omitted;
 expect(reportDocumentV3Schema.parse(legacy)).toEqual(legacy);
});

it('binds the full AI offer report kind without changing its execution or claiming human approval',async()=>{
 const f=await fixture('100',330000,'full'),report=await f.builder.build(f.bundle),document=f.builder.document!;
 expect(document.projection.report_kind).toBe('full');
 expect(JSON.parse(Buffer.from(report.json).toString('utf8')).document.projection.report_kind).toBe('full');
 expect(document.execution_authority?.human_report_approval).toBe(false);
 expect(reportDocumentV3Schema.safeParse({...document,publication:{state:'published',approval_actor_kind:'automation',approved_input_sha256:document.input_sha256,
  published_at:'2026-09-10T16:00:00.000Z'}}).success).toBe(true);
});
