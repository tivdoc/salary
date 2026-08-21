import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = { title: "תנאי שימוש | Tivdoc" };

export default function TermsPage() {
  return (
    <>
      <SiteHeader />
      <main id="main-content" className="legal-page">
        <div className="legal-shell">
          <p className="mono legal-page__label">תנאי שימוש</p>
          <h1>בדיקה ראשונית, לא קביעה משפטית.</h1>
          <p className="legal-page__lead">עמוד זה מספק מבנה ראשוני לתנאי השימוש ויש להשלים אותו בנוסח משפטי מאושר לפני השקה מלאה.</p>
          <section><h2>מה השירות מספק?</h2><p>Tivdoc מבצע בדיקה ראשונית שעשויה לזהות חריגות ולהעריך פערים אפשריים על בסיס המידע והמסמכים שסופקו.</p></section>
          <section><h2>מה השירות אינו מספק?</h2><p>הבדיקה אינה ייעוץ משפטי, אינה תחליף לבדיקה מקצועית מלאה ואינה קובעת שהמעסיק חייב סכום מסוים.</p></section>
          <section><h2>אחריות המשתמש</h2><p>יש למסור מידע נכון, עדכני ומלא ככל האפשר ולהעלות רק מסמכים שיש לך הרשאה להשתמש בהם לצורך הבדיקה.</p></section>
          <section><h2>תשלום</h2><p>מחיר הבדיקה הראשונית הוא 9.90 ₪. התשלום מתבצע דרך Invoice4u ורק אימות תשלום שהתקבל במערכת מסמן אותו כהושלם.</p></section>
          <section><h2>דיוק ותוצאות</h2><p>איכות הבדיקה תלויה במסמכים ובפרטים שנמסרו. ייתכן שיידרשו מסמכים נוספים ושלא ניתן יהיה להגיע למסקנה ברמת ודאות גבוהה.</p></section>
          <div className="legal-notice"><b>נדרש לפני Production</b><p>יש להשלים פרטי ישות מפעילה, מדיניות ביטולים והחזרים, דין וסמכות שיפוט, הגבלת אחריות ופרטי קשר.</p></div>
          <Link className="text-link" href="/">חזרה לעמוד הבית</Link>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
