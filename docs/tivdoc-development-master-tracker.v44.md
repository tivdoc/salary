# Tivdoc — טבלת מעקב פיתוח מרכזית

גרסת tracker: 44
עודכן לאחרונה: 2026-09-05
Repository: `C:\dev\tivdoc\salary`
Current integration branch: `claude/v0-10-2b-full-parallel`
Canonical base branch: `codex/tivdoc-engine-foundation`
HEAD נוכחי: `6a99bb7` (long run 9, freeze) · BASE הריצה: `0d60c0d`
Worktree: clean
המשימה הפעילה: `ההנדסה האוטומטית הושלמה עד לשער האנושי: ריצות רציפות 1–3, Addendum 4 (H/R/S), מאגרים E2/E3/L4/L5/L6/L7/L8/L9 סגורים; הענף על ה־remote לראשונה (‏412 commits היו על דיסק אחד), build ייצור ו־preview מוכחים סגורים ומגישים את חצי המוצר כפי ש־`main` מגיש; CI רץ ב־GitHub. במקביל: פעולות בעלים (ביקורת משפטית, composites, Storage key, BL-24)`

הערת שחזור: קובץ זה נוצר מחדש בתוך המאגר מגרסה 36 של הבעלים, בקריאה בלבד, עם החלת דלתאות v37–v43 ודלתא v44 של ריצה 9. הקובץ המקורי של הבעלים לא נערך.

## 0. כללי ניהול הטבלה

1. הדוח ייבדק ביקורתית מול הדרישות המקוריות.
2. יעודכנו הסטטוסים, הראיות, החסמים והפעולה הבאה.
3. תתווסף שורה ליומן הביצועים וליומן העדכונים.
4. אותו קובץ יעודכן; לא ייווצר tracker חדש בכל איטרציה.
5. מעבר בדיקות, lint או build אינו מספיק לבדו כדי לסמן סעיף כ־Completed.
6. לא יסומן מקור, פרמטר, כלל או תהליך כפעיל בלי evidence מתאים וביקורת אנושית נדרשת.
7. אין מעבר ל־Production לפני Offline Shadow Mode, Customer Shadow Mode ואימות מספק.
8. **Claude Code Opus 5** הוא מנוע המימוש; העבודה מתנהלת בבריף מתגלגל עם תור גלים ושני מסלולים.
9. ‏Green לא עובר בין ראשים: מטריצה שלא הורצה על ה־`FROZEN_HEAD` הנוכחי אינה מוכחת בו.
10. פסיקת הבעלים העומדת: כל פריט שסומן "אנושי" נעשה על ידי המהנדס כטיוטה — ארטיפקט ניתן לביקורת; הביקורת האנושית באה אחרי סיום הפיתוח.

### מקרא סטטוסים

| סימון | סטטוס | משמעות |
|---|---|---|
| ✅ | Verified Complete | הדרישה הושלמה וקיימת ראיה מספקת ביחס לשלב הנוכחי |
| 🟡 | Provisional | דווח כהושלם, אך חסרה בדיקה עצמאית או הוכחת אינטגרציה קנונית |
| 🟠 | Partial | יישום חלקי או שחלק מדרישות הסעיף טרם הושלמו |
| 🔴 | Blocked | לא ניתן להשלים בלי תנאי חיצוני, סביבתי או אנושי |
| ⬜ | Not Started | טרם פותח |
| ⛔ | Forbidden | אסור להתחיל לפני השלמת gates מוגדרים |
| ➖ | Not Applicable Yet | אינו נדרש בשלב הנוכחי |

## 1. תמונת מצב מנהלים

| סעיף | תחום | סטטוס | מצב נוכחי | שער המעבר הבא |
|---:|---|---|---|---|
| 1.1 | Engine Foundation | ✅ | חוזי domain מרכזיים קיימים ומחוברים; מודל העובדות ברשימה אחת (31 נתיבים, ובהם `employment.population`), סכימת ערך לכל נתיב | — |
| 1.2 | Persistence Foundation | ✅ | ‏53/53 migrations pinned על Supabase DEV (זנב 030); ‏RLS forced ‏65/65 tenant-scoped; מטריצה דינמית ‏10/10 supported | — |
| 1.3 | Payslip Extraction | 🟠 | V2.1 ו־evaluation pipeline קיימים; ‏0 קריאות לקוח | Ground Truth אנושי ומדידה מחודשת |
| 1.4 | Legal Knowledge Infrastructure | 🟡 | ‏44 מקורות במניפסט; ‏29 יעדי רכישה (19 פרסומי תיקון רשמיים, 1 retired, 1 מנהלי); chunker table-aware; לקסיקון מספרים; בחירות מכשירים; ציטוטים חזותיים עם דירוג מקור; חבילת ביקורת v11 דטרמיניסטית (32 קבצים) | **ביקורת משפטית אנושית** — השער היחיד שנותר |
| 1.5 | Deterministic Rule Runtime | 🟠 | R-1…R-14 סגורים; ‏14 סוגי צמתים; רישום יחידות דו־כיווני; ‏15 מפרטי טיוטה בני־ביצוע (ובהם חלק המעסיק ורכיב הפיצויים תחת הכרעת הקדימות), ‏7/7 נושאים רצים בדוח הרגישות v7; עקבות R-14 משוחזרות בית־בבית | RuleSpecs מאושרים על ידי אדם |
| 1.6 | Numeric Parameters | 🟠 | governance קיים; ‏59 גרסאות טיוטה רשומות (7 superseded, 52 draft, 7 inferred_visual); ‏0 פרמטרים פעילים; ‏6 הכרעות פתוחות, 2 נמשכו | שתי attestations בלתי תלויות אחרי review משפטי |
| 1.7 | Human Review Operations | ✅ | מסע ‏17/17 (צעד 17: סיכום הצל); ‏69 packets בתור; זרימת Ground Truth עמידה (G-1…G-12) עם אפס תוכן; פאנלי Legal Review, GT ו־Shadow ב־`/operations` | reviewers ו־annotators אנושיים |
| 1.8 | Offline Shadow Mode | 🟡 | מעטפה v0.11 במצב `draft_parameters_synthetic_inputs`: ‏54 חודשי תלוש סינתטיים × 15 מפרטי טיוטה, ‏151 הרצות, ‏106 רצו, ‏106 עקבות שוחזרו; האוכלוסייה עובדה של החודש (חודש הנוער קושר את שיעור הנוער); הפרש־צל סינתטי לכל רכיב תשלום; ‏0/7 real topics | פרמטר וכלל מאושרים; אז Offline legal shadow |
| 1.9 | Customer Shadow Mode | ⛔ | אסור; מטריצת סירוב של ‏43 משטחים (מסלולים, דגלים, יכולות, סכימות, שירותים, סקריפטים, fixtures, אחסון) שכל אחד מהם חייב להשתנות כדי שנתוני לקוח ייכנסו — וכל אחד מסרב היום | Offline Shadow מוצלח ואישור מפורש |
| 1.10 | Production Legal Engine | ⛔ | מחוץ לתחום, ומוכח סגור ב־build בשתי הסביבות (`production` ו־`preview`): ההיטל הסגור חוסם את כל ‏18 היכולות; ‏27 שורשי ה־dispatchers מפוצלים פעם אחת כנתונים — ‏20 של המוצר (מה ש־`main` מגיש) מוגשים כפי ש־`main` מגיש אותם, ‏7 של המנוע עונים 404 ריק; דיפרנציאל מול מצאי המסלולים של `main` עצמו: ‏20/20, ‏0 אי־התאמות; ‏147 נקודות כניסה מסרבות; קבלה `662ef7fa…` (48 בדיקות) | Shadow, אבטחה, פרטיות ואימות משפטי מלא |
| 1.11 | Canonical Product Integration | ✅ | מסע browser ‏17/17 מול DEV; ‏`/`, `/portal`, `/operations` תקינים; פאנל הצל מוגש רק כשמוגדר `TIVDOC_OFFLINE_SHADOW_STATE_ROOT`; CI (`.github/workflows/ci.yml`): tsc, eslint, vitest, build והוכחת הסגירה על כל push ו־PR, ללא סוד; רץ ב־GitHub על הענף (ריצה 33954823347 על `6a99bb7` הצליחה: כל השלבים ירוקים, הוכחת הסגירה ‏48/48 בשתי הסביבות על Ubuntu) | — |
| 1.12 | Platform Security | ✅ | ‏RLS forced ‏65/65; ‏`service_role` closure ‏0/0; ‏definer definitions 154 / surface 108, ‏2 ungated allowlisted; מטריצת זהות שלילית ‏8/8 | X-4 — שמונה `*_salary_*` במסלול התשלום |
| 1.13 | Ledger Truthfulness | 🟡 | ‏60 sweep ids מפויסים; רישום כותבי governance נגזר סטטית מהסקריפטים (לא מוצהר): ה־tenant של כל כתיבה נעקב עד הביטוי שלו דרך ייבוא אחד; `undecidable` מפיל את הסוויטה; שתי רשומות שגויות של ריצה 7 תוקנו (F1, F2) | H-4 |
| 1.14 | Evidence Custody | 🟠 | K-1/K-2 חנות ראיות immutable עם שרשרת hash ויומן גישה; ‏restore drill ‏31/31 מקומי | managed bucket — Storage key מהבעלים; off-host — רכש |

## 2. Governance, Git ו־Auditability

| סעיף | דרישה | סטטוס | ראיה או מצב אחרון | חסם / פעולה הבאה |
|---:|---|---|---|---|
| 2.1 | Branch ייעודי לפיתוח הליבה | ✅ | `claude/v0-10-2b-full-parallel`, על `origin` מאז ריצה 9; bundle מלא של ההיסטוריה (`2fd5c3cd…`) ב־OneDrive | לשמור branch מוגן ונקי |
| 2.2 | Base ancestry ניתן להוכחה | ✅ | preflight מאמת toplevel/branch/HEAD/ancestry בכל ריצה | — |
| 2.3 | Worktrees/branches מבודדים | ➖ | worktrees אסורים; עבודה סדרתית + סוכני קריאה בלבד (Lane B, haiku) | — |
| 2.4 | Commit ו־patch identity | ✅ | יחידה אחת = commit אחד; כל short SHA מדווח | — |
| 2.7 | Full-diff inventory | 🟡 | דוח לכל ריצה ב־`docs/tivdoc-development-state.md` | audit חיצוני |
| 2.8 | Runtime denial canaries | ✅ | ‏0 deploy, ‏0 remote migrations, ‏0 provider/OpenAI calls בכל הריצות | להמשיך לאכוף |
| 2.9 | Evidence package deterministic | 🟡 | receipts ל־`output/next/` בלבד, אחרי freeze; חבילת ביקורת נבנית פעמיים ל־hash אחד | custody מחוץ למארח |
| 2.10 | Evidence package durable custody | 🔴 | מקומי בלבד | immutable replicated off-host + restore drill |
| 2.11 | PII/secret scan | 🟡 | אין סוד בלוג, commit, receipt או דוח | audit ל־runtime secret handling |
| 2.12 | Production/deploy prohibition | ✅ | ‏0 בכל הריצות; ה־push לענף הפעיל preview של Vercel בפרויקט tivdoc.com (לא פריסה שלנו), מוגן מאחורי ההתחברות של הפלטפורמה (כל נתיב עונה 302) | להמשיך; הבעלים מחליט אם previews לענפים נשארים |
| 2.13 | Customer-data prohibition | ✅ | ‏0 customer reads; ‏`eval/customer-payslips` ו־`eval/real-payslips` לא נקראו; composites לא נפתחו | להמשיך |
| 2.14 | LLM legal/calculation prohibition | ✅ | ‏0 OpenAI calls | hard invariant |
| 2.16 | Strict evidence fail-closed gate | ✅ | `PARTIAL` לא הומר ל־`PASS` באף ריצה | לשמר |
| 2.18 | Error fidelity בכל wrapper | ✅ | stage + origin descriptor נשמרים; ‏42501 מהעומק מזוהה בפסגה | לשמר |
| 2.19 | Agent SHA pinning | ✅ | כל סוכן מצהיר על ה־SHA שקרא; ממצא בלי SHA נזרק | לשמר |
| 2.20 | רישום כותבי governance | ✅ | ה־tenant של כל כתיבה נגזר סטטית (`writer-inventory.mjs`), לא מוצהר; שלוש עקיפות שמצא Lane B נסגרו ב־fixtures; סקריפט חדש שאינו רשום מפיל את הבדיקה | לשמר |

## 3. Engine Domain Foundation

| סעיף | רכיב | סטטוס | מצב נוכחי | הפעולה הבאה |
|---:|---|---|---|---|
| 3.1–3.13 | Facts, provenance, hypotheses, runs, traces, money | ✅ | חוזים קיימים ומחוברים; ‏30 נתיבי עובדות ברשימה אחת | — |
| 3.14 | RuleInputSnapshot | 🟡 | רישום מיפוי v2 עם סוגי פלט לפי רישום היחידות; ‏12 טרנספורמציות מגורסות ודטרמיניסטיות; ‏9 קודי סירוב מוכחים; עובדה סותרת לעולם אינה מוכרעת; ‏17/17 משבצות קלט קשורות — על עובדות סינתטיות | לאמת מול real inputs אחרי אישור |
| 3.17 | Case lifecycle/payment/review domain | ✅ | מסע מלא מול DEV | — |
| 3.18 | Seven-topic case orchestration | 🟠 | ‏0/7 real ready; ‏7/7 טיוטות רצות בצל על עובדות סינתטיות | legal/GT gates אנושיים |
| 3.19 | Deterministic report builder | 🟡 | עברית/RTL, hash דטרמיניסטי; דוח הרגישות בעברית (Markdown + PDF) | audit עצמאי |
| 3.20 | Report approval/invalidation | ✅ | ‏10/10 effects אמיתיים; R-8 סגירה סמנטית מלאה | — |

## 4. Persistence Foundation

| סעיף | רכיב | סטטוס | מצב נוכחי | חסם / הפעולה הבאה |
|---:|---|---|---|---|
| 4.1–4.10 | Repositories, jobs, idempotency, logging | ✅ | קיימים ומוכחים מול DEV | — |
| 4.11 | Migration foundation | ✅ | ‏53/53 pinned (018–030 נוספו בריצות); ‏definer definitions 154 | — |
| 4.12 | Static migration checks | ✅ | — | אינם מחליפים DB אמיתי |
| 4.13 | Isolated Supabase | ✅ | פרויקט DEV `tivdoc-engine-dev-20260902-a7f3c1`, eu-central-1, ‏$0, PG 17.6 | אין פרויקט שני |
| 4.14 | Dynamic migration apply | ✅ | clean apply + replay; replay לא הוסיף דבר | — |
| 4.15 | Real RLS actors | ✅ | ‏`rls_forced` ‏65/65 tenant-scoped, ‏0 unforced | — |
| 4.16 | Real transactions/rollback | ✅ | במטריצה הדינמית | — |
| 4.17 | Real concurrency/idempotency | ✅ | replay/divergence/stale/race | — |
| 4.18 | Backup/restore | ➖ | `not_supported_by_managed_platform` | lane מקומי נפרד אם יידרש |
| 4.19 | Production migration | ⛔ | אסור | אחרי Shadow ואישור נפרד |
| 4.23 | Canonical PostgreSQL adapters | ✅ | ‏14/14 | — |
| 4.24 | Canonical composition root | ✅ | `instrumentation.ts` מוכר כ־entrypoint | guard מונע היעלמות entrypoint |
| 4.25 | Automatic memory fallback | ✅ | ‏0 | — |
| 4.26 | Dynamic matrix | ✅ | ‏14 checks, ‏10 supported, ‏10 passed, ‏4 `not_supported_by_managed_platform` | להריץ מחדש בכל freeze שמשנה DB |
| 4.27 | Grant coverage proven by execution | ✅ | ‏22 executed, ‏0 denied | להרחיב בכל migration חדשה |
| 4.28 | עקבות ביצוע עמידות (R-14) | ✅ | טבלה append-only; שחזור בתהליך נפרד בית־בבית; ‏85 עקבות רגישות + 86 עקבות צל שוחזרו בריצה 7 | — |

## 5. Payslip Extraction ו־Evaluation

| סעיף | רכיב | סטטוס | ראיה או מצב | הפעולה הבאה |
|---:|---|---|---|---|
| 5.1–5.10 | Pipeline, Gate 0, benchmark, corpus manifest | ✅ | ‏82.69% overall; ‏0 customer documents | — |
| 5.11 | Owner visual review | 🔴 | `pending_owner_visual_review` | ידני לפני annotation |
| 5.12 | Ground Truth contracts/tooling | 🟡 | workspace סינתטי | ‏0 Human GT |
| 5.13–5.16 | Human annotation / adjudication / locked GT | 🔴 | ‏0 תוכן; **התשתית עמידה ומוכחת** — עצמאות זהויות, adjudication בזהות שלישית, revision chain, lock, replay, race | הבעלים: ביקורת חזותית של 5 composites; אז שני annotators + adjudicator |
| 5.17 | Real customer benchmark | ⛔ | אין GT | אחרי 5.11–5.16 |

## 6. Legal Knowledge Foundation

| סעיף | רכיב | סטטוס | ראיה או מצב | חסם / הפעולה הבאה |
|---:|---|---|---|---|
| 6.1–6.3 | Contracts, hierarchy, taxonomy | ✅ | — | — |
| 6.4 | Registry | 🟡 | ‏44 מקורות במניפסט; ‏29 יעדי רכישה | human role/identity review |
| 6.5 | Registered raw artifacts | 🟡 | כל fetch = observation בלתי־משתנה; baseline לא הוחלף | — |
| 6.6 | Corpus versions | 🟡 | chunker v1 table-aware (‏307 שורות חשופות → 5); ‏19 פרסומי תיקון של חוק שעות עבודה ומנוחה פורסרו; אינדקס תיקונים לסעיפים 16–18 | — |
| 6.9 | Deterministic retrieval | 🟡 | — | positive-path proof |
| 6.12 | Source-change detection | 🟡 | min-wage ו־convalescence מסומנים `review_required`, ללא החלפת baseline | ביקורת משפטית אנושית |
| 6.18 | Current convalescence history | 🟡 | צווי 1988/2016/2023/2026 נבחרו (instrument selections) והמספרים שבהם נקשרו; חוקי 2024/2025 רשומים; ‏6,150 נקרא מהעמוד המסודר (inferred_visual) | ביקורת אנושית |
| 6.19 | Working Time law publications | ✅ | ‏19/19 פרסומים רשמיים נרכשו ופורסרו; ‏§16/§17/§18 לא תוקנו מהותית; ההוצאה לאור מ־1951 היא הטקסט המחייב | — |
| 6.21 | Permit artifact acquisition | 🔴 | ‏15×403 + 1×404 חסרים, ב־`remaining_gaps` | owner handoff |
| 6.22 | Staged acquisition mapping | ✅ | ‏`projected 0 + blocked_active 2 + blocked_superseded 69 = 71` | — |
| 6.24 | Working Time current text | 🟡 | **אין consolidated רשמי — הוכח** מהפרסומים הרשמיים (BL-22 סגור); הפרמיות נקראו מתמונת עמוד 4 (inferred_visual); סף יומי של 8 שעות נקשר מהלקסיקון מעמוד 1 (text_verified) | אימות חזותי אנושי של 1¼ / 1½ / 1½ |
| 6.29 | Reviewed legal sources | 🔴 | 0 | human attestations |
| 6.30 | Active legal sources | 🔴 | 0 | אחרי review וכל gates |
| 6.31 | Legal corpus ready | 🔴 | `LEGAL_SOURCE_CORPUS_INCOMPLETE` | — |
| 6.37 | Blocked-observation store | ✅ | טבלה append-only, reason codes סגורים, RLS forced | anti-graduation נאכף |
| 6.38 | ‏69 תצפיות שלמות־בתים | ✅ | ‏69/69 פורסרו — ‏62 text layer, ‏7 OCR | ביקורת אנושית |
| 6.39 | שתי התצפיות הנותרות מתוך 71 | ✅ | נוקבו מה־DB לפי מזהה וקוד סיבה; `blocked_active` | — |
| 6.40 | ציטוטים | ✅ | ארבעה סוגים: טקסט (עם עוגן עברי חובה), לקסיקון, בחירת מכשיר, חזותי (`legal-visual-citation-v1`); דירוג מקור על כל ציטוט ומועמד; ‏52 עוגנים, ‏46 מאומתים, ‏6 בלתי אפשריים (superseded) | — |

## 7. Numeric Parameter Governance

| סעיף | רכיב | סטטוס | מצב נוכחי | הפעולה הבאה |
|---:|---|---|---|---|
| 7.1–7.3 | Contracts, state machine, hash-bound invalidation | ✅ | מצב `draft`, `superseded`, `withdrawn`; ‏`synthetic` חד־כיווני; ‏`visual_confirmed` נדרש ל־inferred_visual (030) | — |
| 7.4 | Real numeric candidates | 🟡 | ‏59 גרסאות טיוטה רשומות מציטוטים אמיתיים (batches 1–16); ‏7 superseded; כולן `draft`, אף אחת אינה ניתנת להפעלה | review משפטי; שתי attestations |
| 7.5–7.7 | Reviewers 1/2, active parameters | 🔴 | 0 | reviewers אנושיים; `register` קיים ומסרב להריץ את עצמו |
| 7.8 | Parameter approval ≠ rule approval | ✅ | boundary מוגדר | — |
| 7.9 | הכרעות משפטיות פתוחות | 🟡 | ‏6 פתוחות (מחלק שעתי, סעיף תקרת פנסיה, תקופת תעריף הבראה 2026, הרכבת פרמיית מנוחה, קדימות פנסיה 2011/2016, סף שעות יומי) ו־2 נמשכו; כל ענף קשור נרשם כמועמד נפרד; ענף מנהלי אחד נקוב ולא קשור (BL-24) | הכרעת reviewer |

## 8. Controlled Import, Parsing Security ו־Custody

| סעיף | רכיב | סטטוס | מצב נוכחי | חסם / הפעולה הבאה |
|---:|---|---|---|---|
| 8.1 | Local controlled-import tooling | ✅ | קיים | אינו owner import |
| 8.6 | Parser application isolation | 🟡 | דווחה | OS sandbox נשאר חסם |
| 8.7 | Parser OS sandbox | 🔴 | `PARSER_OS_SANDBOX_NOT_VERIFIED`; K-4 מגדיר את הסביבה | הבעלים: סביבה |
| 8.10 | Persistent owner import | 🔴 | ledger 0 | חסום עד readiness |
| 8.13 | Immutable object storage | 🟡 | K-1/K-2; K-3 ‏31/31 byte-equal מקומי | managed bucket — Storage key |
| 8.14 | Replicated/tamper-evident custody | 🔴 | K-5 `blocked_external` | הבעלים: יעד ורכש |
| 8.17 | `controlled-import-ledger` | 🟡 | `implemented_uncalled` | — |

## 9. Deterministic Legal Rule Engine

| סעיף | רכיב | סטטוס | מצב נוכחי | שער המעבר הבא |
|---:|---|---|---|---|
| 9.1–9.6 | Registry, decimal, rounding, replay, fail-closed | ✅ | BigInt, ללא floating point; ‏14 סוגי צמתים (band.lookup, tiered.rate, subtract, divide, constant.integer); רישום יחידות עם ממדים | — |
| 9.7 | Real Rule Input mapping | 🟡 | רישום מיפוי v2: ‏17 משבצות קלט של 13 מפרטי טיוטה קשורות דרך 12 טרנספורמציות מגורסות; רכיבי תשלום ממופים באותה דרך; מוכח על עובדות סינתטיות | mapping מאושר על עובדות אמיתיות |
| 9.8 | Human-approved legal specification | 🔴 | 0 | עורך דין |
| 9.9 | First Israeli rule | ⛔ | אסור | reviewed+active source |
| 9.11 | `shadow_eligible` | 🟠 | boundary קיים; הצל רץ על טיוטות בלבד | אחרי humans |
| 9.13 | Seven real RuleSpecs | 🟠 | ‏7 טיוטות, כל משבצת קשורה; ‏13 מפרטים בני־ביצוע (`real_inactive`); ‏0 מאושרים | human-approved |
| 9.14 | Global dependency invalidation | ✅ | ‏10/10; R-8 סגירה סמנטית | — |
| 9.15 | דוח רגישות | ✅ | v6: ‏102 תרחישים, ‏85 רצו, ‏85 עקבות שוחזרו, ‏7/7 נושאים, דירוג מקור לכל פרמטר, הצל לצדו; עברית (Markdown + PDF) | — |

## 10. Human Review and Ground Truth Operations

| סעיף | פעולה אנושית | סטטוס | אחראי | תנאי/תוצר |
|---:|---|---|---|---|
| 10.1 | ביקורת Evidence packages עצמאית | 🔴 | Owner + auditor | `PREPARED_NOT_DELIVERED`; חבילה v11 מוכנה |
| 10.2 | מינוי עורך דין דיני עבודה | 🔴 | Owner | reviewer identity/role; `owner-reviewer-identity.mts keygen` + `register` בשיחה אינטראקטיבית |
| 10.3–10.7 | Reviews: שכר מינימום, OCR פנסיה, הבראה, Working Time, permits | 🔴 | Legal reviewer | נדחה עד סיום הפיתוח לפי החלטת בעלים; חומר הביקורת: `docs/legal/sensitivity-report.he.md` וחבילה v11 |
| 10.8–10.10 | Parameter verifiers 1/2, rule-spec approval | 🔴 | Independent humans | ‏7 גרסאות inferred_visual דורשות `visual_confirmed` מול העמוד (BL-25) |
| 10.11 | Payslip visual review | 🔴 | Owner | 5 composites |
| 10.12 | Ground Truth annotation | 🔴 | — | תשתית קיימת; תוכן אנושי בלבד |

## 11. Shadow Mode ו־Production Gates

| סעיף | Gate | סטטוס | מצב נוכחי | דרישה לפני מעבר |
|---:|---|---|---|---|
| 11.1–11.5 | Shadow control-plane, envelope, kill switch, offline synthetic | 🟡 | מעטפה v0.11 (‏v0.10 עדיין תקפה); מצב `draft_parameters_synthetic_inputs` עם נעיצה (0 פרמטרים פעילים, 33 גרסאות טיוטה, 54 קלטים סינתטיים, חילוץ לא בשימוש); מתזמן עמיד עם lease מגודר ושרשרת ביקורת; מתג חירום כבוי כברירת מחדל ומוכח; ‏0/7 real | RuleSpec/parameter מאושרים |
| 11.6 | Offline legal shadow | ⛔ | אסור על פרמטרים אמיתיים; ריצת הצל על טיוטות: ‏106 מקרים רצו, ‏81 הפרשי־צל, ‏0 ממצאים, ‏0 מסירות; ‏6 הכרעות מושוות (קדימות הפנסיה ‏10/15, הרכבת יום המנוחה ‏5/5) | first approved rule |
| 11.7 | Customer Shadow Mode | ⛔ | אסור; מטריצת סירוב ‏43/43 (`customer-refusal-matrix.test.ts`) | GT + privacy authorization |
| 11.8 | פאנל צל ב־`/operations` | ✅ | `readShadowSummary` על השירות הקנוני; מצב, נעיצות, ספירות, גיבובים, סירובים לפי סיבה — ללא תוכן; מוגש רק כשמוגדר שורש מצב; מטריצה שלילית ללא שינוי | — |
| 11.10–11.11 | Production readiness / activation | ⛔ | אסור; build ייצור ו־preview מוכחים סגורים ומגישים את חצי המוצר כפי ש־`main` מגיש (L9-4); tivdoc.com מגיש את `main`; PR ל־`main` הוא של הבעלים | החלטה מפורשת נפרדת |

## 12. חסמים מרכזיים פתוחים

| מזהה | חסם | סטטוס | חומרה | מי יכול לפתור | מה נדרש |
|---|---|---|---|---|---|
| B-04 | Parser אינו OS sandbox | 🔴 Open | קריטית לפני owner import | Environment | pinned no-network container/microVM |
| B-06 | Official acquisition blocks | 🔴 Open | גבוהה | Owner handoff | ‏15×403 + 1×404, ב־`remaining_gaps` |
| B-07 | ‏71 observations | ✅ Closed | — | — | — |
| B-08 | ‏0 reviewed/active legal sources | 🔴 Open | קריטית | Legal reviewer | signed attestations; נדחה עד סוף הפיתוח |
| B-09 | ‏0 real numeric parameters | 🔴 Open | קריטית | Two human reviewers | dual verification; ‏59 טיוטות ממתינות |
| B-10 | ‏0 Human Ground Truth | 🔴 Open | קריטית | Owner + annotators | תשתית קיימת |
| B-11 | Durable replicated custody | 🔴 Open | גבוהה | Architecture | off-host immutable replication |
| B-12 | אין כלל משפטי מאושר | 🔴 Open | קריטית | Legal reviewer | ‏13 מפרטי טיוטה בני־ביצוע ממתינים |
| B-25 | Reviewer identity/signature | 🟠 Open | קריטית משפטית | Humans | `register` קיים ומוכח; ‏0 זהויות אמיתיות |
| B-28 | Canonical product reachability | 🟡 Recomputed | גבוהה | — | — |
| B-34 | Isolated Supabase platform proof | ✅ Closed | — | — | — |
| B-35 | Real UI/HTTP→DB E2E | ✅ Closed | — | — | מסע ‏17/17 |
| B-38 | Global invalidation propagation | ✅ Closed | — | — | R-8 |
| B-43 | Governance `SECURITY DEFINER` surface | ✅ Closed | — | — | ‏definer 154 / surface 108 |
| B-61 | Local PostgreSQL blocked by Windows Code Integrity | ➖ Superseded | — | — | — |
| B-63 | Identity-session tenant enforcement | ✅ Closed | — | — | — |
| B-64 | ‏`rls_forced` | ✅ Closed | — | — | ‏65/65 |
| B-65 | ‏25 פונקציות בבעלות `tivdoc_dev_migrator` | ✅ Closed | — | — | — |
| B-66 | טענות יומן לא תואמות | 🟡 Mostly closed | בינונית | — | H-4 |
| B-67 | ‏69 תצפיות שלמות־בתים | ✅ Closed | — | — | — |
| B-68 | ‏`controlled-import-ledger` orphan | ✅ Closed | — | — | — |
| B-69 | ‏8 פונקציות `public.*_salary_*` נגישות ל־`service_role` | 🟠 Open | בינונית | — | X-4 — כל השמונה `cannot_move` |
| B-70 | Scanner reachability | 🟡 Provisionally Closed | גבוהה | Independent auditor | — |
| B-71 | Ground Truth durable workflow | ✅ Closed | — | — | — |
| B-72 | Managed-bucket restore drill | 🟠 blocked_dependency | בינונית | Owner | Storage API key של ה־DEV |
| B-73 | שני tests לא יציבים | 🟠 Open | נמוכה | — | עוברים לבד |
| B-74 | `correction_started` מעל lock מחויב | ✅ Closed | — | — | H-3 |
| BL-10…BL-15, BL-17…BL-23 | חסמי הריצות הרציפות (ציטוטים, chunker, לקסיקון, בחירות מכשירים, session recovery, טקסט מאוחד של חוק שעות עבודה, צו פנסיה 2016) | ✅ Closed | — | — | ראה `docs/tivdoc-development-state.md`, הבלוק "Blocked ledger" של כל ריצה |
| BL-16 | משיכת החופשה המסומנת `synthetic` בטעות | 🟠 Open, permanent | נמוכה | — | הדגל חד־כיווני; רשומה מתוקנת `.v2` |
| BL-24 | P-15/P-16: הנחיית משרד העבודה מ־10.6.2018 (8.6 / 7.6 שעות) אינה ניתנת לאיתור באתר רשמי | 🔴 Open | בינונית | Owner | עותק באתר לא רשמי הוא mirror ואינו קביל; אם יימצא מקור רשמי — `legal:sources:acquisition:import` תחת `ACQ-V06-LABOUR-DIRECTIVE-DAILY-HOURS-2018`, קשירה בדירוג administrative כענף ההכרעה `working_time_daily_threshold` |
| BL-25 | ‏7 גרסאות inferred_visual ממתינות לאימות חזותי אנושי | 🔴 Open | קריטית משפטית | Legal reviewer | `visual_confirmed: true` מול העמודים שבחבילה v12 |

## 13. גלים ומשימות

| סעיף | Worker | תחום | יעד | סטטוס |
|---:|---|---|---|---|
| 13.11 | Claude Code Opus 5 | V0.10.8 DEV Supabase + Corpus | פרויקט DEV, guards, corpus | Completed partially |
| 13.14 | Claude Code Opus 5 | V0.10.9–V0.10.12 | reconciliation invariant, chain replay, ‏404 legal-review, runtime gate | Completed |
| 13.15–13.19 | Claude Code Opus 5 | Rolling Waves 1–4B + continuous runs 1–3 | מסע, effect honesty, identity-session, reachability, מאגרים C/A/B/E, Wave 5, Wave 6 | Completed |
| 13.21 | Claude Code (Sonnet, Session A) | Addendum 4 + Pools H/D/P/A7/S/R | H 8/8, D 12/12, P-0, ‏26 גרסאות P, A7-1…A7-5, S 8/8, R 12/14 | Completed — 3 tests אדומים בסיום, אובחנו |
| 13.22 | Claude Code Opus 5 (Session B = long run 2) | B-0, R-2, R-14, R-8, Q-1…Q-8, E2 | תבניות, עקבות עמידות, טיוטות, דוח רגישות v1, נורמליזציה לוגית | Completed |
| 13.23 | Claude Code Opus 5 (long run 3) | Pool E3 10/10 | דוח רגישות v2 עם מספרים, עוגנים עבריים, supersession, tenant סינתטי | Completed |
| 13.24 | Claude Code Opus 5 (long run 4) | Pool L4 10/10 | chunker v1, band.lookup/tiered.rate, ‏`register`, עברית | Completed |
| 13.25 | Claude Code Opus 5 (long run 5) | Pool L5 12/12 | לקסיקון, יחידות, בחירות מכשירים, sick/vacation מלאים, דוח v4 | Completed |
| 13.26 | Claude Code Opus 5 (long run 6) | Pool L6 11/11 | פרסומי התיקון, ציטוטים חזותיים, דירוג מקור, ‏7/7, דוח v5, חבילה v10 | Completed |
| 13.29 | Claude Code Opus 5 (long run 9) | Pool L9 9/9 | bundle של ההיסטוריה, הוכחת סגירה בשתי סביבות, פיצול מוצר/מנוע כנתונים, דיפרנציאל מול `main`, push לענף, CI ב־GitHub, Lane B, tracker v44 | Completed |
| 13.28 | Claude Code Opus 5 (long run 8) | Pool L8 9/9 | הוכחת סגירת ייצור ב־build, רישום כותבים נגזר (F1 נמשך), מפרטי מעסיק ופיצויים (F2 נמשך), אוכלוסייה כעובדה, CI, מטריצת סירוב לקוחות, Lane B, דוח v7, חבילה v12, tracker v43 | Completed |
| 13.27 | Claude Code Opus 5 (long run 7) | Pool L7 12/12 | רישום מיפוי v2, דירוג ביצוע, קורפוס סינתטי, הפרש־צל, מעטפה v0.11, ריצת צל על DEV, השוואת ענפים, פאנל צל, הכרעת סף יומי, דוח v6, חבילה v11, tracker v42 | Completed |
| 13.20 | Owner / qualified legal reviewers | Final legal review | אחרי סיום הפיתוח: מקורות, תקופות, שתי attestations, RuleSpecs, ‏42 Golden Cases, אימות חזותי של 7 קריאות | **Next** — הפיתוח האוטומטי הסתיים |

## 14. תור הגלים

| סדר | גל | תוכן | תנאי התחלה |
|---:|---|---|---|
| 1–7 | Waves 1–6 + continuous runs 1–3 | מסע, מאגרים, Ground Truth, custody | הושלם |
| 8 | Addendum 4 — hygiene + synthetic runtime + synthetic shadow | H/R/S | הושלם (Session A + long run 2) |
| 9 | Pools E2, E3, L4, L5, L6, L7 | ציטוטים, chunker, לקסיקון, בחירות, ציטוטים חזותיים, הצל על טיוטות | הושלם (long runs 2–7) |
| 10 | Human legal review | זהות reviewer, ביקורת דוח הרגישות v6, אימות חזותי, שתי attestations, RuleSpec, Golden Cases | **עכשיו** — ראה `tivdoc-owner-actions.md` ו־"Resume point" ב־`docs/tivdoc-development-state.md` |
| 11 | Offline legal shadow → Customer Shadow → Production | לפי gates | לעולם לא אוטומטי |

## 15. יומן ביצועים

| מס' | תאריך | שלב / Commit | תוצאה | Tests/Build | החלטת ביקורת |
|---:|---|---|---|---|---|
| E-19 | 2026-09-01 | V0.10.0 `3b1740d` | Marathon | ‏1,252 passed | PARTIAL |
| E-20 | 2026-09-01 | V0.10.1 `5c1945da` | integration | ‏1,308 passed | PARTIAL |
| E-21 | 2026-09-01 | V0.10.2 checkpoint `4879d95b` | recovery anchor | לא הורצו | UNVERIFIED |
| E-22 | 2026-09-01 | V0.10.2A validation | full-range audit | lint/TSC PASS | PARTIAL |
| E-23 | 2026-09-02 | V0.10.8 `391a54e` | Supabase DEV guard + receipt; corpus ‏17/17 נרכשו מחדש | סוויטה אדומה: `artifact-reconciliation` | PARTIAL |
| E-24 | 2026-09-02 | V0.10.9 `1652541` | reconciliation invariant נגזרת; custody של ראיות | ‏1,694 passed / 0 failed | PARTIAL |
| E-25 | 2026-09-02 | V0.10.10 `7636300` | ‏16/23 chain; החסם היה credential ל־DEV | ‏1,671 passed / 1 failed | PARTIAL |
| E-26 | 2026-09-02 | V0.10.11 `bd00b0c` | chain ‏23/23; `/operations` 200 מאומת; journey ‏13/16 | ‏1,694 passed / 0 failed | PARTIAL |
| E-27 | 2026-09-02 | V0.10.12 `e539019` | ‏404 נסגר; ‏422 נפתח | ‏1,706 passed | PARTIAL |
| E-28 | 2026-09-02 | Wave 1 `0e3c700` | מסע ‏16/16; ‏71/71 מדווחות עמידות; blocked-record store | ‏1,740 passed | PARTIAL |
| E-29 | 2026-09-02 | Wave 2 `6902081` | effect honesty; מטריצה ‏10/10 | ‏1,753 passed | PARTIAL |
| E-30 | 2026-09-02 | Wave 3 `7389f04` | identity-session נסגר; scanner reachability | ‏1,762 passed; journey ‏16/16 | PASS לגל |
| E-31 | 2026-09-03 | Wave 4A `851e658` | אימות מחדש של כל מסקנה שנגזרה מהגרף | ‏1,762 passed | PASS, ‏6/6 |
| E-32 | 2026-09-03 | Wave 4B `4844da2` | fixture ל־invalidation; ‏10/10 effects | ‏1,763 passed | PASS, ‏3/3 |
| E-33 | 2026-09-03 | Continuous run 1 `fb77f9c` | ‏102 יחידות; E ‏62/69, A ‏14/30, C ‏21/21 | ‏1,763 passed | PARTIAL |
| E-34 | 2026-09-03 | Continuous run 2 `99336de` | ‏116 יחידות; E ‏69/69 | ‏1,763 passed | PARTIAL |
| E-35 | 2026-09-03 | Continuous run 3 `5273615` | כל המאגרים נסגרו; ‏RLS ‏62/62; Wave 5 ו־6 הושלמו; ‏40/40 migrations | ‏257/258 files; tsc/eslint/build נקיים; journey ‏16/16 | **ההנדסה האוטומטית הגיעה לשער האנושי** |
| E-36 | 2026-09-03 | Session A (Sonnet) `85e6888` | ‏37 commits: Pools H 8/8, D 12/12, P-0, ‏26 גרסאות P, A7-1…A7-5, S 8/8, R 12/14 | ‏3 tests אדומים, אובחנו במדויק | PARTIAL |
| E-37 | 2026-09-03 | Long run 2 (Session B, Opus) `fbd43ca` | ‏16 commits: R-2, R-14, R-8, Q-1…Q-8 (דוח רגישות v1), E2-1…E2-10 (נורמליזציה לוגית, עוגנים); ‏47 migrations | ירוק; eslint 0/0 | PASS |
| E-38 | 2026-09-04 | Long run 3 `42baa9d` | Pool E3 10/10: דוח v2 עם מספרים, ‏25 עקבות, supersession, tenant סינתטי, ‏52 migrations | ירוק | PASS |
| E-39 | 2026-09-04 | Long run 4 `fd45d0d` | Pool L4 10/10: chunker v1, ‏band.lookup/tiered.rate, ‏34 גרסאות, דוח v3 (4/7), `register` מוכח, דוח בעברית | ירוק | PASS |
| E-40 | 2026-09-04 | Long run 5 `deec5b6` | Pool L5 12/12: לקסיקון, יחידות, בחירות מכשירים, ‏42 גרסאות, דוח v4 (6/7), חבילה v9 | ירוק | PASS |
| E-41 | 2026-09-04 | Long run 6 `3b30bcb` | Pool L6 11/11: ‏19 פרסומי תיקון, ציטוטים חזותיים, דירוג מקור, migration 030, ‏58 גרסאות, דוח v5 (7/7), חבילה v10 | ‏2,011 passed; ‏53/53 migrations; journey ‏16/16 | PASS |
| E-44 | 2026-09-05 | Long run 9 `6a99bb7` | Pool L9 9/9: bundle מאומת (‏434 commits), הוכחת סגירה production+preview (‏48 בדיקות), פיצול ‏20/7, דיפרנציאל ‏20/20 מול `main`, push ל־origin, CI ב־GitHub (ריצה 33954823347 על `6a99bb7` הצליחה: כל השלבים ירוקים, הוכחת הסגירה ‏48/48 בשתי הסביבות על Ubuntu) | ‏298/298 files, 2172 passed, 3 skipped, 0 failed; ב־GitHub 290/298 (8 דילגו לפי תנאי־מארח נקוב), 2126 passed; tsc/eslint/build נקיים | PASS |
| E-43 | 2026-09-05 | Long run 8 `85885f4` | Pool L8 9/9: build ייצור סגור בבנייה (היטל חסום, ‏145 נקודות כניסה מסרבות, ‏22 בדיקות PASS), רישום כותבים נגזר, מפרטי מעסיק/פיצויים, `employment.population`, CI מוכח ב־regression, מטריצת סירוב ‏43, ריצת צל על DEV (‏106 רצו, ‏106 עקבות שוחזרו), דוח v7, חבילה v12 (33 קבצים), tracker v43 | ‏297/297 files, 2163 passed, 3 skipped, 0 failed; tsc/eslint/build נקיים; הוכחת סגירה PASS | PASS |
| E-42 | 2026-09-05 | Long run 7 `dc99f89` | Pool L7 12/12: רישום מיפוי v2, ‏12 טרנספורמציות, דירוג ביצוע, קורפוס 54, הפרש־צל, מעטפה v0.11, ריצת צל על DEV (‏86 רצו, ‏86 עקבות שוחזרו), השוואת 6 הכרעות, פאנל צל, הכרעת סף יומי (batch 16), דוח v6, חבילה v11 (32 קבצים), tracker v42 | ‏293/293 files, 2088 passed, 3 skipped, 0 failed (the second of three full runs at the freeze fixes lost one file to the controlled-import concurrency timeout under load — B-73 class, 58/58 alone — and the third full run at the same head was clean); tsc/eslint/build נקיים; journey ‏17/17; כל מטריצות DEV ירוקות | PASS |

## 16. יומן עדכוני tracker

| גרסה | תאריך | דוח שנבדק | שינוי מרכזי |
|---:|---|---|---|
| 33 | 2026-09-02 | Claude master handoff | נוצר מסמך handoff מלא |
| 34 | 2026-09-02 | ביקורת על handoff V0.10.8 | חוזה ביצוע תוקן |
| 35 | 2026-09-03 | V0.10.9 → Wave 4A | Supabase DEV נסגר, מסע ‏16/16, אבטחת identity-session נסגרה |
| 36 | 2026-09-03 | Continuous runs 1–3 | כל המאגרים, Wave 5 ו־6 נסגרו; תור הגלים עבר ל־Addendum 4 |
| 37 | 2026-09-03 | Session A + long run 2 | H/D/P-0/A7/S/R/Q/E2; חוזי הכרעות פתוחות; עקבות R-14; נפתחו BL-10…BL-14 |
| 38 | 2026-09-04 | Long run 3 | דוח רגישות עם מספרים; עוגנים עבריים; supersession; נסגרו BL-10…BL-14; נפתחו BL-15…BL-18 |
| 39 | 2026-09-04 | Long run 4 | chunker v1; ‏band.lookup/tiered.rate; `register`; עברית; נסגרו BL-15, BL-17, BL-18; נפתחו BL-19…BL-21 |
| 40 | 2026-09-04 | Long run 5 | לקסיקון; יחידות; בחירות מכשירים; נסגרו BL-19…BL-21; נפתחו BL-22, BL-23 |
| 41 | 2026-09-04 | Long run 6 | אין טקסט מאוחד רשמי — הוכח; ציטוטים חזותיים ודירוג מקור; ‏7/7; נסגרו BL-22, BL-23; נפתחו BL-24, BL-25 |
| 44 | 2026-09-05 | Long run 9 | הענף על ה־remote ו־bundle מגובה; הסגירה מוכחת גם ב־preview; חצי המוצר מוגש כפי ש־`main` מגיש, חצי המנוע סגור; CI רץ ב־GitHub |
| 43 | 2026-09-05 | Long run 8 | המנוע המשפטי מוכח בלתי־נגיש מהאתר החי ב־build; CI; שתי רשומות שגויות תוקנו (F1 רישום כותבים, F2 חלק המעסיק); מפרטי מעסיק ופיצויים; האוכלוסייה עובדה; מטריצת סירוב לקוחות; דוח v7; חבילה v12 |
| 42 | 2026-09-05 | Long run 7 | הצל הלא־מקוון מריץ את שבע הטיוטות על עובדות סינתטיות מקצה לקצה; מעטפה v0.11; פאנל צל; הכרעת סף יומי (ענף מנהלי לא קשור, BL-24); דוח v6; חבילה v11; ה־tracker נוצר מחדש במאגר |

## 17. סטטוס רשמי נוכחי

```text
CURRENT_HEAD_6a99bb7
LONG_RUNS_1_TO_9_COMPLETE_POOLS_H_D_S_R_Q_E2_E3_L4_L5_L6_L7_L8_L9_CLOSED
BRANCH_ON_ORIGIN_YES_FULL_HISTORY_BUNDLE_SHA256_2fd5c3cd_RESTORE_VERIFIED
PRODUCTION_AND_PREVIEW_BUILDS_CLOSED_BY_CONSTRUCTION_PROVEN_48_CHECKS_IDENTICAL_POSTURE_ENTRY_POINTS_147_REFUSE
ROUTE_SPLIT_PRODUCT_20_ENGINE_7_UNASSIGNED_0_DIFFERENTIAL_VS_MAIN_20_ROUTES_0_MISMATCHES
CI_WORKFLOW_ON_PUSH_AND_PR_NO_SECRET_RUNS_ON_GITHUB_RUN_33954823347_SUCCESS
GOVERNANCE_WRITER_INVENTORY_DERIVED_UNDECIDABLE_FAILS
CUSTOMER_DATA_REFUSAL_MATRIX_43_OF_43_REFUSING
BROWSER_JOURNEY_17/17_ON_SUPABASE_DEV
MIGRATION_CHAIN_53_OF_53_PINNED_TAIL_030
DYNAMIC_MATRIX_14_CHECKS_10_SUPPORTED_10_PASSED_4_NOT_SUPPORTED_BY_MANAGED_PLATFORM
GRANT_COVERAGE_PROVEN_BY_EXECUTION_22_EXECUTED_0_DENIED
IDENTITY_NEGATIVE_MATRIX_8_OF_8
SECURITY_DEFINER_DEFINITIONS_154_SURFACE_108_UNGATED_2_ALLOWLISTED
RLS_FORCED_65_OF_65_TENANT_SCOPED
INVALIDATION_EFFECTS_10_OF_10
MANIFEST_SOURCES_44_ACQUISITION_TARGETS_29
HOURS_LAW_CONSOLIDATED_TEXT_DOES_NOT_EXIST_OFFICIALLY_PROVEN_FROM_19_PUBLICATIONS
CITATION_KINDS_TEXT_LEXICON_SELECTION_VISUAL
PROVENANCE_GRADES_TEXT_VERIFIED_LEXICON_SELECTION_INFERRED_VISUAL_ADMINISTRATIVE
DRAFT_PARAMETER_VERSIONS_59_SUPERSEDED_7_INFERRED_VISUAL_7
LEGAL_OPEN_DECISIONS_6_OPEN_2_WITHDRAWN_UNBOUND_BRANCHES_1
RULESPEC_DRAFTS_7_EVERY_SLOT_BOUND_EXECUTABLE_SPECS_15
SENSITIVITY_REPORT_V7_TOPICS_7_OF_7_SCENARIOS_102_RUN_85_TRACES_85_REPLAYED_85
RULE_INPUT_MAPPING_REGISTRY_V2_SLOTS_19_OF_19_TRANSFORMATIONS_13_REJECTION_CODES_9_PROVEN
FACT_PATHS_31_EMPLOYMENT_POPULATION_BOUND_TO_YOUTH_FIGURES
OFFLINE_SHADOW_ENVELOPE_V011_MODE_DRAFT_PARAMETERS_SYNTHETIC_INPUTS
OFFLINE_SHADOW_DRAFT_RUN_CASES_54_EXECUTIONS_151_RAN_106_TRACES_106_REPLAYED_106
SYNTHETIC_SHADOW_DELTAS_81_COMPUTED_25_NOT_APPLICABLE_0_FINDINGS
SHADOW_DECISION_COMPARISON_6_DECISIONS_NO_AUTOMATIC_ACCEPTANCE
OPERATIONS_SHADOW_PANEL_SERVED_CAPABILITY_PRESENT_ONLY_WITH_STATE_ROOT
KILL_SWITCH_DEFAULT_OFF_PROVEN
HEBREW_SENSITIVITY_REPORT_V7_MARKDOWN_AND_PDF_HASH_BOUND
REVIEW_PACKAGE_V12_FILES_33_DETERMINISTIC_TOPICS_RUN_GATE_7_SHADOW_CASES_RUN_GATE_106
TRACKER_V44_REGENERATED_IN_REPOSITORY_OWNER_FILE_UNTOUCHED
RETRACTED_F1_WRITER_INVENTORY_F2_EMPLOYER_SHARE
EXTRACTION_USED_NO
BLOCKED_OPEN_BL16_PERMANENT_BL24_ADMINISTRATIVE_SOURCE_BL25_VISUAL_CONFIRMATION
NEXT_GATE_HUMAN_LEGAL_REVIEW
REAL_LEGAL_TOPICS_READY_0_OF_7
REAL_SOURCES_ACTIVE_0
REAL_PARAMETERS_ACTIVE_0
REAL_RULES_ACTIVE_0
REAL_CALCULATIONS_OR_FINDINGS_0
ATTESTATIONS_0_VISUAL_CONFIRMATIONS_0
REVIEWER_IDENTITIES_REGISTERED_0
HUMAN_GROUND_TRUTH_LOCKED_0
REAL_CUSTOMER_DATA_READS_0
GENERATED_HUMAN_DECISIONS_0
GENERATED_HUMAN_SIGNATURES_0
HUMAN_LEGAL_REVIEW_DEFERRED_UNTIL_DEVELOPMENT_COMPLETE_NON_BLOCKING
CUSTOMER_SHADOW_AUTHORIZED_NO
PRODUCTION_DELIVERY_ENABLED_NO
DEPLOYMENTS_0_VERCEL_PREVIEW_CREATED_BY_PLATFORM_ON_PUSH_PROTECTED
REMOTE_PRODUCTION_MIGRATIONS_0
LIVE_PROVIDER_CALLS_0
OPENAI_CALLS_0
```

הערה: תשע ריצות רציפות ו־Addendum 4 סגרו את כל ההנדסה שלא צריכה אדם: ‏59 גרסאות פרמטר בטיוטה מציטוטים אמיתיים בארבעה סוגים, ‏7 טיוטות RuleSpec שכל משבצת בהן קשורה, ‏15 מפרטים בני־ביצוע, דוח רגישות שרץ ‏7/7 נושאים ומדרג כל מקור, והצל הלא־מקוון שמריץ את הטיוטות על חודשי תלוש סינתטיים דרך מודל העובדות של המוצר עצמו — כל פלט הפרש־צל סינתטי, לא ממצא. מה שנותר צריך עורך דין, זהות reviewer אמיתית או מקור רשמי שאינו ניתן לאיתור: ביקורת הדוח, אימות חזותי של שבע קריאות, שתי attestations, ואישור RuleSpec. ‏0/7 נושאים, ‏0 מקורות, ‏0 פרמטרים, ‏0 כללים, ‏0 חישובים ו־0 Human GT נשארים אמת מחייבת — ומעכשיו הם משתנים רק בידי אדם.
