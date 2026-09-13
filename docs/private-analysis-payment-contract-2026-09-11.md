# חוזה התשלום והיקף ההזמנה לניתוח פרטי — 2026-09-11

המסמך אינו מכיל נתוני לקוח. זהו audit של הקוד והיסטוריית Git בבסיס `7b5519b`, ובהמשך הצלבה עם snapshot פרטי שהמשלב קרא. בתת־משימה לא בוצעו קריאות DB, הרצות בדיקה או שינוי Production. המשלב דיווח שבפרויקט Production קיימות הטבלאות הישנות `public.cases`, `public.payments`, `public.documents`, ולא `private.product_orders`; יש לאמת עמודות בפועל לפני שימוש בשאילתות להלן. commit מתקופה מסוימת הוא ראיה למה שהקוד הציע, לא הוכחה שגרסה זו נפרסה בזמן עסקה מסוימת.

## חוזה התשלום הישן

הבסיס הוא `supabase/migrations/202608220001_salary_mvp.sql` וההקשחה `202608220002_invoice4u_verification.sql`. רשומת payment מכילה סכום **בשקלים decimal**, מטבע, מצב, case_id ו־idempotency key. אין להמיר `amount` כאילו היה `amount_minor`. מפתח הבדיקה הראשונית הוא `<case UUID>:initial-check`; מזהה ההזמנה אצל הספק הוא `tivdoc-salary:<public_id>`.

ה־verifier שהתווסף ב־`e7e84fe`, וקיים בגרסת `8d00dc9`, קושר Invoice4u clearing log, PaymentId לא־אפס, מספר אישור, סכום ומטבע. הפונקציה ב־DB נועלת payment, בודקת את הקישור לתיק ולאותה הזמנת ספק, מסרבת לשימוש באסמכתה של תיק אחר ושומרת יחד:

- `payments.status='verified'`, `verified_at`, `provider_payment_id`, `provider_reference`, `provider_clearing_log_id`, `provider_confirmation_number`.
- `cases.payment_status='verified'`, `cases.status='under_review'`.

`provider_reference` ו־`provider_clearing_log_id` היו אותו מזהה clearing log אחרי אימות. אינדקסים ייחודיים נועדו למנוע שימוש חוזר במזהי הספק. `provider_order_id` נשמר בעת יצירת checkout. `provider_checkout_created_at`, redirect URL, טוקן חזרה ואירוע analytics אינם אישור חיוב.

המחיר בקוד ההיסטורי הזה היה9.99ILS. אין להשתמש במחיר כתנאי לקוח אמיתי או להשליך מחיר נוכחי על ההזמנה: הסכום שנשמר בעסקה הוא ראיית התשלום. חריגה מול קוד ההצעה מאותה תקופה היא סימון לבירור. `paid` לבדו חלש מ־`verified` עם עקבות. גם status של תיק `under_review` או `completed` אינו ראיית תשלום או מסירה.

הפונקציה הישנה ביותר `private.mark_salary_case_paid` יכלה לסמן verified ללא כל השדות החדשים; היא הוסרה במיגרציית האימות. לכן רשומה היסטורית חסרת עקבות אינה בהכרח לקוח שלא שילם: היא עוברת לקבוצת בירור ואינה נשמטת מהמיפוי.

## סינון בטוח — מיפוי ואז סיווג

אין לספור מראש שישה או שבעה. יש לקרוא תחילה metadata בלבד, ולשמור את תוצאת השאילתה הפרטית מחוץ ל־Git. דוגמת איתור candidate cases, לאחר אימות שהעמודות קיימות:

```sql
with candidates as (
 select p.case_id
 from public.payments p
 where p.status in ('paid','verified','refunded') or p.verified_at is not null
    or (p.status='pending' and nullif(btrim(p.provider_payment_id),'') is not null
        and btrim(p.provider_payment_id)<>'0')
 union
 select c.id from public.cases c
 where c.payment_status in ('paid','verified','refunded')
)
select c.id,c.public_id,c.is_qa,c.attribution_status,
 c.status case_status,c.payment_status case_payment_status,c.created_at case_created_at,
 p.id payment_id,p.provider,p.amount,p.currency,p.status payment_status,p.created_at payment_created_at,
 p.verified_at,p.idempotency_key,p.provider_order_id,p.provider_payment_id,
 p.provider_reference,p.provider_clearing_log_id,p.provider_confirmation_number,
 (select count(*) from public.documents d where d.case_id=c.id) document_rows,
 (select count(*) from public.documents d where d.case_id=c.id and d.document_type='payslip') payslip_rows
from candidates k join public.cases c on c.id=k.case_id
left join public.payments p on p.case_id=c.id
order by c.created_at,c.id,p.created_at,p.id;
```

יש לשמור את **כל** רשומות התשלום של candidate case, ולא לבחור את האחרונה: ניסיון checkout מאוחר שנכשל אינו מבטל בשתיקה עסקה קודמת, ותשלום verified קודם אינו מסביר לבדו refund מאוחר. pending בלי מזהה ספק ממשי יכול להימנות בסיכום metadata נוסף, אך אינו מצדיק הורדת מסמכי לקוח כאילו התשלום אומת.

הסיווג הוא נפרד מהאיתור:

| קבוצה | תנאים/פעולה |
|---|---|
| ניסוי מפורש | `is_qa=true` או `attribution_status='internal_qa'`. להפריד גם אם התשלום מאומת; לא לכלול בתיקי לקוחות אמיתיים. |
| אימות שמור עקבי, מועמד לניתוח פרטי | `is_qa=false`, ללא internal_qa; payment Invoice4u במצב verified עם `verified_at`; סכום חיובי ומטבע שמור; key והזמנת ספק תואמים לתיק; כל מזהי הספק לא־ריקים ו־PaymentId אינו0; reference שווה clearing log; case payment_status עקבי; אין סימן refund/ביטול/סתירת אסמכתה. |
| דורש בירור תשלום | `paid` בלבד, case verified ללא payment, מזהים/מועד חסרים, provider לא מוכר, reference/order mismatch, אי־התאמת case/payment או כפילות. לשמור ברשימת החריגים עם הסיבה; לא להפוך לבד ל־verified ולא לשלול זכאות. |
| החזר/ביטול | לשמור במיפוי עם עקבות, לא לספור כתשלום פעיל רגיל ולא לשנות זכאות. פירוש השירות שנותר דורש ראיה מקורית. |
| לא מאומת | pending/failed בלי עקבת אימות. קיימת רשומת חיוב צפוי, לא ראיה להשלמת חיוב. |
| זהות ניסוי לא ברורה | שם/דומיין/סכום חריג הם רק סימן לבדיקה פרטית. לא לקבוע QA על סמך שם או סכום בלבד. |

`is_qa=false` הוא ראיית הסיווג הקיימת, לא הוכחה עצמאית שאיש לא יצר תיק ניסוי בלי לסמן אותו. רשומות חשודות נשארות גלויות לבעלים. סיווג התשלום יתואר `saved_server_verified`; זו אינה בדיקת settlement חדשה מול הספק ביום הניתוח.

רק אחרי הסיווג נדרשים questionnaire payload ו־document metadata/bytes עבור התיקים הרלוונטיים. תיק ששילם וחסר בו מסמך נשאר במיפוי עם השלמה; count של רשומות documents אינו הוכחה שהבתים עדיין קיימים ונגישים.

## ההצעה והתקופות — לא להחיל זכאות חדשה על רכישה ישנה

ראיות היסטוריות שנקראו:

| commit | קבצים | משמעות |
|---|---|---|
| `bca1d3f` — MVP מ־22.8 | `src/lib/validation.ts`, schema המקורי | מוצר initial-check ושאלון עשיר; בלי order snapshot, חודש נבחר או רשימת topics שנרכשה. |
| `8d00dc9` — 28.8 | `src/components/check/payment-handoff.tsx`, `src/app/terms/page.tsx`, `src/components/landing/faq.tsx`, `src/app/page.tsx`, `src/lib/payment.ts` | בדיקה ראשונית של תלוש, שכר וזכויות; זיהוי חריגות, בחינה מול מידע שנמסר והערכת פערים. תלוש אחד מספיק להתחלה, חוזה ודוח שעות אופציונליים, אפשר לבקש השלמות. |
| `2ac5146` — 5.9 | `src/config/product-offer.json` | מעבר לתצורת מוצר; initial9.99, full149 מסומן default. התצורה לבדה אינה הזמנה פרטנית. |
| `05fcb5c` — 6.9 | `202609070001_terms_consent.sql` | נוספו terms_version ו־terms_accepted_at; אין backfill לרשומות ישנות. היעדרם הוא היעדר רישום מפורש, לא קביעה שלא הייתה הסכמה כלשהי. |
| `8c4f8a5` — 7.9 | `20260907120000_product_orders.sql`, `20260907122000_order_input_scope.sql` | ההזמנות/entitlements/offer hashes והיקף חודש־topics נוספו מאוחר יותר. אין להמציא אותם ב־Production הישן. |
| `c2d89b6` — 7.9 | `src/config/product-offer.json` | מדרגות99/199/349 לדוח full. הן אינן הופכות בדיקה ראשונית ישנה לדוח full ואינן מצמצמות אותה ליוני/שכר מינימום. |

עמוד הבית ב־`8d00dc9` מנה תשעה תחומי בדיקה: שעות נוספות, פנסיה, חופשה, הבראה, נסיעות, שישי/שבת/חגים, שכר בסיס, בונוסים/עמלות וחוזה מול העבודה בפועל. זו ראיית היקף ההצעה הציבורית, לא הבטחה שכל תחום אפשר לחשב בכל תיק. אין שם בחירה של שלושה topics או הוראה להגביל את השירות לשכר מינימום בלבד. יש לשמור בטיוטה מטריצת כיסוי לכל התחומים הרלוונטיים, גם כשמנוע נוכחי אינו תומך בהם.

הקוד ההיסטורי דרש תלוש כדי לפתוח checkout, והתיר קובץ אחד לכל סוג payslip/contract/attendance. זו מגבלת העלאה, לא הוכחה לתקופת זכאות של חודש אחד: PDF אחד יכול להכיל כמה תלושים/תקופות. התקופות ייקראו מהמקור; תאריך העלאה, תאריך תשלום ו־`payslip-01` אינם תקופת שכר. בלי מסמך הזמנה/receipt/פריסה תואמת נרשום `legacy_initial_scope_not_versioned` ומועמד ההצעה ההיסטורית, ולא נייחס snapshot חתום שלא נשמר.

יש לבדוק deployment provenance של אתר הרכישה ולהצליב עם timestamps/receipts המקוריים. תאריך commit או נוכחות טבלאות לבדם אינם מזהים את גרסת האתר שפגש הלקוח. שלב ביקורת הקוד לא אימת את רשומת הפריסה שפגשה כל עסקה. בהמשך נקרא snapshot פרטי של תשלומים לצורכי סיווג בלבד, כמפורט להלן.

## השאלון: שלושה דורות, בלי מילוי תשובות שלא ניתנו

1. **MVP `bca1d3f`:** employmentStartDate בתאריך מלא, statedSalary, breakMinutes, contractRole, actualRole, industry, bonuses, travelArrangement, pension=`yes|no|not_sure`, attendanceReportAvailable, לצד שכר/שעות/ימים/סופי שבוע וחשד חופשי. יש לשמור את השדות אם קיימים בפועל; הסרתם מה־UI מאוחר יותר אינה מוחקת את הצהרת הלקוח.
2. **`8d00dc9`:** שבעה שלבים; stillEmployed, salaryType monthly/hourly, typicalHoursPerDay, workDaysPerWeek, worksFriday/Saturday, payslipAvailable, פרטי קשר ו־suspectedIssue אופציונלי. ההוראה ב־UI אומרת ששעות/שבוע הן הערכה. אין monthly actual hours, תאריך התחלה, גיל, מידע פנסיה בכניסה, נסיעות או החלטת תחולה.
3. **`e65ded2` — 6.9:** נוסף employmentStartMonth, birthYear, sex, hadPensionFundAtHire, employerProvidesTransport, commuteOver500m, managerialOrTrustRole. אין לדרוש את כל השדות הללו מפריט היסטורי ולהפוך כישלון parse ל״הלקוח לא מילא שאלון״.

`src/app/api/cases/route.ts` הישן שמר payload JSONB ושמר suspected_issue בעמודה נפרדת. שני המקורות נחוצים. free text יכול להסביר טענה או חסר, אך אינו הופך מעצמו לנתון מספרי מאומת או החלטה משפטית. אין להכפיל שעות יום וימי שבוע לחודש; אין להסיק שעות משכר/תעריף; pension=yes אינו fund_at_hire=true; stillEmployed=false אינו תאריך סיום; employmentStartMonth אינו היום הראשון בחודש כעובדה; role ניהולי אינו החלטת פטור מדין.

הרכיב המודרני הבטוח יותר הוא `src/server/product/processing/saved-questionnaire.ts`: הוא משמר רק מפתחות מפורשים, declared provenance ו־needs_confirmation, ואינו מסיק פטור מתשובת תפקיד. עם זאת הוא דורש journal/source/month מודרניים; אין ליצור להם סמכות מזויפת בתיק היסטורי. הכלי הפרטי צריך לשמר response UUID, case binding, זמן המקור, raw payload/hash ו־scope לא ידוע כשאינו מוכח, ואז למפות את ההצהרות במסגרת הקלט הפרטי. אין להשתמש ב־`questionnaire-facts.ts` הישן כדי להפוך managerialOrTrustRole לפטור משפטי אוטומטי.

## מסמכי מקור ומצב מסירה

בסכמה המקורית documents מכילה UUID, case_id, סוג, storage_path, filename, MIME, size ו־created_at. אין version_id/content_sha256/period_month או היסטוריית החלפה. אלה נוספו מאוחר יותר, בין השאר במיגרציה `20260907040711_document_upload_integrity.sql`. אין לסמן version=1 כאילו הוכחה גרסה היסטורית. העותק הפרטי יצמיד project, document UUID, storage path, זמן קריאה, size/MIME וה־SHA256 של הבתים שהתקבלו, תחת מזהה snapshot מקומי מפורש. הקבלה מוכיחה את הבתים שנקראו היום, לא בהכרח את הבתים ביום הרכישה.

גם `cases.status='completed'` אינו מסמך מסירה: יש לחפש רק בטבלאות/קבלות שבאמת קיימות רשומת תוצאה, דוח שנשמר, נשלח או נפתח. אם אין שדות כאלה, המיפוי יציין `delivery_evidence_unavailable`; לא להמציא היסטוריית דוח או להפעיל API כדי לייצר אותה.

## גבול קריאה בלבד

אין לקרוא את Production דרך `/api/cases/status`: ה־GET ההיסטורי מפעיל verifyPendingInvoice4uPayment, Meta/GA4 ואפשרות claim analytics. reconcile, payment return ו־verify_salary_payment כותבים; בגרסה המודרנית verifier גם יכול ליצור הודעת קישור לתיק. היות route מסוג GET אינו הופך אותו לקריאה בלבד.

המסלול הבטוח הוא SELECT מצומצם של הטבלאות וקריאת Storage עבור paths שהתגלו בתיקים הרלוונטיים. אין להפעיל checkout, reconciliation, מקור/תשובה/סטטוס write, תור לקוחות, session minting, הודעות או publication. אין לייבא לקוח אמיתי אל רתמת QA שמשנה is_qa, answers או authority. כל המיפוי האישי, תצלומי המקור והטיוטות נשמרים מחוץ ל־Git; במסירה הציבורית יהיו רק מזהי עבודה חלופיים וסיכומים לא מזהים.

## הצלבת snapshot פרטי — סיווג בלי שינוי דגלים

המשלב מסר snapshot מצומצם של שבעה תיקים בעלי payment status מאומת. לא בוצעה בתת־משימה קריאה נוספת ל־Production. המיפוי המלא וקישורו ל־SHA של snapshot המקור נמצאים בקובץ הפרטי `payment-classification.private.json`, מחוץ ל־Git.

| סיווג מבוסס־ראיות | מספר | גבול ההוכחה |
|---|---:|---|
| מועמדי לקוח לא־QA עם אימות שמור עקבי | 4 | כל בדיקות הקישור השמור עברו; זו אינה בדיקת settlement חיה חדשה. |
| QA פנימי עם זיהוי מפורש בהיסטוריית המיגרציה | 2 | שניהם נבחרו במפורש במיגרציית reconciliation שב־`8d00dc9`. תוכן הקבצים לא נבדק כאן, ולכן אין טענה שכל מקור שלהם הוכח כסינתטי. לאחד חסרות עקבות האימות המאוחרות. |
| תשלום עקבי אך בעלות QA אינה מוכרעת | 1 | יש דגל QA ושלושה מסמכים, לצד כל קישורי האימות השמורים. לא נמצא אזכור לבעלות ניסוי במקור הנוכחי או ב־diff ציבורי מוקדם לפי מזהי התיק. העדר אזכור אינו ראיה שזהו לקוח אמיתי. |

לפיכך אין לסכם ״שבעה לקוחות אמיתיים״, ״חמישה לקוחות אמיתיים״ או ״שלושה מקורות סינתטיים שהוכחו״. הסיכום הנכון הוא ארבעה מועמדי לקוח מאומתים, שני ניסויי QA היסטוריים מזוהים ותיק משולם אחד שסיווג בעלותו עמום. התיק העמום נשמר ברשימת עבודה נפרדת ואינו נשמט; `is_qa` נשאר כפי שנקרא. הבירור המדויק הוא קבלת בדיקה היסטורית של הבעלים או audit של שינוי הדגל, אם קיימים, ולא השלמת שאלות או שינוי זהות.

אין להסיק מגודל מסמך, שם קובץ או היעדר המילה QA שמקור הוא אמיתי. תשלום אמיתי יכול לשמש ניסוי של בעל המערכת. בדיקה פרטית נוספת, אם תבוצע, חייבת לשמר את העמימות ולא לכנות את המקור סינתטי או לקוח אמיתי ללא בסיס.

ה־snapshot כולל cohort של verified status בלבד. הוא אינו מוכיח שנסרקו כל pending/failed/refunded או תיקים שה־case שלהם מסומן משולם בלי payment מתאים; שאר מיפוי התשלום נשאר באחריות המשלב. כל ארבעת המועמדים ומקרי הבירור נשמרים לפי ההיקף ההיסטורי, בלי שינוי תשלום, דגל QA, מקור, תשובה או זכאות. אין הודעות לקוחות או תוצר אישי ב־Git.
