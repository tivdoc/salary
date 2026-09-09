import {describe,it,expect} from 'vitest';
import {PDFDocument} from 'pdf-lib';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {CanonicalFact} from '@/engine/facts/contracts';
import {employmentSnapshotSchema,type EmploymentSnapshot} from '@/engine/facts/snapshot';
import {calculateDevMinimumWage,DEV_MINIMUM_WAGE_POLICY} from '@/engine/calculations/dev-minimum-wage';
import {devArtifactSha,renderDevFinancialArtifacts} from '../reports/dev-financial-artifacts';
import {savedMonthIdempotencyKey} from './saved-order-scope';
import {DEV_FINANCIAL_SCHEMA,DEV_FINANCIAL_DISCLOSURE,devFinancialFacts,devFinancialFinding,
 devHoursReadingSchema,parseDevFinancialRun,type DevHoursReading} from './dev-financial-contract';

// Independent in-memory synthetic input. The tested domain calculation creates
// the result and finding; this fixture never seeds a saved report or finding.
// It proves contract/rendering behavior only, not DB authority or PDF OCR.
const id={
 case:'11111111-1111-4111-8111-111111111111',parent:'22222222-2222-4222-8222-222222222222',
 source:'33333333-3333-4333-8333-333333333333',snapshot:'44444444-4444-4444-8444-444444444444',
 hours:'55555555-5555-4555-8555-555555555555',base:'66666666-6666-4666-8666-666666666666',
 period:'77777777-7777-4777-8777-777777777777',salaryType:'88888888-8888-4888-8888-888888888888',
 order:'99999999-9999-4999-8999-999999999999',run:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 request:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',identity:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
 document:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',other:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
} as const;
const now='2026-09-09T12:00:00Z';
const sourceHash='1'.repeat(64),checkpointHash='2'.repeat(64),inputHash='3'.repeat(64),parentResultHash='4'.repeat(64);
function parentFixture():EmploymentSnapshot{
 const documented=(page:number)=>[{source_type:'documented',source_reference:{kind:'document',document_id:id.source,
  locator:{page,text_span:'SYNTHETIC ENGINEERING CASE'}},read_by:'machine',verified:false}];
 const common={case_id:id.case,status:'confirmed',confidence:0.99,conflicting_fact_ids:[],resolution:null,created_at:now};
 return employmentSnapshotSchema.parse({snapshot_id:id.snapshot,case_id:id.case,analysis_run_id:id.parent,schema_version:'1.0.0',created_at:now,facts:[
  {...common,fact_id:id.hours,path:'work.regular_hours',value:{amount:'100',unit:'hours_per_month'},provenance:documented(2)},
  {...common,fact_id:id.base,path:'compensation.base_monthly_salary',value:{currency:'ILS',minor_units:330000},provenance:documented(3)},
  {...common,fact_id:id.salaryType,path:'compensation.salary_type',value:'hourly',provenance:documented(1)},
  {...common,fact_id:id.period,path:'documents.period',value:{document_id:id.source,period:{start_date:'2026-06-01',end_date:'2026-06-30'}},provenance:documented(1)},
 ]});
}
function changeFact(parent:EmploymentSnapshot,path:CanonicalFact['path'],patch:Record<string,unknown>):EmploymentSnapshot{
 return employmentSnapshotSchema.parse({...parent,facts:parent.facts.map(fact=>fact.path===path?{...fact,...patch}:fact)});
}
function missingHours(parent=parentFixture()){
 return changeFact(parent,'work.regular_hours',{status:'missing',value:null});
}
function reading():DevHoursReading{
 return {request_id:id.request,answer_revision:1,identity_id:id.identity,answered_at:now,answer:'100',version_id:id.source,checkpoint_sha256:checkpointHash};
}
function candidate(options:{parent?:EmploymentSnapshot;reading?:DevHoursReading|null;runId?:string;revision?:number}={}){
 const parent=options.parent??parentFixture(),runId=options.runId??id.run,answer=options.reading??null,revision=options.revision??1;
 const facts=devFinancialFacts(parent,runId,answer),calculation=calculateDevMinimumWage({facts,month:'2026-06',calculatedAt:now});
 const job={schema_version:'saved-case-work-v1' as const,case_id:id.case,revision,input_sha256:inputHash,mode:'draft' as const};
 return {schema_version:DEV_FINANCIAL_SCHEMA,authority:'engineering_only' as const,run_id:runId,case_id:id.case,public_id:'TV-1234ABCD',
  order_id:id.order,input_revision:revision,input_sha256:inputHash,month:'2026-06' as const,parent_run_id:parent.analysis_run_id,
  parent_result_sha256:parentResultHash,parent_key:savedMonthIdempotencyKey(job,id.order,'2026-06'),
  parent_facts:parent,parent_facts_sha256:canonicalSha256(parent),facts,facts_sha256:canonicalSha256(facts),reading:answer,
  source:{document_id:id.document,version_id:id.source,source_sha256:sourceHash,checkpoint_sha256:checkpointHash,
   path:`cases/${id.case}/versions/${id.source}.pdf`,mime:'application/pdf' as const,size:1234,page:3},
  policy_sha256:canonicalSha256(DEV_MINIMUM_WAGE_POLICY),created_at:now,calculation,finding:devFinancialFinding(runId,calculation),
  request_id:answer?.request_id??null,scenario:'synthetic_adult_hourly_general_182_regular_base_only' as const,extraction_provider:'injected_test_provider' as const};
}
function pdfLogicalText(bytes:Uint8Array){
 return [...Buffer.from(bytes).toString('latin1').matchAll(/\/ActualText <FEFF([0-9A-F]+)>/gu)]
  .map(match=>String.fromCharCode(...match[1].match(/.{4}/gu)!.map(hex=>parseInt(hex,16)))).join(' ').replace(/\s+/gu,' ');
}

describe('DEV financial snapshot and source contract',()=>{
 it('binds the independently specified 240.00 result and finding to the same new financial run',()=>{
  const p=candidate(),run=parseDevFinancialRun(p);
  expect(run.run_id).not.toBe(run.parent_run_id);
  expect(run.parent_facts.analysis_run_id).toBe(id.parent);
  expect(run.facts.analysis_run_id).toBe(id.run);
  expect(run.facts.facts).toEqual(run.parent_facts.facts);
  expect(run.facts_sha256).not.toBe(run.parent_facts_sha256);
  if(run.calculation.state!=='calculated')throw Error('EXPECTED_FINANCIAL_RESULT');
  expect([run.calculation.expectedMinor,run.calculation.recordedMinor,run.calculation.gapMinor]).toEqual([354000,330000,24000]);
  expect(run.calculation.trace.analysis_run_id).toBe(run.run_id);
  expect(run.finding?.analysis_run_id).toBe(run.run_id);
  expect(run.finding?.trace_sha256).toBe(run.calculation.trace.trace_sha256);
  expect(run.source.page).toBe(3);
 });

 it('keeps the canonical missing fact unchanged and identifies the answer only in the derived financial snapshot',()=>{
  const parent=missingHours(),before=canonicalSha256(parent),answer=reading();
  const waiting=parseDevFinancialRun(candidate({parent}));
  expect(waiting.calculation).toEqual({state:'missing_input',fields:['work.regular_hours']});
  expect(waiting.finding).toBeNull();
  const finished=parseDevFinancialRun(candidate({parent,reading:answer,runId:id.other,revision:2}));
  expect(canonicalSha256(parent)).toBe(before);
  expect(finished.parent_facts.facts.find(f=>f.path==='work.regular_hours')?.value).toBeNull();
  const hours=finished.facts.facts.find(f=>f.path==='work.regular_hours');
  expect(hours?.value).toEqual({amount:'100',unit:'hours_per_month'});
  expect(hours?.provenance).toEqual([{source_type:'declared',source_reference:{kind:'case_request_answer',request_id:id.request,answer_revision:1}}]);
  expect(finished.reading?.identity_id).toBe(id.identity);
  expect(finished.run_id).not.toBe(waiting.run_id);
  expect(finished.finding?.gap_minor).toBe(24000);
 });

 it('allows an absent hours fact to be supplied without altering other original facts',()=>{
  const parent={...parentFixture(),facts:parentFixture().facts.filter(f=>f.path!=='work.regular_hours')};
  const result=devFinancialFacts(parent,id.run,reading());
  expect(result.facts.filter(f=>f.path!=='work.regular_hours')).toEqual(parent.facts);
  expect(result.facts.find(f=>f.path==='work.regular_hours')?.status).toBe('confirmed');
 });

 it.each(['confirmed','candidate','needs_confirmation','rejected'] as const)('refuses to overwrite a present %s hours input with a missing-reading answer',status=>{
  const parent=changeFact(parentFixture(),'work.regular_hours',{status});
  expect(()=>devFinancialFacts(parent,id.run,reading())).toThrow();
 });

 it('does not turn an unresolved hours conflict into a confirmed customer reading',()=>{
  const parent=changeFact(parentFixture(),'work.regular_hours',{status:'conflicted',value:null,conflicting_fact_ids:[id.request,id.other]});
  expect(()=>devFinancialFacts(parent,id.run,reading())).toThrow();
 });

 it.each(['010','01.5','000.5'])('refuses noncanonical leading-zero answer %s before transformation',answer=>{
  expect(devHoursReadingSchema.safeParse({...reading(),answer}).success).toBe(false);
 });

 it.each(['0','-1','182.0001','183','1e2','1,5','1.00001'])('refuses out-of-scenario or malformed hours %s',answer=>{
  expect(devHoursReadingSchema.safeParse({...reading(),answer}).success).toBe(false);
 });

 it.each(['needs_confirmation','candidate','rejected','missing'] as const)('does not adopt an unverified salary-type scenario (%s)',status=>{
  const parent=changeFact(parentFixture(),'compensation.salary_type',{status,value:status==='missing'?null:'hourly'});
  expect(()=>parseDevFinancialRun(candidate({parent}))).toThrow();
 });

 it('refuses monthly, mixed or conflicted salary type despite otherwise calculable hours and pay',()=>{
  for(const value of ['monthly','mixed'])expect(()=>parseDevFinancialRun(candidate({parent:changeFact(parentFixture(),'compensation.salary_type',{value})}))).toThrow();
  const conflict=changeFact(parentFixture(),'compensation.salary_type',{status:'conflicted',value:null,conflicting_fact_ids:[id.request,id.other]});
  expect(()=>parseDevFinancialRun(candidate({parent:conflict}))).toThrow();
 });

 it.each([
  ['2026-05-01','2026-05-31'],['2026-06-02','2026-06-30'],['2026-06-01','2026-07-01'],['2026-06-01',null],
 ])('requires the exact complete June period instead of dates %s to %s',(start_date,end_date)=>{
  const parent=changeFact(parentFixture(),'documents.period',{value:{document_id:id.source,period:{start_date,end_date}}});
  expect(()=>parseDevFinancialRun(candidate({parent}))).toThrow();
 });

 it('requires a confirmed period and does not infer it from the run month',()=>{
  const unconfirmed=changeFact(parentFixture(),'documents.period',{status:'needs_confirmation'});
  expect(()=>parseDevFinancialRun(candidate({parent:unconfirmed}))).toThrow();
  const missing={...parentFixture(),facts:parentFixture().facts.filter(f=>f.path!=='documents.period')};
  expect(()=>parseDevFinancialRun(candidate({parent:missing}))).toThrow();
 });

 it('rejects a displayed source page different from the canonical base-pay source',()=>{
  const p=candidate();expect(()=>parseDevFinancialRun({...p,source:{...p.source,page:99}})).toThrow();
 });

 it('refuses a base-pay source without a page instead of inventing page one',()=>{
  const parent=changeFact(parentFixture(),'compensation.base_monthly_salary',{provenance:[{source_type:'documented',source_reference:{kind:'document',document_id:id.source}}]});
  expect(()=>parseDevFinancialRun(candidate({parent}))).toThrow();
 });

 it('rejects source-version, foreign-case path and financial run tampering',()=>{
  const p=candidate();
  for(const tampered of [
   {...p,source:{...p.source,version_id:id.other,path:`cases/${id.case}/versions/${id.other}.pdf`}},
   {...p,source:{...p.source,path:`cases/${id.other}/versions/${id.source}.pdf`}},
   {...p,run_id:id.other},{...p,parent_run_id:id.other},
   {...p,input_sha256:'a'.repeat(64)},{...p,policy_sha256:'b'.repeat(64)},
   {...p,parent_facts_sha256:'c'.repeat(64)},{...p,facts_sha256:'d'.repeat(64)},
  ])expect(()=>parseDevFinancialRun(tampered)).toThrow();
 });

 it('refuses a customer reading bound to another version, checkpoint or request',()=>{
  const p=candidate({parent:missingHours(),reading:reading()});
  for(const readingPatch of [{version_id:id.other},{checkpoint_sha256:'e'.repeat(64)},{request_id:id.other}]){
   expect(()=>parseDevFinancialRun({...p,reading:{...p.reading,...readingPatch}})).toThrow();
  }
 });

 it('rejects a changed derived fact even when its supplied hash is recomputed',()=>{
  const p=candidate(),facts=changeFact(p.facts,'compensation.base_monthly_salary',{value:{currency:'ILS',minor_units:340000}});
  expect(()=>parseDevFinancialRun({...p,facts,facts_sha256:canonicalSha256(facts)})).toThrow();
 });

 it('recomputes financial result and finding instead of trusting supplied amounts or trace references',()=>{
  const p=candidate();if(p.calculation.state!=='calculated'||!p.finding)throw Error('EXPECTED_FIXTURE_CALCULATION');
  expect(()=>parseDevFinancialRun({...p,calculation:{...p.calculation,gapMinor:1}})).toThrow();
  expect(()=>parseDevFinancialRun({...p,finding:{...p.finding,gap_minor:1}})).toThrow();
  expect(()=>parseDevFinancialRun({...p,finding:{...p.finding,analysis_run_id:id.other}})).toThrow();
  expect(()=>parseDevFinancialRun({...p,finding:{...p.finding,trace_sha256:'f'.repeat(64)}})).toThrow();
 });

 it('does not lose the immutable answer revision when a corrected answer creates a new financial snapshot',()=>{
  const parent=missingHours(),first=parseDevFinancialRun(candidate({parent,reading:reading()}));
  const corrected=parseDevFinancialRun(candidate({parent,reading:{...reading(),answer_revision:2,answer:'101'},runId:id.other,revision:2}));
  expect(first.reading?.answer_revision).toBe(1);expect(first.finding?.gap_minor).toBe(24000);
  expect(corrected.reading?.answer_revision).toBe(2);expect(corrected.finding?.gap_minor).toBe(27540);
  expect(first.facts_sha256).not.toBe(corrected.facts_sha256);
 });
});

describe('DEV HTML/PDF derived from one financial run',()=>{
 it('renders the same run, source, operands and result in HTML and PDF actual text',async()=>{
  const run=parseDevFinancialRun(candidate()),artifacts=renderDevFinancialArtifacts(run);
  expect((await PDFDocument.load(artifacts.pdf)).getPageCount()).toBeGreaterThan(0);
  const logical=pdfLogicalText(artifacts.pdf),compact=logical.replace(/\s/gu,'');
  for(const text of [id.run,id.parent,id.document,id.source,'3540.00','3300.00','240.00','35.40']){
   expect(artifacts.html).toContain(text);expect(compact).toContain(text);
  }
  expect(artifacts.html).toMatch(/>100(?:\.0+)?</u);
  expect(logical).toMatch(/\b100(?:\.0+)?\b/u);
  expect(artifacts.html).toContain(DEV_FINANCIAL_DISCLOSURE);
  // PDF bidi text runs may add spaces next to the embedded Latin DEV label.
  expect(logical.replace(/\s/gu,'')).toContain(DEV_FINANCIAL_DISCLOSURE.replace(/\s/gu,''));
  if(run.calculation.state!=='calculated')throw Error('EXPECTED_FIXTURE_CALCULATION');
  expect(artifacts.html).toContain(run.calculation.trace.trace_sha256);
  expect(compact).toContain(run.calculation.trace.trace_sha256);
  expect(artifacts.htmlSha256).toBe(devArtifactSha(artifacts.html));
  expect(artifacts.pdfSha256).toBe(devArtifactSha(artifacts.pdf));
 });

 it('produces stable bytes on replay and binds changed source-derived amounts into both artifacts',()=>{
  const first=renderDevFinancialArtifacts(candidate()),retry=renderDevFinancialArtifacts(candidate());
  expect(retry).toEqual(first);
  const parent=changeFact(parentFixture(),'compensation.base_monthly_salary',{value:{currency:'ILS',minor_units:340000}});
  const changed=renderDevFinancialArtifacts(candidate({parent,runId:id.other,revision:2}));
  expect(changed.html).toContain('140.00');expect(pdfLogicalText(changed.pdf)).toContain('140.00');
  expect(changed.htmlSha256).not.toBe(first.htmlSha256);expect(changed.pdfSha256).not.toBe(first.pdfSha256);
 });

 it('discloses the identified customer reading in both output formats',()=>{
  const artifacts=renderDevFinancialArtifacts(candidate({parent:missingHours(),reading:reading()}));
  const disclosure='מספר השעות הוזן בתשובת לקוח מזוהה, ולא נקרא בידי ספק OCR.';
  expect(artifacts.html).toContain(disclosure);expect(pdfLogicalText(artifacts.pdf)).toContain(disclosure);
 });

 it('refuses to render artifacts from a forged calculation or provenance envelope',()=>{
  const p=candidate();if(p.calculation.state!=='calculated')throw Error('EXPECTED_FIXTURE_CALCULATION');
  expect(()=>renderDevFinancialArtifacts({...p,calculation:{...p.calculation,expectedMinor:1}})).toThrow();
  expect(()=>renderDevFinancialArtifacts({...p,source:{...p.source,page:99}})).toThrow();
 });

 it('marks literal missing input without inserting a zero financial finding',()=>{
  const run=parseDevFinancialRun(candidate({parent:missingHours()})),artifacts=renderDevFinancialArtifacts(run);
  expect(run.finding).toBeNull();expect(run.calculation.state).toBe('missing_input');
  expect(artifacts.html).toContain('work.regular_hours');
  expect(artifacts.html).not.toContain('צפוי פחות מתועד');
  expect(pdfLogicalText(artifacts.pdf)).toContain('work.regular_hours');
 });
});
