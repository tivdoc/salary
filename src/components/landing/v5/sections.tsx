import Image from "next/image";
import Link from "next/link";
import { TrackedLink } from "@/components/tracked-link";
import { formatDuration, formatPrice, productOffer } from "@/lib/product-offer";
import { siteContent } from "@/lib/site-content";

/** The canvas's "פעולות נפוצות" tiles. The WhatsApp tile appears only when a number is configured. */
export function CommonActions() {
  const offer = productOffer();
  const whatsapp = offer.contact.whatsapp;
  const price = formatPrice(offer.initial_check.price);
  const fullPrice = formatPrice(offer.full_report.price);
  // Only the check tile is a tracked event; `start_check` already exists. The other two
  // are ordinary links — inventing analytics event names to decorate a tile would put
  // strings into the funnel's vocabulary that nothing downstream understands.
  const tiles = [
    { href: "/login", title: "כניסה לתיק", note: "טלפון או מייל ← קוד" },
    { href: "#pricing", title: "מה כולל הדוח המלא", note: `${fullPrice} · תמיד עם בקרה של חשבת שכר` },
  ];
  return (
    <section className="v5-actions" aria-labelledby="v5-actions-title">
      <div className="v5-shell">
        <h2 id="v5-actions-title" className="v5-section-title">פעולות נפוצות</h2>
        <ul className="v5-actions__grid">
          <li>
            <TrackedLink className="v5-tile v5-tile--primary" href="/check" eventName="start_check">
              <strong>לבדוק תלוש</strong>
              <span>מתחילים מהשאלות, כשתי דקות</span>
            </TrackedLink>
          </li>
          {tiles.map((tile) => (
            <li key={tile.href}>
              <Link className="v5-tile" href={tile.href}>
                <strong>{tile.title}</strong>
                <span>{tile.note}</span>
              </Link>
            </li>
          ))}
          {whatsapp === null ? null : (
            <li>
              {/* Not a TrackedLink: it leaves the site, and next/link would not help. */}
              <a
                className="v5-tile"
                href={`https://wa.me/${whatsapp.replace(/[^0-9]/gu, "")}?text=${encodeURIComponent("שלום, יש לי שאלה על בדיקת תלוש")}`}
                rel="noopener noreferrer"
                target="_blank"
              >
                <strong>שאלה? ב־WhatsApp</strong>
                <span>מענה אנושי בשעות הפעילות</span>
              </a>
            </li>
          )}
        </ul>
        <p className="v5-actions__price-note">בדיקה ראשונית {price}. תלוש אחד מספיק כדי להתחיל.</p>
      </div>
    </section>
  );
}

/** The three steps, in the funnel's real order: questions first, payslip and payment second, result third. */
export function ThreeSteps() {
  const offer = productOffer();
  const automatic = formatDuration(offer.initial_check.delivery.automatic);
  const price = formatPrice(offer.initial_check.price);
  const steps = [
    { number: "01", title: "עונים על כמה שאלות", text: "איך אתה באמת עובד: שעות, ימים, תפקיד ומה קורה בפועל. בערך שתי דקות." },
    { number: "02", title: `מצלמים תלוש ומשלמים ${price}`, text: "תלוש אחד מספיק. הקישור לתיק נשלח לערוץ שאימתת." },
    { number: "03", title: `תוצאה תוך ${automatic}`, text: "נקודות לבדיקה, כל אחת עם הכיוון שלה ורמת הוודאות שלה." },
  ];
  return (
    <section className="v5-steps" id="how-it-works" aria-labelledby="v5-steps-title">
      <div className="v5-shell">
        <h2 id="v5-steps-title" className="v5-section-title">שלושה שלבים.</h2>
        <ol className="v5-steps__list">
          {steps.map((step) => (
            <li key={step.number}>
              <span className="v5-steps__number">{step.number}</span>
              <div>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
        <ul className="v5-steps__certainty" aria-label="שלוש רמות הוודאות">
          {/* D-6.2's fixed sentences, verbatim. */}
          <li><strong>ודאות גבוהה</strong><span>הנתון נשען על המסמכים</span></li>
          <li><strong>ודאות בינונית</strong><span>הנתון תלוי במה שמסרת</span></li>
          <li><strong>ודאות נמוכה</strong><span>אי אפשר לקבוע סכום, וזה מה שיעלה את הוודאות</span></li>
        </ul>
      </div>
    </section>
  );
}

const CHECKS = [
  "שעות נוספות 125% / 150%",
  "הפרשות לפנסיה ולפיצויים",
  "שכר מינימום לפי היקף משרה",
  "דמי הבראה",
  "נסיעות",
  "ימי חופשה וצבירה",
  "עבודה בשבת ובחגים",
  "דמי מחלה",
  "תפקיד בפועל מול דירוג בתלוש",
  "ניכויים שלא אמורים להיות שם",
];

export function WhatWeCheck() {
  const illustration = siteContent().assets.checks_illustration;
  return (
    <section className="v5-checks" id="what-we-check" aria-labelledby="v5-checks-title">
      <div className="v5-shell v5-checks__grid">
        <div>
          <h2 id="v5-checks-title" className="v5-section-title">מה בודקים בתלוש</h2>
          <ul className="v5-checks__list">
            {CHECKS.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
        {illustration === null ? null : (
          <Image src={illustration.src} alt={illustration.alt} width={illustration.width} height={illustration.height} className="v5-checks__image" />
        )}
      </div>
    </section>
  );
}

/** The navy band. No photograph and no name until the owner supplies both (brief §4). */
export function HumanReviewBand() {
  const photo = siteContent().assets.payroll_controller_photo;
  return (
    <section className="v5-band" aria-labelledby="v5-band-title">
      <div className="v5-shell v5-band__grid">
        <div>
          <p className="v5-band__eyebrow">לא רק אלגוריתם</p>
          <h2 id="v5-band-title">הדוח המלא עובר תמיד בקרה של חשבת שכר</h2>
          <p>הבדיקה הראשונית רצה על המנוע. הדוח המלא לא מתפרסם בלי שאדם מוסמך עבר עליו.</p>
        </div>
        {photo === null ? null : (
          <Image src={photo.src} alt={photo.alt} width={photo.width} height={photo.height} className="v5-band__photo" />
        )}
      </div>
    </section>
  );
}

export function Pricing() {
  const offer = productOffer();
  return (
    <section className="v5-pricing" id="pricing" aria-labelledby="v5-pricing-title">
      <div className="v5-shell">
        <h2 id="v5-pricing-title" className="v5-section-title">שני מוצרים. שני מחירים. אין הפתעות.</h2>
        <div className="v5-pricing__grid">
          <article className="v5-plan v5-plan--primary">
            <h3>בדיקה ראשונית</h3>
            <p className="v5-plan__price">{formatPrice(offer.initial_check.price)}<span> · חד־פעמי</span></p>
            <p className="v5-plan__when">תוצאה תוך {formatDuration(offer.initial_check.delivery.automatic)} במסלול האוטומטי, ועד {formatDuration(offer.initial_check.delivery.human)} כשנדרשת בקרה אנושית.</p>
            <ul>
              <li>לכל נקודה: כיוון ורמת ודאות</li>
              <li>סכום — רק כשהבסיס לנושא מלא</li>
              <li>מה חסר כדי להעלות את הוודאות</li>
            </ul>
            <TrackedLink className="button button--primary v5-cta" href="/check" eventName="start_check">לבדיקת התלוש שלי</TrackedLink>
          </article>
          <article className="v5-plan">
            <h3>דוח מלא</h3>
            <p className="v5-plan__price">{formatPrice(offer.full_report.price)}<span> · חד־פעמי</span></p>
            <p className="v5-plan__when">תוך {formatDuration(offer.full_report.delivery)} מהרגע שאין שאלה פתוחה אצלך.</p>
            <ul>
              <li>כל התקופה שמסרת, כל הנושאים</li>
              <li>חבילת ראיות, צעדי פעולה ו־PDF</li>
              <li>תמיד עם בקרה של חשבת שכר</li>
            </ul>
            <p className="v5-plan__note">זמין אחרי הבדיקה הראשונית, ומוצע רק אם נמצאו נקודות לבדיקה.</p>
          </article>
        </div>
        <p className="v5-pricing__second-product">{offer.second_product_sentence}</p>
      </div>
    </section>
  );
}

/** "מה קורה לתלוש שלך" — access and privacy, with every duration read from configuration. */
export function PayslipJourney() {
  const access = productOffer().access;
  return (
    <section className="v5-journey" aria-labelledby="v5-journey-title">
      <div className="v5-shell">
        <h2 id="v5-journey-title" className="v5-section-title">מה קורה לתלוש שלך</h2>
        <ul className="v5-journey__list">
          <li>
            <strong>קישור וקוד. בלי סיסמה.</strong>
            <span>
              הקישור לתיק נשלח לערוץ שאימתת ותקף {access.link_token_ttl_hours} שעות; הוא נפתח פעם אחת ומחליף את עצמו בקוד בן שש ספרות.
              הכניסה עצמה נשמרת {access.session_ttl_days} יום, ואפשר להיכנס בכל רגע מ־/login עם הטלפון או המייל שאימתת.
            </span>
          </li>
          <li>
            <strong>מוצפן בהעלאה ובאחסון</strong>
            <span>הקובץ מוצפן מהרגע שהוא עוזב את המכשיר שלך.</span>
          </li>
          <li>
            <strong>המעסיק לא יודע</strong>
            <span>המסמכים והמידע משמשים לבדיקה בלבד ואינם נשלחים למעסיק.</span>
          </li>
        </ul>
      </div>
    </section>
  );
}

export function FinalCtaV5() {
  const offer = productOffer();
  return (
    <section className="v5-final" aria-labelledby="v5-final-title">
      <div className="v5-shell">
        <h2 id="v5-final-title">תלוש אחד. {formatPrice(offer.initial_check.price)}. {formatDuration(offer.initial_check.delivery.automatic)}.</h2>
        <TrackedLink className="button button--primary button--large v5-cta" href="/check" eventName="start_check">לבדיקת התלוש שלי</TrackedLink>
      </div>
    </section>
  );
}
