import {it,expect,vi} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {buildPassEvaluation} from '@/engine/extraction/v2';
import {payslipExtractionV21ResultSchema,resolvePayslipExtractionPassesV21} from '@/engine/extraction/v21';
import {classifyOpenAiV2AggregateTotalRows,OPENAI_V2_AGGREGATE_TOTAL_POLICY} from '@/server/engine/extraction/providers/openai/v2-aggregate-totals';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {loadLiveExtractionCorpus,checkLiveExtractionCorpus} from './live-extraction-corpus';
vi.mock('server-only',()=>({}));

it.skipIf(process.env.TIVDOC_LIVE_AGGREGATE_REPLAY!=='1')('re-evaluates two preserved Hebrew observations without new provider output or rewritten receipts',()=>{
 const directory='output/release-completion/live-provider-june2026',results:unknown[]=[];
 for(const id of ['he-clear','he-scan-clear']){
  const path=`${directory}/live-checkpoint-${id}.json`,bytes=readFileSync(path),fileSha=createHash('sha256').update(bytes).digest('hex');
  const checkpoint=JSON.parse(bytes.toString('utf8')),original=payslipExtractionV21ResultSchema.parse(checkpoint.run.result);
  const context={hourly_analysis_implied:true,required_fields:['salary_period' as const],
   totals_section_visible:original.first_pass.totals_section_visible,pension_section_visible:original.first_pass.pension_section_visible};
  const replay=(pass:typeof original.first_pass)=>buildPassEvaluation({...pass,
   raw_extraction:classifyOpenAiV2AggregateTotalRows(pass.raw_extraction),critical_context:context,reference_year:2026});
  const result=resolvePayslipExtractionPassesV21({first_pass:replay(original.first_pass),recovery_passes:original.recovery_passes.map(replay),
   recovery_decision:original.recovery_decision,final_extraction_id:original.final_extraction.extraction_id,critical_context:context,reference_year:2026});
  const entry=loadLiveExtractionCorpus().find(value=>value.id===id)!;
  const before=checkLiveExtractionCorpus({entry,extraction:original.final_extraction,validation:original.final_validation});
  const after=checkLiveExtractionCorpus({entry,extraction:result.final_extraction,validation:result.final_validation});
  results.push({id,sourceSha256:checkpoint.input_sha256,originalCheckpointFileSha256:fileSha,
   originalPromptVersions:[original.first_pass,...original.recovery_passes].map(pass=>pass.prompt_version),
   before,after,newlyClassifiedTotals:result.final_extraction.aggregate_total_observations?.map(value=>value.total_field)??[],
   remainingComponents:result.final_extraction.additional_components.map(row=>({label:row.source_label,kind:row.semantic_kind,amount:row.amount})),
   remainingPensionFields:result.final_extraction.fields.filter(field=>field.field.startsWith('pension_')||field.field.startsWith('severance_')),
   replayResultSha256:canonicalSha256(result),sameOriginalBytes:createHash('sha256').update(readFileSync(path)).digest('hex')===fileSha});
  expect(readFileSync(path).equals(bytes)).toBe(true);
 }
 writeFileSync(`${directory}/aggregate-replay-hebrew-ef03418.json`,JSON.stringify({state:'OFFLINE_REPLAY_ONLY',
  checkedAt:new Date().toISOString(),classificationPolicy:OPENAI_V2_AGGREGATE_TOTAL_POLICY,providerCalls:0,receiptRewritten:false,
  promptChangeReplayed:false,modelConfidenceChanged:false,financialReportCreated:false,results},null,2)+'\n');
 expect(results).toHaveLength(2);
});
