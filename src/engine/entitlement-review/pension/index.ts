import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import {createRuleSpecPackage,type RuleSpecDraft} from '../../legal-operations/rulespec.ts';
import {calculateDocumentReview,documentReviewCalculationInputSchema,type DocumentReviewCalculationInput,type DocumentReviewOperand,type DocumentReviewSource} from '../../document-review/calculations.ts';
import {sourceRelationshipUsable} from '../../document-review/source-structure-evidence.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import {pensionEntitlementInputSchema,type PensionEntitlementInput,type PensionGap,type PensionDecision,type PensionShare} from './contracts.ts';
import {resolvePensionEligibility,pensionCheckIds,pensionOrdinaryWaitingElapsed} from './eligibility.ts';
import {PENSION_CATALOG,PENSION_FLOOR_CATALOG,PENSION_FLOOR_SOURCE_REVIEW_SHA256,PENSION_LEGAL_MANIFEST,PENSION_SOURCE_REVIEW,PENSION_SOURCE_REVIEW_SHA256,pensionLegalSource,isPinnedPensionLegalSource} from './sources.ts';
import {PENSION_STATUTORY_FLOOR_POLICY} from './source-fact-contracts.ts';
import {assertPensionDerivedFacts,pensionCaseDecisionSources} from './product-facts.ts';
export * from './contracts.ts';
export * from './sources.ts';
export * from './product-facts.ts';
export * from './source-fact-contracts.ts';
export {pensionCheckIds,resolvePensionEligibility} from './eligibility.ts';

type Candidate=Extract<DocumentReviewCalculationInput['operation'],{kind:'candidate_rule'}>;
export const PENSION_APPLICABILITY=deepFreeze({
 'pension.general_coverage':'יש לבחון שהעבודה כפופה למסגרת הכללית של צו ההרחבה, ללא חריג ענפי, הסדר מיוחד או חריג פרישה.',
 'pension.no_better_arrangement':'יש לבדוק אם חל הסדר מיטיב מכוח חוזה, צו ענפי או הסכם קיבוצי. אין להחליף הסדר כזה בתקרת המינימום הכללית.',
 'pension.pensionable_wage':'יש לזהות את רכיבי השכר המבוטח לפי סעיף 6(ב) לצו ואת תקופתם; ברוטו או בסיס שמודפס בתלוש אינם סיווג משפטי בפני עצמם.',
 'pension.pension_fund':'יש לזהות שמדובר בענף קרן פנסיה הנתמך כאן. ביטוח מנהלים, אובדן כושר עבודה והסדרים אחרים דורשים תנאים נוספים.',
 'pension.prior_coverage_evidence':'יש לבחון את תוקף הביטוח הפנסיוני במועד תחילת העבודה ואת השפעתו על ההמתנה; הצהרה אינה מאשרת לבדה את התחולה.',
 'pension.rounding':'יש לציין שהחישוב המותנה משתמש בעיגול חצי כלפי מעלה לכל רכיב בחודש, ולבדוק הסדר מחייב אחר אם קיים.',
 'pension.cap_interval':'בחודש שבו תקופת הזכאות חלקית יש לקבוע בנפרד את אופן תחולת תקרת השכר הממוצע. אין בצו שנבדק נוסחת תקרה יומית מפורשת.',
});
export const PENSION_FLOOR_APPLICABILITY=deepFreeze({...PENSION_APPLICABILITY,
 'pension.statutory_floor':'החישוב מוגבל לרצפת ההפרשות על הבסיס המזוהה. הוא אינו בודק את מלוא ההסדר החוזי או הקיבוצי, וגם פער אפס או עודף רשום אינם מוכיחים עמידה בכל החובות.'});
const shares=[['employee','6','רכיב עובד צפוי לניכוי'],['employer','6.5','תגמולי מעסיק צפויים'],['severance','6','הפרשה צפויה לרכיב פיצויים']] as const;
type ReviewCheck=DocumentReviewInput['checks'][number];
export type PensionComparisonEvidence=Readonly<{schema_version:'pension-recorded-source-evidence-v1';share:PensionShare;
 relationship_check:DocumentReviewCalculationInput;relationship_check_sha256:string}>;

function sourceBound(source:DocumentReviewSource,input:PensionEntitlementInput){
 const pins=input.source_manifest.filter(p=>p.document_id===source.document_id&&p.version_id===source.version_id);
 if(pins.length!==1||pins[0].file_sha256!==source.file_sha256||source.page>pins[0].page_count||pins[0].case_id!==input.case_id)throw Error('PENSION_CASE_SOURCE_BINDING');
 if(source.reading==='customer_declaration'&&pins[0].kind!=='customer_answer')throw Error('PENSION_DECLARATION_SOURCE');
 if(source.reading==='questionnaire_declaration'&&pins[0].kind!=='questionnaire')throw Error('PENSION_DECLARATION_SOURCE');
}
function gap(_input:PensionEntitlementInput,key:string,state:string,question:string,ids:readonly string[],path:string,kind:PensionGap['kind']='missing_fact'):PensionGap{
 void _input;
 return {dependency_id:key,state,kind,question,answer_kind:'text',input_path:path,dependent_check_ids:ids,source_required:true};
}
function manifest(input:PensionEntitlementInput,operands:readonly DocumentReviewOperand[],decisions:readonly PensionDecision[]){
 const used=[...operands.map(o=>o.source),...decisions.flatMap(d=>d.sources)];
 const result=input.source_manifest.filter(s=>used.some(u=>u.document_id===s.document_id&&u.version_id===s.version_id));for(const law of PENSION_LEGAL_MANIFEST){const prior=input.source_manifest.find(s=>s.document_id===law.document_id);
  if(prior&&canonicalSha256(prior)!==canonicalSha256(law))throw Error('PENSION_LEGAL_MANIFEST_PIN');if(!result.some(s=>s.document_id===law.document_id))result.push(law);}
 return result;
}
function decisionSet(input:PensionEntitlementInput):PensionDecision[]{
 const floor=input.calculation_policy===PENSION_STATUTORY_FLOOR_POLICY,requirements=floor?PENSION_FLOOR_APPLICABILITY:PENSION_APPLICABILITY;
 if(new Set(input.applicability.map(d=>d.decision_id)).size!==input.applicability.length||input.applicability.some(d=>!(d.decision_id in requirements)))throw Error('PENSION_DECISION_SET');
 for(const d of input.applicability)for(const source of d.sources){
  if(source.reading==='source_research'){if(!isPinnedPensionLegalSource(source))throw Error('PENSION_DECISION_LEGAL_SOURCE');}
  else sourceBound(source,input);
 }
 return Object.entries(requirements).filter(([id])=>!(floor&&id==='pension.no_better_arrangement')&&!(id==='pension.prior_coverage_evidence'&&pensionOrdinaryWaitingElapsed(input))&&!(id==='pension.cap_interval'&&!resolvePensionEligibility(input).eligibility.partial_waiting_month)).map<PensionDecision>(([decision_id,explanation])=>input.applicability.find(d=>d.decision_id===decision_id)??{
  decision_id,state:'missing',basis:'ai_source_assessment',explanation,sources:[pensionLegalSource('order2011',decision_id==='pension.pensionable_wage'?4:3,decision_id)],valid_until:null}).map(d=>{const consumed=d.state==='accepted'?pensionCaseDecisionSources(input,d.decision_id):[];return consumed.length?{...d,sources:[...new Map([...d.sources,...consumed].map(s=>[canonicalSha256(s),s])).values()]}:d;});
}
function money(operand:DocumentReviewOperand){
 if(operand.representation!=='money_ils'||operand.quantity_unit!==null)throw Error('PENSION_MONEY_UNIT');
 if(operand.printed_value!==null&&!/^(0|[1-9]\d{0,10})(?:\.\d{1,2})?$/u.test(operand.printed_value))throw Error('PENSION_NONNEGATIVE_MONEY');
}
function factualEligibilityDecision(input:PensionEntitlementInput):PensionDecision{
 const consumed=Object.entries(input.facts).filter(([key])=>key!=='prior_coverage_at_start'||!pensionOrdinaryWaitingElapsed(input));
 const facts=Object.fromEntries(consumed.map(([key,f])=>[key,{state:f.state,value:f.value,basis:f.basis,source_sha256:canonicalSha256(f.source),...(f.derivation?{derivation:f.derivation}: {})}]));
 const eligibility=resolvePensionEligibility(input).eligibility;
 if(eligibility.state!=='eligible')throw Error('PENSION_FACTUAL_ELIGIBILITY_NOT_ESTABLISHED');
 const evidence={schema_version:'pension-factual-eligibility-trace-v1',facts,period:input.period,eligible_interval:eligibility.eligible_interval,date_policy:eligibility.date_policy,
  ...(eligibility.partial_waiting_month?{wage_interval:input.eligible_interval_wage?.period??null}:{}),legal_applicability_approved:false};
 const birthday=consumed.some(([,f])=>f.state==='derived')?input.product_facts?.birth_date.source:null;
 const sources=[...new Map([...consumed.flatMap(([,f])=>f.source?[[canonicalSha256(f.source),f.source] as const]:[]),...(birthday?[[canonicalSha256(birthday),birthday] as const]:[])]).values()];
 // This decision is a deterministic fact-dependency check, separate from all
 // required legal assessments. Answers remain customer declarations in sources.
 return {decision_id:'pension.factual_eligibility',state:'accepted',basis:'ai_source_assessment',
  explanation:JSON.stringify({schema_version:evidence.schema_version,evidence_sha256:canonicalSha256(evidence),
   values:Object.fromEntries(consumed.map(([k,f])=>[k,f.value])),eligible_interval:eligibility.eligible_interval,
   date_policy:eligibility.date_policy,...(consumed.some(([,f])=>f.derivation)?{derivations:Object.fromEntries(consumed.filter(([,f])=>f.derivation).map(([k,f])=>[k,f.derivation]))}:{}),legal_applicability_approved:false}),sources,valid_until:null};
}
function calculation(input:PensionEntitlementInput,wage:DocumentReviewOperand,share:PensionShare,rate:string,decisions:PensionDecision[],recorded?:DocumentReviewOperand,relationship?:DocumentReviewCalculationInput):DocumentReviewCalculationInput{
 const floor=input.calculation_policy===PENSION_STATUTORY_FLOOR_POLICY;
 const check_id=`${input.check_prefix}.${share}.${recorded?'comparison':'expected'}`;
 const wageOperand={...wage,id:'pension.wage'},operands:DocumentReviewOperand[]=[wageOperand,
  {id:'pension.cap',observation_id:'btl.2026.section2',state:'observed',printed_value:'13769.00',representation:'money_ils',quantity_unit:null,precision:'source_exact',source:pensionLegalSource('average2026',1,'2026-01-01; section 2; benefits: 13,769 ILS')},
  {id:'pension.rate',observation_id:`pension.rate.${share}.2017`,state:'observed',printed_value:rate,representation:'percent',quantity_unit:'ratio',precision:'source_exact',source:pensionLegalSource(share==='severance'?'order2011':'order2016',share==='severance'?4:2,share==='severance'?'6(d): severance rate from 2014; 2016 section 3(3) preserves at least 6%':`3: ${share} contribution rate from 2017-01-01`)},
 ];
 const nodes:RuleSpecDraft['nodes'][number][]=[{node_id:'pension.base',operation:'min',refs:['fact.wage','parameter.cap']},
  {node_id:'pension.expected',operation:'money.scale',money_ref:'pension.base',rational_ref:'parameter.rate',rounding:'half_up'}];
 const facts:RuleSpecDraft['facts'][number][]=[{ref_id:'fact.wage',value_kind:'money',unit:'currency.ils'}];
 const bindings:Candidate['fact_bindings']=[{ref_id:'fact.wage',operand_id:'pension.wage'}];
 if(recorded){operands.push({...recorded,id:'pension.recorded'});facts.push({ref_id:'fact.recorded',value_kind:'money',unit:'currency.ils'});bindings.push({ref_id:'fact.recorded',operand_id:'pension.recorded'});
  nodes.push({node_id:'pension.difference',operation:'subtract',left_ref:'pension.expected',right_ref:'fact.recorded'});}
 const rule=createRuleSpecPackage({schema_version:'tivdoc-rulespec-v0.6.0',rule_spec_id:`il.review.pension.${share}.${recorded?'comparison':'expected'}${floor?'.floor':''}`,rule_spec_version:floor?'2.0.0':'1.0.0',topic:'pension',catalog_boundary:'real_inactive',
  source_version_ids:PENSION_LEGAL_MANIFEST.map(s=>s.version_id),effective_period:PENSION_SOURCE_REVIEW.supported_period,sectors:['general_private_conditionally_assessed'],populations:['adult_21_59_pension_fund'],facts,
  parameters:[{ref_id:'parameter.cap',parameter_id:'il.pension.general.cap',parameter_version:'2026.1',value_kind:'money',unit:'currency.ils'},
   {ref_id:'parameter.rate',parameter_id:`il.pension.general.${share}.rate`,parameter_version:'2017.1',value_kind:'rational',unit:'ratio'}],nodes,
  output_ref:recorded?'pension.difference':'pension.expected',golden_case_set_sha256:canonicalSha256({wage_ils:'5000.00',employee:'300.00',employer:'325.00',severance:'300.00',cap_2026:'13769.00'}),
  resource_policy:{max_steps:12,max_depth:8,max_aggregate_items:8,max_integer_digits:64}});
 return documentReviewCalculationInputSchema.parse({schema_version:'document-review-calculation-input-v1',case_id:input.case_id,run_id:input.run_id,check_id,period:input.period,evaluated_at:input.evaluated_at,
  source_manifest:manifest(input,operands,decisions),operands,remittance_status:input.remittance_status,operation:{kind:'candidate_rule',rule,fact_bindings:bindings,
   parameter_bindings:[{ref_id:'parameter.cap',operand_id:'pension.cap'},{ref_id:'parameter.rate',operand_id:'pension.rate'}],required_decision_ids:decisions.map(d=>d.decision_id),decisions,
   expected_output_ref:'pension.expected',recorded_ref:null,...(input.conditional_assumptions?.length?{conditional_assumptions:input.conditional_assumptions}:{}),
   ...(recorded?{comparison:{schema_version:'candidate-comparison-v1',expected_ref:'pension.expected',recorded_ref:'fact.recorded',difference_ref:'pension.difference',recorded_basis:'document_amount'}}:{}),
   ...(relationship&&relationship.operation.kind==='observed_ratio'?{recorded_source_evidence:{schema_version:'candidate-recorded-source-evidence-v1',calculation:relationship,calculation_sha256:canonicalSha256(relationship),numerator_operand_id:relationship.operation.numerator_ref,recorded_operand_id:'pension.recorded'}}:{})}});
}

/** Emits ordinary existing-engine inputs, not findings or publication authority.
 * Expected contributions do not depend on a transfer receipt or recorded amount. */
export function resolvePensionEntitlement(candidate:unknown){
 const input=pensionEntitlementInputSchema.parse(candidate),ids=pensionCheckIds(input.check_prefix),checks:ReviewCheck[]=[],comparison_evidence:PensionComparisonEvidence[]=[];
 const floor=input.calculation_policy===PENSION_STATUTORY_FLOOR_POLICY;
 assertPensionDerivedFacts(input);
 const lastDay=new Date(Date.UTC(Number(input.period.from.slice(0,4)),Number(input.period.from.slice(5,7)),0)).toISOString().slice(0,10);
 if(input.period.from<PENSION_SOURCE_REVIEW.supported_period.from||input.period.to>PENSION_SOURCE_REVIEW.supported_period.to||input.period.from.slice(8)!=='01'||input.period.to!==lastDay)throw Error('PENSION_SUPPORTED_MONTH_REQUIRED');
 if(new Set(input.recorded.map(r=>r.share)).size!==input.recorded.length)throw Error('PENSION_DUPLICATE_RECORDED_SHARE');
 for(const f of Object.values(input.facts))if(f.source){if(f.state==='derived'){if(!isPinnedPensionLegalSource(f.source))throw Error('PENSION_DERIVED_LEGAL_SOURCE');}else sourceBound(f.source,input);if(f.basis==='customer_declaration'&&!['customer_declaration','questionnaire_declaration'].includes(f.source.reading))throw Error('PENSION_FACT_BASIS');}
 if(input.pensionable_wage){sourceBound(input.pensionable_wage.source,input);money(input.pensionable_wage);}
 if(input.eligible_interval_wage){sourceBound(input.eligible_interval_wage.operand.source,input);money(input.eligible_interval_wage.operand);}
 const resolved=resolvePensionEligibility(input),gaps=[...resolved.gaps],decisions=decisionSet(input);
 if(floor)gaps.push(gap(input,'pension.complete_arrangement','unknown','מוצגת רצפת הפרשות בלבד. יש לבדוק בנפרד תנאי פנסיה מיטיבים בחוזה, בהסכם קיבוצי או בצו ענפי, לרבות בסיס גבוה יותר ושיעורים נוספים. פער אפס או עודף לעומת הרצפה אינם מאשרים שההסדר המלא קוים.',[`${input.check_prefix}.complete_arrangement`],'applicability.pension.no_better_arrangement','missing_applicability'));
 for(const d of decisions)if(d.state!=='accepted'||d.basis==='customer_declaration'||!d.sources.length||(d.valid_until!==null&&d.valid_until<=input.evaluated_at))gaps.push(gap(input,d.decision_id,d.state==='accepted'?'unknown':d.state,d.explanation,ids,`applicability.${d.decision_id}`,'missing_applicability'));
 const finish=()=>deepFreeze({schema_version:'pension-entitlement-resolution-v1' as const,input_sha256:canonicalSha256(input),catalog:floor?PENSION_FLOOR_CATALOG:PENSION_CATALOG,
  eligibility:resolved.eligibility,checks,gaps,comparison_evidence,rule_metadata:{source_review_sha256:PENSION_SOURCE_REVIEW_SHA256,
   expected_is_cash_debt:false,recorded_is_fund_transfer:false,combined_employer_is_split:false,human_attestation:null,real_activation_allowed:false,
   ...(floor?{source_review_sha256:PENSION_FLOOR_SOURCE_REVIEW_SHA256,calculation_policy:PENSION_STATUTORY_FLOOR_POLICY,complete_arrangement_compliance_assessed:false,zero_difference_establishes_compliance:false}:{})}});
 if(resolved.eligibility.state!=='eligible')return finish();
 let wage=input.pensionable_wage;
 if(resolved.eligibility.partial_waiting_month){
  if(!input.eligible_interval_wage||canonicalSha256(input.eligible_interval_wage.period)!==canonicalSha256(resolved.eligibility.eligible_interval)){
   gaps.push(gap(input,'pension.eligible_interval_wage','missing','הזכאות מתחילה באמצע החודש. יש לזהות את השכר המבוטח שנצבר רק לאחר תחילת הזכאות; לא נחלק שכר חודשי באופן שרירותי.',ids,'eligible_interval_wage','missing_source'));return finish();}
  wage=input.eligible_interval_wage.operand;
 }
 if(!wage){gaps.push({...gap(input,'pension.pensionable_wage','missing','יש לזהות את סכום רכיבי השכר המבוטח של התקופה. בסיס המודפס בתלוש אינו תחליף לסיווג הרכיבים.',ids,'pensionable_wage','missing_source'),answer_kind:'number'});return finish();}
 decisions.push(factualEligibilityDecision(input));
 for(const [share,rate,title]of shares){
  const expected=calculation(input,wage,share,rate,decisions);checks.push({check_id:expected.check_id,topic:'pension',title:floor?`${title} — רצפה בלבד`:title,explanation:floor?'רצפת הפרשות על בסיס המקור המזוהה, בכפוף לתנאי התחולה ולסיווג השכר. תנאים מיטיבים ובסיס גבוה יותר עשויים להגדיל את הזכאות. אין כאן בדיקת מלוא ההסדר או הוכחת העברה לקופה.':'סכום צפוי לפי המסגרת הכללית שנבחרה, בכפוף לתנאי התחולה ולסיווג השכר. אינו הוכחת העברה לקופה או חוב מזומן ללקוח.',calculation:expected});
  const recorded=input.recorded.find(r=>r.share===share),comparisonId=`${input.check_prefix}.${share}.comparison`;
  if(!recorded){gaps.push(gap(input,`pension.recorded.${share}`,'missing',`לצורך השוואת ${title}, יש לזהות בנפרד את הסכום שנרשם ואת הקשר שלו לבסיס ולתקופה. החישוב הצפוי אינו ממתין לאישור העברה לקופה.`,[comparisonId],`recorded.${share}`,'missing_source'));continue;}
  const r=recorded.relationship_check,s=r.source_structure;
  if(r.case_id!==input.case_id||canonicalSha256(r.period)!==canonicalSha256(input.period)||s?.kind!=='source_relationship'||r.operation.kind!=='observed_ratio')throw Error('PENSION_RECORDED_CONTEXT');
  const component={employee:'pension_employee',employer:'pension_employer',severance:'severance'}[share];
  if(s.entry.subject.kind!=='source_relationship'||s.entry.subject.component_kind!==component)throw Error('PENSION_RECORDED_COMPONENT');
  const ratio=calculateDocumentReview(r);
  if(!sourceRelationshipUsable(s)||ratio.state!=='calculated'){
   gaps.push(gap(input,`pension.relationship.${share}`,s.entry.reading?'conflict':'unknown','נדרש קשר מקור שמיש בין רכיב ההפרשה, הקרן, הבסיס והחודש. אין לשחזר את הקשר מהתאמת מספרים.',[comparisonId],`recorded.${share}.relationship_check`,'missing_source'));continue;}
  const numeratorRef=r.operation.numerator_ref,amount=r.operands.find(o=>o.id===numeratorRef)!;sourceBound(amount.source,input);money(amount);
  const evidence:PensionComparisonEvidence={schema_version:'pension-recorded-source-evidence-v1',share,relationship_check:r,relationship_check_sha256:canonicalSha256(r)};
  comparison_evidence.push(evidence);
  const relationDecision:PensionDecision={decision_id:`pension.recorded_relationship.${share}`,state:'accepted',basis:'ai_source_assessment',
   explanation:`Existing exact source relationship receipt validated separately; source evidence SHA256 ${canonicalSha256(evidence)}. No legal or remittance authority is conferred.`,sources:[amount.source],valid_until:null};
  const compared=calculation(input,wage,share,rate,[...decisions,relationDecision],amount,r);
  checks.push({check_id:compared.check_id,topic:'pension',title:`${title}${floor?' — רצפה בלבד':''} — לעומת הסכום שנרשם`,explanation:floor?'הפער הוא רצפת ההפרשה פחות הסכום הרשום, עם סימן. פער אפס או עודף אינם מוכיחים קיום ההסדר המלא; תנאים מיטיבים נבדקים בנפרד. אין כאן הוכחת העברה בפועל.':'הפער הוא צפוי פחות רשום, עם סימן; עודף רשום אינו קובע גביית יתר. רכיב עובד, תגמולי מעסיק ופיצויים נפרדים, ואין הוכחת העברה בפועל.',calculation:compared});
 }
 if(input.recorded.some(r=>r.share==='combined_employer'))gaps.push(gap(input,'pension.combined_employer_split','unknown','הסכום המשולב של המעסיק נשמר כפי שנרשם. נדרש פירוט מקור כדי להשוות תגמולים ופיצויים בנפרד; לא נפצל לפי שיעורי החוק.',[`${input.check_prefix}.employer.comparison`,`${input.check_prefix}.severance.comparison`],'recorded.combined_employer','missing_source'));
 return finish();
}
