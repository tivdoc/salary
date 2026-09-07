import Link from "next/link";
import { productOffer } from "@/config/product-offer";
export function ServiceUnavailable() {
  return <section className="payment-card service-unavailable" aria-labelledby="service-title">
    <p className="home-kicker">זמינות השירות</p>
    <h1 id="service-title">בדיקות חדשות ייפתחו בהמשך.</h1>
    <p>אנחנו משלימים את ההיערכות למסירת תוצאות. כרגע לא ניתן לפתוח בדיקה חדשה או לבצע תשלום באתר.</p>
    <p>כבר התחלת בדיקה או שילמת? אפשר לבדוק את הסטטוס בדפדפן שבו התחלת, או לפנות אלינו לקבלת עזרה.</p>
    <div className="service-unavailable__actions">
      <Link className="button button--primary" href="/check/received">מצב הבדיקה שלי</Link>
      <a className="button button--secondary" href={"mailto:" + productOffer.supportEmail}>פנייה לשירות</a>
      <Link className="home-text-link" href="/">חזרה לעמוד הבית</Link>
    </div>
  </section>;
}
