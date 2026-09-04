# דוח רגישות — מה כל תשובה משנה

מסמך זה **אינו מכריע** באף שאלה משפטית ואינו ממליץ על תשובה. הוא מציג, לכל
תרחיש, מה כל אחת מהאפשרויות מחשבת ומה ההפרש ביניהן. שום מספר כאן לא הוקלד
מחדש: כולם נלקחים מקובץ ה־JSON שממנו נוצר המסמך.

המסמך נוצר אוטומטית מ־`decision-sensitivity-report-v3.json` (`277d6b5fbbd38969…`).
כל הנתונים הם סביבת DEV. אין כאן נתוני לקוחות, אין מקור מאושר ואין פרמטר פעיל.

הערות ההנדסה מצוטטות באנגלית כלשונן, בדיוק כפי שהן מופיעות בקובץ המקור.
תרגומן כאן היה כתיבה מחדש של תוכן, ולא העתקה שלו.

---

## 1. מה נבדק

| מדד | ערך |
|---|---|
| תרחישים שנוסו | 36 |
| תרחישים שרצו | 29 |
| תרחישים שסורבו סירוב סגור | 7 |
| עקבות חישוב שנשמרו | 29 |
| עקבות ששוחזרו מהמסד בית־בבית | 29 |
| נושאים שרצו | 4 מתוך 7 |

---

## 2. שכר מינימום — `legal.reference.il.decision.min_wage_hourly_divisor`

השאלה הפתוחה מפרידה בין **182** לבין **186**.
מתוך 6 תרחישים רצו 5, ומהם 5 מפרידים בין האפשרויות.

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

## 4. נושאים שלא רצו

| נושא | סיבה | משבצת | פירוט |
|---|---|---|---|
| שעות עבודה ומנוחה | משבצת פרמטר לא קשורה — המספר אינו קיים בקורפוס | `slot.working_time.overtime_first_tier_rate` | il.working_time.overtime_rate_first_tier is unbound because the 125/150/175/200 percentages are not in the corpus at all. IL_HOURS_WORK_REST_LAW's nine chunks carry the overtime premium only as words, never as a figure, and the 2018 general overtime permit is quarantined pending an instrument-boundary decision. The tiered.rate node added in L4-2 is ready and has no rates to bind. |
| דמי הבראה | משבצת פרמטר לא קשורה — המקור בהסגר עד להכרעת אדם | `slot.convalescence.daily_rate` | il.convalescence.daily_rate is unbound, and the reason recorded until now — that IL_CONVALESCENCE_EXTENSION_ORDER_2023 failed to parse — is wrong. The order parsed: six chunks exist on disk and one of them states the 418 shekel day rate from 1.7.2023. What blocks it is a policy quarantine, not a technical failure: that gazette issue carries several instruments, the boundary between them is an unmade human decision (instrument_selector_pending_human_review), and the build ledger therefore records chunks_path: null so no citation can resolve. The remedy is a human instrument-boundary decision, not more parsing. |
| דמי מחלה | משבצת פרמטר לא קשורה — המספר אינו קיים בקורפוס | `slot.sick_leave.payment_tier_rates` | The entitlement this topic is about is the payment tiers — nothing for the first day, half for the second and third, full from the fourth. IL_SICK_PAY_LAW carries those only as words, never as figures, so tiered.rate has no rates to bind. The two parameters that ARE bound cannot be combined either: accrual_days_per_month is a rational in days_per_month and accrual_cap_days an integer in days, and min and multiply both require matching kinds and units. Relabelling one to make them fit would be a lie in the spec, so this needs either a unit-conversion node or the tier figures themselves. |

---

## 5. החלטות שנמשכו

שאלות אלה אינן פתוחות עוד. הן מופיעות כאן כדי שהרשימה תהיה מלאה, ולא כדי שיוכרעו.

| מזהה | נושא | סיבת המשיכה |
|---|---|---|
| `legal.reference.il.decision.vacation_minimum_days_threshold_200_vs_240.v2` | חופשה שנתית | Not a real disagreement between two candidate figures for one question — Annual Vacation Law §3(b) and §3(c) are two distinct thresholds for two distinct situations: 200 days governs an employment relationship spanning the full work-year, 240 days governs one spanning only part of it. Read directly, the primary text leaves nothing open to decide. Registered as two plain parameters (il.vacation.full_year_relationship_minimum_days_threshold, il.vacation.partial_year_relationship_minimum_days_threshold) instead of decision alternatives, per Pool P batch 5. |

---

## 6. היקף

Differences only, computed. This states what the answer to each open question changes in each scenario; it does not answer any of them, and nothing here is reviewed, attested or active.

