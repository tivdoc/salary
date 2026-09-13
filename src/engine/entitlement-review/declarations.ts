import {z} from 'zod';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {canonicalFactSchema} from '../facts/contracts.ts';
import type {DocumentReviewInput} from '../document-review/contracts.ts';
import type {DocumentReviewSource} from '../document-review/calculations.ts';
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
export const entitlementDeclarationsSchema=z.object({schema_version:z.literal('entitlement-questionnaire-evidence-v1'),
 snapshot_id:z.string().min(1).max(160),snapshot_sha256:sha,period:z.object({from:z.iso.date(),to:z.iso.date()}).strict(),
 facts:z.array(canonicalFactSchema).max(64)}).strict().superRefine((e,ctx)=>{
 if(canonicalSha256(e.facts)!==e.snapshot_sha256)ctx.addIssue({code:'custom',message:'ENTITLEMENT_DECLARATION_SNAPSHOT_HASH'});
 if(new Set(e.facts.map(f=>f.fact_id)).size!==e.facts.length)ctx.addIssue({code:'custom',message:'ENTITLEMENT_DECLARATION_DUPLICATE'});
});
export type EntitlementDeclarations=z.infer<typeof entitlementDeclarationsSchema>;
const locatorSchema=z.object({schema_version:z.literal('entitlement-declaration-transform-v1'),path:z.string().min(1),
 transform:z.enum(['identity','ongoing_employment','aged_21_for_period','under_60_for_period','no_employer_transport'])}).strict();
export type DeclarationTransform=z.infer<typeof locatorSchema>['transform'];
function transformed(value:unknown,path:string,transform:DeclarationTransform,period:{from:string;to:string}):unknown{
 if(transform==='identity')return value;
 if(transform==='no_employer_transport'){
  if(path!=='travel.employer_provides_transport'||value!==false)throw Error('ENTITLEMENT_DECLARATION_TRANSFORM');return 'none';
 }
 if(transform==='ongoing_employment'){
  if(path!=='employment.still_employed'||value!==true)throw Error('ENTITLEMENT_DECLARATION_TRANSFORM');return 'ongoing';
 }
 if(path!=='person.birth_year'||typeof value!=='number'||!Number.isInteger(value))throw Error('ENTITLEMENT_DECLARATION_TRANSFORM');
 // An unknown birthday cannot be promoted to a precise age. Admit only when
 // every possible birthday in that year gives the same scoped boolean.
 if(transform==='aged_21_for_period'){
  if(Number(period.from.slice(0,4))-value>=22)return true;
  if(Number(period.to.slice(0,4))-value<21)return false;
 }else{
  if(Number(period.to.slice(0,4))-value<60)return true;
  if(Number(period.from.slice(0,4))-value>=61)return false;
 }
 throw Error('ENTITLEMENT_DECLARATION_AGE_BOUNDARY');
}
export function questionnaireFactSource(input:DocumentReviewInput,path:string,transform:DeclarationTransform='identity'){
 const e=input.entitlement_declarations;if(!e)return null;
 const facts=e.facts.filter(f=>f.path===path&&f.case_id===input.case_id&&['needs_confirmation','confirmed'].includes(f.status)
  &&f.provenance.length===1&&f.provenance[0].source_type==='declared'&&f.provenance[0].source_reference.kind==='questionnaire_response');
 if(facts.length!==1)return null;
 const fact=facts[0];let value:unknown;try{value=transformed(fact.value,path,transform,input.period);}catch{return null;}
 const source:DocumentReviewSource={document_id:fact.fact_id,version_id:e.snapshot_id,file_sha256:canonicalSha256(fact),page:1,
  locator:JSON.stringify({schema_version:'entitlement-declaration-transform-v1',path,transform}),label:'תשובה מזוהה לשאלון — הצהרת עובדה בלבד',reading:'questionnaire_declaration',reading_receipt_sha256:e.snapshot_sha256};
 return {value,source,manifest:{document_id:source.document_id,version_id:source.version_id,file_sha256:source.file_sha256,page_count:1,kind:'questionnaire' as const,case_id:input.case_id}};
}
export function assertQuestionnaireSource(input:DocumentReviewInput,source:DocumentReviewSource,value?:unknown):void{
 if(source.reading!=='questionnaire_declaration')throw Error('ENTITLEMENT_QUESTIONNAIRE_SOURCE');
 const evidence=input.entitlement_declarations;
 if(!evidence||canonicalSha256(evidence.period)!==canonicalSha256(input.period)||evidence.facts.some(f=>f.case_id!==input.case_id))throw Error('ENTITLEMENT_QUESTIONNAIRE_SCOPE');
 const locator=locatorSchema.parse(JSON.parse(source.locator));
 const expected=questionnaireFactSource(input,locator.path,locator.transform);
 if(!expected||canonicalSha256(expected.source)!==canonicalSha256(source)||value!==undefined&&canonicalSha256(expected.value)!==canonicalSha256(value))throw Error('ENTITLEMENT_QUESTIONNAIRE_VALUE');
}
