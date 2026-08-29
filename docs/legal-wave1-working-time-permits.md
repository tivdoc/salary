# Working Time and Permits Closure Pack — Wave 1 V0.3

This source-specific pack records public discovery and raw acquisition evidence only. It does not review or activate a source, create a consolidated statute, infer an effective interval or relationship, classify a permit as applicable, or create a legal or numeric rule.

## Snapshot boundary

- Cutoff: `2026-08-29T20:08:23.937Z`.
- Knesset law page: `https://main.knesset.gov.il/apps/legislation/main/laws/2000019`.
- Ministry catalog: `https://www.gov.il/he/Departments/DynamicCollectors/work-permits`.
- Navigation used only the public visible interfaces with empty catalog filters. No login, cookies, CAPTCHA handling, proxying, header/fingerprint manipulation, internal API, mirror, or access-control bypass was used.

## Hours of Work and Rest publications

The Knesset page exposed 20 publication rows after one visible **load more** action: one original promulgation, 18 amendment publications (12 direct and six indirect), and one error-correction publication. Each row records identity, publication date, detail URL, official artifact URL, artifact role and discovery locator in `wave1-working-time-permits-publications.v0.3.json`.

The original row's official PDF was resolved through its visible Knesset detail record, `https://main.knesset.gov.il/apps/legislation/main/bills/148168`. All 20 official Knesset PDFs were acquired as separate raw, unreviewed artifacts. The Knesset page's non-official Wikisource full-text link was excluded. No institutional consolidated representation was observed and no consolidation was created.

## Work-permits catalog

The public catalog reported 58 results. Visible pagination was traversed once with skips `0, 10, 20, 30, 40, 50`, yielding page counts `10, 10, 10, 10, 10, 8`. The source-specific inventory contains 58 unique stable IDs based on the visible `dynamiccollectorresultitem` slug, 68 separate official PDF links and no duplicate artifact URL. Three catalog-title duplicate groups are preserved rather than merged:

- accommodation establishments;
- seasonal agricultural work;
- the two distinct "Am Kelavi" rows.

Every entry has `relevance: unknown_pending_legal_review`. Catalog titles and labels do not establish applicability, expiry, revocation or sector coverage.

Raw acquisition succeeded for 52 of the 68 visible permit artifacts. Fifteen older links returned HTTP 403 to a plain request and one returned HTTP 404. They were not retried or bypassed. The ignored `owner-handoff.json` enumerates the exact 16 artifact IDs and official URLs and provides executable owner steps. The catalog inventory itself is complete at 58/58; the separate artifact acquisition pack remains partial.

## Evidence and execution

Run source validation without network access:

```powershell
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/wave1-working-time-permits.mts --validate-only
```

Run the one-attempt-per-link raw acquisition only when the ignored output directory is empty:

```powershell
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/wave1-working-time-permits.mts
```

The source-specific output is Git-ignored under `output/legal-knowledge/wave1-working-time-permits/`:

- `artifact-acquisition-report.json` contains every request URL, final URL, result, byte count, SHA-256 and relative raw path;
- `owner-handoff.json` contains only unresolved artifact actions;
- `artifacts/hours_publications/` and `artifacts/work_permits/` contain raw PDFs.

Local ignored output is review evidence, not durable audit storage.

## Integration patch request

The integration commit may add a `package.json` script named `legal:sources:wave1:working-time-permits` for the source-specific CLI and may re-export `wave1-working-time-permits.ts` from an appropriate server-only barrel if one is introduced. It must not register these observations as reviewed/active sources, add them to an operative candidate set, or change the central legal manifest without a separate reviewed decision.
