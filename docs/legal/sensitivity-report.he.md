# דוח רגישות — מה כל תשובה משנה

מסמך זה **אינו מכריע** באף שאלה משפטית ואינו ממליץ על תשובה. הוא מציג, לכל
תרחיש, מה כל אחת מהאפשרויות מחשבת ומה ההפרש ביניהן. שום מספר כאן לא הוקלד
מחדש: כולם נלקחים מקובץ ה־JSON שממנו נוצר המסמך.

המסמך נוצר אוטומטית מ־`decision-sensitivity-report-v5.json` (`d713ba18d75769fb…`).
כל הנתונים הם סביבת DEV. אין כאן נתוני לקוחות, אין מקור מאושר ואין פרמטר פעיל.

הערות ההנדסה מצוטטות באנגלית כלשונן, בדיוק כפי שהן מופיעות בקובץ המקור.
תרגומן כאן היה כתיבה מחדש של תוכן, ולא העתקה שלו.

---

## 1. מה נבדק

| מדד | ערך |
|---|---|
| תרחישים שנוסו | 96 |
| תרחישים שרצו | 80 |
| תרחישים שסורבו סירוב סגור | 16 |
| עקבות חישוב שנשמרו | 80 |
| עקבות ששוחזרו מהמסד בית־בבית | 80 |
| נושאים שרצו | 7 מתוך 7 |

---

## 2. שכר מינימום — `legal.reference.il.decision.min_wage_hourly_divisor`

השאלה הפתוחה מפרידה בין **182** לבין **186**.
מתוך 6 תרחישים רצו 5, ומהם 5 מפרידים בין האפשרויות.

דירוג מקור של הפרמטרים בשאלה זו: **אומת בטקסט** (`text_verified`).

| תרחיש | 182 | 186 | הפרש |
|---|---|---|---|
| מצב רגיל | 6442.80 ILS | 6304.48 ILS | 138.32 ILS |
| גבול תחולה | 6442.80 ILS | 6304.48 ILS | 138.32 ILS |
| עובדה חסרה או סותרת | לא רץ | לא רץ | RULESPEC_INPUT_MISSING |
| גבול עיגול או גבול הטבלה | 5057.14 ILS | 4948.57 ILS | 108.57 ILS |
| חפיפת מקורות | 6584.40 ILS | 6443.04 ILS | 141.36 ILS |
| ענף ואוכלוסייה | 3221.40 ILS | 3152.24 ILS | 69.16 ILS |

---

## 3. פנסיה — `legal.reference.il.decision.pension_wage_cap_section`

השאלה הפתוחה מפרידה בין **section1** לבין **section2**.
מתוך 6 תרחישים רצו 5, ומהם 5 מפרידים בין האפשרויות.

דירוג מקור של הפרמטרים בשאלה זו: **אומת בטקסט** (`text_verified`).

הערת היקף: Binds only the mandatory wage cap. The full pension draft also needs il.pension.employee_contribution_rate — registered at 2014.1.0 in L4-1 from the 2011 order's own table, but that instrument's last row is 2014 and whether a later instrument governs is the open precedence question, so this spec does not reach for it.

| תרחיש | section1 | section2 | הפרש |
|---|---|---|---|
| מצב רגיל | 13566.00 ILS | 13769.00 ILS | 203.00 ILS |
| גבול תחולה | 13566.00 ILS | 13769.00 ILS | 203.00 ILS |
| עובדה חסרה או סותרת | לא רץ | לא רץ | RULESPEC_INPUT_MISSING |
| גבול עיגול או גבול הטבלה | 4522.00 ILS | 4589.67 ILS | 67.67 ILS |
| חפיפת מקורות | 13566.00 ILS | 13769.00 ILS | 203.00 ILS |
| ענף ואוכלוסייה | 6783.00 ILS | 6884.50 ILS | 101.50 ILS |

---

## 4. דמי הבראה — `legal.reference.il.decision.convalescence_2026_rate_period`

השאלה הפתוחה מפרידה בין **calendar_year_2026** לבין **from_signature_2026_07**.
מתוך 6 תרחישים רצו 5, ומהם 0 מפרידים בין האפשרויות.

דירוג מקור של הפרמטרים בשאלה זו: **בתוך בחירת מסמך** (`selection`).

הערת היקף: The day rate the 2026 order states, 451.50, cited into the instrument selection over the 2026 gazette issue; the 2023 order's 418 is registered beside it from its own selection. The open decision is the period the 2026 rate covers — the order says 'for the convalescence year 2026' and is signed in July — and both branches carry the same figure, so no scenario separates them in amount. The full draft also needs the seniority-band day counts, which are not in the corpus.

| תרחיש | calendar_year_2026 | from_signature_2026_07 | הפרש |
|---|---|---|---|
| מצב רגיל | 2257.50 ILS | 2257.50 ILS | 0.00 ILS |
| גבול תחולה | 2257.50 ILS | 2257.50 ILS | 0.00 ILS |
| עובדה חסרה או סותרת | לא רץ | לא רץ | RULESPEC_INPUT_MISSING |
| גבול עיגול או גבול הטבלה | 752.50 ILS | 752.50 ILS | 0.00 ILS |
| חפיפת מקורות | 3160.50 ILS | 3160.50 ILS | 0.00 ILS |
| ענף ואוכלוסייה | 2709.00 ILS | 2709.00 ILS | 0.00 ILS |

---

## 5. שעות עבודה ומנוחה — `legal.reference.il.decision.rest_day_overtime_composition`

השאלה הפתוחה מפרידה בין **additive** לבין **multiplicative**.
מתוך 6 תרחישים רצו 5, ומהם 5 מפרידים בין האפשרויות.

דירוג מקור של הפרמטרים בשאלה זו: **נקרא מתמונת העמוד — ממתין לאימות חזותי** (`inferred_visual`).
inferred_visual: המספר נקרא מתמונת העמוד הסרוק, משום ששכבת הטקסט של המסמך מעורפלת או חסרה; הוא ממתין לאימות חזותי של אדם מול אותו עמוד, ולא ניתן לאשרו בלי אימות כזה.

הערת היקף: The additive reading: the rest premium plus the overtime increment. 175% and 200% appear as outputs of the executor, never as figures in a source. The multiplicative reading: the rest premium times the overtime premium — 187.5% and 225%, again outputs and not figures.

| תרחיש | additive | multiplicative | הפרש |
|---|---|---|---|
| מצב רגיל | 165.00 ILS | 180.00 ILS | 15.00 ILS |
| גבול תחולה | 105.00 ILS | 112.50 ILS | 7.50 ILS |
| עובדה חסרה או סותרת | לא רץ | לא רץ | RULESPEC_INPUT_MISSING |
| גבול עיגול או גבול הטבלה | 58.33 ILS | 62.49 ILS | 4.16 ILS |
| חפיפת מקורות | 225.00 ILS | 247.50 ILS | 22.50 ILS |
| ענף ואוכלוסייה | 52.50 ILS | 56.25 ILS | 3.75 ILS |

---

## 6. פנסיה — `legal.reference.il.decision.pension_2011_2016_precedence`

השאלה הפתוחה מפרידה בין **order_2011_2014_row** לבין **order_2016_2017_rates**.
מתוך 6 תרחישים רצו 5, ומהם 5 מפרידים בין האפשרויות.

דירוג מקור של הפרמטרים בשאלה זו: **נקרא מתמונת העמוד — ממתין לאימות חזותי** (`inferred_visual`).
inferred_visual: המספר נקרא מתמונת העמוד הסרוק, משום ששכבת הטקסט של המסמך מעורפלת או חסרה; הוא ממתין לאימות חזותי של אדם מול אותו עמוד, ולא ניתן לאשרו בלי אימות כזה.

הערת היקף: Binds the employee share under the precedence decision and pins the wage cap to its section-1 version so the spec carries one decision; the cap's own decision runs in the cap spec. The 2017 share is a visual citation of an image-only scan (inferred_visual).

| תרחיש | order_2011_2014_row | order_2016_2017_rates | הפרש |
|---|---|---|---|
| מצב רגיל | 746.13 ILS | 813.96 ILS | 67.83 ILS |
| גבול תחולה | 746.13 ILS | 813.96 ILS | 67.83 ILS |
| עובדה חסרה או סותרת | לא רץ | לא רץ | RULESPEC_INPUT_MISSING |
| גבול עיגול או גבול הטבלה | 248.71 ILS | 271.32 ILS | 22.61 ILS |
| חפיפת מקורות | 746.13 ILS | 813.96 ILS | 67.83 ILS |
| ענף ואוכלוסייה | 373.07 ILS | 406.98 ILS | 33.91 ILS |

---

## 7. דירוג המקור של כל פרמטר

כל פרמטר שנקשר בדוח נושא דירוג מקור. הדירוג אומר מאין הגיע המספר, לא אם הוא נכון.

inferred_visual: המספר נקרא מתמונת העמוד הסרוק, משום ששכבת הטקסט של המסמך מעורפלת או חסרה; הוא ממתין לאימות חזותי של אדם מול אותו עמוד, ולא ניתן לאשרו בלי אימות כזה.

| פרמטר | דירוג | קריאה חזותית | עמוד (sha256) |
|---|---|---|---|
| `il.convalescence.daily_rate@2026.1.0` | בתוך בחירת מסמך (`selection`) | — | — |
| `il.convalescence.daily_rate@2026.2.0` | בתוך בחירת מסמך (`selection`) | — | — |
| `il.convalescence.days_year_1@1988.1.0` | אומת בטקסט (`text_verified`) | — | — |
| `il.convalescence.days_years_11_to_15@1988.1.0` | אומת בטקסט (`text_verified`) | — | — |
| `il.convalescence.days_years_16_to_19@1988.1.0` | אומת בטקסט (`text_verified`) | — | — |
| `il.convalescence.days_years_2_to_3@1988.1.0` | אומת בטקסט (`text_verified`) | — | — |
| `il.convalescence.days_years_20_and_above@1988.1.0` | אומת בטקסט (`text_verified`) | — | — |
| `il.convalescence.days_years_4_to_10@1988.1.0` | אומת בטקסט (`text_verified`) | — | — |
| `il.minimum_wage.daily_5day@2026.1.0` | אומת בטקסט (`text_verified`) | — | — |
| `il.minimum_wage.hourly@2026.1.0` | אומת בטקסט (`text_verified`) | — | — |
| `il.minimum_wage.hourly@2026.2.0` | אומת בטקסט (`text_verified`) | — | — |
| `il.pension.employee_contribution_rate@2014.2.0` | אומת בטקסט (`text_verified`) | — | — |
| `il.pension.employee_contribution_rate@2017.1.0` | נקרא מתמונת העמוד — ממתין לאימות חזותי (`inferred_visual`) | 6% | bfba6c9e3b55508a… |
| `il.pension.mandatory_wage_cap@2026.1.0` | אומת בטקסט (`text_verified`) | — | — |
| `il.pension.mandatory_wage_cap@2026.2.0` | אומת בטקסט (`text_verified`) | — | — |
| `il.sick_pay.accrual_cap_days@1.0.0` | אומת בטקסט (`text_verified`) | — | — |
| `il.sick_pay.accrual_days_per_month@1.0.0` | אומת בטקסט (`text_verified`) | — | — |
| `il.sick_pay.rate_days_2_to_3@1.0.0` | מילה שנקראה דרך הלקסיקון (`lexicon`) | — | — |
| `il.travel.daily_reimbursement_cap@2016.1.0` | אומת בטקסט (`text_verified`) | — | — |
| `il.vacation.calendar_days_increment_per_year_from_year_8@1951.1.0` | מילה שנקראה דרך הלקסיקון (`lexicon`) | — | — |
| `il.vacation.calendar_days_year_6@1951.1.0` | אומת בטקסט (`text_verified`) | — | — |
| `il.vacation.calendar_days_year_7@1951.1.0` | אומת בטקסט (`text_verified`) | — | — |
| `il.vacation.calendar_days_years_1_to_5@2017.1.0` | אומת בטקסט (`text_verified`) | — | — |
| `il.vacation.calendar_days_years_8_and_above_cap@1951.1.0` | אומת בטקסט (`text_verified`) | — | — |
| `il.working_time.overtime_rate_first_tier@1951.1.0` | נקרא מתמונת העמוד — ממתין לאימות חזותי (`inferred_visual`) | 1¼ | 6b41df8306ce4c60… |
| `il.working_time.overtime_rate_second_tier@1951.1.0` | נקרא מתמונת העמוד — ממתין לאימות חזותי (`inferred_visual`) | 1½ | 6b41df8306ce4c60… |
| `il.working_time.weekly_rest_rate@1951.1.0` | נקרא מתמונת העמוד — ממתין לאימות חזותי (`inferred_visual`) | 1½ | 6b41df8306ce4c60… |

סיכום: בתוך בחירת מסמך — 2; אומת בטקסט — 19; נקרא מתמונת העמוד — ממתין לאימות חזותי — 4; מילה שנקראה דרך הלקסיקון — 2.

---

## 8. נושאים שלא רצו

כל שבעת הנושאים רצו.

| נושא | סיבה | משבצת | פירוט |
|---|---|---|---|

---

## 9. החלטות שנמשכו

שאלות אלה אינן פתוחות עוד. הן מופיעות כאן כדי שהרשימה תהיה מלאה, ולא כדי שיוכרעו.

| מזהה | נושא | סיבת המשיכה |
|---|---|---|
| `legal.reference.il.decision.vacation_minimum_days_threshold_200_vs_240.v2` | חופשה שנתית | Not a real disagreement between two candidate figures for one question — Annual Vacation Law §3(b) and §3(c) are two distinct thresholds for two distinct situations: 200 days governs an employment relationship spanning the full work-year, 240 days governs one spanning only part of it. Read directly, the primary text leaves nothing open to decide. Registered as two plain parameters (il.vacation.full_year_relationship_minimum_days_threshold, il.vacation.partial_year_relationship_minimum_days_threshold) instead of decision alternatives, per Pool P batch 5. |

---

## 10. היקף

Differences only, computed. This states what the answer to each open question changes in each scenario; it does not answer any of them, and nothing here is reviewed, attested or active.

