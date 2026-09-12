import {canonicalSha256,deepFreeze} from '../rule-runtime/canonical.ts';
import type {DocumentReviewSource} from '../document-review/calculations.ts';
import {pensionLegalSource,PENSION_SOURCE_REVIEW_SHA256,PENSION_FLOOR_SOURCE_REVIEW_SHA256} from '../entitlement-review/pension/sources.ts';
import {travelLegalSource,TRAVEL_SOURCE_REVIEW_SHA256} from '../entitlement-review/travel/sources.ts';
import {TRAVEL_GENERAL_ORDER_FLOOR_POLICY,TRAVEL_FLOOR_SOURCE_REVIEW_SHA256,travelFloorLegalSource} from '../entitlement-review/travel/floor-policy.ts';
import {vacationLegalSource,VACATION_SOURCE_REVIEW_SHA256} from '../entitlement-review/vacation/sources.ts';
import {minimumWageLegalSource,MINIMUM_WAGE_SOURCE_REVIEW_SHA256} from '../entitlement-review/minimum-wage/source-policy.ts';
import {workingTimeLegalSource,WORKING_TIME_SOURCE_REVIEW,WORKING_TIME_SOURCE_REVIEW_SHA256} from '../entitlement-review/working-time/source-policy.ts';
import {convalescenceLegalSource,CONVALESCENCE_SOURCE_REVIEW_SHA256} from '../entitlement-review/convalescence/source-policy.ts';
import {obligationLegalSource,OBLIGATIONS_SOURCE_REVIEW_SHA256} from '../entitlement-review/obligations/source-policy.ts';

export type DecisionBranch='pension'|'travel'|'vacation'|'minimum_wage'|'working_time'|'convalescence'|'obligations';
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
function convalescenceCaseRecipe(decision_id:string,method:string,paths:string[],laws:DocumentReviewSource[]){
 const ordinary=recipe('convalescence',decision_id,method,paths,CONVALESCENCE_SOURCE_REVIEW_SHA256,laws);
 const {recipe_sha256:prior,...body}=ordinary;void prior;
 const candidate={...body,recipe_id:'ai-case.'+decision_id,case_predicate:'convalescence-case-facts-v1' as const};
 return deepFreeze({...candidate,recipe_sha256:canonicalSha256(candidate)});
}
function vacationCaseRecipe(decision_id:string,method:string,paths:string[],page:number,locator:string){
 const ordinary=recipe('vacation',decision_id,method,paths,VACATION_SOURCE_REVIEW_SHA256,[vacationLegalSource('law',page,locator),vacationLegalSource('amendment15',1,'תיקון 15 — מכסת השנים הראשונות והתחילה; אינו אישור לתנאי המקרה')]);
 const {recipe_sha256:prior,...body}=ordinary;void prior;
 const candidate={...body,recipe_id:'ai-case.'+decision_id,case_predicate:'vacation-product-facts-v1' as const,source_context_paths:['documents','checks','answer_history']};
 return deepFreeze({...candidate,recipe_sha256:canonicalSha256(candidate)});
}
function workingTimeCaseRecipe(decision_id:string,method:string,paths:string[],laws:DocumentReviewSource[],perDay=false){
 const ordinary=recipe('working_time',decision_id,method,paths,WORKING_TIME_SOURCE_REVIEW_SHA256,laws);
 const {recipe_sha256:prior,...body}=ordinary;void prior;
 const candidate={...body,recipe_id:'ai-case.'+decision_id,case_predicate:'working-time-product-facts-v2' as const,
  decision_scope:perDay?'exact_workday_id_v2_or_historical_scope_v1' as const:'source_week' as const,source_context_paths:['documents','non_payslip_evidence','answer_history']};
 return deepFreeze({...candidate,recipe_sha256:canonicalSha256(candidate)});
}
function obligationCaseRecipe(decision_id:string,method:string,paths:string[]){
 const ordinary=recipe('obligations',decision_id,method,paths,OBLIGATIONS_SOURCE_REVIEW_SHA256,[
  obligationLegalSource('prior',381,'סעיפים 1–6 — הצעה וקיבול בהודעה או בהתנהגות; אין קיבול מכוח שתיקה'),
  obligationLegalSource('amendment2',2,'סעיף 25(א), (ב1) בנוסח תיקון2; אינו מוחל מכוח חודש התלוש'),
  obligationLegalSource('amendment3',2,'סעיף 25(א)(4) לחוזה עבודה והוראת תחולה סעיף2; נסיבות המקרה נבדקות בנפרד'),
 ]);
 const {recipe_sha256:prior,...body}=ordinary;void prior;
 const candidate={...body,recipe_id:'ai-case.'+decision_id,case_predicate:'explicit-obligations-case-policy-v2' as const,
  decision_scope:'exact_obligation_id_and_clause' as const,source_context_paths:['documents','non_payslip_evidence','answer_history']};
 return deepFreeze({...candidate,recipe_sha256:canonicalSha256(candidate)});
}
const historicalRecipes=deepFreeze([
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
 convalescenceCaseRecipe('cv.benefit_year','explicit_benefit_year_2026_and_source_payment_coverage',['period','evaluated_at','benefit_year','payment_coverage'],[convalescenceLegalSource(1),convalescenceLegalSource(2)]),
 convalescenceCaseRecipe('cv.qualifying_service','completed_first_year_continuous_service_complete_positive_fte_segments',['period','employment_start','qualifying_service','payment_coverage','due_date','segments'],[convalescenceLegalSource(0,'סעיפים 4–5 — השלמת שנה, רציפות וחלקיות לפי תקופות מקור מפורשות')]),
 convalescenceCaseRecipe('cv.due_date','explicit_due_date_in_selected_payroll_month_not_summer_default',['period','employment_start','payment_coverage','due_date'],[convalescenceLegalSource(0,'סעיף 6 — מועד מפורש ומזוהה; אין בחירת חודש אוטומטית בטווח הקיץ')]),
 convalescenceCaseRecipe('cv.allocation','identified_complete_recorded_inventory_exact_accrual_period',['period','payment_coverage','recorded','recorded_coverage','recorded_inventory'],[convalescenceLegalSource(0,'שיוך רישום לתקופת צבירה מזוהה; אין הוכחת העברה בפועל')]),
 convalescenceCaseRecipe('cv.population','v2_explicit_employee_private_without_public_wage_linkage_product_age21_59',['period','source_gates_policy','product_facts.birth_date','product_facts.employment_relationship','product_facts.workplace_sector','product_facts.employment_category','product_facts.public_wage_linked'],[convalescenceLegalSource(0,'תחולת המגזר הפרטי; גיל 21–59 הוא גבול מוצר מפורש ולא תנאי בצו')]),
 convalescenceCaseRecipe('cv.legal_source_chain','v2_complete_pinned_2016_2026_2025_chain_after_publication_separate_arrangement',['period','evaluated_at','source_gates_policy'],[convalescenceLegalSource(0),convalescenceLegalSource(1),convalescenceLegalSource(2)]),
 convalescenceCaseRecipe('cv.arrangement_scope','v2_existing_positive_current_contract_classification_not_negative_awareness',['period','source_gates_policy','applicability#cv.source_chain','product_facts.special_terms_known'],[convalescenceLegalSource(0,'הסדר כללי או מיטיב דורש הערכת מקור נפרדת; חוסר ידיעה אינו הוכחת היעדר זכויות')]),
 vacationCaseRecipe('vacation.general_section3','explicit_employee_private_product_age21_59_salary_basis_and_section4_boundary',['period','product_facts.birth_date','product_facts.employment_relationship','product_facts.workplace_sector','product_facts.salary_basis','product_facts.continuous_employment','annual_basis.employment_start'],1,'סעיפים 1, 3 ו־4 — סוג ההעסקה ותקופה רציפה מפורשת; גיל 21–59 הוא גבול המוצר'),
 vacationCaseRecipe('vacation.seniority_basis','same_employer_calendar_seniority_from_pinned_start_or_replayed_source_witness',['period','calendar_year','seniority_year','annual_basis.employment_start','product_facts.same_employer_or_workplace'],1,'סעיפים 1 ו־3 — שנת העבודה אצל אותו מעסיק או מקום עבודה; ללא יצירת קריאת ותק פיקטיבית'),
 vacationCaseRecipe('vacation.annual_workdays','replayed_complete_annual_classified_workday_inventory',['period','evaluated_at','annual_basis'],1,'סעיף 3 — מלאי ימי עבודה שנתי מסווג ושלם; אין חלוקה שרירותית לחודש'),
 vacationCaseRecipe('vacation.pay_calendar_days','replayed_exact_leave_days_after_source_bound_exclusions',['period','leave_pay.mode','leave_pay.leave_period','leave_pay.leave_calendar_days'],2,'סעיפים 3 ו־5 — ימי החופשה בתקופה לאחר בדיקת ההחרגות; אין המרת יתרה לימי חופשה שנוצלו'),
 vacationCaseRecipe('vacation.pay_quarter_selection','replayed_preceding_full_quarter_or_explicit_fullest_quarter_inventory',['period','leave_pay.mode','leave_pay.leave_period','leave_pay.quarter_period'],3,'סעיף 10(ב)(2) — בחירת רבע השנה לפי המקורות המזוהים, בלי לבחור סכום לצורך התוצאה'),
 vacationCaseRecipe('vacation.pay_monthly_period','replayed_monthly_wage_if_worked_same_leave_period',['period','leave_pay.mode','leave_pay.leave_period','leave_pay.wage'],3,'סעיף 10(ב)(1) — השכר שהיה משתלם באותה תקופת חופשה; אינו כל שכר חודשי בתלוש'),
 vacationCaseRecipe('vacation.pay_recorded_allocation','replayed_exclusive_payment_for_exact_leave_period',['period','leave_pay.leave_period','leave_pay.recorded'],3,'סעיף 10(א) — שיוך רישום תשלום לאותם ימי חופשה; אין אישור העברה בפועל'),
 workingTimeCaseRecipe('wt.coverage','explicit_private_hourly_product_population_duties_and_tracking_boundaries',['period','week_start','calculation_policy','product_facts'],[workingTimeLegalSource('law',6,'סעיף 30 — גבולות התחולה נבחנים מנתוני המקרה; גיל 21–59 הוא גבול המוצר'),workingTimeLegalSource('week',1,'הסדר השבוע הפרטי הנתמך; אין אישור גורף להסדרים מיוחדים')]),
 workingTimeCaseRecipe('wt.regular_wage','identified_complete_regular_hourly_wage_composition_exact_period',['period','week_start','calculation_policy','regular_hourly_wage','product_facts.regular_wage_basis'],[workingTimeLegalSource('law',3,'סעיף 18 — הרכב השכר הרגיל לפי מקור מזוהה'),workingTimeLegalSource('rest',1,'עותק פסק הדין המלא; הבחנת תוספת חוזית לפי הפניות קבלת הפרשנות, ללא אימות חדש באתר בית המשפט')]),
 workingTimeCaseRecipe('wt.arrangement','identified_explicit_schedule_daily_limit_and_source_day_no_42_division',['period','week_start','calculation_policy','arrangement','scheduled_weekdays','workdays'],[workingTimeLegalSource('law',1,'סעיפים 2–3 — מגבלה יומית לפי ההסדר והיום'),workingTimeLegalSource('week',1,'שבוע בן 42 שעות אינו קובע לבדו מגבלה יומית או יום מקוצר')],true),
 workingTimeCaseRecipe('wt.workday_assignment','identified_exact_clock_rows_and_explicit_multi_interval_day_association',['period','week_start','calculation_policy','workdays','product_facts.assignment_witnesses'],[workingTimeLegalSource('law',1,'זהות יום העבודה ומקטעיו מזוהה במקור; אין איחוד משמרות מכוח הפסקה קצרה בלבד'),workingTimeLegalSource('week',1,'שיוך רישום ליום העבודה בהסדר המזוהה')],true),
 workingTimeCaseRecipe('wt.payroll_allocation','identified_complete_same_day_payment_allocation_without_reused_rows',['period','week_start','calculation_policy','workdays'],[workingTimeLegalSource('law',3,'סעיפים 16–17 — השוואה לרישום שהוקצה לאותו יום; אין הוכחת תשלום או חלוקה שווה אוטומטית')],true),
 workingTimeCaseRecipe('wt.worked_time','identified_clock_duration_and_explicit_work_break_classification_per_day',['period','week_start','calculation_policy','workdays'],[workingTimeLegalSource('law',1,'הגדרת שעות עבודה בסעיף 1; סיווג נוכחות והפסקות מתוך עובדות המקור')],true),
 obligationCaseRecipe('obligation.clause_interpretation','whole_literal_expression_with_identified_agreement_context_not_binding_by_ocr',['period','clause','promise','product_facts','source_witness.literal_promise']),
 obligationCaseRecipe('obligation.agreement_binding','positive_exact_source_acceptance_matching_authentic_case_context',['period','clause','product_facts','source_witness.agreement_acceptance']),
 obligationCaseRecipe('obligation.payment_scope','identified_whole_month_and_same_period_quantity_no_proration',['period','clause','payment_period','promise','source_witness.payment_period']),
 obligationCaseRecipe('obligation.complete_conditions','positive_closed_source_inventory_not_empty_extraction',['period','clause','condition_inventory','source_witness.complete_conditions']),
 obligationCaseRecipe('obligation.rounding','fixed_or_linear_exact_agora_without_rounding_effect',['period','promise','source_witness.payment_period']),
]);
// Additive recipes retain the exact historical bodies and hashes. Selection
// requires the versioned source packet; a descriptor alone cannot upgrade it.
function ageRangeRecipe(parentId:string){
 const parent=historicalRecipes.find(r=>r.recipe_id===parentId);
 if(!parent)throw Error('AI_AGE_RECIPE_PARENT_REQUIRED');
 const {recipe_sha256,...body}=parent;void recipe_sha256;
 const candidate={...body,recipe_id:parent.recipe_id+'.age-range-v1',
  parent_recipe_sha256:parent.recipe_sha256,age_range_policy:'questionnaire-age-range-reuse-v1' as const,
  case_predicate:'questionnaire-age-range-case-v1' as const,
  method:parent.method+'_or_authenticated_questionnaire_age_interval_without_invented_birth_date',
  consumed_paths:[...parent.consumed_paths,'product_age_range'],
  source_context_paths:['documents','checks','entitlement_declarations','answer_history']};
 return deepFreeze({...candidate,recipe_sha256:canonicalSha256(candidate)});
}
function pensionFloorRecipe(decision_id:string,method:string,paths:string[],page:number,locator:string){
 const ordinary=recipe('pension',decision_id,method,paths,PENSION_FLOOR_SOURCE_REVIEW_SHA256,[
  pensionLegalSource('order2011',page,locator),
  pensionLegalSource('order2016',2,'סעיף 3 — שיעורי מינימום לפי המוצר המזוהה; הסדר מיטיב נשאר בלתי מוכרע'),
  ...(decision_id==='pension.statutory_floor'?[pensionLegalSource('order2016',1,'סעיף 2(א) — השכר לפי ההסכם ולא פחות מבסיס פנסיית החובה; רצפה אינה אישור למלוא ההסדר')]:[]),
 ]);
 const {recipe_sha256,...body}=ordinary;void recipe_sha256;
 const candidate={...body,recipe_id:'ai-case.'+decision_id+'.floor-v2',case_predicate:'pension-statutory-floor-case-v2' as const,
  calculation_policy:'pension-statutory-floor-v2' as const,source_context_paths:['documents','non_payslip_evidence','answer_history'],
  complete_arrangement_compliance_assessed:false,zero_difference_establishes_compliance:false};
 return deepFreeze({...candidate,recipe_sha256:canonicalSha256(candidate)});
}
function travelFloorRecipe(decision_id:string,method:string,paths:string[],locator:string){
 const ordinary=recipe('travel',decision_id,method,paths,TRAVEL_FLOOR_SOURCE_REVIEW_SHA256,[travelLegalSource(1,locator),travelFloorLegalSource('סעיף 30(א)–(ב) — הנוסח המקורי; קבלה נפרדת נדרשת לעדכניות ולפרשנות')]);
 const {recipe_sha256,...body}=ordinary;void recipe_sha256;
 const candidate={...body,recipe_id:'ai-case.'+decision_id+'.floor-v2',case_predicate:'travel-general-order-floor-case-v2' as const,calculation_policy:TRAVEL_GENERAL_ORDER_FLOOR_POLICY,
  complete_arrangement_compliance_assessed:false,zero_difference_establishes_compliance:false,current_source_and_interpretation_admission_required:true};
 return deepFreeze({...candidate,recipe_sha256:canonicalSha256(candidate)});
}
export const AI_RELEASE_DECISION_RECIPES=deepFreeze([
 ...historicalRecipes,
 ...['ai-case.mw.population','ai-case.cv.population','ai-case.vacation.general_section3','ai-case.wt.coverage'].map(ageRangeRecipe),
 pensionFloorRecipe('pension.general_coverage','explicit_employee_private_product_age21_59_for_floor_only',['period','product_facts','facts.aged_21_or_more','facts.under_60'],3,'סעיפים 2–4 — אוכלוסייה; גיל 21–59 הוא גבול המוצר ואינו אישור לבסיס או להסדר מיטיב'),
 pensionFloorRecipe('pension.pension_fund','identified_pension_product_from_exact_current_relation_or_source_clause',['period','product_facts.pension_product','recorded','source_facts.arrangement'],4,'סעיף 6 — סוג המוצר לפי מקור מזוהה, לא סיווג לקוח'),
 pensionFloorRecipe('pension.pensionable_wage','identified_complete_component_basis_exact_period_and_operand',['period','pensionable_wage','eligible_interval_wage','source_facts'],4,'סעיף 6(ב)–(ג) — בסיס מזוהה לתקופה; אין אישור לתקרה חלקית או להסדר גבוה יותר'),
 pensionFloorRecipe('pension.prior_coverage_evidence','identified_prior_insurance_source_covers_actual_employment_start',['period','facts.employment_start','facts.prior_coverage_at_start','source_facts.prior_insurance'],4,'סעיף 6(ה) — מקור לביטוח קודם במועד תחילת העבודה; תזמון ההפקדה נבדק בנפרד'),
 pensionFloorRecipe('pension.statutory_floor','explicit_general_minimum_on_identified_base_not_complete_entitlement',['period','calculation_policy'],4,'סעיפים 5(א), 6 — רצפת 6% לפיצויים; אין הכרעה במלוא ההסדר או הוכחת העברה'),
 travelFloorRecipe('travel.general_coverage','explicit_private_employee_and_uniform_route_for_general_order_floor',['period','product_facts.employment_relationship','product_facts.workplace_sector','facts','commute_days'], 'רישת צו 2016 וסעיף 3 — תחום המוצר ועובדות ההגעה; לא מלוא ההסדר'),
 travelFloorRecipe('travel.fare_basis','identified_route_tariff_daily_cell_for_general_order_floor',['period','product_facts','facts','commute_days','fare_source_context','discounted_daily_fare'],'סעיף 4 — תעריף מוזל מתאים, תקופה וכיוונים מזוהים'),
 travelFloorRecipe('travel.ticket_options','identified_complete_ticket_inventory_for_general_order_floor',['period','product_facts','facts','commute_days','fare_source_context','discounted_daily_fare','monthly_pass','monthly_pass_cost'],'סעיף 4 — מלאי כרטיסים ומנוי מתאימים; חוסר אינו אי־זמינות'),
 travelFloorRecipe('travel.general_order_floor','current_source_assessed_general_order_floor_preserving_better_terms',['period','calculation_policy'],'רישת צו 2016 וסעיפים 2–4 — סכום במסלול הכללי בלבד'),
]);
export type AiReleaseDecisionRecipe=(typeof AI_RELEASE_DECISION_RECIPES)[number];
