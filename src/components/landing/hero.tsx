import { ArrowDown } from "@phosphor-icons/react/dist/ssr";
import { LensArtwork } from "@/components/landing/lens-artwork";
export function Hero() {
  return (
    <section className="studio-hero" aria-labelledby="hero-title">
      <div className="studio-shell studio-hero__layout">
        <div className="studio-hero__copy">
          <p className="studio-eyebrow">לראות מעבר לתלוש</p>
          <h1 id="hero-title">
            <span>יש יותר</span>
            <span>ממה שכתוב.</span>
          </h1>
          <p className="studio-hero__intro">
            תלוש השכר הוא רק ההתחלה. תבדוק נעזרת ב־AI כדי לחבר בין המסמכים לבין מה שקורה
            בעבודה.
          </p>
          <a className="studio-link" href="#how-it-works">
            <span className="studio-link__icon">
              <ArrowDown size={22} aria-hidden="true" />
            </span>
            מגלים את התמונה
          </a>
        </div>
        <LensArtwork />
      </div>
    </section>
  );
}
