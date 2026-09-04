# דוח רגישות — מה כל תשובה משנה

מסמך זה **אינו מכריע** באף שאלה משפטית ואינו ממליץ על תשובה. הוא מציג, לכל
תרחיש, מה כל אחת מהאפשרויות מחשבת ומה ההפרש ביניהן. שום מספר כאן לא הוקלד
מחדש: כולם נלקחים מקובץ ה־JSON שממנו נוצר המסמך.

המסמך נוצר אוטומטית מ־`decision-sensitivity-report-v4.json` (`a12ec637a97c7cee…`).
כל הנתונים הם סביבת DEV. אין כאן נתוני לקוחות, אין מקור מאושר ואין פרמטר פעיל.

הערות ההנדסה מצוטטות באנגלית כלשונן, בדיוק כפי שהן מופיעות בקובץ המקור.
תרגומן כאן היה כתיבה מחדש של תוכן, ולא העתקה שלו.

---

## 1. מה נבדק

| מדד | ערך |
|---|---|
| תרחישים שנוסו | 60 |
| תרחישים שרצו | 50 |
| תרחישים שסורבו סירוב סגור | 10 |
| עקבות חישוב שנשמרו | 50 |
| עקבות ששוחזרו מהמסד בית־בבית | 50 |
| נושאים שרצו | 6 מתוך 7 |

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

## 4. דמי הבראה — `legal.reference.il.decision.convalescence_2026_rate_period`

השאלה הפתוחה מפרידה בין **calendar_year_2026** לבין **from_signature_2026_07**.
מתוך 6 תרחישים רצו 5, ומהם 0 מפרידים בין האפשרויות.

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

## 5. נושאים שלא רצו

| נושא | סיבה | משבצת | פירוט |
|---|---|---|---|
| שעות עבודה ומנוחה | משבצת פרמטר לא קשורה — המספר אינו קיים בקורפוס | `slot.working_time.overtime_first_tier_rate` | il.working_time.overtime_rate_first_tier is unbound. The only corpus text of the Hours of Work and Rest Law is the 1951 gazette scan, whose OCR renders 1¼ and 1½ as 11/4 and 11/2 — ambiguous, and refused by name by the numeral lexicon rather than read. The 2018 general permit's caps (12 hours a day, 16 overtime hours a week, 58 hours a week) are registered from their instrument selection, but they are ceilings, not rates; the tiered.rate node is built and waiting on a consolidated text. That text is requested through the controlled acquisition path (L5-8); if it lands, §16(א) binds through the lexicon and this topic runs. |

---

## 6. החלטות שנמשכו

שאלות אלה אינן פתוחות עוד. הן מופיעות כאן כדי שהרשימה תהיה מלאה, ולא כדי שיוכרעו.

| מזהה | נושא | סיבת המשיכה |
|---|---|---|
| `legal.reference.il.decision.vacation_minimum_days_threshold_200_vs_240.v2` | חופשה שנתית | Not a real disagreement between two candidate figures for one question — Annual Vacation Law §3(b) and §3(c) are two distinct thresholds for two distinct situations: 200 days governs an employment relationship spanning the full work-year, 240 days governs one spanning only part of it. Read directly, the primary text leaves nothing open to decide. Registered as two plain parameters (il.vacation.full_year_relationship_minimum_days_threshold, il.vacation.partial_year_relationship_minimum_days_threshold) instead of decision alternatives, per Pool P batch 5. |

---

## 7. היקף

Differences only, computed. This states what the answer to each open question changes in each scenario; it does not answer any of them, and nothing here is reviewed, attested or active.

