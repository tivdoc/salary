# Website UX audit — 8 September 2026

The user requested a design and usability review followed by implementation. This follow-up preserves the studio identity and original artwork while making the page easier to navigate and understand.

| Before | After |
| --- | --- |
| Opening copy does not immediately identify the service | Clear salary and employment-rights context and a descriptive process link |
| Four long scroll chapters; illustration separated from mobile explanations | Four selectable phases with a shared illustration and stable explanation area; previous/next controls and RTL arrow, Home and End keys |
| Opening the mobile menu and pressing Tab skips its links | Opening focuses the first link; Escape restores toggle focus; leaving the header closes the disclosure |
| No persistent navigation position | Current section marked visually and with aria-current; anchor navigation moves keyboard focus to the heading |
| Paused service CTA records a start event and opens another availability page | Explicit availability beside each planned price; direct service email link while checkout is closed |
| Large reveal movement and content fades from zero opacity | Shorter 440 ms reveals, smaller translation, readable starting opacity and no late reveal of passed content |
| Advertising scripts compete with the initial page | Next Script lazyOnload waits for load/idle; existing early-event queues preserved |
| Silent video may look like broken audio | Visible silent-video note beside its written alternative |

## Verification

- Build and TypeScript pass. ESLint passes. All 55 existing tests across 13 files pass.
- Chromium at widths 320, 360, 390, 768, 1024 and 1440: no horizontal overflow, hero CTA in first viewport, stable process height across every selected phase.
- Process keyboard and pointer controls, report tabs and details, mobile menu focus/Tab/Escape, anchor focus, selected navigation, direct email target and reduced motion all pass with no pageerror. Light and dark captures inspected.
- At 1440 px, process height fell from 1836 to 1026 px (44%). At 390 px it fell from 1418 to 1000 px (30%). These are section-height measurements, not conversion results.
- A browser check deliberately held an image request before window load and intercepted third-party scripts. Both providers stayed deferred; landing_view and PageView were queued, then drained exactly once after release. This checks browser queue behavior, not delivery to external analytics accounts.
- Production baseline mobile Lighthouse: performance 57, accessibility 100, LCP 7.1 s, TBT 510 ms, CLS 0. A local preliminary run without configured third-party IDs scored 77/100, LCP 5.7 s, TBT 180 ms, CLS 0; this is not a valid before/after production speed comparison. Public post-deployment measurement is recorded below when available.
- Existing local funnel_write_error persists when the optional analytics API cannot write. No engine, payment intake, migrations or production environment variables were changed.
- Evidence and scripts are retained under output/ux-audit and excluded from deployment.

## Deployment

Previous production / rollback target: https://salary-nshmw5oma-tivdoccom-5042s-projects.vercel.app (dpl_4CNGHNBCBBZa8rNrDZxFzkUxcwzV).

Published to https://tivdoc.com from commit 6e0fc55. Deployment dpl_BAZuWfKRWSag5YpAvzP4dDptgdU4 / https://salary-qhq00nevw-tivdoccom-5042s-projects.vercel.app. Vercel build passed; protected HTML and health checked before promotion. Public browser checks passed at all six widths with no pageerror. Production Google and Meta bootstrap scripts loaded and both early-event queues were empty afterward. The no-JavaScript fallback exposes all four stage descriptions, and keyboard focus leaving the mobile header closes its menu. No service gates or production configuration were changed.

Post-deployment public mobile Lighthouse: performance 67, accessibility 100, FCP 1.0 s, LCP 4.8 s, TBT 570 ms, CLS 0. Compared with this turn's public baseline (57, 100, 2.9 s, 7.1 s, 510 ms, 0), measured paint improved while total blocking time did not. These are individual lab runs, not field Core Web Vitals or proof of a general speed guarantee; further third-party/main-thread work remains possible.
