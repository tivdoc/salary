# הפעלת תצורת AI ושיוך תיק QA ב־DEV

הכלי `scripts/product-workers/ai-release-control.mjs` מאמת ושומר תצורה בלתי ניתנת לשינוי, ורושם אירועי שיוך וביטול ביומן. ברירת המחדל היא בדיקה ללא כתיבה למסד הנתונים. `--apply` נדרש במפורש עבור `config-store`,‏ `enroll` ו־`revoke`.

כל הפעלה נעשית ממחשב מקומי בסביבת פיתוח, מתוך שורש מאגר `salary`, ב־Node 22 ומעלה ובאמצעות התלויות הנעולות של המאגר. סביבת Production או Vercel נדחית לפני קריאת קבצים. אין מסלול עקיפה. נדרש schema 177, ובפרט פונקציית הבעלים `private.ai_release_enrollment_record`.

הכלי מוגבל למסד DEV הקיים `tivdoc_release_replay_20260907`, לשרת ה־pooler ולמשתמש migrator המקובעים בקוד. לפני כל פעולה מול המסד נבדקים גם `session_user`,‏ `current_user` ושם המסד בפועל. פעולות תיק דורשות `cases.is_qa=true`. אין בכלי יצירה של הרשאת מכונה, שינוי תקציב, שליחת הודעה, פרסום דוח, שינוי תצורה קיימת או הפעלה של ספק.

## קבצים פרטיים קבועים

יש להשתמש בקובץ credentials הקיים, שמכיל `TIVDOC_DEV_DATABASE_URL`. מעבירים **נתיב לקובץ**, ולא URL או סיסמה בשורת הפקודה. החיבור משתמש ב־CA הקיים ובאימות תעודה; `sslmode` שהגיע ב־URL אינו מבטל זאת. צורת חיבור pooler ומשתמש מותאם מתועדת גם ב[תיעוד Supabase הרשמי](https://supabase.com/docs/guides/database/connecting-to-postgres).

קובצי credentials, תצורה ובקשה חייבים להיות מחוץ למאגר המוצר. הכלי פותר קישורים וצמתים, מסרב לקבצים שבמעקב Git ודורש החרגה מפורשת בכל מאגר אב. מאגר בית המשתמש אינו פטור מבדיקה זו. אין להשתמש בקובץ שנמצא בתוך מאגר המוצר גם אם הוא ignored. אין שינוי אוטומטי של `.gitignore`,‏ `info/exclude` או credentials.

התצורה היא הפלט המקורי של מנגנון תצורת AI הקיים: `tivdoc-ai-release-configuration-v1`, כולל hash, תצורת מדיניות, מרשם וקבלות מקור/פרשנות/בדיקות. הכלי אינו יוצר או משלים קבלות, אינו בוחר שיטה ואינו משנה `unknown`,‏ `conflict` או `human_by_law.unresolved` למצב מאושר.

כל בקשת שיוך או ביטול נשמרת בקובץ פרטי חדש עם המבנה הבא. הדוגמה סינתטית בלבד, והתאריכים אינם הרשאה לפעולה:

```json
{
  "schema_version": "ai-release-control-request-v1",
  "case_id": "11111111-1111-4111-8111-111111111111",
  "configuration_sha256": "<64 lowercase hexadecimal characters from the verified configuration>",
  "request_key": "owner-approved-package-grant-001",
  "issued_at": "2026-09-12T09:00:00Z",
  "expires_at": "2026-09-12T12:00:00Z",
  "reason": "An explicit, accurate description of this bounded QA operation."
}
```

הזמנים חייבים להיות UTC מפורשים, עם שניות ולכל היותר שלוש ספרות אלפיות; החלון חיובי ועד 24 שעות. שיוך חדש חייב להיות בתוך חלונות המדיניות והמרשם ולהיות בתוקף לפי שעון המסד. אין החלפת זמן אוטומטית ב־`Date.now`. לביטול יוצרים **קובץ בקשה חדש ומפתח חדש**, לא עורכים את בקשת השיוך. hash התצורה בביטול חייב להתאים לשיוך האחרון.

## פקודות

משתני PowerShell אלה מכילים נתיבים בלבד. יש להציב נתיבים אמיתיים של הקבצים הפרטיים הקיימים והמוכנים לבדיקה:

```powershell
$aiCredentials = 'C:/private-existing-owner/credentials.env'
$aiConfiguration = 'C:/private-current-package/configuration.private.json'
$aiGrant = 'C:/private-current-package/grant-request.private.json'
$aiRevoke = 'C:/private-current-package/revoke-request.private.json'
$aiQaCase = '11111111-1111-4111-8111-111111111111'
```

בדיקה מקומית ללא חיבור למסד:

```powershell
node scripts/product-workers/ai-release-control.mjs inspect
node scripts/product-workers/ai-release-control.mjs config-validate --configuration $aiConfiguration
```

שתי הפקודות בודקות את manifest הבנייה מול קוד המקור הנוכחי. המאמת הקיים נטען מ־bundle זמני בזיכרון, יחד עם singleton הבנייה הקומפלת. drift עוצר את הפעולה; הכלי אינו מריץ `--write` ואינו מחדש אישור בעקבות שינוי קוד. `config-validate` מוכיח שלמות וקשרים בלבד, ואינו מוכיח שהתצורה מספיקה לפרסום או להכרעת תיק.

בדיקות DEV ללא כתיבה; כל החיבור מתנהל בטרנזקציה `READ ONLY`:

```powershell
node scripts/product-workers/ai-release-control.mjs config-store --configuration $aiConfiguration --credentials $aiCredentials
node scripts/product-workers/ai-release-control.mjs enroll --request $aiGrant --credentials $aiCredentials
node scripts/product-workers/ai-release-control.mjs revoke --request $aiRevoke --credentials $aiCredentials
node scripts/product-workers/ai-release-control.mjs status --case $aiQaCase --credentials $aiCredentials
```

`enroll` דורש שהתצורה כבר נשמרה. `revoke` דורש שיוך מתאים; לכן הבדיקה תסרב לביטול לפני שקיים שיוך. `status` מציג את האירוע האחרון ואת מצבו בזמן הקריאה, בלי להפעיל ניתוח ובלי לקרוא פרטי לקוח.

לאחר שהקבצים והפעולה המוגדרת בהם אושרו במסגרת חבילת העבודה, הכתיבות המפורשות הן:

```powershell
node scripts/product-workers/ai-release-control.mjs config-store --configuration $aiConfiguration --credentials $aiCredentials --apply
node scripts/product-workers/ai-release-control.mjs enroll --request $aiGrant --credentials $aiCredentials --apply
node scripts/product-workers/ai-release-control.mjs revoke --request $aiRevoke --credentials $aiCredentials --apply
```

`config-store` שומר INSERT בלבד. אותו מזהה וגרסה חייבים להתאים לכל תוכן התצורה הקיים; אין upsert שמחליף תוכן. RPC האירועים נועל את התיק, בודק את המפתח לפני INSERT, מקצה sequence ועוגן predecessor ומחזיר קבלה בלתי משתנה.

## חזרה, תפוגה וביטול

לאחר תשובה לא ודאית, מריצים **אותה פקודה עם אותו קובץ בקשה**. מפתח קיים עם payload שונה נדחה. מפתח קיים עם אותו payload מחזיר את האירוע המקורי, גם אם פג תוקפו או שיש אירוע חדש אחריו. `replayed=true` אינו הרשאה מחודשת; `current=false` מסומן `superseded`. אין להחליף מפתח כדי לעקוף חוסר ודאות על פעולת עבר.

ביטול, בדיקת מצב וחזרה מדויקת על אירוע קודם נשארים אפשריים גם אחרי שינוי קוד או תפוגת תצורה. ביטול אינו דורש שתצורה ישנה תתאים לבנייה חדשה. **שיוך חדש** כן דורש אימות תצורה מול הבנייה הנוכחית ותוקף חלונות; הוא אינו מאריך מדיניות או קבלות מקור.

הפלט הוא JSON מסונן: מזהי אירועים, hashes, זמנים, מצבי קבלות וספירות. הוא אינו כולל credentials, טקסט reason או payload התצורה; reason ו־request_key מיוצגים ב־hash. יש לשמור פלט תפעולי בתיקייה הפרטית של החבילה. שגיאות מוצגות בקוד קבוע ללא SQL, נתיב או ערך רגיש.

`within_window` פירושו רק שיוך אחרון בתוך חלון הזמן שנרשם. בכל הפלט `runtime_admission_evaluated=false`: מקור, תחולה, עובדות, החלטות נדרשות, בדיקות, build ותוקף ייבדקו מחדש במסלול המוצר הרגיל. הגבלה זו חלה גם אם שמירת התצורה והשיוך הצליחו.

## אימות הכלי

```powershell
npx vitest run scripts/product-workers/ai-release-control.test.mjs --maxWorkers=1
npx eslint scripts/product-workers/ai-release-control.mjs scripts/product-workers/ai-release-control.test.mjs
```

הבדיקות סינתטיות ומקומיות: סירוב Production/Preview, תחימת DEV וזהות, קריאה בלבד כברירת מחדל, שלמות תצורה, retry לאחר תפוגה/ביטול, סירוב payload שונה, קישורים ו־Git, סינון פלט והמאמת הקומפל. הוכחת RPC וטרנזקציה במסד DEV מתועדת בנפרד על ידי מפעיל החבילה; בדיקות אלה אינן מציגות כתיבה חיה כאילו בוצעה.
