import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import type {DocumentReviewSource,DocumentReviewOperand} from '../../document-review/calculations.ts';
import {travelEntitlementInputSchema,type TravelEntitlementInput} from './contracts.ts';
import {travelFareSourceContextSchema,travelProductRoute} from './product-facts.ts';
import {TRAVEL_GENERAL_ORDER_FLOOR_POLICY} from './floor-policy.ts';
import {travelTariffTarget,travelTariffDocumentSchema,travelTariffGroupSchema,travelTariffJournalEntrySchema,resolveTravelTariffReading,travelTariffSourceLocatorSchema,
 type TravelTariffDocument,type TravelTariffJournalEntry,type TravelTariffReading,type TravelTariffTarget} from './tariff-contracts.ts';
export * from './tariff-contracts.ts';
const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
type Subject=TravelTariffTarget['subject'];
const subjects:Subject[]=['context','daily_fare','ticket_inventory','monthly_pass_cost'];
function sourceFor(target:TravelTariffTarget,reading:TravelTariffReading):DocumentReviewSource{
 const d=target.document,basis=reading.value?.basis;
 return {document_id:d.document_id,version_id:d.version_id,file_sha256:d.file_sha256,page:target.group.page,
  locator:JSON.stringify({schema_version:'travel-tariff-source-locator-v1',source_group_sha256:target.source_group_sha256,target_sha256:target.target_sha256,
   receipt_sha256:reading.receipt_sha256,subject:target.subject,locator:basis?.locator??target.group.locator}),label:'קריאת מקור תעריף נסיעה מזוהה',reading:'identified_document_reading',reading_receipt_sha256:reading.receipt_sha256};
}
function ownSource(source:DocumentReviewSource|null|undefined,group:string){if(!source)return false;try{return travelTariffSourceLocatorSchema.parse(JSON.parse(source.locator)).source_group_sha256===group;}catch{return false;}}
/** Feed only the ordinary authenticated document_field journal. Every current
 * receipt is rebuilt here. Older versions remain history and never supply a
 * current amount. Caller JSON and model confidence are not authentication. */
export function materializeTravelTariffSource(args:{travel:TravelEntitlementInput;current:TravelTariffDocument;group:{page:number;locator:string};journal:readonly TravelTariffJournalEntry[]}){
 const original=travelEntitlementInputSchema.parse(args.travel),current=travelTariffDocumentSchema.parse(args.current),group=travelTariffGroupSchema.parse(args.group);
 if(original.calculation_policy!==TRAVEL_GENERAL_ORDER_FLOOR_POLICY)throw Error('TRAVEL_TARIFF_POLICY_NOT_SELECTED');
 if(original.case_id!==current.case_id||original.period.from.slice(0,7)!==current.month||original.period.to.slice(0,7)!==current.month)throw Error('TRAVEL_TARIFF_CASE_PERIOD');
 if(args.journal.length>256)throw Error('TRAVEL_TARIFF_JOURNAL_BOUND');
 const targets=subjects.map(subject=>travelTariffTarget(current,group,subject)),bySubject=new Map<Subject,TravelTariffReading>(),history:{target_sha256:string;request_id:string;answer_revision:number;current:boolean}[]=[];
 const revisions=new Map<string,TravelTariffJournalEntry>();
 for(const item of args.journal){const entry=travelTariffJournalEntrySchema.parse(item);
  if(entry.target.document.case_id!==current.case_id||entry.target.document.document_id!==current.document_id)throw Error('TRAVEL_TARIFF_FOREIGN_JOURNAL');
  const key=entry.request_id+':'+entry.answer_revision,prior=revisions.get(key);if(prior&&!same(prior,entry))throw Error('TRAVEL_TARIFF_REVISION_CONFLICT');revisions.set(key,entry);
 }
 const latest=new Map<string,TravelTariffJournalEntry>();
 for(const entry of revisions.values()){const old=latest.get(entry.request_id);if(!old||entry.answer_revision>old.answer_revision)latest.set(entry.request_id,entry);}
 for(const entry of revisions.values())history.push({target_sha256:entry.target.target_sha256,request_id:entry.request_id,answer_revision:entry.answer_revision,current:latest.get(entry.request_id)===entry&&targets.some(t=>t.target_sha256===entry.target.target_sha256)});
 for(const entry of latest.values()){
  const target=targets.find(t=>t.target_sha256===entry.target.target_sha256);if(!target)continue;
  if(bySubject.has(target.subject))throw Error('TRAVEL_TARIFF_MULTIPLE_ACTIVE_REQUESTS');
  bySubject.set(target.subject,resolveTravelTariffReading(current,entry));
 }
 const out=structuredClone(original),conflicts:{path:string;reason:string;original_sha256:string;transcribed_sha256:string}[]=[];
 const inventoryReading=bySubject.get('ticket_inventory')?.value,monthlyAvailable=inventoryReading?.subject==='ticket_inventory'&&inventoryReading.value.monthly_pass_availability==='available';
 const route=travelProductRoute(out),usedTargets=targets.filter(t=>route.kind!=='zero'&&(t.subject!=='monthly_pass_cost'||monthlyAvailable));
 const dependencies=usedTargets.map(target=>({target,check_ids:[out.check_prefix+'.expected',out.check_prefix+'.comparison'],state:bySubject.get(target.subject)?.state??'missing',answered:bySubject.has(target.subject),
  question:tariffQuestion(target.subject),dependency_sha256:canonicalSha256({schema_version:'travel-tariff-dependency-v1',target_sha256:target.target_sha256,period:out.period,route,subject:target.subject})}));
 if(route.kind==='zero')return deepFreeze({travel:out,receipts:[],dependencies:[],history,conflicts,accepted_reading_sha256:[]});
 const receiptFor=(subject:Subject)=>bySubject.get(subject),source=(subject:Subject)=>{const r=receiptFor(subject);return r?sourceFor(targets.find(t=>t.subject===subject)!,r):null;};
 const fact=(subject:Subject,value:unknown)=>({state:receiptFor(subject)?.state==='identified'?'observed':receiptFor(subject)?.state??'missing',value,source:source(subject)});
 const operand=(subject:'daily_fare'|'monthly_pass_cost'):DocumentReviewOperand|null=>{const r=receiptFor(subject),s=source(subject);if(!r||!s)return null;
  return {id:'travel.tariff.'+subject,observation_id:r.target_sha256,state:r.state==='identified'?'observed':r.state,printed_value:r.value?.subject===subject?r.value.value:null,representation:'money_ils',quantity_unit:null,precision:'printed_precision',source:s};};
 const mergeOperand=(path:'discounted_daily_fare'|'monthly_pass_cost',next:DocumentReviewOperand|null)=>{
  const old=out[path];if(!old||ownSource(old.source,targets[0].source_group_sha256)){out[path]=next;return;}
  if(!next||same(old,next))return;
  if(old.printed_value===next.printed_value&&old.state===next.state)return;
  conflicts.push({path,reason:'existing_source_observation_disagrees',original_sha256:canonicalSha256(old),transcribed_sha256:canonicalSha256(next)});
  out[path]={...old,state:'conflict',printed_value:null};
 };
 mergeOperand('discounted_daily_fare',operand('daily_fare'));
 const context=receiptFor('context')?.value,inventory=receiptFor('ticket_inventory')?.value;
 const cv=context?.subject==='context'?context.value:null,iv=inventory?.subject==='ticket_inventory'?inventory.value:null;
 if(iv?.monthly_pass_availability==='unavailable'){
  if(out.monthly_pass_cost&&!ownSource(out.monthly_pass_cost.source,targets[0].source_group_sha256))conflicts.push({path:'monthly_pass_cost',reason:'unavailable_ticket_conflicts_with_existing_cost',original_sha256:canonicalSha256(out.monthly_pass_cost),transcribed_sha256:canonicalSha256(iv)});
  else out.monthly_pass_cost=null;
 }else mergeOperand('monthly_pass_cost',operand('monthly_pass_cost'));
 const availability=source('ticket_inventory'),priorAvailability=out.monthly_pass;
 if(availability){
  const reading=receiptFor('ticket_inventory')!;
  const next={state:reading.state==='identified'?'known' as const:reading.state,value:iv?.monthly_pass_availability??null,source:availability,basis:'identified_document_reading' as const};
  if(priorAvailability.source&&!ownSource(priorAvailability.source,targets[0].source_group_sha256)){
   if(priorAvailability.state==='known'&&next.state==='known'&&!same(priorAvailability.value,next.value)){
   conflicts.push({path:'monthly_pass',reason:'existing_availability_disagrees',original_sha256:canonicalSha256(priorAvailability),transcribed_sha256:canonicalSha256(next)});out.monthly_pass={...priorAvailability,state:'conflict',value:null};
   }
  }else out.monthly_pass=next;
 }
 const nextContext=travelFareSourceContextSchema.parse({schema_version:'travel-fare-source-context-v2',source_group_sha256:targets[0].source_group_sha256,
  route_reference:fact('context',cv?.route_reference??null),discount_profile:fact('context',cv?.discount_profile??null),association:fact('context',cv?'same_route_tariff_group':null),
  effective_period:fact('context',cv?.effective_period??null),directions:fact('context',cv?.directions??null),ticket_inventory:fact('ticket_inventory',iv?.ticket_inventory??null),monthly_pass_availability:fact('ticket_inventory',iv?.monthly_pass_availability??null),
  daily_fare_operand_sha256:canonicalSha256(operand('daily_fare')),monthly_pass_operand_sha256:iv?.monthly_pass_availability==='unavailable'?null:operand('monthly_pass_cost')?canonicalSha256(operand('monthly_pass_cost')):null});
 if(out.fare_source_context&&!ownSource(out.fare_source_context.association.source,targets[0].source_group_sha256)&&!same(out.fare_source_context,nextContext)){
  conflicts.push({path:'fare_source_context',reason:'existing_source_context_preserved',original_sha256:canonicalSha256(out.fare_source_context),transcribed_sha256:canonicalSha256(nextContext)});
  out.fare_source_context={...out.fare_source_context,association:{...out.fare_source_context.association,state:'conflict',value:null}};
 }else out.fare_source_context=nextContext;
 const pin={document_id:current.document_id,version_id:current.version_id,file_sha256:current.file_sha256,page_count:current.page_count,kind:'case_document' as const,case_id:current.case_id};
 const existing=out.source_manifest.find(m=>m.document_id===current.document_id);if(existing&&!same(existing,pin))throw Error('TRAVEL_TARIFF_MANIFEST_CHANGED');if(!existing)out.source_manifest.push(pin);
 const receipts=targets.flatMap(t=>{const r=receiptFor(t.subject);return r?[r]:[];});
 return deepFreeze({travel:travelEntitlementInputSchema.parse(out),receipts,dependencies,history,conflicts,accepted_reading_sha256:receipts.map(r=>r.receipt_sha256)});
}
export function tariffQuestion(subject:Subject){return {
 context:'במקור התעריף, מה המסלול, פרופיל ההנחה, הכיוונים ותקופת התוקף המפורשים? יש להעתיק את הקשר המקור ולא לאשר תחולה משפטית.',
 daily_fare:'מה התעריף היומי המוזל המודפס למסלול ולכיוונים שבמקטע המקור? אין להעתיק את סכום הנסיעות בתלוש או את התקרה שבצו.',
 ticket_inventory:'האם המקור מציג מלאי שלם של הכרטיסים המתאימים, והאם מנוי חודשי מתאים זמין בו? מחיר חסר אינו מוכיח אי־זמינות.',
 monthly_pass_cost:'מה מחיר המנוי החודשי המתאים המודפס באותו מקטע מקור, לאחר הנחות? יש לזהות מספר זה בנפרד מהתעריף היומי.',
 }[subject];}
