import {canonicalSha256,deepFreeze} from '../rule-runtime/canonical.ts';
import type {DocumentReviewSource} from '../document-review/calculations.ts';
import {pensionLegalSource,PENSION_SOURCE_REVIEW_SHA256} from '../entitlement-review/pension/sources.ts';
import {travelLegalSource,TRAVEL_SOURCE_REVIEW_SHA256} from '../entitlement-review/travel/sources.ts';
import {vacationLegalSource,VACATION_SOURCE_REVIEW_SHA256} from '../entitlement-review/vacation/sources.ts';
import {minimumWageLegalSource,MINIMUM_WAGE_SOURCE_REVIEW_SHA256} from '../entitlement-review/minimum-wage/source-policy.ts';
import {workingTimeLegalSource,WORKING_TIME_SOURCE_REVIEW,WORKING_TIME_SOURCE_REVIEW_SHA256} from '../entitlement-review/working-time/source-policy.ts';
import {convalescenceLegalSource,CONVALESCENCE_SOURCE_REVIEW_SHA256} from '../entitlement-review/convalescence/source-policy.ts';

export type DecisionBranch='pension'|'travel'|'vacation'|'minimum_wage'|'working_time'|'convalescence';
function weeklyInterpretationSource():DocumentReviewSource{
 const source=WORKING_TIME_SOURCE_REVIEW.sources.find(s=>s.key==='weekly_judgment');
 if(!source)throw Error('AI_DECISION_WEEKLY_SOURCE_REQUIRED');
 return {document_id:source.document_id,version_id:source.version_id,file_sha256:source.file_sha256,page:1,
  locator:'עותק פסק הדין המלא; מיקום הסעיף נבחן בקבלת הפרשנות, ללא טענה שזהו עמוד הסעיף',label:source.label,
  reading:'source_research',reading_receipt_sha256:WORKING_TIME_SOURCE_REVIEW_SHA256};
}
function recipe(branch:DecisionBranch,decision_id:string,method:string,paths:string[],source_policy_sha256:string,law:DocumentReviewSource[]){
 const body={schema_version:'ai-release-decision-recipe-v1' as const,recipe_id:'ai-method.'+decision_id,recipe_version:'1' as const,
  branch,decision_id,method,consumed_paths:paths,source_policy_sha256,legal_sources:law,
  supported_period:{from:'2026-05-01',to:'2026-07-31'},actor_kind:'ai_reviewer' as const,human_attestation:null};
 return deepFreeze({...body,recipe_sha256:canonicalSha256(body)});
}
function minimumCaseRecipe(decision_id:string,method:string,paths:string[],page:number,locator:string){
 const ordinary=recipe('minimum_wage',decision_id,method,paths,MINIMUM_WAGE_SOURCE_REVIEW_SHA256,[minimumWageLegalSource(0,page,locator),minimumWageLegalSource(1,3,'שבוע העבודה 42 שעות; בחירת ענף מוצר מפורש')]);
 const {recipe_sha256:prior,...body}=ordinary;void prior;
 const candidate={...body,recipe_id:'ai-case.'+decision_id,case_predicate:'minimum-wage-case-facts-v1' as const,
  source_context_paths:['documents','checks']};
 return deepFreeze({...candidate,recipe_sha256:canonicalSha256(candidate)});
}
function pensionCaseRecipe(decision_id:string,method:string,paths:string[],locator:string){
 const ordinary=recipe('pension',decision_id,method,paths,PENSION_SOURCE_REVIEW_SHA256,[pensionLegalSource('order2011',3,locator)]);
 const {recipe_sha256:prior,...body}=ordinary;void prior;
 const candidate={...body,recipe_id:'ai-case.'+decision_id,case_predicate:'pension-case-facts-v1' as const};
 return deepFreeze({...candidate,recipe_sha256:canonicalSha256(candidate)});
}
function travelCaseRecipe(decision_id:string,method:string,paths:string[],page:number,locator:string){
 const ordinary=recipe('travel',decision_id,method,paths,TRAVEL_SOURCE_REVIEW_SHA256,[travelLegalSource(page,locator)]);
 const {recipe_sha256:prior,...body}=ordinary;void prior;
 const candidate={...body,recipe_id:'ai-case.'+decision_id,case_predicate:'travel-case-facts-v1' as const};
 return deepFreeze({...candidate,recipe_sha256:canonicalSha256(candidate)});
}
export const AI_RELEASE_DECISION_RECIPES=deepFreeze([
 recipe('pension','pension.rounding','half_up_per_component_per_month',['period','facts.aged_21_or_more','facts.under_60','pensionable_wage'],PENSION_SOURCE_REVIEW_SHA256,[pensionLegalSource('order2011',4,'סעיף 6; שיטת העיגול היא בחירת פרשנות נפרדת')]),
 recipe('travel','travel.rounding','half_up_final_period_agora',['period','commute_days','discounted_daily_fare'],TRAVEL_SOURCE_REVIEW_SHA256,[travelLegalSource(1,'סעיפים 2–3; שיטת העיגול אינה הוראה מפורשת בצו')]),
 recipe('vacation','vacation.pay_rounding','hourly_quarter_half_up_once',['period','leave_pay.mode','leave_pay.wage','leave_pay.leave_calendar_days'],VACATION_SOURCE_REVIEW_SHA256,[vacationLegalSource('law',3,'סעיף 10; עיגול חד פעמי לפי שיטת החישוב שנבדקה')]),
 recipe('minimum_wage','mw.method','explicit_method_only_no_best_result_selection',['period','method','employment'],MINIMUM_WAGE_SOURCE_REVIEW_SHA256,[minimumWageLegalSource(0,1,'השיטה המפורשת שנבחרה נבחנת בנפרד מהתעריף המפורסם')]),
 recipe('minimum_wage','mw.rounding','exact_full_month_or_half_up_final_by_explicit_method',['period','method','employment'],MINIMUM_WAGE_SOURCE_REVIEW_SHA256,[minimumWageLegalSource(0,1,'שיטת עיגול לפי ענף מפורש; אין החלפת דיוק בין השיטות')]),
 recipe('working_time','wt.rounding','half_up_per_day_and_allocated_rate_group',['period','arrangement','regular_hourly_wage'],WORKING_TIME_SOURCE_REVIEW_SHA256,[workingTimeLegalSource('law',3,'סעיפים 16–17; שיטת עיגול נפרדת')]),
 recipe('working_time','wt.weekly_aggregation','daily_ot_excluded_then_weekly_regular_threshold_no_double_count',['period','arrangement','week_start','week_inventory','workdays'],WORKING_TIME_SOURCE_REVIEW_SHA256,[workingTimeLegalSource('law',3,'סעיף 16'),workingTimeLegalSource('week',1,'קיצור שבוע העבודה; הקצאת שעות לפי הפרשנות שנבדקה'),weeklyInterpretationSource()]),
 recipe('working_time','wt.rest_additive','base_plus_ot_increment_plus_rest_increment',['period','arrangement','rest_window','workdays'],WORKING_TIME_SOURCE_REVIEW_SHA256,[workingTimeLegalSource('law',3,'סעיפים 16–17'),workingTimeLegalSource('rest',1,'מקור הפסיקה הארכיוני; לא אימות חדש באתר בית המשפט')]),
 recipe('convalescence','cv.rate_2026','451_50_benefit_year_2026_no_inferred_2025_day_deduction',['period','population','benefit_year'],CONVALESCENCE_SOURCE_REVIEW_SHA256,[convalescenceLegalSource(1,'תחולת תעריף שנת הבראה 2026 לפי פרשנות שנבדקה'),convalescenceLegalSource(2,'הוראות 2025 ותחולת העדכון לשנת 2026')]),
 recipe('convalescence','cv.proration','calendar_service_year_slices_constant_fte',['period','employment_start','qualifying_service','segments'],CONVALESCENCE_SOURCE_REVIEW_SHA256,[convalescenceLegalSource(0,'חלקיות; בחירת יחס ימים קלנדריים היא פרשנות חישוב נפרדת')]),
 recipe('convalescence','cv.rounding','half_up_once_after_all_segments',['period','population','benefit_year','segments'],CONVALESCENCE_SOURCE_REVIEW_SHA256,[convalescenceLegalSource(0,'שיטת עיגול נפרדת לאחר שקלול כל המקטעים')]),
 minimumCaseRecipe('mw.population','explicit_employee_private_age21_59_no_adapted_or_special_arrangement',['period','product_facts'],1,'תחולת מסגרת השכר הכללית; גיל 21–59 הוא גבול המוצר, לא גיל הזכאות שבחוק'),
 minimumCaseRecipe('mw.ordinary_scope','explicit_hourly_42_published_182_same_source_ordinary_hours',['period','product_facts','ordinary_hours','ordinary_hours_period'],1,'מסגרת שעתית שנבחרה מראש, בלי פרורציה חודשית או בחירת התוצאה הגבוהה'),
 minimumCaseRecipe('mw.eligible_components','single_explicit_base_component_printed_inventory_only',['period','components','eligible_pay_inventory'],1,'סעיף 3 — רכיב בסיס מפורש יחיד; שלמות המקור הרשום אינה הוכחת תשלומים מחוץ לתלוש'),
 minimumCaseRecipe('mw.allocation','single_component_exact_payslip_period_without_reused_payment',['period','components','ordinary_hours','ordinary_hours_period','eligible_pay_inventory'],1,'סעיף 3 — שיוך רכיב ושעות לאותה תקופה; אין צירוף תשלום ממקור אחר'),
 pensionCaseRecipe('pension.general_coverage','explicit_employee_private_age21_59',['period','product_facts','facts.aged_21_or_more','facts.under_60'],'סעיפים 2–4; גיל 21–59 ומגזר פרטי הם גבול ענף המוצר, לא אישור להסדר מיטיב או לבסיס השכר'),
 pensionCaseRecipe('pension.pension_fund','identified_source_pension_product_not_customer_classification',['period','product_facts.pension_product','recorded'],'סוג המוצר הפנסיוני מזוהה במקור; אין סיווג קרן מתוך הצהרה בלבד'),
 travelCaseRecipe('travel.general_coverage','explicit_private_employee_and_source_selected_uniform_route',['period','product_facts.employment_relationship','product_facts.workplace_sector','facts','commute_days'],1,'רישת הצו וסעיף 3 — עובד שכיר במגזר הפרטי וצורך/הגעה מזוהים; אין אישור להסדר מיטיב'),
 travelCaseRecipe('travel.fare_basis','identified_standard_adult_route_tariff_group_exact_daily_cell',['period','product_facts','facts','commute_days','fare_source_context','discounted_daily_fare'],2,'סעיף 4 — תעריף מוזל מזוהה למסלול ולתקופה; פרופיל הנחה, כיוונים ושיוך מקור נבדקים בנפרד'),
 travelCaseRecipe('travel.ticket_options','identified_complete_same_route_ticket_inventory_and_monthly_availability',['period','product_facts','facts','commute_days','fare_source_context','discounted_daily_fare','monthly_pass','monthly_pass_cost'],2,'סעיף 4 — מלאי כרטיסים שלם וזמינות מנוי מתאימים במקור; מחיר חסר אינו היעדר מנוי'),
]);
export type AiReleaseDecisionRecipe=(typeof AI_RELEASE_DECISION_RECIPES)[number];
