# P13 acceptance matrix — work in progress

Evidence baseline: `30f24e79ca4ffc3df92403b0d625f8eea4d17ebf`. CI runs 34134352583 and 34134347940 passed. Earlier database receipts prove their named migration/fixture scope, not a final hosted customer journey. Preview evidence is recorded separately. No RC, production rollout, provider delivery, human legal approval or user study is asserted.

`IMPLEMENTED` describes code; `VERIFIED` is limited to stated evidence. `FAIL` in the A/D acceptance tables means the complete criterion has not passed, including unfinished internal work. `BLOCKED` names a specific external requirement and does not halt other work. Ready to operate and deployed are separate decisions.

## E01–E20 execution acceptance

| ID | Required behavior | State | Existing evidence | Remaining verification / work |
|---|---|---|---|---|
| E01 | PR #1 משולב; הוספה, החלפה וכשל שומרים קבצים וגרסאות | VERIFIED | P13-protected-upload-verification.json; P13-request-pause-authority-db.json | Hosted code 923517e plus isolated DB migration 20260907190000. Actual bytes verified before fault, replacement/retry/two-tab/reopen and contract-only completion pass. Final RC must revalidate its own SHA. |
| E02 | אין סכום אסור בשום ערוץ; ראשוני נשאר חודש אחד ועד שלושה נושאים | IMPLEMENTED | P02-report-db.json; projection/renderer contract tests | Integrated DOM, PDF and copy checks on final build. |
| E03 | אפס נושאים שנבדקו אינו no_gap ואינו דוח שהושלם | IMPLEMENTED | P02-report-db.json; canonical seven-refusal draft proof | Final browser no-report/refused/awaiting states. |
| E04 | שני תיקים/זהויות/חודשים מופרדים ב-API, Storage, דוח ו-UI | IN_PROGRESS | P05-saved-analysis-db.json; P08-report-source-db.json; P09-orders-db.json | Two browser identities through every protected surface. |
| E05 | OCR ומענה לשאלון מתאחדים לעובדות עם מקור; סתירה נשמרת ומטופלת | IN_PROGRESS | P03 verified extraction adapter; P05-saved-analysis-db.json | Persist and apply questionnaire/answer/correction provenance through canonical resolution; invoke worker. |
| E06 | לכל אחד משבעת הנושאים יש מקרי זהב, גבולות ותחולה בזמן | IN_PROGRESS | P04-ai-expectations.json; P04-source-manifest.json | Remaining applicability branches and genuine human-locked goldens/activation (B-005). |
| E07 | restart, crash ו-retry אינם מאבדים עבודה או מפרסמים תוצר חלקי | IN_PROGRESS | P05-source-journal-db.json; P05-saved-analysis-db.json; fresh-child-launcher tests | Committed worker admission/extraction/final projection/job acknowledgement and full crash rehearsal. |
| E08 | בקשה פגה/נענתה פעם אחת; שתי חסימות אינן עוצרות SLA פעמיים | IMPLEMENTED | P06-request-db.json; P09-orders-db.json; business-clock tests | Scheduled sweep and order dispatcher links; final browser journey. |
| E09 | תשלום→קישור→קוד בפרופיל דפדפן שני→התיק הנכון; יציאה וגלגול תקפים | IN_PROGRESS | P07-notification-db.json; session/logout tests | Authorized provider recipient, DNS and real delivery; browser profiles A/B (B-006). |
| E10 | QA רואה מקור ודוח, מאשר גרסה ויכול לפרסם; גרסה שהתיישנה נדחית | IMPLEMENTED | P08-report-review-db.json; P08-report-source-db.json | Operations browser source/preview/approve/publish with actual scoped identity. |
| E11 | פרסום מוצלח ומשלוח שנכשל נשארים שני מצבים נפרדים | IMPLEMENTED | P07-notification-db.json; P08-report-review-db.json | Publication notification provider retry and customer browser status. |
| E12 | ראשוני ומלא: snapshot מחיר, entitlement, פיוס ו-webhook חוזר ללא כפילות | IN_PROGRESS | P09-orders-db.json; order verification tests | Verified provider receipt/refund contract and actual duplicate callback/return journey. |
| E13 | תיקון אחרי פרסום יוצר גרסה חדשה עם עקבות ולא משנה את הישנה בשקט | IN_PROGRESS | P08-report-source-db.json; P06-request-db.json | Apply accepted correction through canonical facts and produce new projection without replacing history. |
| E14 | PDF/מקור/העתקה בעברית שומרים על הרשאה, גרסאות וכללי הצגה | IMPLEMENTED | P08-report-source-db.json; P08-artifact-visual.json; shared renderer tests | Final source/DOM/PDF/copy browser verification; tagged PDF accessibility remains unproven. |
| E15 | כל משטחי v1.2 עובדים במובייל/RTL/מקלדת ובמצבי כשל ופקיעת סשן | IN_PROGRESS | P11 integrated ac319bf; CI authentication-before-streaming closure | Protected responsive, keyboard, offline, expiry and draft restoration journeys. |
| E16 | מדדים מבוססי DB מבחינים בין אפס, חסר נתונים ו-QA | IMPLEMENTED | P12-metrics-db.json; metrics tests | Operations browser on actual persisted cohorts; no provider cost values invented. |
| E17 | שחזור גיבוי מבודד מחזיר תיקים, הפניות וקבצים באופן עקבי | VERIFIED | P10-restore.json | Actual isolated snapshot through 132000 restored; repeat final-schema rehearsal before RC. No production RPO/RTO guarantee. |
| E18 | פרטיות, lifecycle ו-cleanup אינם מוחקים מקור נדרש או מדליפים מידע | IN_PROGRESS | P10-privacy-db.json; P10-gc-storage.json | Complete case purge/accounting separation/contact change and final lifecycle/browser proof. |
| E19 | 13-T/14/15/16 מסווגים לפי ראיות ותנאים, ללא דילוג מוסווה | IN_PROGRESS | This matrix and release-blockers.md | 13-T composition, actual 14 offline/15 shadow evidence and guarded 16 rollout rehearsal remain open. |
| E20 | כל F01–F21 ו-A01–A16 של v1.2 ממופים לתיקון, ראיה או חסם מפורש | VERIFIED | This complete E/F/A/D inventory | Keep evidence pinned when implementation/Preview changes. Mapping completeness is not feature acceptance. |

## F01–F21 review findings

Each row maps the original finding to implemented work and the exact still-open acceptance above.

| ID | Required correction | Mapping | Current scope |
|---|---|---|---|
| F01 | לאכוף את גבול הראשוני בחוזה ובכל ערוצי התצוגה | E02 | IMPLEMENTED |
| F02 | הפרדת כיסוי מנושאים שנבדקו, בחירה דטרמיניסטית שאינה תלויה בסכום הפער | E02 | IMPLEMENTED |
| F03 | להציג נתוני תיק ומצב אמיתי; אין דוח → אין דוח אישי מדומה | E04 | IN_PROGRESS |
| F04 | מצב תוצאה מפורש; „לא נמצאו” מותר רק כאשר יש כיסוי שבאמת נבדק | E03 | IMPLEMENTED |
| F05 | מזהי מסמך/גרסה יציבים; הוספה אינה דריסה. החלפה מחייבת בחירה מפורשת ושמירת עקבות | E01 | IMPLEMENTED |
| F06 | הקשר העלאה מפורש וחזרה לתיק/בקשה; אין דרישת תשלום נוספת על השלמה | E01 | IMPLEMENTED |
| F07 | סגירה עמידה, תזכורות וביטול חסימה אטומי; תשובה מאוחרת מטופלת במפורש | E08 | IMPLEMENTED |
| F08 | לחבר ספק בסביבה מורשית ולשקף queued/sent/failed/refused. הצלחת תשלום אינה הוכחת הודעה | E09 | IN_PROGRESS |
| F09 | לחדש גם cookie במסלול שרת מתאים; לבדוק גלגול מעבר לתוקף המקורי ולממש יציאה | E09 | IN_PROGRESS |
| F10 | תור „אושרו לפרסום”, תצוגה מקדימה ומצב מסירה עצמאי | E10 | IMPLEMENTED |
| F11 | להשאיר שערים סגורים ולהפריד מוכנות UI ממוכנות דוח אמיתי | E06 | IN_PROGRESS; real-rule gates remain closed, no fixture reports in customer routes |
| F12 | מעטפת עקבית, הפעולה הבאה, זמן עדכון וניווט שמיש | E15 | IN_PROGRESS |
| F13 | הזמנת מוצר מלא, היקף תקופה, זכאות, קבלה ומעבר לאיסוף השלמות | E12 | IN_PROGRESS |
| F14 | תקופת העסקה היסטורית, סוגים נחוצים, תצוגה/החלפה/סיווג והרשאות | E01 | IMPLEMENTED |
| F15 | תשובות לפי סוג בתוך אותו שרשור, עם קישור למסמך ולגרסתו | E05 | IN_PROGRESS |
| F16 | חוזה תצוגה ופעולות דוח ראשוני/מלא, בלי חישובים חדשים בצד הלקוח | E14 | IMPLEMENTED |
| F17 | להבחין בין ריק, לא זמין וחסר מידע; מיפוי סטטוסים ממצה | E15 | IN_PROGRESS |
| F18 | מילון תוצאות ואירועים בעל גרסה; אין שימוש ב־S05 כמשמעות אחידה לפני מיפוי | E16 | IMPLEMENTED |
| F19 | טקסטי הבטחה מותנים במסלול ובזמינות; התאמה בין שיווק, רכישה ומסירה | E12 | IN_PROGRESS |
| F20 | מערכת רכיבים ונכסי מותג אחת, כולל מסכים מוגנים ומצבי שגיאה | E15 | IN_PROGRESS |
| F21 | ליצור את המשפט מתבנית ומשדות המחיר, כדי ששינוי מחיר יחיד יעדכן גם את ההסבר | E12 | IMPLEMENTED; website offer derives text from immutable configured price; provider acceptance remains open |

## A01–A16 UX acceptance

| ID | Scenario | Verdict | Evidence / exact remainder |
|---|---|---|
| A01 | תשלום בדיקה מאומת → קישור מגיע לערוץ בדיקה מורשה → פתיחה בפרופיל B ללא cookies של A → קוד → התיק הנכון נראה | BLOCKED | E09; B-006 provider/DNS/authorized recipient missing; authenticated browser A/B still also required. |
| A02 | ראשוני עם high/medium ובסיס חסר אינו מציג סכום/טווח; low אינו מציג סכום/טווח בכל ערוץ | FAIL | E02; Integrated DOM, PDF and copy checks on final build. |
| A03 | ראשוני מנסה להכיל יותר משלושה נושאים שנבדקו או יותר מחודש אחד | FAIL | E02; Integrated DOM, PDF and copy checks on final build. |
| A04 | כל הנושאים refused או awaiting, כולל ערבוב, ללא נושא שנבדק | FAIL | E03; Final browser no-report/refused/awaiting states. |
| A05 | שני תיקים מחודשים שונים, ואחד ללא projection | FAIL | E04; Two browser identities through every protected surface. |
| A06 | העלאה ראשונה, רענון, העלאה נוספת, שני טאבים והחלפה מפורשת | FAIL | E01; Final authenticated browser refresh/two-tab/replacement journey. |
| A07 | לקוח ששילם עונה לבקשת מסמך, כולל כשל העברה ו־retry | FAIL | E01; Final authenticated browser refresh/two-tab/replacement journey. |
| A08 | בקשה חוסמת, שתי חסימות חופפות, מענה, תפוגה והרצה חוזרת | FAIL | E08; Scheduled sweep and order dispatcher links; final browser journey. |
| A09 | בדיקה שנייה באותה זהות; זהות אחרת; קישור פג; סשן מתגלגל מעבר למועד תפוגת cookie המקורי; יציאה | FAIL | E09; Authorized provider recipient, DNS and real delivery; browser profiles A/B (B-006). |
| A10 | בודק פותח מקור וממצא, מאשר, חוזר לתור מאושרים ומפרסם | FAIL | E10; Operations browser source/preview/approve/publish with actual scoped identity. |
| A11 | פרסום הצליח ושליחת הודעה נכשלה; בקשת תיקון אחרי פרסום | FAIL | E13; Apply accepted correction through canonical facts and produce new projection without replacing history. |
| A12 | רוחבי 360/390/768/1440 פיקסלים **[ברירות מחדל לבדיקה]**, מקלדת, RTL, session שפג ו־offline | FAIL | E15; Protected responsive, keyboard, offline, expiry and draft restoration journeys. |
| A13 | מחיר משתנה בהגדרה; ראשוני ומלא; חזרה מספק לפני webhook; webhook כפול | FAIL | E12; Verified provider receipt/refund contract and actual duplicate callback/return journey. |
| A14 | חמישה משתמשים: התחלה, הוספת מסמך, חזרה, מענה לבקשה, הבנת תוצאה וצעד הבא | BLOCKED | E15; Five real participants have not been recruited/run. Automated scenarios are not participants. |
| A15 | מדידת תמהיל עם S05 הישן והחדש ועם מכנה ריק | FAIL | E16; Operations browser on actual persisted cohorts; no provider cost values invented. |
| A16 | מסך התקבל: אימות מתעכב, נכשל, מתאושש, משלוח נכשל ובדיקה חוזרת | FAIL | E11; Publication notification provider retry and customer browser status. |

## D01–D08 design acceptance

Source: owner-supplied website v1.3, section 11; this supersedes older brand colors.

| ID | Criterion | Verdict | Evidence / remainder |
|---|---|---|
| D01 | One brand across public/protected/error surfaces | FAIL | ac319bf integrated; final protected screenshots still required. |
| D02 | 360/390/768/1440 and 200% zoom | FAIL | Hosted public measurement pending; protected routes and keyboard remain. |
| D03 | Real playable accessible video and failure states | BLOCKED | No approved video/captions/transcript asset. Honest unavailable content is implemented; video capability is absent. |
| D04 | Motion, manual control, reduced motion, offscreen/video pause | FAIL | Website process illustration integrated; final interactive browser checks remain. |
| D05 | Actual pipeline example with publication permission | FAIL | Public fallback is honest; no real canonical pipeline-backed approved example yet. |
| D06 | Verified claims and working contact/legal links | FAIL | Unverified registration claim not expanded; final link audit and operator/media evidence remain. |
| D07 | Build and measured performance/media loading | FAIL | Cloud optimized build passes; device/route performance measurement remains. |
| D08 | Price, period, SLA and server availability consistency | FAIL | Immutable offers/order scope/clock and closed flags implemented; complete provider/customer journey remains. |

## Readiness sequence

| Stage | State | Required next evidence |
|---|---|---|
| 13-T synthetic end-to-end | IN_PROGRESS | Actual worker admission, provider adapter invocation, canonical draft/projection and restart through hosted isolated customer journey. Current DB proofs cover bounded components. |
| 14 offline | BLOCKED_EXTERNAL / internal preparation open | Genuine locked extraction/legal ground truth and required reviewed bindings; synthetic/AI expectations cannot replace them. |
| 15 shadow | BLOCKED_EXTERNAL / internal preparation open | Valid 14 evidence plus authorized shadow scope and no-publication controls; no run claimed. |
| 16 rollout | IN_PROGRESS | Final migration rehearsal against compatible existing data, old signed-upload token drain, safe write-stop fallback, service/provider readiness and explicit operational deployment. No production change performed. |

## Release decision

Development continues. Integrated code is pushed in Draft PR #2 on top of upload PR #1. This matrix deliberately does not convert passed legacy/component checks into completed customer capabilities. Production is unchanged.
