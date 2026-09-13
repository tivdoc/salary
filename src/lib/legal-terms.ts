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

export const TERMS_VERSION = "2026-09-13" as const;
export const RETAINED_TERMS_VERSION = "2026-09-07" as const;
export const REPORT_NOTIFICATION_NOTICE = "במסגרת הבדיקה שרכשת נוכל לשלוח לכתובת האימייל המאומתת שלך הודעה כאשר דוח חדש זמין בתיק. ההודעה תכלול קישור לתיק, ללא מסמכי השכר או ממצאי הדוח בגוף ההודעה. אלה הודעות שירות על הדוח, ולא הודעות פרסומיות. אפשר לבקש להפסיק את ההודעות; הגישה לדוח בתיק נשמרת לפי הרשאותיו.";

/** A saved offer keeps its accepted version. Unknown versions never resolve
 * to the current text, and publication of this notice grants no send authority. */
export function resolveTermsPresentationVersion(value:unknown){
  if(value===undefined)return TERMS_VERSION;
  return value===TERMS_VERSION||value===RETAINED_TERMS_VERSION?value:null;
}
export const hasReportNotificationTerms=(version:string)=>version===TERMS_VERSION;
export const termsVersionHref=(version:string)=>`/terms?version=${encodeURIComponent(version)}`;
export const privacyVersionHref=(version:string)=>`/privacy?version=${encodeURIComponent(version)}`;

/** The version as the terms page prints it: 7.9.2026. */
export function termsVersionLabel(version: string = TERMS_VERSION): string {
  const [year, month, day] = version.split("-");
  return `${Number(day)}.${Number(month)}.${year}`;
}
