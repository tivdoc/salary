# Website information flow — 9 September 2026

Application source: a92151ae3a6392634aaf44149b45c9f4890e1602. Vercel Git Preview dpl_F6dyhYakhBVTnuAzY1CdfD28tvo4 is READY and was tested remotely. Branch: codex/website-review-full; integration PR: https://github.com/tivdoc/salary/pull/3 .

Preview: https://salary-git-codex-website-review-full-tivdoccom-5042s-projects.vercel.app (login or previously supplied seven-day share link). Share credentials are not committed. Production was not promoted by this work.

## Information architecture

| Before | After | Detail on request |
| --- | --- | --- |
| Repeated process introduction and large standalone video section | Existing brand headline, one service sentence and lens artwork | Video opens from the hero in a native modal dialog; player mounts only on request |
| Process text plus a second example paragraph at each stage | Same June pension example progresses through document, missing answer, highlighted source and next action | Additional explanation for the selected stage; short mobile explanation always visible |
| Two versions of the same missing-information report inline | One finding: what was checked, source, next step, inability to calculate | Source text, inquiry wording and actual seven-topic renderer in a separate modal view |
| Long trust narrative repeats the example | Sources, operator contact and privacy, before pricing | Method, operator/correction details and full policy links |
| Two large price sheets and visible tier table | Initial 9.99 ILS, one-month/up-to-three-topic scope, total follow-up range and availability | Canonical tier table and credit calculation; accessible before the final action |
| Six FAQs followed by three service actions | One availability-aware final action and four short FAQs | Answers expand individually; existing-case access stays in the header |

Material limits remain visible: AI/no promised professional review in Trust; missing information/no amount next to the finding; synthetic disclaimer; price, scope and separate paid continuation in Pricing; availability at Pricing and final CTA. Full report remains unavailable for purchase. Canonical offer, billing and processing/publication gates are unchanged.

## Verification

- Next production build and TypeScript pass; changed-file ESLint passes.
- 16 targeted tests pass: synthetic report integrity/rendering, canonical offer, measurement gate and route split.
- scripts/website-review/verify-flow.cjs passes locally and on the remote Preview at 360/390/768/1440 widths: section order, visible price/range/scope, one primary final CTA, four FAQs, four process stages plus RTL keyboard, separate seven-topic dialog, no horizontal overflow, focus containment/restore, Escape, video intent-only mounting, play/pause, captions, removal on close, source failure/text recovery, mobile menu, 200% CSS reflow and dark/reduced-motion mode. Zero page errors. The script waits for React close/unmount cleanup rather than assuming synchronous event completion.
- Poster regenerated from the actual focused finding via capture-poster.cjs and inspected. Original brand artwork and existing video footage remain intact.
- No checkout, customer report, real customer data or engine activation was performed. No new Lighthouse or field-performance score is claimed for this layout revision.

Fresh-page comparison uses 1000px viewport height, loaded fonts, reduced motion and closed disclosures. The former Preview showed 591–595 whitespace-separated words in main; the new page shows 324 (about 45% fewer). At 360px width total document height fell from 8,678 to 5,101px (41.2%); at 1440px from 7,054 to 3,874px (45.1%). These are page-density measurements, not usability-study or speed guarantees.

Evidence: [comparison](release-evidence/website-flow/comparison.json), [browser receipt](release-evidence/website-flow/browser-results.json), [mobile before](release-evidence/website-flow/before-mobile.png), [mobile after](release-evidence/website-flow/after-mobile.png), [desktop before](release-evidence/website-flow/before-desktop.png), [desktop after](release-evidence/website-flow/after-desktop.png), [source highlight stage](release-evidence/website-flow/process-source.png).

The earlier H/D/P13 system dependencies in website-review-full-handoff.md remain. The completed-result example still requires appropriate verified evidence. This revision completes the requested information hierarchy within the public website; it does not establish engine readiness or change the production deployment.
