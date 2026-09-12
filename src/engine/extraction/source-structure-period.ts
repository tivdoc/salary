import {canonicalSha256,deepFreeze} from '../rule-runtime/canonical.ts';
import {sourceStructurePeriodWitnessSchema,customerSourceStructureReadingV1Schema,type CustomerSourceStructureReading,type SourceStructurePeriodWitness,type SourceStructureRef,type SourceStructureSubject} from './source-structure.ts';

export const IDENTIFIED_PERIOD_STRUCTURE_POLICY='identified-period-structures-v2' as const;
export type SourceStructurePeriodPins=Readonly<{case_id:string;document_id:string;source_sha256:string;normalized_extraction_sha256:string;
 first_pass_extraction_sha256:string;extraction_result_sha256:string;month:string;policy_version?:string}>;
export function sourceStructureRefs(subject:SourceStructureSubject):readonly SourceStructureRef[]{
 return subject.kind==='period_association'?subject.refs:subject.kind==='source_relationship'?[subject.contribution,subject.base]
  :subject.kind==='deduction_group'?[...subject.rows,subject.mandatory_total,...(subject.voluntary_total?[subject.voluntary_total]:[])]:[subject.anchor];
}
const sorted=(refs:readonly SourceStructureRef[])=>[...refs].sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
const fail=():never=>{throw Error('SOURCE_STRUCTURE_PERIOD_WITNESS_INVALID');};
function matchesRef(reading:CustomerSourceStructureReading,ref:SourceStructureRef){
 return reading.subject.kind==='period_association'&&reading.subject.refs.some(r=>r.kind===ref.kind&&r.id===ref.id);
}
function assertPeriodReading(readingInput:unknown,ref:SourceStructureRef,period:SourceStructurePeriodWitness['period'],pins?:SourceStructurePeriodPins){
 const reading=customerSourceStructureReadingV1Schema.parse(readingInput),{verification_sha256,...body}=reading;
 if(canonicalSha256(body)!==verification_sha256||reading.subject.kind!=='period_association'||reading.value.kind!=='period_association')return fail();
 const subject=reading.subject,value=reading.value,month=period.from.slice(0,7),lastDay=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10);
 if(period.from!==`${month}-01`||period.to!==lastDay||reading.month!==month||value.period_kind!=='current'||canonicalSha256(value.period)!==canonicalSha256(period)
  ||!subject.refs.some(r=>canonicalSha256(r)===canonicalSha256(ref))||value.basis.page!==ref.source.page
  ||subject.refs.some(r=>r.source.document_id!==reading.document_id||r.source.source_scope?.period_kind&&r.source.source_scope.period_kind!=='unknown'&&r.source.source_scope.period_kind!=='current'))return fail();
 if(pins&&Object.entries(pins).some(([key,value])=>reading[key as keyof typeof pins]!==value))return fail();
 return reading;
}
/** Internal source proof. A server loader must independently authenticate and
 * supply the current period map; embedded receipts are never current authority. */
export function assertSourceStructurePeriodWitness(input:{witness:unknown;refs:readonly SourceStructureRef[];period:SourceStructurePeriodWitness['period'];
 pins?:SourceStructurePeriodPins;currentReadings?:ReadonlyMap<string,CustomerSourceStructureReading>}):SourceStructurePeriodWitness{
 const w=sourceStructurePeriodWitnessSchema.parse(input.witness);
 if(canonicalSha256(w.period)!==canonicalSha256(input.period)||canonicalSha256(w.refs.map(e=>e.ref))!==canonicalSha256(sorted(input.refs)))return fail();
 for(const e of w.refs){
  const label=e.ref.source.source_scope?.period_kind;
  if(e.basis==='original_current'){if(label!=='current')return fail();}
  else{
   if(label&&label!=='unknown')return fail();
   assertPeriodReading(e.reading,e.ref,w.period,input.pins);
  }
  if(input.currentReadings){
   const readings=[...input.currentReadings.values()].filter(r=>matchesRef(r,e.ref));
   // Original current metadata does not override a conflicting new decision.
   if(readings.length>1||e.basis==='identified_current'&&(readings.length!==1||canonicalSha256(readings[0])!==canonicalSha256(e.reading)))return fail();
   if(e.basis==='original_current'&&readings.length)assertPeriodReading(readings[0],e.ref,w.period,input.pins);
  }
 }
 return deepFreeze(w);
}
/** This builder does not infer a period. Missing, ambiguous or explicitly
 * noncurrent observations return a blocker; original source refs stay intact. */
export function buildSourceStructurePeriodWitness(input:{refs:readonly SourceStructureRef[];period:SourceStructurePeriodWitness['period'];
 pins:SourceStructurePeriodPins;currentReadings:ReadonlyMap<string,CustomerSourceStructureReading>}){
 const refs:SourceStructurePeriodWitness['refs']=[];
 for(const ref of sorted(input.refs)){
  const label=ref.source.source_scope?.period_kind,readings=[...input.currentReadings.values()].filter(r=>matchesRef(r,ref));
  if(readings.length>1)return {state:'conflict' as const,ref,witness:null};
  if(label==='current'){
   if(readings.length){try{assertPeriodReading(readings[0],ref,input.period,input.pins);}catch{return {state:'conflict' as const,ref,witness:null};}}
   refs.push({ref,basis:'original_current',reading:null});continue;
  }
  if(label&&label!=='unknown')return {state:'other' as const,ref,witness:null};
  if(!readings.length)return {state:ref.kind==='scope'?'unsupported_scope' as const:'missing' as const,ref,witness:null};
  try{const reading=assertPeriodReading(readings[0],ref,input.period,input.pins);refs.push({ref,basis:'identified_current',reading});}
  catch{return {state:'conflict' as const,ref,witness:null};}
 }
 const witness=assertSourceStructurePeriodWitness({...input,witness:{schema_version:'document-source-structure-period-witness-v1',period:input.period,refs}});
 return {state:'current' as const,ref:null,witness};
}
export function sourceStructurePeriodReadings(witness:SourceStructurePeriodWitness){
 return [...new Map(witness.refs.flatMap(e=>e.reading?[[e.reading.verification_sha256,e.reading] as const]:[])).values()];
}
