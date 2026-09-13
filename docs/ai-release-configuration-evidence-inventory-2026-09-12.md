# מלאי ראיות לבניית תצורת AI — 12.9.2026

**אפשר להכין תצורת QA פרטית מן המקורות השמורים והקוד הקיים, בלי עובדות תיק מוכנות מראש ובלי חתימה אנושית מדומה. אין בכך כשירות לפרסום.** בשכר מינימום נמצאו ארבעת קובצי המקור המקובעים בקוד, וכן תמלולים שמורים. עדיין נדרשות קבלות סקירת מקור, פרשנות ובדיקות בפורמט AI החדש. החלטת שיטה והכרעת תחולה בתיק אינן נגזרות מעצם קיומו של PDF.

זהו מלאי בקריאה בלבד: נקראו הקוד והמסמכים הציבוריים, ונבדקו קבצים בתיקיות המקור הידועות בלבד תחת `../release-work/entitlement-branches-20260912`. לא נקראו תיקי לקוחות או credentials. לא נוצרו תצורה, קבלה פעילה, שיוך, פלט תיק או כתיבה למסד; לא הופעלו ספק, build או בדיקות. כתיבת מסמך זה היא השינוי היחיד במשימה. הבדיקה נערכה בזמן checkpoint מקביל; את hash הבנייה הסופי יש להפיק מהקוד שייקפא, ולא להעתיק hash של עץ שנמצא בפיתוח.

## תשע משפחות והראיות הקיימות

ב־[runtime/contracts.ts](../src/engine/ai-release-runtime/contracts.ts) רשומות תשע משפחות. לכל נושא `T`, מזהה המשפחה והענף הוא `entitlement.T`, מזהה היצרן הוא `tivdoc.entitlement.T.generator`, והגרסה `1`. `generator.code_sha256` מגיע מ־`getCompiledAiReleaseBuild()`; תצורה אינה מקור אמון ל־hash של עצמה. מקור העובדות וה־RuleSpec נוצרים מחדש במסלול הרגיל.

בטבלה, `P` הוא `docs/release-evidence/legal-source-pages`;‏ `E` הוא תיקיית המקורות הפרטית `../release-work/entitlement-branches-20260912`. אלה מיקומי מסמכי מקור ציבוריים שמורים, ולא תיקי לקוחות. כל 13 הקבצים הנזכרים בטבלה מחוץ לשכר מינימום נמצאו, וה־SHA המלא שלהם הושווה ל־pin במודול המצוין. התאמת קובץ אינה אישור שרשרת תיקונים או פרשנות חדשה.

| משפחה | קוד מקור וקבצים זמינים | מתכוני שיטה בקטלוג הנוכחי | מה אינו נפתר מן הקובץ לבדו |
|---|---|---|---|
| `working_time` | [working-time/source-policy.ts](../src/engine/entitlement-review/working-time/source-policy.ts);‏ `P/IL_HOURS_WORK_REST_LAW_1951.pdf`,‏ `P/IL_SHORT_WORK_WEEK_EXTENSION_ORDER_2018.pdf`,‏ `E/oracles/primary/sami-188-06-third-party-copy.pdf` | `wt.rounding`,‏ `wt.weekly_aggregation` | תחולת ההסדר, שיבוץ יום העבודה, זמן עבודה/הפסקות, מלאי שבועי והקצאת תשלום; המקור מ־1951 הוא הפרסום המקורי, ולא נוסח משולב עדכני |
| `rest_day` | אותה מדיניות; בנוסף `E/oracles/primary/ilan-38313-03-18-third-party-copy.pdf` | `wt.rest_additive`; משפחת working-time של המתכונים יכולה להיקשר לפרשנות `working_time` או `rest_day` | חלון המנוחה, תחולה ומניעת כפל. שני פסקי הדין הם עותקי צד שלישי של פסק הדין, בלי אימות חדש מאתר בית המשפט |
| `pension` | [pension/sources.ts](../src/engine/entitlement-review/pension/sources.ts);‏ `P/IL_GENERAL_PENSION_EXTENSION_ORDER_2011.pdf`,‏ `P/IL_GENERAL_PENSION_INCREASE_EXTENSION_ORDER_2016.pdf`,‏ `E/pension-sources/btl-average-wage-20260912.html` | `pension.rounding` | מוצר פנסיוני, בסיס, הסדר מיטיב, תקופת המתנה ושיוך רכיבים; טבלת שכר ממוצע אינה ראיית הפקדה |
| `travel` | [travel/sources.ts](../src/engine/entitlement-review/travel/sources.ts);‏ `P/IL_GENERAL_TRAVEL_EXTENSION_ORDER_2016.pdf` | `travel.rounding` | ימי נסיעה, תעריף מסלול ואפשרויות כרטיס, הסעת מעסיק ותחולת ההסדר |
| `convalescence` | [convalescence/source-policy.ts](../src/engine/entitlement-review/convalescence/source-policy.ts);‏ `E/convalescence-sources/yalkut-7417-olaw-primary-copy.pdf`,‏ `P/IL_CONVALESCENCE_EXTENSION_ORDER_2026.pdf`,‏ `E/oracles/next-sources/conval-freeze2025-full-20260912.pdf` | `cv.rate_2026`,‏ `cv.proration`,‏ `cv.rounding` | שנת הבראה, שירות מזכה, חלקיות, מועד תשלום והסדר. המדיניות מציינת במפורש פרסום צו 2026 באוגוסט: אין להציג את המקור כאילו היה זמין בחודש שכר מוקדם יותר |
| `vacation` | [vacation/sources.ts](../src/engine/entitlement-review/vacation/sources.ts);‏ `E/oracles/next-sources/vacation-btl-20260912.pdf`,‏ `P/IL_ANNUAL_VACATION_LAW_AMENDMENT_15_2016.pdf` | `vacation.pay_rounding` | מכסה שנתית לעומת דמי חופשה, מניין ימים, ותק, בסיס ורבע שכר. אין גזירת צבירה חודשית בחלוקה אוטומטית ב־12 |
| `minimum_wage` | [minimum-wage/source-policy.ts](../src/engine/entitlement-review/minimum-wage/source-policy.ts); ארבעת המקורות מפורטים להלן | `mw.method`,‏ `mw.rounding` | בחירת שיטה, אוכלוסייה, שעות רגילות, מלאי רכיבים זכאים והקצאתו לתקופה |
| `bonuses` | [obligations/policy.ts](../src/engine/entitlement-review/obligations/policy.ts),‏ [obligations/index.ts](../src/engine/entitlement-review/obligations/index.ts) | אין | הסעיף והתנאים המסוימים הם ראיות תיק. אין למלא תצורה כללית בחוזה לדוגמה או להמציא מקור סטטוטורי לסכום הבונוס |
| `contract` | אותם רכיבי obligations | אין | גרסת ההסכם המחייבת, פרשנות הסעיף, היקף ותנאי התשלום. `obligation.rounding` אינו מתכון מאושר בקטלוג |

הטבלה מתארת **11 מתכונים ייחודיים**, לא תשע משפחות מוכנות להפעלה. [catalog.ts](../src/engine/ai-release-decisions/catalog.ts) הוא מקור הרשימה, ה־`recipe_sha256`, ה־`source_policy_sha256` והמקורות המדויקים. אין להעתיק pins מקטלוג קודם לאחר שינוי קוד. לכל ענף נוסף נדרשות קבלות מקור/פרשנות/בדיקות משלו; שיתוף מסמך בין משפחות אינו שיתוף אוטומטי של החלטת התחולה.

## שכר מינימום: קובץ, גרסה וסעיף

כל הקבצים הבאים נמצאים ב־[release-evidence/minimum-wage-june2026](release-evidence/minimum-wage-june2026/acquisition.json). ה־SHA חושב מחדש מהקובץ המקומי ב־12.9.2026 ותאם ל־[sources.ts](../src/engine/minimum-wage-june2026/sources.ts). נבדק גם התוכן הזמין באתרי המקור; לא בוצעה רכישה חדשה או השוואת hash של הורדה חדשה לאלה השמורים. תאריכי הרכישה ההיסטוריים נשארים 9.9.2026.

| מזהה | `source_version_id` | קובץ ו־SHA-256 של הבייטים המקוריים |
|---|---|---|
| MW-LAW | `IL_MIN_WAGE_LAW@20260909.4674f07928a2` | [minimum-wage-law-nii.pdf](release-evidence/minimum-wage-june2026/minimum-wage-law-nii.pdf),‏ 111,812 בתים, 5 עמודים; `4674f07928a2397b626db362c6c9b98b7c4e77e693e397463fdabd83c7f4f161` |
| MW-WEEK | `IL_WORKWEEK_ORDER_2018@20260909.d99d1f420b84` | [workweek-order-yalkut-7732-osh.pdf](release-evidence/minimum-wage-june2026/workweek-order-yalkut-7732-osh.pdf),‏ 142,140 בתים, 8 עמודים; `d99d1f420b8427f9734da2252791b0937478810a56ffd09939b39908cdd23787` |
| MW-NOTICE | `IL_MIN_WAGE_NOTICE_2026@20260909.65af7940d69a` | [minimum-wage-notice-yalkut-14324-industry.pdf](release-evidence/minimum-wage-june2026/minimum-wage-notice-yalkut-14324-industry.pdf),‏ 64,624 בתים, 2 עמודים; `65af7940d69a7c1ea96ae9008d44132a140866010f281ac49fc5779f61bdb679` |
| MW-TABLE | `IL_MIN_WAGE_OFFICIAL_RATES@20260909.63bb67d11d02` | [minimum-wage-rates-nii.html](release-evidence/minimum-wage-june2026/minimum-wage-rates-nii.html),‏ 218,465 בתים; `63bb67d11d02ae1377d3979a5028303c9905900c998106263570046cecc5edb2` |

הסעיפים ומעמד המקור שצריכים להיכלל בקבלת הסקירה:

| מזהה | מיקום ותפקיד | מעמד רכישה מתאים לחוזה החדש |
|---|---|---|
| MW-LAW | PDF עמ׳ 1: סעיף 1, סעיפים 2(א)–(ג), 3; עמ׳ 2: סעיף 6(1). החוק מבחין באוכלוסייה, משרה ושכר המובא בחשבון. בהגדרה שבנוסח השמור מופיע 186; אין להסיק מכאן לבדו את בחירת ענף 182. [נוסח הביטוח הלאומי](https://www.btl.gov.il/Laws1/00_0021_000000.pdf) | `official_acquisition`; העתק משולב רשמי באתר הגוף, לא הפרסום המקורי ברשומות ולא הוכחה לבדה לשלמות שרשרת התיקונים |
| MW-WEEK | PDF עמ׳ 2 / עמ׳ מודפס 6284: סעיף 2.1; PDF עמ׳ 3 / עמ׳ 6285: סעיף 2.8 לגבי 182, סעיפים 2.9–2.12 לגבי הסדרים והחרגות. [עותק ילקוט 7732](https://www.osh.org.il/UploadedImages/03_2018/yp_7732.pdf) | `primary_copy`; עותק פרסום ראשוני באתר המוסד לבטיחות ולגיהות. אין לשנות את מקור הרכישה לשרת רשומות ממשלתי |
| MW-NOTICE | PDF עמ׳ 2 / עמ׳ מודפס 4496: הודעה לפי סעיף 6(1), נחתמה ב־3.3.2026, סכום חודשי 6,443.85 ₪ מ־1.4.2026. [עותק ההודעה ברשומות](https://industry.org.il/files/work/jpg/%D7%99%D7%9C%D7%A7%D7%95%D7%985_3.pdf) | `primary_copy`; ההודעה הראשונית הועתקה לאתר התאחדות התעשיינים. לא הורדה מאתר ממשלתי ולא אישור אותנטיות אנושי |
| MW-TABLE | שורת 1.4.2026 והכותרות/ההסברים: 35.40 ₪ לפי 182,‏ 34.64 ₪ לפי 186,‏ 6,443.85 ₪ לחודש. [טבלת הביטוח הלאומי](https://www.btl.gov.il/Mediniyut/GeneralData/Pages/%D7%A9%D7%9B%D7%A8%20%D7%9E%D7%99%D7%A0%D7%99%D7%9E%D7%95%D7%9D.aspx) | `official_acquisition`; טבלת יישום רשמית תומכת, שאינה תחליף להכרעת ההסדר החל. זהו HTML; `page:1` בחוזה הקיים חייב להיות מתואר כמקטע DOM וירטואלי, לא כעמוד PDF |

גם התמלולים הבאים נמצאו ו־SHA שלהם אומת מחדש:

| מקור | תמלול שמור | `transcription_sha256` אפשרי לאחר סקירה חדשה |
|---|---|---|
| MW-LAW | `minimum-wage-law-nii.pdf.txt` | `78c56ddc92a3c91725376e27bd06cb769bf9660899c82f7dc26873adb89401d8` |
| MW-WEEK | `workweek-order-yalkut-7732-osh.pdf.txt` | `f795acf90318c6f33d12099741295b14a4667cd29285b356621d112ab6263aed` |
| MW-NOTICE | `minimum-wage-notice-yalkut-14324-industry.pdf.txt` | `80907fa359f8668d4d3d95ab8e0d8253102d77f502cec90d0c7849637fedbf63` |
| MW-TABLE | `minimum-wage-rates-nii-review-1.1.0.txt` — JSON של כותרות, tooltips והשורה הרלוונטית, עם קישור מפורש ל־HTML המקורי | `e79d522eeb8f77a229b53d971dfff7a19e7ba6cb8d97f3f442ea076ee0f51213` |

תמלולי ה־PDF נוצרו ב־`pypdf-layout 6.10.0`. תמלול ה־HTML מתעד פענוח entities, איחוד רווחים, הסרת U+200B ושימור סדר תאים ו־rowspan/colspan; הוא מציין `human_transcription_attested:false` ו־`operative_parameter_authority:false`. אין לפרש את hash הקובץ כקבלת דיוק פעילה. לכל `locators[].excerpt_sha256` יש לשמור קטע ראיה מדויק עם הסעיף/כותרות הדרושים ולחשב את hash שלו; אין למחזר עבורו את hash כל המסמך.

קובץ אחד **באמת חסר במלאי הרכישה**: `hourly-enforcement-policy-gov.pdf`. רשומת acquisition מתעדת 403 בניסיון לקבל [נוהל אכיפת השכר השעתי](https://www.gov.il/BlobFolder/policy/instructions-regarding-hourly-minimum-wage-in-light-a-shorten-work-week/he/workers-rights_enforcement-and-exercise-of-rights_minimum-wage-enforcement-procedure.pdf). לא בוצע ניסיון חוזר במשימה זו. אם הפרשנות תסתמך עליו, נדרשת רכישה תחומה ממקור זמין או תיעוד חלופה; אין לטעון שקיים לו artifact SHA. הכשל אינו הופך את ארבעת המקורות הזמינים ל״חסרים״.

## השיטה שדורשת הכרעה נפרדת

קטלוג `il.review.minimum-wage.may-july-2026@1.0.0` משמר שלוש שיטות נפרדות. זו עובדת קוד, לא הכרעה שהן חלופות משפטיות חופשיות:

| שיטה | חישוב מפורש | תנאי מרכזי |
|---|---|---|
| `published_hourly_182@1.0.0` | 35.40 ₪ כפול שעות רגילות מזוהות, עיגול half-up בסוף לאגורה | בסיס שעתי מתאים ותקופה/מלאי רכיבים מזוהים |
| `monthly_exact_div182@1.0.0` | 6,443.85 ₪ כפול שעות רגילות חלקי 182, עיגול בסוף | קבלת פרשנות מפורשת לשיטה זו; אין החלפה אוטומטית בתעריף המעוגל |
| `full_monthly@1.0.0` | 6,443.85 ₪ בדיוק | חודש מלא ומשרה מלאה במסגרת הנתמכת; אין הנחת שעות מומצאת או יחס חלקיות אוטומטי |

לדוגמה סינתטית בלבד, עבור 100 שעות: השיטה הראשונה מצפה ל־3,540.00 ₪, והשנייה ל־3,540.58 ₪. ההבדל מחייב בחירת שיטה מתועדת לפני השוואה, ולא בחירת התוצאה שמתאימה לבדיקה. מקור התעריף והגדרת 182 מפורטים לעיל; **כלל הבחירה ודיוק העיגול אינם מוכרעים בטבלת המחירים לבדה**. המדיניות עדיין מציינת `operative_rounding_dispute_resolved:false`.

`ai-method.mw.method` דורש שיטה שכבר נבחרה במפורש; הוא אינו בוחר אותה. `ai-method.mw.rounding` בוחן את הדיוק לפי אותה שיטה. שני המתכונים נושאים במדויק את MW-LAW מתוך הקטלוג. תיאור המתכון חייב להכיל את **קבוצת המקורות המדויקת שלו**, בעוד שקבלת פרשנות הענף צריכה לכלול את מלוא קבוצת מקורות הענף שעליה היא נשענת. אין להוסיף לתיאור מתכון pins שלא הוגדרו בו, ואין להסיק מכך שדי בחוק בלבד כדי לבסס את התעריף.

בנוסף נדרשות החלטות תיק `mw.population`,‏ `mw.ordinary_scope`,‏ `mw.eligible_components`,‏ `mw.allocation`. הן אינן קבלות תצורה: גיל/אוכלוסייה, מתכונת, קריאות סכומים, מלאי רכיבים והקצאה לתקופה יבואו רק מהקלט הרגיל ומההכרעה המקושרת אליו. [מפת ההחלטות](ai-release-remaining-case-decisions-2026-09-12.md) מתארת בנפרד פערי מימוש; הקוד המקביל עשוי להשלים חלק מהם. אין למלא את התצורה בהחלטות `accepted` כדי להסתיר פער כזה.

## קבלות נדרשות וסדר בנייה ללא תלות מעגלית

החוזים המדויקים נמצאים ב־[ai-release/contracts.ts](../src/engine/ai-release/contracts.ts),‏ [decision methods](../src/engine/ai-release-decisions/contracts.ts) וב־[ai-release-configuration.ts](../src/server/product/processing/ai-release-configuration.ts). `canonicalSha256` מחשב את גוף הרשומה בלי שדה `sha256`; hash קובץ ראיה הוא של בייטי הקובץ. אלה שני סוגי hash שונים.

1. **לקבע build שנבדק.** בעל ה־checkpoint מפיק manifest מפורש ורץ `--check`. מזהי תשעת היצרנים ו־hash גרף המקורות באים מ־`getCompiledAiReleaseBuild()` בלבד. גרף המקורות מנורמל LF, מסודר לפי נתיב, וכולל תלויות; tests, fixtures וה־manifest הנוצר עצמו מוחרגים. שינוי קוד אינו חידוש אישור.
2. **לשמור חומר סקירה חדש, בלי לשנות היסטוריה.** לכל מקור: קובץ הרכישה הקיים, תמלול, קטעי סעיפים, אימות השוואה, מלאי תיקונים וניתוח סמכות/תוקף. `verification_evidence_sha256`,‏ `amendment_inventory_sha256`,‏ `authority_analysis_sha256` צריכים להצביע למסמכי ראיה שמורים אמיתיים. אין להמציא שלושה hashes כדי לעבור סכמה. `available_from` מתעד זמינות אמיתית, ולא את תחילת חודש השכר.
3. **לחתום תוכן קבלות מקור בפורמט AI.** `tivdoc-ai-source-review-v1` כולל את ה־source version,‏ artifact/transcription/excerpt hashes, מקור הרכישה, תחולה/אוכלוסייה/נושאים, סטטוס סקירה, זהות סוקר AI ומתודולוגיה, זמנים ו־hash. `status:accepted` דורש סקירה שבוצעה ומתועדת; מציאת הקובץ תומכת בזמינות בלבד. אפשר לשמור `unknown` כששרשרת או סמכות לא הושלמו.
4. **להכין את שיטת הענף לפני hash הפרשנות.** בוחרים descriptors מהקטלוג ומחשבים `aiReleaseFamilyMethodsSha256(branchId, methods)` מתוך `recipe_id`,‏ `recipe_version`,‏ `recipe_sha256`,‏ `source_policy_sha256` בלבד. כך ניתן לקבע `interpretation.method_sha256` בלי מעגל hash. סדר המתכונים קנוני ו־IDs כפולים נדחים.
5. **ליצור קבלת פרשנות.** `tivdoc-ai-interpretation-review-v1` מצמידה generator מהבנייה, קבוצת קבלות מקור בדיוק, שיטה, תחולה, נימוקים, מגבלות ו־`human_by_law`. זהות הסוקר היא AI אמיתי/יישום דטרמיניסטי של סקירה מזוהה, ולא ״אישור עורך דין״. כעת descriptors יכולים להצביע ל־hash הפרשנות. חלון המתכון חייב להיות בתוך חלונות מקור/פרשנות/מדיניות/מרשם.
6. **להפיק ראיית בדיקות אמיתית על הבנייה והשיטה.** `tivdoc-ai-rule-tests-v1` מקבעת branch/generator, מקורות ופרשנות בדיוק, `code_sha256=source_graph_sha256`, הגדרות בדיקה, אורקל עצמאי ותוצאות שמורות. זמני הבדיקות מאוחרים לקבלת הפרשנות. fixture סינתטי הוא ראיית בדיקה לגיטימית; הוא אינו מקור משפטי או עובדת תיק בתוך התצורה. מספרי passed/failed ותוצאת הריצה ייקראו מהתוצאה האמיתית, לא יועתקו מהרצה של build אחר.
7. **לבנות policy, registry ואז configuration.** המדיניות מצמידה קבלות וקטגוריות בדיקה, תקופה ואוכלוסייה, גבול מוצר ו־`human_attestation:null`. המרשם מצמיד policy hash וזהויות סוקרים עם גרסה, `model_reference` אמיתי וחלון קבוע. לבסוף `tivdoc-ai-release-configuration-v1` מכילה configuration UUID/revision,‏ population,‏ build manifest SHA,‏ policy/registry, קבלות, methods ו־hash. אין בה case ID, סכומי תיק, assessment, current context או pins שסופקו כתחליף לבנייה.
8. **לאמת שלמות לפני שימוש.** `verifyAiReleaseConfiguration(candidate, getCompiledAiReleaseBuild())` בודק קישורים, מקור/תקופה/אוכלוסייה, build, recipes, זמנים וסדר קבלות. הוא מסרב גם לקבלות שאינן בשימוש ול־source version שמופיע פעמיים. המאמת אינו בוחן כשירות מקרה או תוקף לפי שעון המסד ואינו מקדם `unknown`.

`MINIMUM_WAGE_SOURCE_REVIEW_SHA256` הוא hash מדיניות המקור הקיימת; הוא **אינו** `tivdoc-ai-source-review-v1.sha256`. גם `unsigned-review-package.json` ו־`unsigned-review-addendum-1.1.0.json` הם חבילות היסטוריות מסוג אחר. שומרים אותן ובונים קבלות חדשות עם provenance, בלי לשנות שמות או להוסיף להן אישורים בדיעבד.

אם המדיניות דורשת `generated.case_evidence`, היא צריכה לומר במפורש שזהו manifest מחושב של ראיות מקרה שנוצרו מחדש. הוא אינו שם של תא מסמך, ואסור להציבו ב־`document_reading_fact_keys`; המאמת מסרב לכך. אימות manifest אינו מקדם קריאת שדה חסרה, אינו מעניק תחולה ואינו מחליף החלטות תיק נדרשות.

## מפת קטגוריות בדיקה לשכר מינימום

הקוד הקיים [minimum-wage.test.ts](../src/engine/entitlement-review/minimum-wage/minimum-wage.test.ts) מכיל את הווקטורים שלהלן. **לא הורצה כאן הקבוצה ולא נוצרה קבלת תוצאות עדכנית.** שמות הקטגוריות המוצעים הם החלטת מדיניות שיש לקבע; הם אינם רשימה שמתקבלת אוטומטית מספירת בדיקות.

| קטגוריה מוצעת | ראיה קיימת בקוד הבדיקות |
|---|---|
| `positive_zero_signed_delta` | פער חיובי; התאמה מלאה; תשלום מתועד מעל המצופה בכל אחת משלוש השיטות |
| `explicit_method_divergence` | 100 שעות נותנות 3,540.00 מול 3,540.58; rule IDs ו־fingerprints נפרדים |
| `rounding_and_units` | חצי שעה, אגורה סופית; סירוב ליחידות ימים במקום שעות; סכום חודשי אינו 182 כפול תעריף שעתי מעוגל |
| `period_and_population_boundary` | מאי, יוני ויולי בנפרד; סירוב אפריל/חודש חסר/מקור זר; קטין וחלקיות לא נתמכת נשארים חסומים |
| `eligible_inventory_and_duplicates` | רכיב בסיס ותוספת קבועה; הוצאת החזר הוצאות שכבר סווג; חסימת רכיב לא ברור/מלאי חלקי; סירוב לכפל תצפית |
| `missing_conflict_stale_expired` | סכום/שעות/תקופה חסרים אינם אפס; סיווג conflict/stale/expired אינו מוחלף במספר שמיש |
| `applicability_not_declaration` | תחולה חסרה/פגה חוסמת; הצהרת לקוח אינה אישור תחולה; בחירת מסגרת 182/42 מופנית להכרעה פנימית |
| `replay_and_legacy_preservation` | שינוי operand מפיל replay; חבילת יוני ההיסטורית נשמרת, והקטלוג החדש נשאר תחום וגרסאי |

בנפרד יש לצרף ראיית מעטפת מן הבדיקות הקיימות ב־`ai-release/policy.test.ts`,‏ `ai-release-runtime` וב־`processing/ai-release-configuration.test.ts`: build זר/drift, hash או source set שונו, מתכון זר, תפוגה וביטול, מקור סינתטי ב־REAL, `human_by_law` לא מוכרע ו־QA מחוץ לסביבה. אין להכריז שקטגוריית דין נבדקה רק מפני ש־schema או חיבור למסד עברו.

## חבילת QA ישימה בלי הכנת עובדות תיק

המלצה לבעל חבילת ההפעלה: להתחיל ב־**configuration של MW בלבד** עם ארבעת מקורותיו ו־11 המתכונים אינם חובה לכל תצורה. החוזה מאפשר תת־קבוצה של ענפים; קיום תשעה pins קומפלים אינו מחייב להמציא קבלות לשמונה ענפים אחרים. הרחבת התצורה לתשע המשפחות תיעשה בגרסאות חדשות לאחר השלמת ראיות כל משפחה. הדבר אינו משנה רכישה או מעלים נושאים חסומים בדוח.

אפשר לשמור את חומרי ההכנה החדשים תחת `E/ai-configuration-evidence/<package>/`:‏ `sources/`,‏ `interpretations/`,‏ `tests/`,‏ `policy/`,‏ `registry/` ו־`configuration.private.json`. זו הצעת מבנה בלבד; תיקיות וקבצים אלה לא נוצרו במשימה זו. אין שם `case_facts`,‏ customer assessment, RuleSpec שנשתל כתוצאה או דו״ח שהוכן מראש. במקרה QA שהוגדר בנפרד, המסלול הרגיל בלבד טוען מקור, קריאות/תשובות ותקופה, ובונה את החישוב.

יש להבחין בין שתי בדיקות:

* **בדיקת שלמות והמסלול החסום:** `namespace:isolated_test`, סביבות `development`/`test`, ו־`is_qa:true` רק בהקשר המאומת של המוצר. אפשר לבנות תצורה ישרה עם פרשנות/גבול מוצר `unresolved` ולוודא שהמסלול מחזיר את החסם הנכון ושומר היסטוריה. אין צורך לשנות עובדות כדי לבדוק זאת.
* **בדיקת admission חיובי:** מחייבת גם הכרעה מבוססת ומוקלטת ב־`human_by_law`, מקורות/פרשנות שמישים, בדיקות ונתוני תיק/החלטות נדרשות. [policy.ts](../src/engine/ai-release/policy.ts) מחזיר `AI_RELEASE_HUMAN_BY_LAW_UNRESOLVED` גם ב־`isolated_test`. שינוי namespace אינו פטור. אין להעתיק מן ה־runtime fixture את `not_required_for_supported_branch` לחבילה שעוסקת בדין אמיתי.

לגבול השירות ב־REAL נשארת ההכרעה הממוקדת ב[מסמך גבול המוצר](ai-release-product-boundary-2026-09-12.md). מסמכי חוק הלשכה המקוריים שמורים ב־`E/ai-activation-sources`; הם חומר לסקירה, לא אישור. יש לברר שירות ותוכן מוגדרים ולתעד בסיס, מקור ומעמד ההכרעה. שינוי מניין הסוקרים הפנימי אינו קביעה משפטית. אם קבלת `human_by_law` נשענת על מקור נוסף, עליו להיות קבלת מקור אמיתית בשימוש בענף ובתחולה המתאימה; אי אפשר להכניס hash לא מוכר רק בשדה ההסבר.

המנגנון התפעולי כבר קיים: [ai-release-control.mjs](../scripts/product-workers/ai-release-control.mjs) ו[runbook](ai-release-control-runbook-2026-09-12-he.md). הפקודות המקומיות, לאחר שקובץ התצורה הוכן במסגרת חבילה נפרדת, הן:

```powershell
node scripts/ai-release-build-manifest.mjs --check
node scripts/product-workers/ai-release-control.mjs inspect
node scripts/product-workers/ai-release-control.mjs config-validate --configuration <existing-private-configuration-path>
```

אלה דוגמאות שימוש בלבד, לא פקודות שבוצעו במשימה זו. placeholder הנתיב יוחלף בנתיב קובץ פרטי קיים. `config-store`,‏ `enroll`,‏ `revoke` ו־`status` משתמשים בכלי הקיים לפי ה־runbook, עם dry-run כברירת מחדל. אין במלאי זה הוראת כתיבה, אישור שיוך או חידוש זמן. הכלי אינו מחבר קבלות ואינו בוחר שיטה; **החסר לפניו הוא בניית חומרי סקירה וקבלות אמיתיים, לא כתיבת עוד כלי DB**.

## החלטות שנותרו והבעלים שלהן

| חסר | סיווג | הפעולה הקונקרטית והבעלים |
|---|---|---|
| ארבעת קובצי MW ותמלוליהם | זמינים, hashes תואמים | סוקר המקור משתמש בבייטים הקיימים, מתעד קטעים ומלאי תיקונים; אין צורך להוריד מחדש כדי להוכיח נוכחות |
| נוהל אכיפה 403 | artifact שלא נרכש | סוקר המקור קובע אם נדרש לשיטה הנבחרת; אם כן משיג מקור תחום/חלופה מתועדת, בלי קבלת תוכן מומצאת |
| `verification_evidence`,‏ amendment inventory, authority analysis בפורמט AI | חומר וקבלות סקירה שלא הופקו במשימה | סוקר AI מזוהה מכין מסמכי ראיה ושומר hashes, תוקף וסטטוס אמיתי; יש להבחין בחוסר ראיה ובסתירה |
| MW published hourly מול exact divide ודיוק העיגול | הכרעת שיטה | סוקר הפרשנות ובעל מדיניות המוצר מקבעים שיטה, מקורות, מגבלות וקבלת מתכון; לא שואלים לקוח לבחור נוסחה משפטית |
| אוכלוסייה, רכיבים, שעות והקצאה | ראיות והכרעת תיק; לעתים חיבור תוכנה חסר | המתאמים וה־assessment הרגילים בלבד; config לא ממלא ערכים ולא הופך תשובה כללית לקריאת מקור |
| גבול שירות אישי ו־`human_by_law` | הכרעה משפטית/מוצרית מוגדרת שטרם הוכחה | בעל השירות משלים את ההכרעה על השירות בפועל והמקורות הנדרשים; עד אז `unresolved`, גם אם כל hashes תקינים |
| build סופי וקבלת בדיקות מקושרת אליו | checkpoint וראיית ביצוע | בעל הבנייה מקבע את הגרף ומפיק ריצה עם תוצאות ו־oracle hashes; אין הסבת מספרי PASS מבנייה קודמת |
| יצירת JSON מקבלות מוכנות | הרכבה מקומית חסרה | assembler קטן שיקרא רשומות סקירה מפורשות, יחשב קישורים בסדר שלעיל ויקרא למאמת הקיים; ללא ברירת מחדל `accepted`, ללא אישור מחדש וללא עובדות תיק |

הבחנה זו מאפשרת להשלים את הקוד והראיות בלי לכנות כל חסם ״מקור חסר״ או ״נדרש אדם״, ובלי להציג תצורה שלמה מבחינה מבנית כאילו היא החלטת פרסום.
