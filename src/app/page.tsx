import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { FaqV5 } from "@/components/landing/v5/faq";
import { HeroV5 } from "@/components/landing/v5/hero";
import { LandingView } from "@/components/landing/landing-view";
import {
  CommonActions,
  FinalCtaV5,
  HumanReviewBand,
  PayslipJourney,
  Pricing,
  ThreeSteps,
  WhatWeCheck,
} from "@/components/landing/v5/sections";
import { ProofStrip, StorySection, Testimonials, VideoSection } from "@/components/landing/v5/slots";
import { StickyCta } from "@/components/landing/v5/sticky-cta";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";
import "./landing-v5.css";

/**
 * Site S5. The home page in the canvas's order (design/landing-v5, direction B),
 * built from the site's own components rather than the canvas's markup.
 *
 * Four sections of that canvas are NOT here, and their absence is the point:
 * the proof strip, the video, the founder's story and the testimonials each
 * need something nobody has yet — funnel counters with a source, a real file,
 * the founder's own sentences, real reviews with consent. Each is a slot in
 * `site-content.json` that renders itself the day it is filled (see
 * `docs/design/assets-needed.md`). Nothing is filled with stock imagery, an
 * invented person or an unsourced number.
 *
 * Every figure on this page — price, estimate, link and session lifetimes,
 * contact channels — is read from configuration, so the page cannot drift from
 * what the funnel actually does.
 */
export default async function Home() {
  await guardStableAppEntrypoint("CEP-001");
  return (
    <div className="v5">
      <LandingView />
      <SiteHeader />
      <main id="main-content">
        <HeroV5 />
        <CommonActions />
        <ProofStrip />
        <VideoSection />
        <ThreeSteps />
        <WhatWeCheck />
        <StorySection />
        <HumanReviewBand />
        <Testimonials />
        <Pricing />
        <PayslipJourney />
        <FaqV5 />
        <FinalCtaV5 />
      </main>
      <SiteFooter />
      <StickyCta />
    </div>
  );
}
