# Tivdoc studio redesign — 8 September 2026

## User request and design audit

The user asked for a distinctive, innovative appearance, less information in the first screen, information distributed through the page, and more animation. This is a public-site visual overhaul on the existing product and route structure.

Before: warm paper #FAF8F5, indigo #302C48, coral #E8845C, IBM Plex Sans Hebrew; split hero with multiple descriptions, prices, scope, availability notice and service shortcuts immediately below it. Rounded feature/pricing containers and repeated explanations created visual and information density. Existing approximate dials: variance 4, motion 3, density 7.

After: cool paper #F5F5F7, original indigo/coral identity and original logos, larger Hebrew typography, a commissioned optical-lens artwork, editorial spacing and a progressive four-step explanation. Dials: variance 8, motion 7, density 3. URLs, primary navigation labels, metadata, legal policies, analytics event names, product prices and service availability gates remain intact.

## Before / after review

| Before | After | Purpose |
| --- | --- | --- |
| Prices, scope and service links compete in the opening | One heading, a short explanation, one exploration link; availability below the hero, prices and service links farther down | Reduce the first decision and distribute detail |
| Generic stacked document hero | Original CGI lens artwork in the actual brand colors | Visual identity tied to examining documents |
| Static or isolated decorative transitions | Staggered typography, subtle pointer tilt, scroll-linked artwork, four-phase document assembly, section reveals and small hover feedback | Show hierarchy, source assembly and interaction state |
| Two boxed offer cards | Open two-column comparison; secondary detail in native disclosure controls | Make comparison easier without presenting all details immediately |
| Light-only presentation | Scoped light and dark tokens honoring the operating system | Preserve contrast in both settings |
| Above-fold image scale/opacity delays the largest-contentful paint | Constant-size image entrance using translation; compressed eager-loaded WebP with a high fetch priority | Keep motion without postponing the main visual |

## Implementation

- Home composition: src/app/page.tsx; scoped design rules in src/app/studio.css. Existing check and legal page styling is not replaced.
- Motion leaves: lens-artwork.tsx and studio-motion.tsx. Pointer movement updates an element transform without React re-renders. IntersectionObserver reveals are progressive enhancements; all content exists and is visible without JavaScript. Animations and listeners are cleaned up. No endless timers, autoplay or scroll hijacking.
- process.tsx: observer-driven discrete phases, real pointer and keyboard buttons, transform-based paper assembly. Keyboard interaction and reduced-motion settings remove transitions.
- Generated artwork: C:/Users/smart/.codex/generated_images/01a07a37-02c0-7e21-9ed4-8aeb78f35425/exec-77ed2b9e-628a-4346-9f85-700a5e1b16c6.png. Original retained locally; served as public/brand/lens-study.webp (41,488 bytes). This is illustrative art, not a recreated logo or a report screenshot.
- A second generated cutout was rejected because its checkerboard was baked into RGB instead of a real alpha channel. It is not referenced or deployed.
- The video is retained with controls, captions, written explanation and no autoplay. Its poster is now public/media/tivdoc-explainer-poster.webp.
- Reduced route prefetching for the paused checkout and direct icon imports avoid unnecessary work in the redesigned view.

## Verification

- Production build with TypeScript passed; 55 existing tests across 13 files passed. No new tests mirroring presentation markup were added.
- Chromium: 360, 390, 768, 1024, 1440 widths, no horizontal overflow or clipped hero heading; primary CTA visible within the first 900-pixel viewport.
- Hero image loads at every checked width. An initially stalled responsive optimizer request at 768 was eliminated by serving a precompressed static image.
- Mobile navigation opens, Escape closes it; report tabs support pointer and arrow keys; disclosures expand; light and dark screenshots inspected; reduced-motion has no running animation.
- Pointer tilt produces a perspective transform; scrolling from chapter one to four changes the assembly from phase 0 to phase 3 and moves the document sheets.
- No browser pageerror in the smoke tests. Evidence is in output/studio (not uploaded).
- Local analytics writes logged existing funnel_write_error; this redesign does not claim analytics-provider delivery verification. No paid case, document upload, external message or payment was created.

## Deployment

Pending verification and promotion. Previous production: dpl_2sd8iW5ybFaCnBgdq7scEFLwLYTR / https://salary-l1s8w4bzq-tivdoccom-5042s-projects.vercel.app. This is the explicit rollback target.
