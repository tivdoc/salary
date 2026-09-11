# הודעת השלמות אחת לסבב ניתוח מוכן

בסיס החבילה: `e52d320`. החיבור עדיין בעבודה; אין במסמך זה טענת פריסה, בדיקת DB או שליחה חדשה.

החיבור המנוהל הקודם שלח הודעה לכל `request:`. פתיחת14 שאלות יצרה14 הודעות. כעת TypeScript קורא סבב שלם מהשרת ומייצר envelope מוצפן אחד, עם קישור לכל שאלה פתוחה וקישור למסך ההשלמות. שאלות בודדות שמוחזרות בחוזה ההיסטורי אינן נשלחות. OTP ודוח ממשיכים בתבניותיהם. מיילים שכבר נשלחו אינם משתנים.

## READY והיסטוריה

READY מציין שהעובד סיים את כל יוצרי השאלות של ריצת המקור. הוא אינו כשירות משפטית או דוח כספי מאושר. המקור הוא `engine_durable_jobs.state='succeeded'` יחד עם מניפסט `engine_outbox_events.effect_kind='saved_analysis_draft_ready_v1'`, באותה עסקה שהשלימה את העובד. אין להסתפק בשאלה שנוצרה בזמן חילוץ או ב־analysis stage שטרם הושלם.

הגילוי חייב להצמיד case/tenant, מזהה job, ה־terminal hash, מקור/current revision+SHA+authority dependency וה־analysis run מתוך `months[0]`. בהיקף הנוכחי יש חודש ורכישה יחידים: יוני2026 ושכר מינימום. `publication='draft'` במניפסט הוא חוזה הסיום הקיים, גם כשהריצה ממתינה לשאלות.

מזהה הסבב הוא SHA256 של `managed-completion-v1|<job_id>|<terminal_effect_sha256>`. חזרה לאותו job משתמשת באותו סבב. סבב READY מאוחר יותר יוכל להודיע רק אם קיימת לפחות שאלה אחת בגרסה/UUID שעדיין לא נכללה בשיגור קודם. ההודעה החדשה תציג אז את כל השאלות הפתוחות. שינוי תשובה לבדו, רענון סמכות או restart אינם סיבה לשלוח שוב את אותו אוסף שאלות. שאלת מקור מקבלת UUID חדש כשהיעד/הגרסה משתנים לפי מנגנון הבקשות הקיים.

## חוזה SQL למסירה למשלב

כל המיגרציות והחלתן בבעלות המשלב. החוזים הבאים הם שמות ופרמטרים מדויקים שה־TypeScript צורך; הם אינם טענה שהסכמה כבר הוחלה.

```sql
public.case_notification_completion_pending(target_capability text)
returns table(round_id text,job_id text,analysis_run_id uuid,case_id uuid,
 public_id text,identity_id uuid,contact text,request_set_sha256 text,questions jsonb);

public.case_notification_completion_enqueue(
 target_capability text,target_round text,target_delivery text,target_payload jsonb,
 target_expires timestamptz,expected_case uuid,expected_identity uuid,
 expected_recipient text,expected_request_set_sha256 text,expected_request_ids uuid[])
returns text;

public.case_notification_managed_dispatch(
 target_capability text,target_delivery text,target_worker uuid,target_fence integer)
returns table(state text); -- exactly one: ready / cancelled / held
```

`questions` הוא מערך של `{request_id, question}`, מסודר לפי UUID, ללא כפילות. השרת אוסף את **כל** השאלות הלא־נענות, הלא־סגורות והלא־פגות, ומחייב `private.managed_dev_notification_event_current(case_id,'request:'||id)`. אין להשתמש בתוצאת pending ההיסטורית שמוגבלת לעשר. הלקוח מסרב למערך מעל40, ולא שולח חלק ממנו. נוסח השאלה במייל הוא תקציר של180 תווים; כל מזהי השאלות וכל הקישורים נשמרים.

`request_set_sha256` מחושב ב־DB על JSONB מסודר של ה־UUID והטקסט המדויק. הלקוח מחזיר את digest השרת ואת כל מזהי השאלות; אין לו סמכות להצהיר ש־run מוכן. ה־digest נבדק שוב תחת נעילת התיק לפני enqueue ולפני dispatch.

דוגמת בסיס גילוי READY, שיש לצרף אליה את הגנות capability/identity/paid scope הקיימות:

```sql
select j.job_id,j.terminal_effect_sha256,e.payload
from private.case_input_heads h
join private.case_analysis_dispatch d on d.case_id=h.case_id
 and d.revision=h.revision and d.mode='draft'
join public.engine_durable_jobs j on j.job_id=d.job_id
 and j.canonical_case_id=h.case_id::text
 and j.tenant_id='saved-case:'||h.case_id::text
join public.engine_outbox_events e on e.outbox_id='saved-draft:'||j.job_id
 and e.logical_effect_id=j.job_id and e.tenant_id=j.tenant_id
 and e.canonical_case_id=j.canonical_case_id
 and e.effect_kind='saved_analysis_draft_ready_v1'
 and e.payload_sha256=j.terminal_effect_sha256
where j.state='succeeded' and not j.cancellation_requested
 and e.payload->>'schema_version'='saved_analysis_draft_ready_v1'
 and e.payload->>'publication'='draft'
 and e.payload->>'job_id'=j.job_id
 and e.payload->'source'=j.payload
 and (j.payload->>'revision')::bigint=h.revision
 and j.payload->>'input_sha256'=h.input_sha256
 and j.payload->>'authority_dependency_sha256'
     is not distinct from d.authority_dependency_sha256
 and jsonb_array_length(e.payload->'months')=1
 and e.payload#>>'{months,0,month}'='2026-06';
```

יש לקשור את `analysis_run_id`, ה־command וה־result hash מהחודש במניפסט לרשומת analysis completed קיימת. לא להוסיף ממצאים או ליצור מניפסט לשם בדיקת ההודעה.

ה־ledger החדש צריך להכיל לפחות `round_id` ייחודי, `case_id`, `job_id`, `analysis_run_id`, `source_revision`, `source_sha256`, `terminal_sha256`, `request_ids`, `request_set_sha256`, `delivery_id`, `dispatch_started_at`. רק תפקידי owner/פונקציות מוגנות כותבים בו; RLS ו־revoke runtime direct נדרשים. ה־outbox הקיים ממשיך להיות תור השליחה היחיד.

ה־event המשויך למעטפה הוא `completion:<round_id>:<delivery_id>`. כך envelope שבוטל לפני שיגור נשאר בהיסטוריה ואפשר להחליף את pointer של אותו סבב. helper המראה מסכמה156 צריך להכיר `completion:` עבור `document_request`; יש לשמר את `request:` ההיסטורי לבדיקות currentness ולבריאות. query ה־managed pending ההיסטורי צריך לסנן `request_required` **לפני LIMIT**, כדי ששאלות לא יסתירו דוח מוכן.

## מרוצים ותוצאת ספק לא ידועה

1. `completion_enqueue` נועל case → round → outbox; הוא מאמת מחדש READY, זהות/recipient/hash ורשימת השאלות. קריאה חוזרת או מקבילה מחזירה את אותה מעטפה. digest/case/identity זרים מחזירים סירוב ללא כתיבה.
2. מעטפה שטרם התחיל שיגורה יכולה להתבטל אם נענתה שאלה או הוחלף המקור. הפונקציה מסיימת אותה ללא שליחה; round חדש/מעודכן יכיל רק שאלות פתוחות לאחר READY מחדש.
3. `managed_dispatch` הוא fence אחרון אחרי claim ולפני API. הוא מאמת lease owner+fence+expiry, יכולת פעילה, זהות, current source ואותו אוסף שאלות. הוא מסמן `dispatch_started_at` באופן אטומי ומחזיר `ready` רק פעם אחת. הלקוח אינו פונה לספק על תשובה ריקה/לא מוכרת/`cancelled`/`held`.
4. תהליך שנעצר אחרי `dispatch_started_at` ולפני קבלת תשובה משאיר מצב לא ידוע. אין שינוי body או delivery key ואין resend אוטומטי של אותו aggregate; reconciliation הוא פעולה נפרדת. guard זה מגן גם אם העצירה הייתה ממש לפני HTTP ולא ידוע אם הפנייה יצאה. שרת הספק והלקוח אינם טרנזקציה אחת.
5. תשובה שמתקבלת אחרי תחילת HTTP אינה יכולה לבטל הודעה שכבר יצאה. הקישורים בתיק קוראים תמיד את המצב הנוכחי. מצב זה יישאר מתועד עם snapshot זמן השיגור.
6. `case_notification_outbox_claim` הגנרי חייב להחריג aggregate envelopes כדי שלא יעקוף את fence החדש. `managed_claim` צריך להחזיק aggregates שהתחיל שיגורם בלי receipt, ולסרב למקור/סט שהתיישנו. ניסיונות OTP ודוח רגיל שומרים על מנגנון retry הקיים.

`sent` פירושו שהספק קיבל מזהה הודעה; `delivered` נשמר רק מקבלת webhook. אין כאן שליחת הודעה או המצאת קבלת ספק.

## אימות נדרש

- יחידה:14 שאלות מייצרות envelope ופניית ספק מוזרקת אחת, כל14 הקישורים נשמרים, ordering לא משנה digest, סבב חדש נשאר נפרד, false READY/תיק זר/סט חלקי/dispatch חסר מסורבים.
- DB: מניפסט סיום אמיתי מול14 בקשות; שתי זהויות/two clients; enqueue כפול ומקביל; תשובה בין pending ל־enqueue ובין claim ל־dispatch; worker restart אחרי fence; אין mutation של מיילים שנשלחו; ריצה מאוחרת עם שאלה חדשה מקבלת מייל אחד נוסף.
- ספק: רק אחרי שהמשלב מאשר היקף ותקציב. עד אז אין הוכחת שליחה אמיתית של aggregate.

בעלות הקוד: `automatic-dev-notifications.ts`, `automatic-dev-completion-notifications.ts` והבדיקות שלהן. על DB/סכמה, ריצות ופריסה אחראי המשלב. תוצאות האימות יתווספו לאחר הרצתן.
