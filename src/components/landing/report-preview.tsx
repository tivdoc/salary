import samples from "@/content/report-samples.json";
import { parseProjection } from "@/server/product/reports/case-report-projection";
import { ReportView } from "@/components/case/report-view";
import { ReportExampleTabs } from "./report-example-tabs";
export function ReportPreview() {
  return (
    <section
      className="report-preview home-section"
      id="what-you-get"
      aria-labelledby="report-title"
    >
      <div className="studio-shell">
        <div className="section-intro">
          <p className="studio-eyebrow">פותחים את הפרטים</p>
          <h2 id="report-title">
            ממצא שאפשר
            <br />
            לעקוב אחריו.
          </h2>
          <p>מה ראינו, על מה הסתמכנו ומה עדיין צריך לברר.</p>
        </div>
        <p className="sample-disclosure">
          דוגמה להמחשה על נתונים סינתטיים; אינה דוח של לקוח.
        </p>
        <ReportExampleTabs>
          {samples.reports.map((document, i) => {
            const projection = parseProjection(document.projection);
            return (
              <div key={document.id}>
                <div className="sample-summary">
                  <h3>
                    {i === 0
                      ? "חודש אחד. תמונה ראשונית."
                      : "אותו ממצא. יותר הקשר."}
                  </h3>
                  <p>
                    {i === 0
                      ? "בדוגמה: יוני 2026, נושא אחד נבדק ונושא נוסף ממתין להשלמה. בראשוני נבדקים עד שלושה נושאים בחודש שנבחר."
                      : "בדוגמה זו נבדק אותו חודש בלבד. בדוח מלא, היקף התקופה יופיע בהצעה לצד מקורות מפורטים, PDF ונוסח בירור."}
                  </p>
                </div>
                <details className="sample-finding" open>
                  <summary>
                    <span>
                      <small>פנסיה · ממצא עם מידע חסר</small>
                      <strong>הרכיב מופיע. ההקשר עדיין חסר.</strong>
                    </span>
                    <span aria-hidden="true">+</span>
                  </summary>
                  <div className="sample-evidence-grid">
                    <div>
                      <h4>מה צריך לברר</h4>
                      <p>
                        מסמך ההדגמה מציין רכיב פנסיה. לא נמסר אישור על קרן פעילה
                        בתחילת ההעסקה, ולכן אין בסיס לקבוע סכום.
                      </p>
                      <p className="sample-status">אי אפשר לקבוע סכום</p>
                      <h4>הצעד הבא</h4>
                      <p>
                        להשלים אישור על מצב הקרן בתחילת ההעסקה. השלמת המידע אינה
                        מבטיחה ממצא כספי.
                      </p>
                      {i === 1 ? (
                        <blockquote>
                          נוסח בירור לדוגמה: אבקש לקבל את פירוט ההפקדות ואת מועד
                          תחילתן, כדי להשלים את המידע החסר.
                        </blockquote>
                      ) : null}
                    </div>
                    <figure className="sample-source" id={"sample-source-" + i}>
                      <figcaption>
                        המקור הסינתטי · עמוד {document.evidence[0].page}
                      </figcaption>
                      <p>מסמך הדגמה · יוני 2026</p>
                      <dl>
                        <dt>רכיב פנסיה</dt>
                        <dd>מופיע במסמך</dd>
                        <dt>קרן פעילה בתחילת ההעסקה</dt>
                        <dd>
                          <mark>לא נמסר</mark>
                        </dd>
                        <dt>סידור עבודה רגיל</dt>
                        <dd>לא נמסר</dd>
                      </dl>
                    </figure>
                  </div>
                </details>
                <details className="sample-coverage">
                  <summary>
                    כל הנושאים שנבדקו ומה נותר להשלים
                  </summary>
                  <ReportView projection={projection} embedded />
                </details>
              </div>
            );
          })}
        </ReportExampleTabs>
      </div>
    </section>
  );
}
