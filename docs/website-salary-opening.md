# Salary-first opening and five visitor questions

Application source: ad6307c. The first screen now asks “קיבלת את כל מה שמגיע לך בעבודה?” and explicitly describes AI analysis of salary slips and documents, findings, missing information and next steps. The former brand line is secondary under the lens.

The opening action uses the same availability passed by the server page: when sales are open it links to /check with “התחילו בדיקת שכר”; while sales are closed it offers email contact about salary checks and visibly states that new purchases are unavailable. Unit tests cover both render states without opening sales. The video and “איך זה עובד?” remain secondary.

The page and navigation now follow these headings:

1. מעלים תלוש. אנחנו בודקים.
2. מקבלים ממצאים עם הסבר ומקור.
3. יודעים מראש כמה משלמים.
4. יודעים מי עומד מאחורי הבדיקה.
5. מתחילים מתלוש אחד.

Pricing precedes Trust. Operator name and contact are visible in Trust; the closing section explicitly says to prepare one salary slip, with contract and attendance report optional if available. The same synthetic pension case remains throughout the process and report. Initial price, scope, follow-up range, credit, service availability and material limits remain visible where relevant. No billing, processing or publication gates changed.

Production build/TypeScript, changed-file ESLint and 16 relevant tests pass (Hero availability, report integrity, canonical offer, route split). The browser script verifies heading-only order, first-screen geometry and existing progressive disclosures at 360/390/768/1440 widths; opening captures use 360×740, 390×844 and 1440×900. A separate no-JavaScript check confirms the service explanation, contact action, price, native tier-table disclosure and heading sequence remain usable without playing video or opening explanatory details. No new speed or conversion improvement is claimed.

Evidence: [mobile opening](release-evidence/salary-opening/opening-mobile.png), [desktop opening](release-evidence/salary-opening/opening-desktop.png), [mobile page](release-evidence/salary-opening/page-mobile.png), [desktop page](release-evidence/salary-opening/page-desktop.png), [no-JavaScript receipt](release-evidence/salary-opening/no-js.json).

Deployment and remote verification are recorded below after completion. This revision is a Preview update; production is not promoted.

Remote result: Vercel Git deployment `dpl_EYtrHMibBUuhqJt5GRgbhYBnEsLD` is READY and matches `ad6307c600471267bac7eea5f14d0cc34a5dbb33`. The complete browser flow, including first-screen geometry and heading order, passes on the remote branch Preview with zero page errors. [Browser receipt](release-evidence/salary-opening/browser-results.json). The existing seven-day share link continues to open this branch.
