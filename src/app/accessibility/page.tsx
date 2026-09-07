import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { productOffer } from "@/config/product-offer";
export const metadata: Metadata = { title: "נגישות | Tivdoc", alternates: { canonical: "/accessibility" } };
export default function AccessibilityPage() {
 return <><SiteHeader /><main id="main-content" className="legal-page"><div className="legal-shell">
  <p className="legal-page__label">נגישות · עודכן ביום 7.9.2026</p><h1>גישה נוחה למידע ולשירות.</h1>
  <p className="legal-page__lead">אנחנו פועלים כדי שהאתר יהיה ברור ונוח לשימוש גם באמצעות מקלדת וטכנולוגיות מסייעות.</p>
  <section><h2>ההתאמות באתר</h2><ul><li>ניווט במקלדת, סימון מיקוד וקישור לדילוג לתוכן.</li><li>כותרות מסודרות, שמות לכפתורים וטקסט חלופי לתמונות.</li><li>תצוגה מותאמת למסכים קטנים ותמיכה בהעדפה להפחתת תנועה.</li><li>הסבר כתוב לצד סרטון ההמחשה, ללא הפעלה אוטומטית.</li></ul></section>
  <section><h2>דיווח על קושי בשימוש</h2><p>אם נתקלת בקושי, אפשר לפנות אלינו ולציין את כתובת העמוד, הפעולה שניסית לבצע וסוג המכשיר או הדפדפן. אין צורך לצרף תלוש או מידע אישי רגיש.</p><a href={"mailto:" + productOffer.supportEmail}><bdi>{productOffer.supportEmail}</bdi></a></section>
  <section><h2>היקף הבדיקות</h2><p>האתר נבדק בתצוגת מחשב וטלפון ובניווט מקלדת. טרם הושלמה בדיקת נגישות חיצונית מקיפה; עמוד זה אינו אישור לעמידה מלאה בתקן. שירותים חיצוניים, ובהם ספק התשלום, פועלים בממשק נפרד.</p></section>
 </div></main><SiteFooter /></>;
}
