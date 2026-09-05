// UX Run 1 / U8. No component renders a raw error. A response's machine code
// maps to customer copy here; a message the product's own API wrote is
// customer copy by contract and passes through; anything else — a provider's
// English, an exception's name, a network failure — becomes the screen's own
// fallback sentence, and the technical detail stays where it was logged.

export const CUSTOMER_ERROR_COPY: Readonly<Record<string, string>> = Object.freeze({
  // Access (U2)
  access_request_invalid: "לא הצלחנו לקרוא את הבקשה. אפשר לנסות שוב.",
  access_code_invalid: "הקוד שהוזן אינו נכון. נותרו עוד ניסיונות.",
  access_code_expired: "תוקף הקוד פג. אפשר לבקש קוד חדש.",
  access_code_locked: "יותר מדי ניסיונות. אפשר לבקש קוד חדש בעוד כמה דקות.",
  access_code_missing: "לא נמצא קוד פעיל. אפשר לבקש קוד חדש.",
  access_link_invalid: "הקישור אינו תקף או שפג תוקפו. אפשר להיכנס עם הטלפון או האימייל שמסרת.",
  access_rate_limited: "יותר מדי בקשות מהמכשיר הזה. אפשר לנסות שוב בעוד כמה דקות.",
  access_session_required: "צריך להיכנס כדי לראות את התיק.",
  access_case_not_yours: "התיק הזה אינו שייך לזהות שנכנסה.",
  access_resend_limited: "שלחנו את הקישור כמה פעמים. אם הוא לא הגיע, אפשר להיכנס דרך /login.",
  access_send_failed: "לא הצלחנו לשלוח את ההודעה עכשיו. התיק נשמר; אפשר לנסות לשלוח שוב.",
  // Funnel (U5–U8)
  case_not_found: "לא נמצא תיק בדיקה בדפדפן הזה. אפשר להתחיל בדיקה חדשה.",
  case_status_unavailable: "לא הצלחנו לטעון את סטטוס הבדיקה. אפשר לבדוק שוב.",
  case_create_failed: "לא הצלחנו לפתוח את הבדיקה כרגע. אפשר לנסות שוב בעוד רגע.",
  upload_prepare_failed: "הכנת ההעלאה נכשלה. אפשר לנסות שוב.",
  upload_transfer_failed: "העלאת הקובץ נכשלה. אפשר לבדוק את החיבור ולנסות שוב.",
  upload_complete_failed: "שמירת הקבצים נכשלה. אפשר לנסות שוב.",
  payment_start_failed: "לא הצלחנו לפתוח את עמוד התשלום. אפשר לנסות שוב.",
  network_failed: "החיבור נכשל. אפשר לבדוק את הרשת ולנסות שוב.",
  unknown: "משהו השתבש. אפשר לנסות שוב.",
});

export type CustomerErrorCode = keyof typeof CUSTOMER_ERROR_COPY;

const HEBREW = /[֐-׿]/u;
const TECHNICAL = /(?:error|exception|failed|invalid|undefined|null|\bat\b|http|status|json|token|supabase|postgres)/iu;

/**
 * The sentence a customer sees for a failed call. `code` wins; a Hebrew
 * message from the product's own API passes through unless it reads as
 * technical; everything else falls back to the given code's copy.
 */
export function customerErrorMessage(
  input: Readonly<{ code?: unknown; error?: unknown }>,
  fallback: CustomerErrorCode = "unknown",
): string {
  if (typeof input.code === "string" && input.code in CUSTOMER_ERROR_COPY) return CUSTOMER_ERROR_COPY[input.code]!;
  if (typeof input.error === "string" && HEBREW.test(input.error) && !TECHNICAL.test(input.error)) return input.error;
  return CUSTOMER_ERROR_COPY[fallback]!;
}

/** Reads `{ error, code }` out of a failed fetch response body, tolerating bodies that are not JSON. */
export async function customerErrorFromResponse(response: Response, fallback: CustomerErrorCode): Promise<string> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return customerErrorMessage({ code: record.code, error: record.error }, fallback);
}
