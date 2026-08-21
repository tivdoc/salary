import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = { title: "מדיניות פרטיות | Tivdoc" };

export default function PrivacyPage() {
  return (
    <>
      <SiteHeader />
      <main id="main-content" className="legal-page">
        <div className="legal-shell">
          <p className="mono legal-page__label">מדיניות פרטיות</p>
          <h1>הפרטים והמסמכים שלך משמשים לבדיקה.</h1>
          <p className="legal-page__lead">עמוד זה הוא מבנה ראשוני למדיניות הפרטיות של Tivdoc לקראת השלמת נוסח משפטי מלא.</p>
          <section><h2>איזה מידע נאסף?</h2><p>פרטי קשר, מידע על ההעסקה והעבודה בפועל, תלושי שכר ומסמכים שתבחר להעלות, וכן מידע טכני בסיסי הנדרש להפעלת השירות ולמדידת השימוש בו.</p></section>
          <section><h2>למה המידע משמש?</h2><p>לפתיחת תיק בדיקה, בחינת המסמכים והפרטים שסופקו, יצירת קשר במקרה שנדרש מידע נוסף, טיפול בתשלום ושיפור השירות.</p></section>
          <section><h2>מסמכים</h2><p>המסמכים נשמרים ב־Supabase Storage ב־bucket פרטי. הגישה מתבצעת דרך השרת בלבד, ללא קישור ציבורי קבוע. המסמכים אינם נשלחים למעסיק.</p></section>
          <section><h2>ספקים</h2><p>השירות נעזר ב־Supabase לאחסון נתונים ומסמכים, ב־Invoice4u לתשלום וב־Google Analytics למדידת שימוש כאשר הוא מופעל.</p></section>
          <section><h2>שמירה ומחיקה</h2><p>מדיניות תקופת השמירה והמחיקה האוטומטית תוגדר לפני השקה מלאה. עד אז אין בעמוד זה התחייבות למחיקה אוטומטית במועד מסוים.</p></section>
          <section><h2>יצירת קשר</h2><p>לפניות פרטיות או בקשות הנוגעות למידע, יש לפרסם כאן כתובת קשר ייעודית לפני העלייה לאוויר.</p></section>
          <div className="legal-notice"><b>נדרש לפני Production</b><p>יש להעביר את הנוסח לעיון משפטי ולהוסיף פרטי בעל המאגר, דרכי קשר, תקופות שמירה וזכויות נושא המידע.</p></div>
          <Link className="text-link" href="/">חזרה לעמוד הבית</Link>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
