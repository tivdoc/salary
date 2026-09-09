import samples from "@/content/report-samples.json";
import { parseProjection } from "@/server/product/reports/case-report-projection";
import { ReportView } from "@/components/case/report-view";
import { DetailDialog } from "./detail-dialog";

export function ReportPreview() {
  const document = samples.reports[0];
  const projection = parseProjection(document.projection);
  return (
    <section
      className="report-preview home-section"
      id="what-you-get"
      aria-labelledby="report-title"
    >
      <div className="studio-shell">
        <h2 id="report-title" className="studio-section-title">
          מה מקבלים
        </h2>
        <p className="sample-disclosure">
          דוגמה להמחשה על נתונים סינתטיים; אינה דוח של לקוח.
        </p>
        <article className="focused-finding" aria-labelledby="finding-title">
          <div className="focused-finding__heading">
            <span className="studio-eyebrow">פנסיה · יוני 2026</span>
            <h3 id="finding-title">הרכיב מופיע. האישור עדיין חסר.</h3>
            <p className="sample-status">אי אפשר לקבוע סכום</p>
          </div>
          <div className="finding-steps">
            <div>
              <span>01 / מה נבדק</span>
              <p>רכיב הפנסיה במסמך והמידע על הקרן בתחילת ההעסקה.</p>
            </div>
            <div>
              <span>02 / המקור</span>
              <p>
                מסמך ההדגמה, עמוד {document.evidence[0].page}: רכיב פנסיה מופיע;
                מצב הקרן לא נמסר.
              </p>
            </div>
            <div>
              <span>03 / הצעד הבא</span>
              <p>
                להשלים אישור על מצב הקרן בתחילת ההעסקה. אין הבטחה לממצא כספי.
              </p>
            </div>
          </div>
          <DetailDialog
            label="לפירוט הדוגמה והכיסוי"
            title="הדוגמה המלאה · יוני 2026"
          >
            <p>
              דוגמה להמחשה על נתונים סינתטיים; אינה דוח של לקוח. הכיסוי כאן הוא
              חודש אחד בלבד.
            </p>
            <figure className="sample-source">
              <figcaption>מסמך ההדגמה · עמוד 1</figcaption>
              <p className="sample-source-text">{samples.source}</p>
            </figure>
            <p>
              נוסח בירור לדוגמה: אבקש לקבל את פירוט ההפקדות ואת מועד תחילתן, כדי
              להשלים את המידע החסר.
            </p>
            <div className="sample-coverage">
              <ReportView projection={projection} embedded />
            </div>
          </DetailDialog>
        </article>
      </div>
    </section>
  );
}
