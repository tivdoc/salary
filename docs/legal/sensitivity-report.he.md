# דוח רגישות — מה כל תשובה משנה

מסמך זה **אינו מכריע** באף שאלה משפטית ואינו ממליץ על תשובה. הוא מציג, לכל
תרחיש, מה כל אחת מהאפשרויות מחשבת ומה ההפרש ביניהן. שום מספר כאן לא הוקלד
מחדש: כולם נלקחים מקובץ ה־JSON שממנו נוצר המסמך.

המסמך נוצר אוטומטית מ־`decision-sensitivity-report-v9.json` (`d74c308c4f4e96ee…`).
כל הנתונים הם סביבת DEV. אין כאן נתוני לקוחות, אין מקור מאושר ואין פרמטר פעיל.

הערות ההנדסה מצוטטות באנגלית כלשונן, בדיוק כפי שהן מופיעות בקובץ המקור.
תרגומן כאן היה כתיבה מחדש של תוכן, ולא העתקה שלו.

---

## 1. מה נבדק

| מדד | ערך |
|---|---|
| תרחישים שנוסו | 120 |
| תרחישים שרצו | 100 |
| תרחישים שסורבו סירוב סגור | 20 |
| עקבות חישוב שנשמרו | 100 |
| עקבות ששוחזרו מהמסד בית־בבית | 100 |
| נושאים שרצו | 7 מתוך 7 |

---

## ברירות מחדל שנרשמו על ידי הבעלים — לא אטסטציה

שש מן ההכרעות הפתוחות שלהלן נושאות **ברירת מחדל שנרשמה על ידי הבעלים** ביום 2026-09-05, על יסוד חוות דעת משפטית שאושרה על ידי עורך/ת דין לדיני עבודה
(sha256 `3ddad7e8c9fd81ec…`; רשומת האישור `0258b6400040b156…`). מעמד כל רישום: `owner_recorded`.

**לא בוצעה אטסטציה.** לעורך/ת הדין אין זהות בודק/ת רשומה; אף מקור לא נסקר, אף פרמטר לא יצא ממצב טיוטה, אף כלל לא הופעל, והמונים נותרו 0/7.
רישום ברירת מחדל משנה דבר אחד בלבד: איזה ענף הדוח וריצת הצל מריצים כברירת מחדל. כל ענף אחר ממשיך להיות מחושב ומוצג, וההפרש ממנו לברירת המחדל מצוין בטבלה.
רישומים: 6; אטסטציות: 0.

| הכרעה | הענף שנבחר (בלשון חוות הדעת) | בסיס | מעמד |
|---|---|---|---|
| `hourly_wage_divisor` | **182** (order_182) | lawyer_approved_opinion | `owner_recorded` |
| `pension_wage_cap_source` | **section2** (nii_section_2_benefits) | lawyer_approved_opinion | `owner_recorded` |
| `pension_2011_2016_precedence` | **order_2016_2017_rates** (overlay) | lawyer_approved_opinion | `owner_recorded` |
| `rest_day_overtime_composition` | **additive** (additive) | lawyer_approved_opinion | `owner_recorded` |
| `convalescence_rate_period` | **havraa_year** (havraa_year) | lawyer_approved_opinion | `owner_recorded` |
| `working_time_daily_threshold` | **administrative** (administrative) | lawyer_approved_opinion | `owner_recorded` |

---

## 2. שכר מינימום — `legal.reference.il.decision.min_wage_hourly_divisor`

השאלה הפתוחה מפרידה בין **182** לבין **186**.

ברירת מחדל: **182** — נרשמה על ידי הבעלים על יסוד חוות הדעת המאושרת. הענף שנבחר בהכרעה: **182** (`hourly_wage_divisor`), מעמד `owner_recorded`, ללא זהות מאשר/ת.

סיווג חומרת הפער: **הפרה סטטוטורית** — התשלום נמוך מהזכאות גם לפי הסכום שבחוק וגם לפי הסכום שבצו ההרחבה; **זכות מכוח צו הרחבה** — הפער קיים רק בין הסכום שבחוק לסכום שבצו ההרחבה (ניתנת לתביעה, אינה נאכפת מנהלית). הסיווג הוא שדה על הממצא ואינו מסתיר ממצא.
בריצת הצל: `no_gap` — 1; `not_comparable` — 2; `order_entitlement` — 3; `statutory_violation` — 2.
תצוגת ברירת המחדל: בתצוגת ברירת המחדל (182) תשלום בין 34.64 ל־35.40 לשעה הוא פער מסוג זכות מכוח צו הרחבה; מתחת ל־34.64 — הפרה סטטוטורית.

מעבר ברירת המחדל: 182 ← 182 (ללא שינוי); חודשים סינתטיים שהתוצאה השתנתה בהם: 0; סיווג a; חודש הרצועה `synthetic.minimum_wage.edge.hourly_between_divisors` — התוצאה בו לא השתנתה.
מתוך 6 תרחישים רצו 5, ומהם 5 מפרידים בין האפשרויות.

דירוג מקור של הפרמטרים בשאלה זו: **אומת בטקסט** (`text_verified`).

| תרחיש | 182 (ברירת מחדל) | 186 | הפרש | הפרש מברירת המחדל |
|---|---|---|---|---|
| מצב רגיל | 6442.80 ILS | 6304.48 ILS | 138.32 ILS | 186: -138.32 ILS |
| גבול תחולה | 6442.80 ILS | 6304.48 ILS | 138.32 ILS | 186: -138.32 ILS |
| עובדה חסרה או סותרת | לא רץ | לא רץ | RULESPEC_INPUT_MISSING | — |
| גבול עיגול או גבול הטבלה | 5057.14 ILS | 4948.57 ILS | 108.57 ILS | 186: -108.57 ILS |
| חפיפת מקורות | 6584.40 ILS | 6443.04 ILS | 141.36 ILS | 186: -141.36 ILS |
| ענף ואוכלוסייה | 3221.40 ILS | 3152.24 ILS | 69.16 ILS | 186: -69.16 ILS |

---

## 3. פנסיה — `legal.reference.il.decision.pension_wage_cap_section`

השאלה הפתוחה מפרידה בין **section1** לבין **section2**.

ברירת מחדל: **section2** — נרשמה על ידי הבעלים על יסוד חוות הדעת המאושרת. הענף שנבחר בהכרעה: **section2** (`pension_wage_cap_source`), מעמד `owner_recorded`, ללא זהות מאשר/ת.

מעבר ברירת המחדל: section1 ← section2; חודשים סינתטיים שהתוצאה השתנתה בהם: 3 (למשל `synthetic.pension.edge.wage_between_caps`); סיווג b; חודש הרצועה `synthetic.pension.edge.wage_between_caps` — התוצאה בו השתנתה.
מתוך 6 תרחישים רצו 5, ומהם 5 מפרידים בין האפשרויות.

דירוג מקור של הפרמטרים בשאלה זו: **אומת בטקסט** (`text_verified`).

הערת היקף: Binds only the mandatory wage cap. The full pension draft also needs il.pension.employee_contribution_rate — registered at 2014.1.0 in L4-1 from the 2011 order's own table, but that instrument's last row is 2014 and whether a later instrument governs is the open precedence question, so this spec does not reach for it.

ההפרש בטבלה הוא הפרש **בתקרה** (בסיס). הסכום שבו מדובר הוא הפרש **ההפרשות** על התקרה בשיעורי ההפרשה, ומוצג בעמודה נפרדת.
| תרחיש | section1 | section2 (ברירת מחדל) | הפרש (בסיס) | הפרש מברירת המחדל | הפרש הפרשות |
|---|---|---|---|---|---|
| מצב רגיל | 13566.00 ILS | 13769.00 ILS | 203.00 ILS | section1: -203.00 ILS | 37.56 ILS |
| גבול תחולה | 13566.00 ILS | 13769.00 ILS | 203.00 ILS | section1: -203.00 ILS | 37.56 ILS |
| עובדה חסרה או סותרת | לא רץ | לא רץ | RULESPEC_INPUT_MISSING | — | — |
| גבול עיגול או גבול הטבלה | 4522.00 ILS | 4589.67 ILS | 67.67 ILS | section1: -67.67 ILS | 12.52 ILS |
| חפיפת מקורות | 13566.00 ILS | 13769.00 ILS | 203.00 ILS | section1: -203.00 ILS | 37.56 ILS |
| ענף ואוכלוסייה | 6783.00 ILS | 6884.50 ILS | 101.50 ILS | section1: -101.50 ILS | 18.78 ILS |

שיעורי ההפרשה (ברירת המחדל של הכרעת הקדימות): employee `il.pension.employee_contribution_rate@2017.1.0` = 3/50; employer `il.pension.employer_contribution_rate@2017.1.0` = 13/200; severance `il.pension.severance_contribution_rate@2017.1.0` = 3/50.

---

## 4. דמי הבראה — `legal.reference.il.decision.convalescence_2026_rate_period`

השאלה הפתוחה מפרידה בין **calendar_year_2026** לבין **from_signature_2026_07** לבין **havraa_year**.

ברירת מחדל: **havraa_year** — נרשמה על ידי הבעלים על יסוד חוות הדעת המאושרת. הענף שנבחר בהכרעה: **havraa_year** (`convalescence_rate_period`), מעמד `owner_recorded`, ללא זהות מאשר/ת.

מעבר ברירת המחדל: calendar_year_2026 ← havraa_year; חודשים סינתטיים שהתוצאה השתנתה בהם: 1 (למשל `synthetic.convalescence.edge.havraa_year_2027_rate_not_published`); סיווג b.
מתוך 6 תרחישים רצו 5, ומהם 0 מפרידים בין האפשרויות.

דירוג מקור של הפרמטרים בשאלה זו: **בתוך בחירת מסמך** (`selection`).

הערת היקף: The day rate the 2026 order states, 451.50, cited into the instrument selection over the 2026 gazette issue; the 2023 order's 418 is registered beside it from its own selection. The open decision is the period the 2026 rate covers — the order says 'for the convalescence year 2026' and is signed in July — and all three branches carry the same figure, so no scenario separates them in amount; they differ in period (the calendar year, from the signature, or the convalescence year 1.7.2025–30.6.2026, the owner-recorded default) and in knowledge time, which the rate table states. The full draft also needs the seniority-band day counts, which are not in the corpus.

| תרחיש | calendar_year_2026 | from_signature_2026_07 | havraa_year (ברירת מחדל) | הפרש | הפרש מברירת המחדל |
|---|---|---|---|---|---|
| מצב רגיל | 2257.50 ILS | 2257.50 ILS | 2257.50 ILS | 0.00 ILS | calendar_year_2026: 0.00 ILS; from_signature_2026_07: 0.00 ILS |
| גבול תחולה | 2257.50 ILS | 2257.50 ILS | 2257.50 ILS | 0.00 ILS | calendar_year_2026: 0.00 ILS; from_signature_2026_07: 0.00 ILS |
| עובדה חסרה או סותרת | לא רץ | לא רץ | לא רץ | RULESPEC_INPUT_MISSING | — |
| גבול עיגול או גבול הטבלה | 752.50 ILS | 752.50 ILS | 752.50 ILS | 0.00 ILS | calendar_year_2026: 0.00 ILS; from_signature_2026_07: 0.00 ILS |
| חפיפת מקורות | 3160.50 ILS | 3160.50 ILS | 3160.50 ILS | 0.00 ILS | calendar_year_2026: 0.00 ILS; from_signature_2026_07: 0.00 ILS |
| ענף ואוכלוסייה | 2709.00 ILS | 2709.00 ILS | 2709.00 ILS | 0.00 ILS | calendar_year_2026: 0.00 ILS; from_signature_2026_07: 0.00 ILS |

---

## 5. שעות עבודה ומנוחה — `legal.reference.il.decision.working_time_daily_threshold`

השאלה הפתוחה מפרידה בין **statute** לבין **administrative**.

ברירת מחדל: **administrative** — נרשמה על ידי הבעלים על יסוד חוות הדעת המאושרת. הענף שנבחר בהכרעה: **administrative** (`working_time_daily_threshold`), מעמד `owner_recorded`, ללא זהות מאשר/ת.

סיווג חומרת הפער: **הפרה סטטוטורית** — התשלום נמוך מהזכאות גם לפי הסכום שבחוק וגם לפי הסכום שבצו ההרחבה; **זכות מכוח צו הרחבה** — הפער קיים רק בין הסכום שבחוק לסכום שבצו ההרחבה (ניתנת לתביעה, אינה נאכפת מנהלית). הסיווג הוא שדה על הממצא ואינו מסתיר ממצא.
בריצת הצל: `no_gap` — 4; `not_comparable` — 2; `order_entitlement` — 1; `statutory_violation` — 1.
תצוגת ברירת המחדל: בתצוגת ברירת המחדל (8.6 / 7.6) שעה בין 8.0 ל־8.6 ביום רגיל בשבוע של חמישה ימים אינה פער; לפי ענף החוק (8) היא זכות מכוח צו הרחבה — לא הפרה סטטוטורית.

**נגזר, לא לשון המקור:** `il.working_time.daily_overtime_threshold_hours@2018.1.0` = 8.6 (יום רגיל) / 7.6 (היום המקוצר). weekly_before ÷ days_per_week = 43 ÷ 5 = 8.6; regular_day − reduction = 8.6 − 1 = 7.6; (days_per_week − reduced_days) × regular_day + reduced_days × short_day = 4 × 8.6 + 1 × 7.6 = 42. **הנחה מחייבת** `five_day_even_distribution`: The 43-hour week is spread evenly over the five working days of a five-day week (43 ÷ 5 = 8.6), and the one reduced hour falls on one defined, fixed day (8.6 − 1 = 7.6). The order states the reduction and the fixed day; the even spreading is assumed. הקריאה המתחרה: `nine_hour_day`. עלול להתבטל על ידי: V11 — the lawyer's answer on §5 ministerial approval of the shortened-week agreements (1988/1990/1996/2000/2017) can invalidate the even-distribution assumption; V12 — the 1990 and 2000 orders' wording. (sha256 `c272afa433cfdfd9…`)

**נגזר, לא לשון המקור:** `il.working_time.short_day_overtime_threshold_hours@2018.1.0` = 8.6 (יום רגיל) / 7.6 (היום המקוצר). weekly_before ÷ days_per_week = 43 ÷ 5 = 8.6; regular_day − reduction = 8.6 − 1 = 7.6; (days_per_week − reduced_days) × regular_day + reduced_days × short_day = 4 × 8.6 + 1 × 7.6 = 42. **הנחה מחייבת** `five_day_even_distribution`: The 43-hour week is spread evenly over the five working days of a five-day week (43 ÷ 5 = 8.6), and the one reduced hour falls on one defined, fixed day (8.6 − 1 = 7.6). The order states the reduction and the fixed day; the even spreading is assumed. הקריאה המתחרה: `nine_hour_day`. עלול להתבטל על ידי: V11 — the lawyer's answer on §5 ministerial approval of the shortened-week agreements (1988/1990/1996/2000/2017) can invalidate the even-distribution assumption; V12 — the 1990 and 2000 orders' wording. (sha256 `c272afa433cfdfd9…`)

מעבר ברירת המחדל: statute ← administrative; חודשים סינתטיים שהתוצאה השתנתה בהם: 5 (למשל `synthetic.working_time.golden.current`); סיווג b.

ענף שלא נקשר ולא רץ: **nine_hour_day** — The competing reading of the five-day week — the 1990 order's nine-hour day, 9 × 4 + 7 (accepted in סע"ש 14271-10-17) — is named and not run: the 1990 order's text is not in the corpus (the lawyer's open item V12), and it is not derived here. Listed, never omitted.
מתוך 6 תרחישים רצו 5, ומהם 5 מפרידים בין האפשרויות.

דירוג מקור של הפרמטרים בשאלה זו: **נקרא מתמונת העמוד — ממתין לאימות חזותי** (`inferred_visual`).
inferred_visual: המספר נקרא מתמונת העמוד הסרוק, משום ששכבת הטקסט של המסמך מעורפלת או חסרה; הוא ממתין לאימות חזותי של אדם מול אותו עמוד, ולא ניתן לאשרו בלי אימות כזה.

הערת היקף: Derives the day's overtime from hours worked and the daily threshold, then prices it by the §16(א) tiers. The statute branch binds eight hours from §2(א) through the lexicon (text_verified). The full draft also carries the 42-hour weekly threshold and the 2018 permit's caps. The owner-recorded default, executable since L12-1: the derived five-day norm (43/5 hours on the regular day, 38/5 on the shortened day, grade derived, assumption five_day_even_distribution) on a five-day week, the statute's eight on a six-day week, priced by the same §16(א) tiers over a rational quantity with one rounding. The schedule is a mandatory declared fact. The full draft also carries the 42-hour weekly threshold and the 2018 permit's caps.

| תרחיש | statute | administrative (ברירת מחדל) | הפרש | הפרש מברירת המחדל |
|---|---|---|---|---|
| מצב רגיל | 165.00 ILS | 138.00 ILS | 27.00 ILS | statute: 27.00 ILS |
| גבול תחולה | 120.00 ILS | 93.00 ILS | 27.00 ILS | statute: 27.00 ILS |
| עובדה חסרה או סותרת | לא רץ | לא רץ | RULESPEC_INPUT_MISSING | — |
| גבול עיגול או גבול הטבלה | 41.66 ILS | 16.67 ILS | 24.99 ILS | statute: 24.99 ILS |
| חפיפת מקורות | 210.00 ILS | 183.00 ILS | 27.00 ILS | statute: 27.00 ILS |
| ענף ואוכלוסייה | 75.00 ILS | 52.50 ILS | 22.50 ILS | statute: 22.50 ILS |

---

## 6. שעות עבודה ומנוחה — `legal.reference.il.decision.rest_day_overtime_composition`

השאלה הפתוחה מפרידה בין **additive**.

ברירת מחדל: **additive** — נרשמה על ידי הבעלים על יסוד חוות הדעת המאושרת. הענף שנבחר בהכרעה: **additive** (`rest_day_overtime_composition`), מעמד `owner_recorded`, ללא זהות מאשר/ת.

מעבר ברירת המחדל: additive ← additive (ללא שינוי); חודשים סינתטיים שהתוצאה השתנתה בהם: 0; סיווג a.
מתוך 6 תרחישים רצו 5, ומהם 0 מפרידים בין האפשרויות.

דירוג מקור של הפרמטרים בשאלה זו: **נקרא מתמונת העמוד — ממתין לאימות חזותי** (`inferred_visual`).
inferred_visual: המספר נקרא מתמונת העמוד הסרוק, משום ששכבת הטקסט של המסמך מעורפלת או חסרה; הוא ממתין לאימות חזותי של אדם מול אותו עמוד, ולא ניתן לאשרו בלי אימות כזה.

הערת היקף: The additive reading: the rest premium plus the overtime increment. 175% and 200% appear as outputs of the executor, never as figures in a source.

| תרחיש | additive (ברירת מחדל) | הפרש | הפרש מברירת המחדל |
|---|---|---|---|
| מצב רגיל | 165.00 ILS | 0.00 ILS | — |
| גבול תחולה | 105.00 ILS | 0.00 ILS | — |
| עובדה חסרה או סותרת | לא רץ | RULESPEC_INPUT_MISSING | — |
| גבול עיגול או גבול הטבלה | 58.33 ILS | 0.00 ILS | — |
| חפיפת מקורות | 225.00 ILS | 0.00 ILS | — |
| ענף ואוכלוסייה | 52.50 ILS | 0.00 ILS | — |

---

## 7. שעות עבודה ומנוחה — `legal.reference.il.decision.rest_day_daily_threshold`

השאלה הפתוחה מפרידה בין **worker_daily_norm** לבין **statute_8**.

ברירת מחדל: **worker_daily_norm** — ללא הכרעה רשומה — הענף הראשון ברשימה. אין הכרעה רשומה לשאלה זו; ביטחון נמוך.
מתוך 6 תרחישים רצו 5, ומהם 3 מפרידים בין האפשרויות.

דירוג מקור של הפרמטרים בשאלה זו: **נקרא מתמונת העמוד — ממתין לאימות חזותי** (`inferred_visual`).
inferred_visual: המספר נקרא מתמונת העמוד הסרוק, משום ששכבת הטקסט של המסמך מעורפלת או חסרה; הוא ממתין לאימות חזותי של אדם מול אותו עמוד, ולא ניתן לאשרו בלי אימות כזה.

הערת היקף: The opinion's default, at low confidence: on the weekly rest, overtime begins beyond the worker's own declared daily norm (a fact of the payslip or the attendance record — 9 where a nine-hour day is declared; a fractional norm such as 8.6 would need the rational-hours path and is not run here). Priced by the additive composition the owner-recorded resolution selects. Not in the offline shadow: no canonical fact path carries the rest day's hours worked or the declared norm. The alternative: on the weekly rest, overtime begins beyond the statute's eight hours (§2(א), bound through the lexicon), the same threshold as an ordinary day. Priced by the additive composition. Low confidence, as the opinion states for both branches.

| תרחיש | worker_daily_norm (ברירת מחדל) | statute_8 | הפרש | הפרש מברירת המחדל |
|---|---|---|---|---|
| מצב רגיל | 105.00 ILS | 165.00 ILS | 60.00 ILS | statute_8: 60.00 ILS |
| גבול תחולה | 52.50 ILS | 105.00 ILS | 52.50 ILS | statute_8: 52.50 ILS |
| עובדה חסרה או סותרת | לא רץ | לא רץ | RULESPEC_INPUT_MISSING | — |
| גבול עיגול או גבול הטבלה | 58.33 ILS | 58.33 ILS | 0.00 ILS | statute_8: 0.00 ILS |
| חפיפת מקורות | 165.00 ILS | 225.00 ILS | 60.00 ILS | statute_8: 60.00 ILS |
| ענף ואוכלוסייה | 52.50 ILS | 52.50 ILS | 0.00 ILS | statute_8: 0.00 ILS |

---

## 8. פנסיה — `legal.reference.il.decision.pension_2011_2016_precedence`

השאלה הפתוחה מפרידה בין **order_2011_2014_row** לבין **order_2016_2017_rates**.

ברירת מחדל: **order_2016_2017_rates** — נרשמה על ידי הבעלים על יסוד חוות הדעת המאושרת. הענף שנבחר בהכרעה: **order_2016_2017_rates** (`pension_2011_2016_precedence`), מעמד `owner_recorded`, ללא זהות מאשר/ת.

מעבר ברירת המחדל: order_2011_2014_row ← order_2016_2017_rates; חודשים סינתטיים שהתוצאה השתנתה בהם: 10 (למשל `synthetic.pension.golden.current`); סיווג b.
מתוך 6 תרחישים רצו 5, ומהם 5 מפרידים בין האפשרויות.

דירוג מקור של הפרמטרים בשאלה זו: **נקרא מתמונת העמוד — ממתין לאימות חזותי** (`inferred_visual`).
inferred_visual: המספר נקרא מתמונת העמוד הסרוק, משום ששכבת הטקסט של המסמך מעורפלת או חסרה; הוא ממתין לאימות חזותי של אדם מול אותו עמוד, ולא ניתן לאשרו בלי אימות כזה.

הערת היקף: Binds the employee share under the precedence decision and pins the wage cap to its section-1 version so the spec carries one decision; the cap's own decision runs in the cap spec. The 2017 share is a visual citation of an image-only scan (inferred_visual).

| תרחיש | order_2011_2014_row | order_2016_2017_rates (ברירת מחדל) | הפרש | הפרש מברירת המחדל |
|---|---|---|---|---|
| מצב רגיל | 746.13 ILS | 813.96 ILS | 67.83 ILS | order_2011_2014_row: -67.83 ILS |
| גבול תחולה | 746.13 ILS | 813.96 ILS | 67.83 ILS | order_2011_2014_row: -67.83 ILS |
| עובדה חסרה או סותרת | לא רץ | לא רץ | RULESPEC_INPUT_MISSING | — |
| גבול עיגול או גבול הטבלה | 248.71 ILS | 271.32 ILS | 22.61 ILS | order_2011_2014_row: -22.61 ILS |
| חפיפת מקורות | 746.13 ILS | 813.96 ILS | 67.83 ILS | order_2011_2014_row: -67.83 ILS |
| ענף ואוכלוסייה | 373.07 ILS | 406.98 ILS | 33.91 ILS | order_2011_2014_row: -33.91 ILS |

---

## 9. הצל הלא־מקוון — טיוטות על עובדות סינתטיות

ריצת הצל מריצה את הטיוטות על ערכי פרמטרים בטיוטה ועל עובדות סינתטיות שהוצהרו לפי תבנית,
דרך מודל העובדות הקנוני ורשמי המיפוי, בתוך המתזמן הלא־מקוון. שום פלט כאן אינו ממצא:
כל תוצאה היא הפרש־צל סינתטי או סירוב; דבר אינו מופעל ודבר אינו נמסר. לא הופעל חילוץ.

| מדד | ערך |
|---|---|
| ריצה | `l76.6d0667ad` |
| מצב ריצה | `draft_parameters_synthetic_inputs` |
| גרסאות פרמטר בטיוטה שנקשרו | 36 |
| פרמטרים פעילים | 0 |
| חודשי תלוש סינתטיים | 58 |
| הרצות (מקרה × מפרט × ענף) | 169 |
| רצו | 121 |
| סורבו בהכנת הקלט | 42 |
| סורבו במנוע | 6 |
| הפרשי־צל שחושבו | 94 |
| ללא רכיב תשלום להשוואה | 27 |
| עקבות שנשמרו / שוחזרו מהמסד | 121 / 121 |
| חילוץ בשימוש | לא |
| קורפוס (sha256) | `1c7d48541894642d…` |
| קבלה (sha256) | `c412d56ca81a443d…` |

סירובים לפי סיבה:

| סיבה | מספר |
|---|---|
| מחוץ לטבלת המדרגות (שנה אפס / יום ראשון) (`executor:RULESPEC_BAND_LOOKUP_INPUT_OUT_OF_RANGE`) | 6 |
| ביטחון נמוך מהסף (`preparation:fact.below_confidence_threshold`) | 8 |
| עובדה סותרת — לא הוכרעה (`preparation:fact.conflicted`) | 4 |
| עובדה חסרה (`preparation:fact.missing`) | 19 |
| עובדה ישנה מדי (`preparation:fact.stale`) | 1 |
| עובדה שלא אושרה (`preparation:fact.unconfirmed`) | 4 |
| preparation:rate_not_published (`preparation:rate_not_published`) | 1 |
| העובדה אינה בצורה שהמשבצת צורכת (`preparation:transformation.failed`) | 6 |

דירוג הריצות — הגרוע מבין דירוגי העובדות והפרמטרים של כל הרצה:

| דירוג | מספר |
|---|---|
| עובדה מוצהרת, או פרמטר בתוך בחירת מסמך (`declared`) | 46 |
| עובדה נגזרת מעובדות אחרות, או פרמטר נגזר — חישוב על טקסט מצוטט בתוספת הנחה מוצהרת (הסף היומי 8.6 / 7.6) (`derived`) | 5 |
| עובדה שהפיק סוכן, או פרמטר שנקרא מתמונת העמוד (`inferred`) | 37 |
| פרמטר שנקרא דרך הלקסיקון (`lexicon`) | 5 |
| מאומת — עובדות מתועדות ופרמטרים מאומתים בטקסט (`verified`) | 34 |

השאלות הפתוחות בצל — לכל שאלה, כמה מקרים הושוו בין הענפים וכמה מהם שונים; אף ענף לא התקבל:

| הכרעה | ענפים | ענף שלא נקשר | הושוו | שונים | לא ניתנים להשוואה |
|---|---|---|---|---|---|
| `legal.reference.il.decision.convalescence_2026_rate_period` | calendar_year_2026, from_signature_2026_07, havraa_year | — | 6 | 0 | 3 |
| `legal.reference.il.decision.min_wage_hourly_divisor` | 182, 186 | — | 6 | 5 | 2 |
| `legal.reference.il.decision.pension_2011_2016_precedence` | order_2011_2014_row, order_2016_2017_rates | — | 15 | 10 | 6 |
| `legal.reference.il.decision.pension_wage_cap_section` | section1, section2 | — | 6 | 3 | 2 |
| `legal.reference.il.decision.rest_day_overtime_composition` | additive | — | 5 | 0 | 2 |
| `legal.reference.il.decision.working_time_daily_threshold` | administrative, statute | nine_hour_day | 6 | 5 | 2 |

---

## 10. ענפים שנבחנו ונדחו

| הכרעה | ענף | סיבה | הוצא מהטבלה ב־ |
|---|---|---|---|
| `legal.reference.il.decision.rest_day_overtime_composition` | **multiplicative** | no source of any grade supports it | run 11 / D3.3, on the lawyer-approved opinion of 5.9.2026 (question 4) |

---

## 11. תעריף ההבראה לפי שנת הבראה — זמן תוקף וזמן ידיעה

| שנת הבראה | תעריף ליום | בתוקף מ־ | עד | ידוע מ־ | רטרואקטיבי | גרסת פרמטר |
|---|---|---|---|---|---|---|
| 2026 | 451.50 ILS | 2025-07-01 | 2026-06-30 | 2026-08-18 | כן | `il.convalescence.daily_rate@2026.3.0` |

תקופה מ־1.7.2026 ואילך: התעריף אינו מפורסם — המנוע מסרב (`rate_not_published`), לא 418 ולא 451.50 כברירת מחדל.
דוגמה: a payslip of June, July or August 2026 that paid 418.00 a day is short 33.50 a day, tagged retroactive_update_2026-08-18 (the shadow's paid_at_previous_rate month)

---

## 12. מעבר ברירות המחדל — מה השתנה בפועל

לכל הכרעה: הענף שרץ כברירת מחדל לפני רישום ההכרעות (הראשון ברשימה), הענף שרץ עכשיו, כמה חודשים סינתטיים שינו את תוצאתם במעבר, ודוגמה אחת. סיווג: a — ברירת המחדל הקודמת כבר הייתה הענף שנבחר; b — הענף השתנה וחודשים השתנו; c — הענף השתנה ואף חודש לא השתנה, ואז נוסף חודש רצועה כדי שההשוואה לא תהיה ריקה. ריצות: `l76.7721fd34` ← `l76.6d0667ad` (PASS).

| הכרעה | ברירת מחדל קודמת | חדשה | חודשים שהשתנו | דוגמה | סיווג | חודש רצועה |
|---|---|---|---|---|---|---|
| `convalescence_2026_rate_period` | calendar_year_2026 | **havraa_year** | 1 | `synthetic.convalescence.edge.havraa_year_2027_rate_not_published` | b | — |
| `min_wage_hourly_divisor` | 182 | **182** | 0 | — | a | `synthetic.minimum_wage.edge.hourly_between_divisors` (לא השתנה) |
| `pension_2011_2016_precedence` | order_2011_2014_row | **order_2016_2017_rates** | 10 | `synthetic.pension.golden.current` | b | — |
| `pension_wage_cap_section` | section1 | **section2** | 3 | `synthetic.pension.edge.wage_between_caps` | b | `synthetic.pension.edge.wage_between_caps` (השתנה) |
| `rest_day_overtime_composition` | additive | **additive** | 0 | — | a | — |
| `working_time_daily_threshold` | statute | **administrative** | 5 | `synthetic.working_time.golden.current` | b | — |

---

## 13. ממדים שסיווג החומרה מוגדר להם ואינם מחושבים עדיין

- weekly overtime threshold: חוק — 45 hours a week (Hours of Work and Rest Law 1951); צו — 42 hours a week (2018 42-hour extension order; il.working_time.weekly_overtime_threshold_hours@2018.1.0, registered and bound in the working-time draft). no executable spec derives weekly overtime from weekly hours; the 42-hour parameter is registered and the class is defined, the computation is not yet run

---

## 14. דירוג המקור של כל פרמטר

כל פרמטר שנקשר בדוח נושא דירוג מקור. הדירוג אומר מאין הגיע המספר, לא אם הוא נכון.

inferred_visual: המספר נקרא מתמונת העמוד הסרוק, משום ששכבת הטקסט של המסמך מעורפלת או חסרה; הוא ממתין לאימות חזותי של אדם מול אותו עמוד, ולא ניתן לאשרו בלי אימות כזה.

| פרמטר | דירוג | קריאה חזותית | עמוד (sha256) | הנחה (נגזר) |
|---|---|---|---|---|
| `il.convalescence.daily_rate@2026.1.0` | בתוך בחירת מסמך (`selection`) | — | — | — |
| `il.convalescence.daily_rate@2026.2.0` | בתוך בחירת מסמך (`selection`) | — | — | — |
| `il.convalescence.daily_rate@2026.3.0` | אומת בטקסט (`text_verified`) | — | — | — |
| `il.convalescence.days_year_1@1988.1.0` | אומת בטקסט (`text_verified`) | — | — | — |
| `il.convalescence.days_years_11_to_15@1988.1.0` | אומת בטקסט (`text_verified`) | — | — | — |
| `il.convalescence.days_years_16_to_19@1988.1.0` | אומת בטקסט (`text_verified`) | — | — | — |
| `il.convalescence.days_years_2_to_3@1988.1.0` | אומת בטקסט (`text_verified`) | — | — | — |
| `il.convalescence.days_years_20_and_above@1988.1.0` | אומת בטקסט (`text_verified`) | — | — | — |
| `il.convalescence.days_years_4_to_10@1988.1.0` | אומת בטקסט (`text_verified`) | — | — | — |
| `il.minimum_wage.daily_5day@2026.1.0` | אומת בטקסט (`text_verified`) | — | — | — |
| `il.minimum_wage.hourly@2026.1.0` | אומת בטקסט (`text_verified`) | — | — | — |
| `il.minimum_wage.hourly@2026.2.0` | אומת בטקסט (`text_verified`) | — | — | — |
| `il.pension.employee_contribution_rate@2014.2.0` | אומת בטקסט (`text_verified`) | — | — | — |
| `il.pension.employee_contribution_rate@2017.1.0` | נקרא מתמונת העמוד — ממתין לאימות חזותי (`inferred_visual`) | 6% | bfba6c9e3b55508a… | — |
| `il.pension.mandatory_wage_cap@2026.1.0` | אומת בטקסט (`text_verified`) | — | — | — |
| `il.pension.mandatory_wage_cap@2026.2.0` | אומת בטקסט (`text_verified`) | — | — | — |
| `il.sick_pay.accrual_cap_days@1.0.0` | אומת בטקסט (`text_verified`) | — | — | — |
| `il.sick_pay.accrual_days_per_month@1.0.0` | אומת בטקסט (`text_verified`) | — | — | — |
| `il.sick_pay.rate_days_2_to_3@1.0.0` | מילה שנקראה דרך הלקסיקון (`lexicon`) | — | — | — |
| `il.travel.daily_reimbursement_cap@2016.1.0` | אומת בטקסט (`text_verified`) | — | — | — |
| `il.vacation.calendar_days_increment_per_year_from_year_8@1951.1.0` | מילה שנקראה דרך הלקסיקון (`lexicon`) | — | — | — |
| `il.vacation.calendar_days_year_6@1951.1.0` | אומת בטקסט (`text_verified`) | — | — | — |
| `il.vacation.calendar_days_year_7@1951.1.0` | אומת בטקסט (`text_verified`) | — | — | — |
| `il.vacation.calendar_days_years_1_to_5@2017.1.0` | אומת בטקסט (`text_verified`) | — | — | — |
| `il.vacation.calendar_days_years_8_and_above_cap@1951.1.0` | אומת בטקסט (`text_verified`) | — | — | — |
| `il.working_time.daily_overtime_threshold_hours@1951.1.0` | אומת בטקסט (`text_verified`) | — | — | — |
| `il.working_time.daily_overtime_threshold_hours@2018.1.0` | נגזר — חישוב על טקסט מצוטט בתוספת הנחה מוצהרת; לא לשון המקור (`derived`) | — | — | `five_day_even_distribution` — (days_per_week − reduced_days) × regular_day + reduced_days × short_day = weekly_after |
| `il.working_time.overtime_rate_first_tier@1951.1.0` | נקרא מתמונת העמוד — ממתין לאימות חזותי (`inferred_visual`) | 1¼ | 6b41df8306ce4c60… | — |
| `il.working_time.overtime_rate_second_tier@1951.1.0` | נקרא מתמונת העמוד — ממתין לאימות חזותי (`inferred_visual`) | 1½ | 6b41df8306ce4c60… | — |
| `il.working_time.short_day_overtime_threshold_hours@2018.1.0` | נגזר — חישוב על טקסט מצוטט בתוספת הנחה מוצהרת; לא לשון המקור (`derived`) | — | — | `five_day_even_distribution` — (days_per_week − reduced_days) × regular_day + reduced_days × short_day = weekly_after |
| `il.working_time.weekly_rest_rate@1951.1.0` | נקרא מתמונת העמוד — ממתין לאימות חזותי (`inferred_visual`) | 1½ | 6b41df8306ce4c60… | — |

סיכום: בתוך בחירת מסמך — 2; אומת בטקסט — 21; נקרא מתמונת העמוד — ממתין לאימות חזותי — 4; מילה שנקראה דרך הלקסיקון — 2; נגזר — חישוב על טקסט מצוטט בתוספת הנחה מוצהרת; לא לשון המקור — 2.

---

## 15. נושאים שלא רצו

כל שבעת הנושאים רצו.

| נושא | סיבה | משבצת | פירוט |
|---|---|---|---|

---

## 16. החלטות שנמשכו

שאלות אלה אינן פתוחות עוד. הן מופיעות כאן כדי שהרשימה תהיה מלאה, ולא כדי שיוכרעו.

| מזהה | נושא | סיבת המשיכה |
|---|---|---|
| `legal.reference.il.decision.vacation_minimum_days_threshold_200_vs_240.v2` | חופשה שנתית | Not a real disagreement between two candidate figures for one question — Annual Vacation Law §3(b) and §3(c) are two distinct thresholds for two distinct situations: 200 days governs an employment relationship spanning the full work-year, 240 days governs one spanning only part of it. Read directly, the primary text leaves nothing open to decide. Registered as two plain parameters (il.vacation.full_year_relationship_minimum_days_threshold, il.vacation.partial_year_relationship_minimum_days_threshold) instead of decision alternatives, per Pool P batch 5. |

---

## 17. היקף

Differences only, computed. This states what the answer to each open question changes in each scenario. Six questions carry a DEFAULT the owner recorded on 5.9.2026 on a lawyer-approved opinion (status owner_recorded; no reviewer identity; no attestation); the default is what the shadow runs first and what the table names as such, and every other branch is still computed and shown with its difference from the default. Nothing here is reviewed, attested or active; the counters are unchanged.

