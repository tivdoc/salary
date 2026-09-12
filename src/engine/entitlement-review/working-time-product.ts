import {canonicalSha256} from '../rule-runtime/canonical.ts';
import type {DocumentReviewInput} from '../document-review/contracts.ts';
import {documentReviewCalculationInputSchema} from '../document-review/calculations.ts';
import type {ReviewCompletionNeed} from '../document-review/completions.ts';
import {resolveWorkingTimeEntitlement,workingTimeEntitlementInputSchema,WORKING_TIME_CATALOG} from './working-time/index.ts';
import type {EntitlementBranchReview,EntitlementAnswerTarget} from './branch-contract.ts';
import {workingTimeProductFactQuestions,workingTimeProductFactKey} from './working-time/product-facts.ts';
import {WORKING_TIME_PRODUCT_FACTS_POLICY} from './working-time/product-fact-contracts.ts';
import {workingTimeProductSourcePins} from './working-time/source-facts.ts';
import {evaluateWorkingTimeCaseRecipe} from './working-time/product-decisions.ts';

export function workingTimeProductReview(input:DocumentReviewInput,candidates:unknown):EntitlementBranchReview{
 if(!Array.isArray(candidates)||!candidates.length||candidates.length>6)throw Error('ENTITLEMENT_WORKING_WEEK_SET');
 const checks:DocumentReviewInput['checks']=[],gaps:DocumentReviewInput['coverage_gaps']=[],needs:ReviewCompletionNeed[]=[],answer_targets:EntitlementAnswerTarget[]=[];
 const purchased=input.purchased_scope.topics;
 if(!purchased.includes('working_time')&&!purchased.includes('rest_day'))throw Error('ENTITLEMENT_WORKING_TIME_UNPURCHASED');
 const prefixes=new Set<string>();
 candidates.forEach((candidate,index)=>{
  const e=workingTimeEntitlementInputSchema.parse(candidate);
  if(e.case_id!==input.case_id||canonicalSha256(e.period)!==canonicalSha256(input.period)||prefixes.has(e.check_id_prefix))throw Error('ENTITLEMENT_WORKING_TIME_SCOPE');
  prefixes.add(e.check_id_prefix);
  const resolved=resolveWorkingTimeEntitlement(e);
  const selected=resolved.checks.filter(c=>purchased.includes(c.topic));checks.push(...selected);
  const branchGaps=resolved.coverage_gaps.filter(g=>purchased.includes(g.topic)).map(g=>{
   if(e.product_facts?.schema_version!==WORKING_TIME_PRODUCT_FACTS_POLICY||!g.source_pins)return g;
   const {source_pins,...rest}=g,pins=source_pins.filter(p=>input.documents.some(d=>d.case_id===p.case_id&&d.document_id===p.document_id&&d.version_id===p.version_id&&d.file_sha256===p.source_sha256));
   // Answer provenance remains in the fact and answer journal. Gap source links
   // only address physical documents admitted to the report's document list.
   return {...rest,...(pins.length?{source_pins:pins}:{})};
  });gaps.push(...branchGaps);
  for(const missing of resolved.missing){
   const topic=missing.fact_key==='wt.rest_window'?'rest_day':'working_time';if(!purchased.includes(topic))continue;
   const ids=missing.dependent_check_ids.filter(id=>!resolved.checks.some(c=>c.check_id===id&&!purchased.includes(c.topic)));
   if(!ids.length)continue;
   for(const id of ids)if(!checks.some(c=>c.check_id===id)&&!gaps.some(g=>g.check_id===id))gaps.push({check_id:id,topic,kind:'missing_fact',detail:missing.question,next_step:missing.question});
   const scalar=missing.customer_declaration_allowed&&missing.kind==='fact'&&/^workdays\.\d+\.(kind|inventory|no_work_credit|intervals\.\d+\.classification)$/u.test(missing.input_path);
   let questionPins=[...missing.source_pins];
   if(scalar&&e.product_facts?.schema_version===WORKING_TIME_PRODUCT_FACTS_POLICY){
    const path=/^workdays\.(\d+)\.(?:intervals\.(\d+)\.classification|kind|inventory|no_work_credit)$/u.exec(missing.input_path)!;
    const day=e.workdays[Number(path[1])],clocks=path[2]===undefined?day.intervals.map(i=>i.clock_source):[day.intervals[Number(path[2])].clock_source];
    // The question is about preserved source time, even after its factual
    // answer is unknown. An answer receipt is not a replacement source file.
    const pins=clocks.filter(s=>input.documents.some(d=>d.document_id===s.document_id&&d.version_id===s.version_id&&d.file_sha256===s.file_sha256))
     .map(s=>({case_id:input.case_id,document_id:s.document_id,version_id:s.version_id,source_sha256:s.file_sha256}));
    questionPins=pins.length?[...new Map(pins.map(p=>[canonicalSha256(p),p])).values()].sort((a,b)=>canonicalSha256(a).localeCompare(canonicalSha256(b))):workingTimeProductSourcePins(input,e);
   }
   const fact_key=`entitlement.work.${canonicalSha256({period:input.period,pins:questionPins,prefix:e.check_id_prefix,path:missing.input_path}).slice(0,32)}`;
   const legal=missing.kind==='applicability';
   if(e.product_facts?.schema_version===WORKING_TIME_PRODUCT_FACTS_POLICY&&missing.fact_key==='wt.rest_window'&&e.rest_window.state!=='conflict')continue;
   const need:ReviewCompletionNeed={fact_key,kind:legal?'legal':'factual',reason:missing.state==='conflict'?'conflicted':missing.state==='unreadable'?'unreadable':missing.state==='missing'?'missing':'unknown',
    required_evidence_kind:scalar?'customer_declaration':'observed_reading',question:missing.question,
    answer_kind:scalar&&missing.options?.length?'choice':'text',...(scalar&&missing.options?.length?{options:[...missing.options]}:{}),
    source_pins:questionPins,dependent_check_ids:[...ids],general_question:false};
   const prior=needs.find(n=>n.fact_key===fact_key);
   if(!prior){needs.push(need);if(scalar)answer_targets.push({fact_key,input_path:missing.input_path,branch:'working_time',index,value_kind:'text'});}
   else {
    const {dependent_check_ids:priorIds,...priorCore}=prior,{dependent_check_ids:nextIds,...nextCore}=need;
    if(canonicalSha256(priorCore)!==canonicalSha256(nextCore))throw Error('ENTITLEMENT_WORKING_QUESTION_COLLISION');
    needs[needs.indexOf(prior)]={...prior,dependent_check_ids:[...new Set([...priorIds,...nextIds])].sort()};
   }
  }
  for(const q of workingTimeProductFactQuestions(e,input)){
   const ids=e.workdays.filter(d=>d.inventory.value!=='no_work').flatMap(d=>[`${e.check_id_prefix}.${d.id}`,...(e.calculation_policy?[`${e.check_id_prefix}.${d.id}.expected`]:[])]);
   if(!ids.length)continue;
   const fact_key=workingTimeProductFactKey(input,e,q.path),pins=workingTimeProductSourcePins(input,e);
   const need:ReviewCompletionNeed={fact_key,kind:'factual',reason:q.fact.state==='conflict'?'conflicted':q.fact.state==='unreadable'?'unreadable':q.fact.state==='missing'?'missing':'unknown',required_evidence_kind:'customer_declaration',question:q.question,answer_kind:q.answer_kind,
    ...(q.choices?{options:q.choices.map(c=>c.label),value_mapping:{schema_version:'document-review-choice-values-v1' as const,entries:[...q.choices]}}:{}),...(q.format?{value_validation:{schema_version:'document-review-value-validation-v1' as const,format:q.format}}:{}),source_pins:pins,dependent_check_ids:ids,general_question:false};
   const prior=needs.find(n=>n.fact_key===fact_key);
   if(prior){const {dependent_check_ids:priorIds,...priorCore}=prior,{dependent_check_ids:nextIds,...nextCore}=need;if(canonicalSha256(priorCore)!==canonicalSha256(nextCore))throw Error('WT_PERSONAL_QUESTION_COLLISION');needs[needs.indexOf(prior)]={...prior,dependent_check_ids:[...new Set([...priorIds,...nextIds])].sort()};}
   else needs.push(need);
   answer_targets.push({fact_key,input_path:q.path,branch:'working_time',index,value_kind:q.format==='iso_date'?'date':'text'});
   const topic=input.purchased_scope.topics.includes('working_time')?'working_time':'rest_day';
   gaps.push({check_id:e.check_id_prefix+'.personal.'+q.path,topic,kind:'missing_fact',detail:q.question,next_step:q.question,source_pins:pins});
  }
  if(e.product_facts?.schema_version===WORKING_TIME_PRODUCT_FACTS_POLICY){
   const coverage=evaluateWorkingTimeCaseRecipe('wt.coverage',e,{review:input});
   const limitations:Record<string,{detail:string;next_step:string}>={
    'coverage:minor_population_requires_separate_branch':{detail:'הגיל בתקופה מחייב בדיקת הסדר עבודת נוער, שאינו נכלל בענף החישוב הזה.',next_step:'נדרשת בדיקה נפרדת של הסדר עבודת נוער; אין להחיל את נוסחת הבגירים.'},
    'coverage:outside_release_population_21_59':{detail:'התקופה אינה כולה בטווח הגילים 21–59 של גרסת המוצר הנוכחית. זהו גבול מוצר ולא קביעה שאין זכאות.',next_step:'נדרשת בדיקה נפרדת לאוכלוסייה שמחוץ לטווח הנתמך.'},
    'coverage:unsupported_employment_population':{detail:'מעמד העבודה, המגזר או שיטת השכר שנמסרו אינם תואמים לענף המצומצם לשכיר שעתי במגזר הפרטי.',next_step:'יש לבדוק את הסדר ההעסקה המזוהה בענף מתאים לפני קביעת גמול.'},
    'coverage:special_occupation_requires_separate_assessment':{detail:'מסגרת העבודה שנמסרה דורשת בדיקת תחולה נפרדת; היא לא סווגה אוטומטית כעבודה רגילה.',next_step:'נדרשת בחינה של מסגרת התפקיד, תנאי ההעסקה והמקור החל עליהם.'},
    'coverage:responsibilities_require_source_assessment':{detail:'הסמכויות שנמסרו מחייבות בחינה נפרדת של אופי התפקיד והחריגים לחוק.',next_step:'יש לבחון את המשימות והסמכויות בפועל לצד הגדרת התפקיד ותנאי ההעסקה; אין צורך שהלקוח יקבע תחולה משפטית.'},
    'coverage:tracking_circumstances_require_source_assessment':{detail:'נמסר שלא ניתן היה לעקוב אחר זמני העבודה. אין בכך לבדו הכרעה שהחוק אינו חל.',next_step:'נדרשת בחינה של אופן ביצוע העבודה ואפשרויות הפיקוח והתיעוד בפועל.'},
    'coverage:other_hours_terms_source_required':{detail:'נמסר על הסדר שעות נוסף שעשוי לשנות את החישוב.',next_step:'יש לצרף או לזהות את הסדר השעות הנוסף שכבר נמסר, כדי לבדוק את תנאיו ותקופתו.'},
   };
   const limitation=coverage.reason?limitations[coverage.reason]:undefined;
   if(limitation)gaps.push({check_id:e.check_id_prefix+'.coverage.population',topic:purchased.includes('working_time')?'working_time':'rest_day',kind:'missing_applicability',...limitation,source_pins:workingTimeProductSourcePins(input,e)});
  }
 });
 if(new Set(checks.map(c=>c.check_id)).size!==checks.length)throw Error('ENTITLEMENT_WORKING_CHECK_COLLISION');
 const uniqueGaps=[...new Map(gaps.map(g=>[g.check_id,g])).values()];
 return {checks,gaps:uniqueGaps,needs,answer_targets,selections:(['working_time','rest_day'] as const).filter(t=>purchased.includes(t)).map(topic=>{
  const selected=checks.filter(c=>c.topic===topic),rule_pins=selected.map(c=>documentReviewCalculationInputSchema.parse(c.calculation).operation).filter(o=>o.kind==='candidate_rule')
   .map(o=>({rule_id:o.rule.rule_spec_id,version:o.rule.rule_spec_version,sha256:o.rule.content_sha256}));
  return {topic,catalog_id:WORKING_TIME_CATALOG.catalog_id,catalog_version:WORKING_TIME_CATALOG.catalog_version,evidence_sha256:canonicalSha256(candidates),
   source_policy_sha256:WORKING_TIME_CATALOG.source_review_sha256,status:selected.length?'selected_for_review' as const:'missing_facts' as const,
   rule_pins:[...new Map(rule_pins.map(r=>[r.rule_id,r])).values()],generated_check_ids:selected.map(c=>c.check_id),generated_gap_ids:uniqueGaps.filter(g=>g.topic===topic).map(g=>g.check_id),
   publication_authority:false as const,authority_status:'candidate_review_not_financial_authority' as const};})};
}
