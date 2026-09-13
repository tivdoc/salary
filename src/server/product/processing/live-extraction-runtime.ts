import 'server-only';
import {resolveOpenAiExtractionConfig} from '@/server/engine/extraction/providers/openai/config';
import {createOpenAiPayslipV21ExtractorFromEnv} from '@/server/engine/extraction/providers/openai/v21-adapter';
import type {OpenAiPayslipV2PassExtractor} from '@/server/engine/extraction/providers/openai/v2-adapter';
import {PAYSLIP_EXTRACTION_V21_VERSION} from '@/engine/extraction/v21';
import {OPENAI_SOL_COMPARISON_PROFILE} from '@/server/engine/extraction/providers/openai/v2-request';
import {SOURCE_ROW_DUPLICATE_POLICY} from '@/engine/extraction/validation';

export const LIVE_EXTRACTION_RUNTIME_POLICY='tivdoc-openai-live-runtime-v1' as const;
export type LiveExtractionRuntime=
 | Readonly<{state:'configured';extractor:OpenAiPayslipV2PassExtractor;provider:Readonly<{
   kind:'openai_live';model:string;extractorVersion:string;policyVersion:typeof LIVE_EXTRACTION_RUNTIME_POLICY}>}>
 | Readonly<{state:'blocked';code:'LIVE_EXTRACTION_PROVIDER_UNCONFIGURED'|'LIVE_EXTRACTION_CONFIG_INVALID';provider:'openai'}>;

/** Runtime configuration alone never proves a provider call succeeded. This
 * factory intentionally has no test transport, fallback or confidence override.
 * Origin and outcomes are recorded by the actual transport in each checkpoint. */
export function createLiveExtractionRuntime(environment:Readonly<Record<string,string|undefined>>=process.env):LiveExtractionRuntime{
 try{
  const config=resolveOpenAiExtractionConfig(environment);
  if(!config.apiKey)return {state:'blocked',code:'LIVE_EXTRACTION_PROVIDER_UNCONFIGURED',provider:'openai'};
  const options=config.model==='gpt-5.6-sol'?{executionProfile:OPENAI_SOL_COMPARISON_PROFILE,componentDuplicatePolicy:SOURCE_ROW_DUPLICATE_POLICY}:{};
  return {state:'configured',extractor:createOpenAiPayslipV21ExtractorFromEnv(environment,options),provider:{
   kind:'openai_live',model:config.model,extractorVersion:PAYSLIP_EXTRACTION_V21_VERSION,policyVersion:LIVE_EXTRACTION_RUNTIME_POLICY}};
 }catch{
  // Do not surface a Zod/SDK message: malformed environment values may contain
  // a secret. The scheduler can persist this bounded, actionable reason.
  return {state:'blocked',code:'LIVE_EXTRACTION_CONFIG_INVALID',provider:'openai'};
 }
}
