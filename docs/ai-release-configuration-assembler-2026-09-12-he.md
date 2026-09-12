# הרכבת תצורת AI מקבלות וראיות פרטיות

הכלי [ai-release-configuration-assemble.mjs](../scripts/product-workers/ai-release-configuration-assemble.mjs) קורא החלטת מדיניות וסקירות מפורשות, מאמת קובצי ראיה לפי SHA ומרכיב קבלות וקשרים בסדר קבוע. הוא משתמש במאמת וב־build הקומפלים של המוצר. אין בו חיבור למסד, קריאת credentials, שיוך תיק, פרסום, הפעלת ספק או חידוש אישור.

`unknown`,‏ `missing`,‏ `conflict` ו־`human_by_law.unresolved` נשארים כפי שנכתבו. סכמה תקינה ו־hash תואם אינם אישור מקור או היתר משפטי. הכלי אינו מסיק נימוק, בוחר שיטה או משנה את החוזים ההיסטוריים. [מלאי המקורות](ai-release-configuration-evidence-inventory-2026-09-12.md) הוא נקודת ההתחלה לסקירה; אין להעתיק ממנו סטטוס מאושר שלא נקבע.

## הפעלה מקומית

מריצים מתוך שורש מאגר `salary`, באמצעות Node 22 והתלויות הנעולות. Production,‏ Vercel ו־Preview מסורבים לפני קריאת הקלט. אין טעינת קובצי סביבה או חיפוש קבצים אוטומטי.

```powershell
$aiAssemblyInput = 'C:/private-current-package/assembly-input.private.json'
$aiAssemblyOutput = 'C:/private-current-package/assembled-v1'
node scripts/product-workers/ai-release-configuration-assemble.mjs validate --input $aiAssemblyInput
node scripts/product-workers/ai-release-configuration-assemble.mjs assemble --input $aiAssemblyInput --output-dir $aiAssemblyOutput
```

יש להחליף את נתיבי הדוגמה בנתיבים פרטיים אמיתיים. `validate` אינו כותב. `assemble` כותב רק אחרי שכל הקריאות, hashes, הקשרים והמאמת הקומפל עברו. תיקיית האב של הפלט צריכה להתקיים. נכתבים שני קבצים בתיקייה חדשה, באמצעות תיקיית ביניים ו־rename:

* `configuration.private.json` — תצורה רגילה `tivdoc-ai-release-configuration-v1`, שאפשר להעביר לכלי התפעול הקיים.
* `assembly-receipt.private.json` — hash הקלט, התצורה והבנייה; מזהי/hash/גודל ראיות; זמן ההערכה המפורש; סיבות חסימה מקדימות. אין בקבלה נתיבי קבצים או בייטי המקור.

ניסיון חוזר עם אותם קלטים מחזיר את אותם בייטים ומשתמש בפלט הקיים. שינוי תוכן, קובץ עודף או יעד אחר באותה תיקייה נדחים; אין overwrite. גם לאחר הצלחה `runtime_admission_evaluated:false`. סיבות החסימה המקדימות אינן תחליף לבדיקת המוצר מול תיק, מקור, שעון המסד וביטולים.

הקלט והפלט חייבים להיות מחוץ למאגר, לא tracked, ומוחרגים בכל מאגר Git אב, כולל מאגר בית משתמש. קישורים וצמתים נפתרים לפני הבדיקה. לראיות בלבד מותר לקרוא גם מתוך `docs/release-evidence` הקיים, כך שאין צורך להעתיק PDF משפטי ציבורי אל מאגר פרטי. יתר הקבצים במאגר אינם מסלול קריאה מותר. נתיבי ראיה יחסיים נפתרים ביחס למיקום האמיתי של קובץ הקלט.

## חוזה הקלט

הגרסה היא `tivdoc-ai-release-assembly-input-v1`. הסכמה המלאה זמינה דרך `aiAssemblySchemas(helpers).input`; היא מרכיבה את שדות הסכמות הקיימות ומסרבת לשדות עודפים. היא אינה מקבלת `case_facts`,‏ case ID,‏ assessment, תוצאות תיק, pins של יצרן מהקורא או חתימה אנושית.

| שדה עליון | תוכן נדרש |
|---|---|
| `schema_version` | הגרסה המדויקת לעיל |
| `build_manifest_sha256` | hash ה־manifest שעליו הוכנו הסקירות והבדיקות. שינוי build מסרב; הכלי אינו מריץ `--write` |
| `evaluated_at` | זמן ISO מפורש לצורך סיבות חסימה ותוצאה דטרמיניסטית; אינו זמן הרשאה מהמסד |
| `configuration` | `configuration_id`,‏ `revision`,‏ `population` בלבד |
| `evidence` | מערך `{id, kind, path, sha256}` של קבצים ממשיים; ID ייחודי, SHA קטן בן 64 תווים |
| `policy` | שדות `aiReleasePolicySchema` בלי `sha256`,‏ `branches`,‏ `product_decision_sha256`; במקום האחרון `product_decision_evidence_id`. namespace, סביבות, confidence, מתודולוגיה, תוקף ו־`human_attestation:null` מפורשים |
| `registry` | שדות `aiReleaseRegistrySchema` בלי `sha256` ו־`policy_sha256`. סוקרים מסוג `ai_reviewer` בלבד; model reference ותוקף מפורשים. ביטולים היסטוריים נשארים מפורשים, ולא נמחקים |
| `source_reviews` | שדות סקירת מקור המפורטים להלן, לרבות status וזהות סוקר; אין ברירת מחדל accepted |
| `interpretations` | סקירות פרשנות לפי branch, מקורות ושיטה, עם reasoning/limitations ו־`human_by_law` מפורשים |
| `tests` | מזהי קבלות ותוקף, הפניות למקור/פרשנות ולקובצי הגדרה, אורקל ותוצאות |
| `methods` | בחירה מפורשת של recipes עם ה־pins הנוכחיים; מערך ריק מותר כשיש ראיית שיטה נפרדת |
| `branches` | ענפים מוכרים מתוך תשע המשפחות, תקופה מאי–יולי 2026, populations, דרישות עובדות/החלטות/בדיקות והפניות לפי מזהי קבלות |

סוגי הראיות הם `artifact`,‏ `transcription`,‏ `excerpt`,‏ `verification`,‏ `amendment_inventory`,‏ `authority_analysis`,‏ `product_decision`,‏ `human_law_basis`,‏ `method_review`,‏ `test_definition`,‏ `independent_oracle`,‏ `test_results`. ההפניה נבדקת גם לפי הסוג: תמלול אינו מחליף artifact. כל קובץ עד 32 MiB, סך הראיות עד 128 MiB, והקלט עד 4 MiB. קובץ ריק או hash לא תואם נדחים. ראיה שאינה בשימוש נדחית.

ב־`source_reviews`, כל שדות `tivdoc-ai-source-review-v1` נשארים, למעט ה־hash המחושב ושדות ההפניה הבאים:

| במקום hash | קלט לפי מזהה ראיה |
|---|---|
| `artifact_sha256` / `transcription_sha256` | `artifact_evidence_id` / `transcription_evidence_id` |
| `verification_evidence_sha256` | `verification_evidence_id` |
| `amendment_inventory_sha256` | `amendment_inventory_evidence_id` |
| `authority_analysis_sha256` | `authority_analysis_evidence_id` |
| `locators[].excerpt_sha256` | `locators[].excerpt_evidence_id`; שדות `page` ו־`provision` מפורשים |

ב־`interpretations`, לא מספקים `generator`,‏ `sha256`,‏ `source_receipt_sha256s` או `method_sha256`. מספקים `source_receipt_ids` ו־`method_evidence_id`. האחרון הוא `null` בדיוק כאשר נבחרו מתכוני קטלוג לאותה פרשנות; אחרת הוא מזהה ראיית `method_review` שנבדקה במפורש. `human_by_law` מכיל `state`,‏ `explanation`,‏ `basis_evidence_id` ו־`source_receipt_ids`. השדה לא יכול להיעדר, והכלי אינו בוחר את מצבו.

כל פריט `methods` מכיל `recipe_id`,‏ `recipe_version`,‏ `recipe_sha256`,‏ `source_policy_sha256`,‏ `interpretation_receipt_id`,‏ `issued_at`,‏ `expires_at`. את ארבעת ה־pins הראשונים מקבלים מן הקטלוג החי לאחר הסקירה, בלי מחרוזות מקובעות בתסריט פרטי. הכלי מאמת אותם ומחשב לבד את קבוצת קבלות המקור המדויקת לפי גרסת מקור ו־artifact SHA. אם חסר מקור, אין מילוי אוטומטי.

כל פריט `branches` מכיל `branch_id`,‏ `period`,‏ `populations`,‏ `source_receipt_ids`,‏ `interpretation_receipt_id`,‏ `test_receipt_ids`,‏ `required_test_categories`,‏ `required_fact_keys`,‏ `document_reading_fact_keys`,‏ `required_decision_ids`. `topic` וה־generator באים ממשפחה קומפלת מוכרת. `generated.case_evidence` יכול להיות דרישה ל־manifest שנוצר מחדש, אך אינו document-reading fact. אין בתצורה ערך לעובדת תיק זו.

## קובץ תוצאות בדיקה וקישור לסקירה

כל פריט `tests` מכיל `schema_version:'tivdoc-ai-rule-tests-v1'`,‏ `receipt_id`,‏ `branch_id`,‏ `source_receipt_ids`,‏ `interpretation_receipt_id`,‏ `test_definition_evidence_id`,‏ `independent_oracle_evidence_id`,‏ `results_evidence_id`,‏ `expires_at`. הוא אינו מקבל passed/failed/outcome/categories חופשיים.

קובץ `test_results` הוא JSON סגור:

```text
schema_version: tivdoc-ai-release-test-results-evidence-v1
branch_id
code_sha256
review_binding_sha256
test_definition_sha256
independent_oracle_sha256
categories[]
passed
failed
outcome: passed | failed | incomplete
issued_at
```

מפיק ראיית הבדיקות מחשב לפני ההרצה `aiAssemblyReviewBinding(reviewInput, interpretationId, helpers)`. `reviewInput` מכיל `build_manifest_sha256`,‏ `source_reviews`,‏ `interpretations`,‏ `methods`,‏ `evidence`; אין צורך בקובץ תוצאות או ב־hash שלו. ה־helper קושר את תוכן סקירת הפרשנות, סטטוסים, בסיס `human_by_law`, קבלות המקור המיועדות, hashes של ראיות המקור והמתכונים. הוא מוציא מן הגוף את נתיבי הקבצים ואת תוצאות הבדיקות, ולכן אין תלות מעגלית. התוצאה תירשם ב־`review_binding_sha256` של דוח ההרצה האמיתי.

לאחר ההרצה מעדכנים במניפסט הראיות את נתיב ו־SHA קובץ התוצאות שנוצר. הכלי מאמת build, הגדרות, אורקל וקישור סקירה מול הבייטים והקלט הנוכחיים. עריכת הפרשנות או החלפת `unknown` ב־`accepted` גורמת לסירוב שימוש בתוצאות קודמות; אין חתימה מחדש אוטומטית על ראיית בדיקה ישנה. חלונות הזמנים וסדר מקור → פרשנות → בדיקות נבדקים במאמת הקיים.

קובץ תוצאות הוא ראיה שמפיק הריצה אחראי לתוכנה; ה־assembler אינו מריץ את הבדיקות ואינו יכול להוכיח בעצמו שתהליך שלא הפעיל אכן בוצע. יש לשמור לצדו את הפלט המקורי שממנו נגזר. אין להמציא ספירות, להציג סיכום ידני כהרצה חדשה או להכניס fixture של תיק לתצורה. סטטוס failed/incomplete נשמר ויופיע כסיבת חסימה.

## API והרכבה

`loadAiAssemblyHelpers()` טוען בזיכרון bundle של קוד קבוע: schemas, קטלוג recipes, singleton הבנייה, canonical hashing והמאמת. טקסט הקלט אינו קוד; אין interpolation של נתיב או JSON לתוך תוכנית. התלויות אינן כוללות קריאת credentials או חיבור DB.

`assembleAiReleaseConfiguration(input, helpers, readEvidence)` מאמת את הסכמה ואת כל קובצי הראיה, בונה source receipts, מחשב method hash ללא מעגל, בונה interpretations, מחבר descriptors, קורא test results, ואז בונה policy → registry → configuration. בסוף נקרא `verifyAiReleaseConfiguration` עם ה־singleton הקומפל. התוצאה כוללת configuration ו־receipt בלבד.

ה־CLI בודק תחילה גם התאמת ה־manifest לגרף המקורות הנוכחי. `runAiAssembly` מקבל ports לצורך בדיקות מקומיות; ה־main אינו מאפשר החלפת מאמת או build בידי קובץ הקלט. אין מסלול לעקיפת drift או רשימת המשפחות.

## בדיקות וגבול המסירה

הקבוצה [ai-release-configuration-assemble.test.mjs](../scripts/product-workers/ai-release-configuration-assemble.test.mjs) משתמשת בנתונים סינתטיים בלבד; בדיקת pin אחת קוראת את PDF חוק שכר המינימום הציבורי השמור. היא מכסה קשרי hashes, retry, סטטוסים מפורשים, recipe/build drift, שינוי ראיית מקור/פרשנות, זמנים, סירוב מקור סינתטי ב־REAL, קלט עודף/כפול/חסר, פלט פרטי בלתי משתנה וסירוב Production דינמי.

בהרצה הממוקדת מ־12.9.2026 עברו 25 מתוך 25 בדיקות; לינט שני קובצי הכלי עבר. אלה בדיקות מקומיות של ההרכבה, ולא הוכחת הפעלת מדיניות או כתיבה למסד.

```powershell
npx vitest run scripts/product-workers/ai-release-configuration-assemble.test.mjs --maxWorkers=1
npx eslint scripts/product-workers/ai-release-configuration-assemble.mjs scripts/product-workers/ai-release-configuration-assemble.test.mjs
```

אחרי ההרכבה אפשר לבדוק את `configuration.private.json` בכלי [ai-release-control](ai-release-control-runbook-2026-09-12-he.md). שמירה ושיוך למסד הם פעולות נפרדות שבידי מפעיל החבילה. `human_by_law.unresolved` נשאר חסם גם ב־`isolated_test`; כלי הרכבה תקין אינו משנה גבול זה.
