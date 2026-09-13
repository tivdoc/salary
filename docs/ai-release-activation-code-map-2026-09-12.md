# מפת קוד להפעלת מוצר AI — 12.09.2026

זהו מיפוי קריאה בלבד והצעת חיבור למועמדת השחרור. הוא אינו רישום הפעלה, קבלת שחרור או היתר פריסה. נבדק עץ העבודה שבסיסו `54279912fc6e30dd4dd0a16b8407412ddb2570d7`, בעת פיתוח מקביל של ענפי הזכאות. שמות הממשקים המוצעים להלן אינם טענה שהם כבר קיימים.

החלטת המוצר המתועדת ב[חוזה מועמדת השחרור](tivdoc-release-candidate-v1.md), סעיף ״חוזה המוצר והאמון״, מתירה מדיניות AI גרסתית מפורשת במקום הצגת מספר מאשרים פנימי כדרישת דין. היא אינה מתירה זיוף חתימת אדם, שינוי מסמך היסטורי, החלשת הרשאות או הנחת עובדה חסרה. ההיקף נשאר מאי–יולי 2026 והענפים המוגדרים בחוזה.

## הממצא המרכזי

ענפי הזכאות החדשים מתחברים ל־`document_review_input` ולדוח סקירה שמור. חיבור זה **אינו מפעיל את הקטלוג הכספי הרגיל**. המסלול הקיים עדיין בוחר קטלוג חסום ברוב הנושאים; המסיים אף דורש שתוצאות הנושאים הרגילות יישארו ללא סכום ועקבה. מסלול כספי רגיל אחר קיים לשכר מינימום ביוני בלבד, עם סמכות חתומה לפי חוזה אנושי היסטורי. מעבר למוצר AI רב־תחומי מחייב חיבור גרסתי לאורך בחירת הכלל, התלויות, הממצא, הפרסום ובדיקת הרעננות.

יש כבר הצגת טיוטות מוגנת לבעל תיק ב־DEV. לכן ״אין פרסום כספי רגיל״ אינו שקול ל״אי אפשר לראות שום דוח״: `private-document-review.ts` משתמש ב־RPC ייעודי לקריאת טיוטות, ובמסד הוא מוגבל ל־QA המבודד. אין להסיק ממנו הרשאת שירות ציבורי או מסירה ללקוחות אמיתיים.

## הפרדת סוגי החסמים

| סוג | מה באמת נדרש | מה אינו תחליף |
|---|---|---|
| מקור משפטי ותחולה | נוסח ומקטע מזוהים, תוקף לתקופה, תיקונים וקדימות, אוכלוסייה/הסדר, יחידות ושיטת עיגול המתאימים לכלל המסוים | מספר חתימות, מספר סוכני AI, הצלחת בדיקות או מחיר השירות אינם מאמתים דין |
| פרשנות | קבלה מפורשת של בחירת ענף, נימוק והראיות התומכות; אי־ודאות והחרגות נשמרות | בחירת פירוש מפני שהוא מפיק את תוצאת הבדיקה הרצויה |
| נתוני מקרה | מקור/גרסה/חודש, קריאה מזוהה או הצהרה המסווגת כהצהרה, תחולה וקשרי תשלום, עם חסרים נפרדים | אישור המדיניות אינו מאשר מספר, שעות עבודה, הרכב בסיס או העברה לקרן |
| מדיניות אמון פנימית | זהות מפעיל והחלטת מוצר, גרסה, תוקף, רמת בדיקת AI, ראיות ויכולת ביטול | `human_reviewed=true`, מזהי ״מאשר אנושי״ או חתימות סינתטיות |
| קוד מוצר | ענף כלל נתמך, תלויות, executor, ממצא/השוואה תקינים, היקף רכישה ופרסום מאותה ריצה | הסרת `BLOCKED` או העתקת סכום מתוך טיוטה |

הקוד אינו מפנה למקור חוק המחייב דווקא חמישה בודקי מקור, שני מאשרי פרמטר ומאשר הפעלה נפרד. אלה דרישות המדיניות ההיסטורית הממומשת. אין בכך קביעה שלא יכולה להיות דרישה משפטית לאישור אדם בענף מסוים: דרישה כזו צריכה לקבל שדה נפרד, מקור ותחולה; מצב לא מוכרע לא יהפוך אוטומטית ל״אין דרישה״.

## מפת חסמי היישום

נתיבי `engine/` ו־`server/` בטבלה הם ביחס לתיקיית `src/` במאגר.

| מקום ופונקציה קיימת | החסם המדויק | השינוי התחום הנדרש |
|---|---|---|
| `engine/legal-operations/catalog.ts`: `LegalOperationsCatalog.resolve`, המסלול `#real` | `REAL_CATALOG_BOUNDARY` הוא קטלוג לא פעיל עם אפס מקורות/פרמטרים/כללים פעילים. מועמדי REAL מוחזרים ללא כלל או פרמטר; מצב READY בלתי צפוי נזרק כ־`REAL_CATALOG_UNEXPECTED_READY` | קטלוג חדש בעל מזהה וגרסה למדיניות ה־AI, עם allowlist של ענפים, מקורות וכללים שנבדקו; הקטלוג ההיסטורי נשאר כפי שהיה |
| `engine/legal-operations/june2026-catalog.ts`: `June2026ReviewCatalog` | גם תוספת מקור יוני היא סקירה בלבד; `UNSIGNED_JUNE2026_CATALOG_UNEXPECTED_READY`; אין בחירת כלל/פרמטר פעיל | אין להשתמש בה כמתג. בחירה מפורשת של פרופיל ה־AI לאחר אימות קבלות המדיניות והמקור |
| `engine/legal-knowledge/canonical-readiness/evaluate-legal-readiness.ts`: `v050Reasons`, `evaluateLegalReadiness` | `review_attestation.status=reviewed` עם מועד וקישור לגרסת מקור נדרש, אחרת `HUMAN_LEGAL_REVIEW_MISSING`. נשמרים שערי ציטוט, תוקף, תחולה, תמיכה כספית וגרסה | גרסת readiness חדשה שמכירה בקבלת בדיקת AI מפורשת ומחשבת את ההחלטה מחדש. אין להציג קבלת AI כ־attestation אנושי ואין לשנות תוצאת v0.5.0 שמורה |
| `engine/legal-operations/contracts.ts`, `state-machine.ts`, `rulespec-lifecycle.ts`, `human-trust.ts` | תפקידי `human_*`; חמש החלטות מקור עם הפרדת זהויות, בדיוק שני מאשרי פרמטר, הפרדת סמנטיקה/אורקלים, `human_activation_approver`. מעטפות וקישור לחתימה נבדקים | חוזה אמון AI חדש בנפרד מהחוזה האנושי. לשמר hashes, רצף append-only, ביטול ותפוגה; זהות שירות או חתימת שלמות של מכונה תתואר ככזו |
| `engine/minimum-wage-june2026/regular-service/{authority,catalog,executor,source-admission}.ts` | `createJune2026RegularAuthority` דורש מעטפות אנושיות חתומות וארטיפקטים מדויקים; הקטלוג וה־executor מכירים מועמד יוני יחיד. הממצא נוצר רק לאחר התאמת עקבה, עובדות וסמכות | להשתמש בדפוס אימות הראיות והממצא, עם factory חדש לפרופיל AI רב־ענפי. לא להרחיב בדיעבד את סמכות יוני ולא להעביר fixture סינתטי כ־REAL |
| `server/product/processing/saved-analysis.ts`: `runSavedMonthAnalysis` | מקור עבודה במצב `draft`; ריצת June regular נבחרת רק לחודש יוני ולהזמנה של נושא מינימום יחיד, וה־runtime אינו נוצר ל־`legacy_initial`. אחרת `June2026ReviewCatalog`, `SavedAnalysisDraftBuilder`, ו־executor שזורק `REGULAR_AUTHORITY_REQUIRED` | לבחור runtime חדש מתוך הזמנה תקפה, תקופה, מקור וקבלת מדיניות מאומתת. `draft` הוא חוזה העבודה הקיים, לא הוכחה שהפעלת `mode=real` לבדה תפעיל את המוצר |
| `engine/case-analysis/service.ts`: `independentlyEvaluateReadiness`, `readyToExecute`, `topicResult` | ה־service מחשב readiness מחדש; שינוי JSON של READY ייכשל בהתאמת hash. קיימת תלות ב־`criticalFactPath` יחיד לכל נושא, למשל יתרת חופשה או תשלום הבראה, שאינם תחליף לבסיס זכאות. הודעת `PARAMETER_DUAL_ATTESTATION_REQUIRED` גם מחוברת להיעדר פרמטרים | dispatcher גרסתי למאמת AI, ותלות מוגדרת לכל ענף ולא רק שדה שער היסטורי. לא לחייב תשלום מתועד כדי לחשב צפוי עצמאי. לעדכן קודי סיבה חדשים בלי לשכתב סיבות/ריצות ישנות |
| `engine/wave3/contracts.ts`, `rule-input/snapshot.ts`, `server/product/processing/saved-order-scope.ts` | `WAVE3_TOPICS` כולל שבעה נושאים, ובהם מחלה; `savedOrderLegalTopics` מסנן אליו. תשעת נושאי הרכישה כוללים בנפרד `rest_day`, `contract`, `bonuses` ואינם אותו סט | חוזה פלט/בחירה גרסתי לכל תשעת תחומי הרכישה, עם checks מרובים, יחידות לא כספיות והשוואות. לסקור גם decode/persistence/report mappers המשתמשים ב־Wave3; אין להוסיף מחלה לרכישה ואין להשמיט שלושה נושאים |
| `engine/legal-operations/rulespec.ts`, `engine/document-review/calculations.ts` | RuleSpec מועמד מוגבל ל־`real_inactive` או `synthetic_test_only`; תוצאת candidate מסומנת `conditional_not_real_approval`, `real_activation_allowed:false`, `human_attestation:null` | provenance ותוצאת ה־candidate נשארים אמת היסטורית. קבלת מוצר חדשה תקשור את bytes שנבדקו לפרופיל ולקטלוג פעיל חדש; אין לשנות flags קיימים במקום בניית שרשרת הפעלה |
| `server/product/processing/automatic-dev-flow.ts`: `completeDocumentReview`, `completeRegularMonth`, `runAutomaticDevMonth` | `completeDocumentReview` דורש `known_subtotal:null`, `coverage_complete:false`, נושאים חסומים ו־amount/trace null, משחזר `June2026ReviewCatalog` ומוודא רינדור זהה. `completeRegularMonth` קשור ליוני/מינימום ולסמכות הנוכחית | ענף סיום חדש ומפורש לדוח ה־AI באותו runner ובאותה עסקה. אין להסיר את בדיקות הטיוטה ההיסטורית כדי להעביר אליה תוצאה כספית |
| `server/product/reports/{report-document,publication-gate,publish-ai-report}.ts` | v2 משמר הבטחה לבקרה אנושית בדוח מלא. v3 מאפשר אוטומציה רק בחוזה AI, עם מקורות, grades, ודאות ובסיס. `publicationDecision` משמר תקרת 5,000 ₪ לממצא והחזקה במקרה סתירה | חוזה מסמך/פרסום גרסתי לפרופיל החדש. שינוי תקרת מוצר או הבטחת שירות, אם יידרש, יקבל החלטה ורגרסיות משלו; אין להציג את התקרה כחוק. אימות עובד, מקור ומצב פרסום נשמר |

## מדוע ה־composer לבדו אינו סוגר את המסלול

`server/product/processing/saved-document-review.ts` טוען קלט שמור ומפעיל `composeEntitlementReview`. הפונקציה ב־`engine/entitlement-review/compose.ts` מאמתת packet, משלבת תשובות מזוהות, יוצרת checks/gaps/bindings, ושומרת `entitlement_composition` עם hash. `source-admission.ts` מאמת מקור, הזמנה, תקופה וקבלות תשובה. אלה רכיבים שימושיים שנדרשים גם במסלול החדש.

ב־`CaseAnalysisService` ה־catalog selections ותוצאות הנושאים מחושבים **לפני** `runDocumentReview`. הפלט החדש מצורף ל־`bundle.document_review`; הוא אינו משנה `bundle.topic_results` או `known_subtotal`. ממצא רגיל, כדוגמת `findingV2Schema` שנוצר ב־`June2026RegularExecutor.materialize`, דורש מקור, כלל, השוואת צפוי/מתועד, עקבה וקבלת סמכות מאותה ריצה. אין ליצור אותו מה־HTML או מהתוצאה המסוכמת של הסקירה.

נדרש גם לשמר סמנטיקה: מכסת חופשה היא ימים ולא סכום; צבירה לקרן אינה חוב מזומן; תשלום גבוה מהצפוי ואפס אינם ממצא חיובי; שעות ומנוחה עשויים לחפוף; חוזה ובונוס עשויים להתייחס לאותו תשלום. סכימת checks או בחירת המספר הגדול ביותר תיצור משמעות כספית שלא חושבה.

## שערי המסד שיש לחבר במיגרציה קדימה

זו סקירה של קובצי השרשרת, ללא שאילתה למסד או אימות סכמה מותקנת. אין לשנות מיגרציות שכבר הוחלו.

| שרשרת קיימת | בדיקה קיימת והשפעתה על השחרור |
|---|---|
| `20260907053658_release_report_contract.sql`: `private.case_report_require_checked_before_publish` | פרסום מחייב לפחות נושא `checked`; טיוטה ריקה אינה דוח מוכן |
| `20260907103000_report_review_binding.sql` ותוספות provenance | `private.case_report_current_input` נועל תיק, בודק סוג דוח ורוויזיית קלט; פרסום אוטומטי מוגבל לתנאי המדיניות. `private.report_published_immutable` מונע שינוי תוכן/מקור אחרי אישור/פרסום; מסלול תיקון append-only |
| `20260908162320_ai_report_publication.sql` | הענף v3 דורש worker מאומת בתיק, actor מערכת מוגדר, הזמנת `full` עם offer v2/AI ו־`human_review_required=false` כבוליאני JSON, hash הזמנה, topics פעילים/ישימים, basis מלא, grades פעילים ומקור מסמך/גרסה/SHA. `private.report_ai_publish` מקבל רק מסמך שמור זהה ומקבע receipt שרתי אידמפוטנטי. אין במסלול זה חלופה אוטומטית לקבלת legacy |
| `20260910160042_june2026_regular_service_authority.sql` וההרחבות המאוחרות | authority/assessment שמורים נבחרים לפי מקור, הזמנה וגרסה; זהות runtime והיקף חתום. הסכמה והטוען יודעים חוזה June ולא manifest AI רב־תחומי |
| `20260910161527_june2026_regular_results_publication.sql` | `private.june2026_regular_result_save` מחייב ריצה completed מדויקת, חודש יוני ומינימום יחיד, diagnostics, execution, facts, artifact ומסמך מאותה ריצה. טבלת results פרטית ובלתי ניתנת לשכתוב. trigger הפרסום דורש אותה תוצאת execution; namespace סינתטי מוגבל ל־DB/QA |
| `20260910172700_june2026_regular_current_authority.sql` והרחבות התלות/חידוש | `private.june2026_regular_publication_current` בודק קלט נוכחי, רכישה פעילה, assessment/registry/hash, תפוגה, ביטול וגרסאות אמון. מחובר לקריאת דוח, לבחירת הודעות ולשליחה. פרופיל AI צריך בדיקה מקבילה עם actor/policy מתאימים, לא זיהויו בתור reviewer אנושי |
| `20260910184000_regular_publication_dependency_guard.sql` | trigger הפרסום הישיר קורא גם ל־publication-current. לכן תיקון callback ב־TS בלבד אינו מספיק; אין לעקוף currentness באמצעות SQL ישיר |
| `20260911171700_private_review_canonical_case_binding.sql` | ה־RPC לקריאת טיוטה פרטית דורש קשר זהות לתיק ובסיס QA מבודד. אין להסיר מגבלה זו כדי להפוך טיוטה לפרסום; הפרסום החדש ישתמש במסלול הדוח הרגיל |

חיבור legacy צריך להשתמש בקבלת הרכישה המאומתת וב־origin/hash שלה. רכישה היסטורית אינה offer v2 חדש, אינה סמכות פרסום, ואין ליצור עבורה תשלום או הזמנה פיקטיביים. תקופת רכישה חסרה נשארת חסרה עד ראיה מתאימה. אם הבטחת השירות ההיסטורית שונה, החלטת המוצר תתועד בחוזה החדש בלי לשנות את קבלת המקור.

## ממשק מדיניות AI מוצע

שם מוצע: `tivdoc-ai-release-policy-v1`; אימות במודול חדש `engine/ai-release/**`. זהו **חוזה מוצע לתיאום**, ללא הפעלה. הוא יפלוט קבלת הערכה ולא שינוי אובייקט אנושי:

1. **Policy manifest:** מזהה/גרסה/hash, מועד כניסה ותפוגה, החלטת מוצר מקושרת, סביבה ו־namespace, תשעת נושאי הרכישה, ענפים/תאריכים/אוכלוסיות מותרים, פרופיל בדיקה ופרסום, גרסאות source/interpretation/test שהותרו. `actor_kind=ai_reviewer` או זהות שירות נפרדת, ללא תפקיד `human_*`.
2. **Source review receipt:** SHA של bytes ושל תעתיק שנבדק, מזהה גרסה, סעיף/עמוד, דרך רכישה ומקור, סטטוס תיקונים וקדימות, תוקף וידיעה בזמן ההערכה. ״עותק ראשוני באתר צד שלישי״ שונה מרכישה רשמית, וכשל URL אינו הופך להצלחה. קבלה מצביעה לראיות; טענה עצמית `verified:true` אינה מספיקה.
3. **Interpretation receipt:** שאלת הפרשנות, הענף שנבחר והחלופות/החרגות, סעיפים תומכים, parameters/units/rounding/rule SHA, תחולה ומה אינו מוכרע. קבלת בדיקה נפרדת עם expected outputs שנקבעו ממקור, קוד הבדיקה, תוצאה ו־SHA. מספר בדיקות או ציון ביטחון לבדם אינם תנאי זכאות.
4. **Case assessment:** case/order origin ו־receipt SHA, מקור revision/SHA, חודש, עובדות וקבלות קריאה, selectors, dependencies לכל check, חלון זמן, בסיס תחולה, receipt IDs של מקור/פרשנות/בדיקה. מצב לכל החלטה: מוכרע, חסר, לא ידוע, סותר, מיושן או פג תוקף. תשובת לקוח אינה סמכות משפטית ואינה מאמתת קריאה שלא נעשתה.
5. **Human-by-law decision:** שדה נפרד `required | not_required | unresolved` עם בסיס ותחום ההחלטה. מדיניות המוצר יכולה להחליף דרישת מאשרים פנימית; היא אינה יכולה לעקוף דרישה משפטית מזוהה. `required`/`unresolved` אינם עוברים לענף הפעלה ללא הנתיב המתאים.
6. **Admission receipt:** אימות חוזר של כל הקבלות ושל registry נוכחי, hash של מכלול התלויות, החלטות/חסמים, זמן הערכה ותפוגה, `human_attestation:null`. יכולת ההפעלה נוצרת רק מה־factory המאמת ולא מ־JSON שהועבר בידי לקוח. confidence של AI יוצג בנפרד מוודאות הקריאה, שלמות בסיס החישוב ומעמד טענה כספית.

מאמת ליבה טהור אינו יודע אם registry שמסר קורא הוא העדכני במסד. לכן הטוען השרתִי יפיק הקשר מאומת בתיק, בזמן המסד, עם ראש registry/מדיניות ורשומות ביטול; ה־executor וה־publisher יבדקו אותו שוב. signatures של מכונה, אם ישמשו להגנת שלמות, יתויגו כחתימת שירות ולא כהסמכה מקצועית. מעטפה חסרה, זרה, פגת תוקף, שבוטלה או עם digest שאינו תואם תידחה.

## סדר החיבור ותנאי הקבלה

1. **חוזה ומאמת חדשים.** לקבע תחילה policy/receipts/admission ואת רשימת ה־digests המותרים. בדיקות למקור זר, חסר, תיקון חדש, תוקף, ביטול, בדיקת כלל שאינה תואמת, שינוי כלל/פרמטר, דרישת אדם לא מוכרעת, namespace ו־case/order. חוזי human ו־synthetic קיימים אינם משתנים.
2. **קטלוג ו־executor בפרופיל חדש.** אימות readiness מחודש באותו `CaseAnalysisService`; תלויות ענפיות וכל תשעת הנושאים, עם ריצה מאותו source packet. expected, recorded, difference ויחידות נשמרים בנפרד. אין הפיכת gap לאפס ואין סיכום חופף של תוצאות. נתיב חסר נשאר פעיל להשלמה בלי לחסום בדיקה עצמאית.
3. **אותו מסלול פרסום רגיל.** המונח `ordinaryPublicationFlow` כאן מתאר את השרשרת הקיימת: saved job → `CaseAnalysisService` → completed stages → מסיים החודש → projection שמור → `publishSavedAiReport`/`private.report_ai_publish` → QA receipt → קריאה מוגנת/הודעה. לא נמצאה פונקציה בשם מילולי זה. נדרש discriminator חדש בסמכות ובמסמך יחד עם מאמת result-save חדש; אין תור, עמוד ציבורי או publisher עוקף.
4. **מיגרציה קדימה והפעלה מתוחמת.** table/receipt חדש וקבלת תוצאה מאותה ריצה, בלי הרשאות ישירות ללקוח. כל שערי publish/read/send יקבלו את אותו profile-current check. הרחבת legacy היא union מפורש של מקור רכישה, לא הסרת order guard. backward readers ו־terminal manifests נשארים ניתנים לשחזור כפי שנחתמו.
5. **רעננות ועבודה חוזרת.** source/order/policy/registry/interpretation/test change יוצר dependency token חדש בתור הקיים; מקור אינו מקבל revision מזויף עקב מדיניות. אין איפוס עבודה שכבר הסתיימה. replay היסטורי מחזיר bytes ללא פרסום חדש; טעינת דוח ״נוכחי״ דורשת כל dependency בתוקף. expiry/revocation מחזיקים מסירה גם בלי תשובת לקוח חדשה.
6. **בדיקת מוצר על אותה גרסה וסכמה.** העלאה רגילה ותשובה מזוהה → עובדות → בחירה → ממצא/השוואה → HTML/PDF → גישה מורשית. negatives במקביל לשינוי מקור, תוקף, ביטול, הזמנה זרה ושתי עסקאות; retry ללא כפל תוצאות או הודעות. מקור/סמכות סינתטיים יישארו מסומנים ומוגבלים ל־QA. אין טענה שהבדיקות האלה נעשו במסגרת המיפוי.

אין צורך להמתין למספר מאשרים פנימי כדי לכתוב את החוזה והחיבור שהבעלים התיר. נדרש כן להחזיק ענף שאין לו מקור/פרשנות/עובדות/קוד מספיקים, ולציין את החסר המסוים בדוח. הפעלת מועמדת תתועד רק לאחר שהמאמת, הקטלוג, ה־executor, מסד הנתונים והפרסום עברו את אותה בדיקת מוצר.
