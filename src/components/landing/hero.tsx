import { ArrowDown } from "@phosphor-icons/react/dist/ssr";
import { LensArtwork } from "@/components/landing/lens-artwork";
export function Hero() {
  return (
    <section className="studio-hero" aria-labelledby="hero-title">
      <div className="studio-shell studio-hero__layout">
        <div className="studio-hero__copy">
          <p className="studio-eyebrow">בדיקת שכר וזכויות בעבודה</p>
          <h1 id="hero-title">
            <span>יש יותר</span>
            <span>ממה שכתוב.</span>
          </h1>
          <p className="studio-hero__intro">
            מחברים בין תלוש השכר, מסמכי ההעסקה והעבודה בפועל, כדי להבין מה כדאי
            לבדוק.
          </p>
          <a className="studio-link" href="#how-it-works">
            <span className="studio-link__icon">
              <ArrowDown size={22} aria-hidden="true" />
            </span>
            איך הבדיקה עובדת
          </a>
        </div>
        <LensArtwork />
      </div>
    </section>
  );
}
