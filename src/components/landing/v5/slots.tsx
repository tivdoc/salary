import Image from "next/image";
import { siteContent } from "@/lib/site-content";

// Site S5, brief §4. Four sections of the canvas have no data and no asset
// behind them. Each is a slot: it renders nothing at all today, and renders
// itself the moment its slot in `site-content.json` is filled. None of them is
// filled by this wave, by design —
//
//   proof strip     needs D-11's own funnel counters. A number with no source
//                   is deleted, never estimated.
//   video           needs a real 30-60s file or a poster. No stock clip.
//   story           needs the founder's own 3-5 sentences. A model-written
//                   founder story is a placeholder person wearing a name.
//   testimonials    needs real reviews with recorded consent, and no large
//                   sums in the headline (external review 3.1).
//
// Rendering `null` rather than an empty shell matters: an empty section with a
// heading would still tell the reader something exists.

export function ProofStrip() {
  const strip = siteContent().content.proof_strip;
  if (strip === null) return null;
  return (
    <section className="v5-proof" aria-labelledby="v5-proof-title">
      <div className="v5-shell v5-proof__grid">
        <h2 id="v5-proof-title" className="v5-visually-hidden">במספרים</h2>
        <p className="v5-proof__figure"><strong>{strip.payslips_checked.toLocaleString("he-IL")}</strong><span>תלושים נבדקו עד היום</span></p>
        <p className="v5-proof__source">מקור: {strip.source}, נכון ל־{strip.measured_at}</p>
      </div>
    </section>
  );
}

export function VideoSection() {
  const video = siteContent().assets.video;
  if (video === null) return null;
  return (
    <section className="v5-video" aria-labelledby="v5-video-title">
      <div className="v5-shell">
        <h2 id="v5-video-title" className="v5-section-title">איך זה עובד</h2>
        {/* Lazy by default: the poster is what the first paint needs. */}
        <video className="v5-video__player" controls preload="none" poster={video.poster}>
          <source src={video.src} type="video/mp4" />
        </video>
      </div>
    </section>
  );
}

export function StorySection() {
  const story = siteContent().content.story;
  const photo = siteContent().assets.founder_photo;
  if (story === null) return null;
  return (
    <section className="v5-story" aria-labelledby="v5-story-title">
      <div className="v5-shell v5-story__grid">
        <div>
          <h2 id="v5-story-title" className="v5-section-title">מה הסיפור של Tivdoc?</h2>
          {story.paragraphs.map((paragraph) => <p key={paragraph.slice(0, 24)}>{paragraph}</p>)}
          <p className="v5-story__attribution">{story.attribution}</p>
        </div>
        {photo === null ? null : <Image src={photo.src} alt={photo.alt} width={photo.width} height={photo.height} className="v5-story__photo" />}
      </div>
    </section>
  );
}

export function Testimonials() {
  const items = siteContent().content.testimonials;
  if (items.length === 0) return null;
  return (
    <section className="v5-testimonials" aria-labelledby="v5-testimonials-title">
      <div className="v5-shell">
        <h2 id="v5-testimonials-title" className="v5-section-title">מה אנשים מצאו בתלוש שלהם</h2>
        <ul className="v5-testimonials__grid">
          {items.map((item) => (
            <li key={item.attribution}>
              <blockquote><p>{item.quote}</p></blockquote>
              <p className="v5-testimonials__by">{item.attribution}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
