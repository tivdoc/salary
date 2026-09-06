// Site S4 (2.6). The one place the terms' version is written down.
//
// A consent record is only worth keeping if it says WHICH terms were agreed to.
// The terms page used to state its own date in prose and the consent, when it
// existed, would have recorded nothing — so a change to the terms would have
// silently reinterpreted every past agreement as being about the new text.
//
// Both the page and the stored consent read this constant, so "what the page
// said" and "what we recorded they agreed to" are the same string by
// construction. Changing the terms means changing this date in the same commit.

export const TERMS_VERSION = "2026-08-22" as const;

/** The version as the terms page prints it: 22.8.2026. */
export function termsVersionLabel(version: string = TERMS_VERSION): string {
  const [year, month, day] = version.split("-");
  return `${Number(day)}.${Number(month)}.${year}`;
}
