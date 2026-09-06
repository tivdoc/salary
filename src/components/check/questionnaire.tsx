"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, LockKey, Timer } from "@phosphor-icons/react";
import { trackEvent } from "@/lib/analytics";
import { useFunnelProgress } from "./funnel-progress";
import { customerErrorFromResponse, customerErrorMessage } from "@/lib/customer-copy";
import { currentFirstTouch } from "@/lib/attribution";
import { metaEventDescriptor, trackMetaBrowserEventOnce } from "@/lib/meta-browser";
import { questionnaireSchema } from "@/lib/validation";
import { AccessChallenge } from "@/components/case/access-challenge";
import { productOffer } from "@/lib/product-offer";

type FormState = {
  stillEmployed: boolean | null;
  salaryType: "monthly" | "hourly" | null;
  typicalHoursPerDay: string;
  workDaysPerWeek: string;
  worksFriday: boolean | null;
  worksSaturday: boolean | null;
  payslipAvailable: boolean | null;
  suspectedIssue: string;
  firstName: string;
  phone: string;
  email: string;
  employmentStartMonth: string;
  birthYear: string;
  sex: "female" | "male" | "unspecified" | null;
  hadPensionFundAtHire: boolean | null;
  employerProvidesTransport: boolean | null;
  commuteOver500m: boolean | null;
  managerialOrTrustRole: boolean | null;
};

const DRAFT_KEY = "tivdoc:questionnaire-draft:v2";
const CONTACT_DRAFT_KEY = "tivdoc:questionnaire-contact:v2";
// S4 / funnel-adversarial finding: "open a new check" survives a refresh.
// Without this the banner returns on reload and the next click resumes the
// old case, which is the opposite of what the person just chose.
const RESUME_DISMISSED_KEY = "tivdoc:resume-dismissed";

const initialForm: FormState = {
  stillEmployed: null,
  salaryType: null,
  typicalHoursPerDay: "",
  workDaysPerWeek: "",
  worksFriday: null,
  worksSaturday: null,
  payslipAvailable: null,
  suspectedIssue: "",
  firstName: "",
  phone: "",
  email: "",
  // S3.1: the engine's own inputs. Each one decides whether a topic can be
  // checked at all — without them the report refuses instead of answering.
  employmentStartMonth: "",
  birthYear: "",
  sex: null,
  hadPensionFundAtHire: null,
  employerProvidesTransport: null,
  commuteOver500m: null,
  managerialOrTrustRole: null,
};

// S4 (2.8). What a contact field is checked for on blur, in the customer's own
// words. Deliberately forgiving: the point is to catch the typo that loses the
// case, not to argue with an unusual but real address or number.
function phoneProblem(value: string): string {
  const digits = value.replace(/\D/gu, "");
  if (digits.length === 0) return "צריך טלפון — לשם נשלח קוד הכניסה לתיק.";
  return digits.length >= 9 && digits.length <= 15 ? "" : "המספר נראה קצר או ארוך מדי. אפשר לבדוק שוב?";
}

function emailProblem(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "צריך אימייל — לשם נשלח הקישור לתיק.";
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u.test(trimmed) ? "" : "הכתובת לא נראית תקינה. אפשר לבדוק שוב?";
}

const stepTitles = [
  ["האם עדיין עובדים אצל אותו מעסיק?", "שאלה קצרה כדי להבין את מצב ההעסקה הנוכחי."],
  ["איך השכר מוגדר?", "אין צורך לדעת כרגע את הסכום המדויק."],
  ["כמה שעות עובדים ביום רגיל?", "בחרו את האפשרות הקרובה ביותר."],
  ["איך נראה שבוע העבודה?", "מספיק אומדן. את הפרטים המדויקים נראה במסמכים."],
  ["מתי התחלת, ומה התפקיד?", "הוותק קובע ימי חופשה והבראה; התפקיד קובע אם חוק שעות העבודה חל עליך."],
  ["עוד שתי שאלות קצרות", "גיל קובע שכר מינימום לנוער; פנסיה ונסיעות נקבעות לפי מה שתסמן כאן."],
  ["יש תלוש שאפשר לצלם או להעלות?", "PDF או צילום ברור מהטלפון — שניהם מתאימים."],
  ["מה גרם לכם לבדוק?", "לא חובה. משפט קצר יכול לעזור לנו להבין איפה להסתכל."],
  ["לאן לקשר את הבדיקה?", "הפרטים נשמרים באופן פרטי ולא נשלחים למעסיק."],
] as const;

function OptionButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={selected ? "option-button is-selected" : "option-button"}
      type="button"
      aria-pressed={selected}
      onClick={onClick}
    >
      {selected && <Check weight="bold" aria-hidden="true" />}
      {children}
    </button>
  );
}

function nonPersonalDraft(form: FormState, step: number) {
  const { firstName: _firstName, phone: _phone, email: _email, ...answers } = form;
  void _firstName;
  void _phone;
  void _email;
  return { form: answers, step };
}

export function Questionnaire() {
  const router = useRouter();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { reportSubstep } = useFunnelProgress();
  const started = useRef(false);
  const hydrated = useRef(false);
  const [step, setStep] = useState(0);
  // Review 2.8: a field says what is wrong when you leave it, not when you submit.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const setFieldError = (field: string, message: string) =>
    setFieldErrors((current) => ({ ...current, [field]: message }));
  const [form, setForm] = useState<FormState>(initialForm);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [activeCase, setActiveCase] = useState<string | null>(null);
  // External review #1, finding 1: the contact is verified by a code before any document binds and before any payment.
  const [verification, setVerification] = useState<{ to: string | null; channel: "email" | "phone" | null } | null>(null);
  const [caseCreated, setCaseCreated] = useState(false);

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null") as {
          form?: Partial<FormState>;
          step?: number;
        } | null;
        const contact = JSON.parse(sessionStorage.getItem(CONTACT_DRAFT_KEY) || "null") as
          | Pick<FormState, "firstName" | "phone" | "email">
          | null;
        if (saved?.form) {
          setForm((current) => ({ ...current, ...saved.form, ...(contact || {}) }));
        }
        if (Number.isInteger(saved?.step)) {
          setStep(Math.min(Math.max(saved?.step ?? 0, 0), stepTitles.length - 1));
        }
      } catch {
        localStorage.removeItem(DRAFT_KEY);
        sessionStorage.removeItem(CONTACT_DRAFT_KEY);
      }
      hydrated.current = true;
    });

    // UX Run 1 / U6: an active check is offered, never forced. A paying customer opening a second check
    // (another employer, another period) is a second case; the first is not disturbed.
    void fetch("/api/cases/resume", { cache: "no-store" })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((result) => {
        if (result?.contactVerified === false) {
          // A case exists in this browser whose contact was never verified: the verification step is where it resumes.
          setCaseCreated(true);
          if (new URLSearchParams(window.location.search).get("verify") === "1") void requestVerification();
          else setActiveCase("/check?verify=1");
          return;
        }
        if (sessionStorage.getItem(RESUME_DISMISSED_KEY) === "1") return;
        if (typeof result?.resumePath === "string") setActiveCase(result.resumePath);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(nonPersonalDraft(form, step)));
    sessionStorage.setItem(
      CONTACT_DRAFT_KEY,
      JSON.stringify({ firstName: form.firstName, phone: form.phone, email: form.email }),
    );
  }, [form, step]);

  useEffect(() => {
    trackEvent("questionnaire_step_viewed", { step_number: step + 1 });
    // S4 (2.1): the header's indicator and this event read the same number, so
    // what the customer sees and what the funnel measures cannot drift apart.
    reportSubstep({ index: step + 1, count: stepTitles.length });
    return () => reportSubstep(null);
  }, [step, reportSubstep]);

  function markStarted() {
    if (started.current) return;
    started.current = true;
    trackEvent("questionnaire_started");
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    markStarted();
    setForm((current) => ({ ...current, [key]: value }));
    setError("");
  }

  function validateCurrentStep() {
    if (step === 0 && form.stillEmployed === null) return "צריך לבחור תשובה כדי להמשיך.";
    if (step === 1 && !form.salaryType) return "צריך לבחור איך השכר מוגדר.";
    if (step === 2 && !form.typicalHoursPerDay) return "צריך לבחור מספר שעות משוער.";
    if (
      step === 3
      && (!form.workDaysPerWeek || form.worksFriday === null || form.worksSaturday === null)
    ) {
      return "צריך להשלים את ימי העבודה ושאלות שישי ושבת.";
    }
    // S3.1: the engine inputs. A missing one here becomes a refusal later, so it is
    // cheaper for everyone to ask now than to open a blocking request afterwards.
    if (step === 4 && (!form.employmentStartMonth || form.managerialOrTrustRole === null)) {
      return "צריך למלא את חודש תחילת העבודה ולסמן אם התפקיד ניהולי.";
    }
    if (step === 5 && (!form.birthYear || form.sex === null || form.hadPensionFundAtHire === null
      || form.employerProvidesTransport === null || (form.employerProvidesTransport === false && form.commuteOver500m === null))) {
      return "צריך להשלים את שנת הלידה, המין, הפנסיה והנסיעות.";
    }
    if (step === 6 && form.payslipAvailable === null) {
      return "צריך לבחור אם יש תלוש זמין.";
    }
    if (step === 8 && (!form.firstName.trim() || !form.phone.trim() || !form.email.trim())) {
      return "צריך למלא שם, טלפון ואימייל כדי לפתוח את הבדיקה.";
    }
    return "";
  }

  function moveTo(next: number) {
    setStep(next);
    setError("");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    // S4 (4.1). Without this, the whole question changes while focus stays on
    // the button that was pressed: a keyboard or screen-reader user is told
    // nothing and has to hunt for what moved. Focusing the new heading is also
    // why the progress bar needs no aria-live.
    requestAnimationFrame(() => headingRef.current?.focus());
  }

  function nextStep() {
    markStarted();
    const validationError = validateCurrentStep();
    if (validationError) {
      setError(validationError);
      return;
    }
    trackEvent("questionnaire_step_completed", { step_number: step + 1 });
    moveTo(Math.min(stepTitles.length - 1, step + 1));
  }

  async function requestVerification(contact?: string) {
    setError("");
    try {
      const response = await fetch("/api/cases/access/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(contact ? { funnel: true, contact, channel: "email" } : { funnel: true }),
      });
      if (!response.ok) throw new Error(await customerErrorFromResponse(response, "access_send_failed"));
      const result = (await response.json()) as { to?: string | null; channel?: "email" | "phone" | null; already_verified?: boolean };
      if (result.already_verified) {
        router.push("/check/upload");
        return;
      }
      setActiveCase(null);
      setVerification({ to: result.to ?? null, channel: result.channel ?? null });
    } catch (caught) {
      setError(customerErrorMessage({ error: caught instanceof Error ? caught.message : null }, "access_send_failed"));
      setSubmitting(false);
    }
  }

  async function submit() {
    markStarted();
    if (caseCreated) {
      // The contact fields were corrected after the case was opened: the case's contact is replaced (while unverified) and a code goes to it.
      if (!form.email.trim()) { setError("צריך אימייל כדי לשלוח קוד."); return; }
      setSubmitting(true);
      await requestVerification(form.email.trim());
      setSubmitting(false);
      return;
    }
    const validationError = validateCurrentStep();
    if (validationError) {
      setError(validationError);
      return;
    }

    const attribution = currentFirstTouch();
    // When the employer provides transport the distance question is never shown, and it
    // has no meaning: there is no travel entitlement to measure. It is recorded as false
    // rather than left unset, so the fact is present and answered rather than missing.
    const commuteOver500m = form.employerProvidesTransport === true ? false : form.commuteOver500m;
    const parsed = questionnaireSchema.safeParse({ ...form, commuteOver500m, attribution });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message || "יש פרט שדורש תיקון לפני שממשיכים.");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (!response.ok) throw new Error(await customerErrorFromResponse(response, "case_create_failed"));
      const result = await response.json();
      sessionStorage.setItem("tivdoc-public-id", result.publicId);
      localStorage.setItem("tivdoc:active-case", result.publicId);
      localStorage.removeItem(DRAFT_KEY);
      sessionStorage.removeItem(CONTACT_DRAFT_KEY);
      const metaEvent = metaEventDescriptor(result.metaEvent);
      if (metaEvent) trackMetaBrowserEventOnce(metaEvent);
      trackEvent("questionnaire_step_completed", { step_number: step + 1 });
      trackEvent("questionnaire_completed");
      setCaseCreated(true);
      // S4 / funnel-adversarial finding. The funnel keeps one case per browser
      // in a cookie. Two tabs each finishing a questionnaire means the second
      // one's case replaces the first's in that cookie — and the verification
      // request that follows reads the cookie, so the first tab would send a
      // code for a case it did not create and link the wrong contact.
      //
      // The case id is NOT sent from here to fix it: a client that could name
      // the case to verify could name anyone's. Instead this asks the server
      // which case the cookie now holds and stops if it is not the one just
      // created, which is a check the client is allowed to make.
      const holder = await fetch("/api/cases/resume", { cache: "no-store" })
        .then(async (response) => (response.ok ? await response.json() as { publicId?: string } : null))
        .catch(() => null);
      if (holder?.publicId && holder.publicId !== result.publicId) {
        setError("נפתחה בדיקה נוספת בחלון אחר של הדפדפן, והיא זו שפעילה כרגע. הבדיקה הזו נשמרה — אפשר לסגור את החלון האחר ולרענן כדי להמשיך בה.");
        setSubmitting(false);
        return;
      }
      await requestVerification();
      setSubmitting(false);
    } catch (caught) {
      setError(customerErrorMessage({ error: caught instanceof Error ? caught.message : null }, "case_create_failed"));
      setSubmitting(false);
    }
  }

  if (verification) {
    return (
      <div className="questionnaire">
        <AccessChallenge
          mode="funnel"
          publicId={null}
          maskedTo={verification.to}
          channel={verification.channel}
          codeTtlMinutes={productOffer().access.code_ttl_minutes}
          onVerified={(next) => router.push(next)}
          onChangeContact={() => { setVerification(null); setStep(6); }}
        />
      </div>
    );
  }

  return (
    <div className="questionnaire" onFocusCapture={markStarted}>
      {activeCase && (
        <div className="check-resume-banner" role="status">
          <b>יש לך בדיקה פעילה.</b>
          <span>אפשר להמשיך אותה מהמקום שבו עצרת, או לפתוח בדיקה חדשה — למשל למעסיק אחר או לתקופה אחרת. הבדיקה הקיימת נשמרת.</span>
          <div className="check-resume-banner__actions">
            <button type="button" className="button button--primary" onClick={() => router.push(activeCase)}>המשך אליה</button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                try { sessionStorage.setItem(RESUME_DISMISSED_KEY, "1"); } catch { /* a private window still dismisses for this render */ }
                setActiveCase(null);
              }}
            >פתח בדיקה חדשה</button>
          </div>
        </div>
      )}
      {/* S4 (2.1): no bar and no counter here — the header carries the funnel's
          one indicator, and this screen reports its position to it. */}
      <div className="questionnaire__heading">
        <h1 id="questionnaire-step-title" ref={headingRef} tabIndex={-1}>{stepTitles[step][0]}</h1>
        <p>{stepTitles[step][1]}</p>
      </div>

      <div className="questionnaire__body">
        {step === 0 && (
          <div className="option-row" role="group" aria-labelledby="questionnaire-step-title">
            <OptionButton selected={form.stillEmployed === true} onClick={() => update("stillEmployed", true)}>כן</OptionButton>
            <OptionButton selected={form.stillEmployed === false} onClick={() => update("stillEmployed", false)}>לא</OptionButton>
          </div>
        )}

        {step === 1 && (
          <div className="option-row" role="group" aria-labelledby="questionnaire-step-title">
            <OptionButton selected={form.salaryType === "monthly"} onClick={() => update("salaryType", "monthly")}>חודשי</OptionButton>
            <OptionButton selected={form.salaryType === "hourly"} onClick={() => update("salaryType", "hourly")}>שעתי</OptionButton>
          </div>
        )}

        {step === 2 && (
          <div className="option-row option-row--four" role="group" aria-labelledby="questionnaire-step-title">
            {["8", "9", "10", "11"].map((hours) => (
              <OptionButton
                key={hours}
                selected={form.typicalHoursPerDay === hours}
                onClick={() => update("typicalHoursPerDay", hours)}
              >
                <bdi dir="ltr">{hours === "11" ? "11+" : hours}</bdi>
              </OptionButton>
            ))}
          </div>
        )}

        {step === 3 && (
          <div className="form-stack">
            <fieldset className="field-group">
              <legend>כמה ימים בשבוע?</legend>
              <div className="option-row option-row--three">
                {["5", "6", "7"].map((days) => (
                  <OptionButton
                    key={days}
                    selected={form.workDaysPerWeek === days}
                    onClick={() => update("workDaysPerWeek", days)}
                  >
                    {days}
                  </OptionButton>
                ))}
              </div>
            </fieldset>
            <div className="form-grid">
              <fieldset className="field-group">
                <legend>עבודה בשישי?</legend>
                <div className="option-row">
                  <OptionButton selected={form.worksFriday === true} onClick={() => update("worksFriday", true)}>כן</OptionButton>
                  <OptionButton selected={form.worksFriday === false} onClick={() => update("worksFriday", false)}>לא</OptionButton>
                </div>
              </fieldset>
              <fieldset className="field-group">
                <legend>עבודה בשבת?</legend>
                <div className="option-row">
                  <OptionButton selected={form.worksSaturday === true} onClick={() => update("worksSaturday", true)}>כן</OptionButton>
                  <OptionButton selected={form.worksSaturday === false} onClick={() => update("worksSaturday", false)}>לא</OptionButton>
                </div>
              </fieldset>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="form-stack">
            <label className="field">
              <span>חודש ושנה של תחילת העבודה</span>
              <input
                type="month"
                value={form.employmentStartMonth}
                max={new Date().toISOString().slice(0, 7)}
                onChange={(event) => update("employmentStartMonth", event.target.value)}
                aria-invalid={fieldErrors.employmentStartMonth ? true : undefined}
                aria-describedby={fieldErrors.employmentStartMonth ? "error-employmentStartMonth" : undefined}
                onBlur={(event) => setFieldError("employmentStartMonth", event.target.value ? "" : "צריך לבחור חודש ושנה")}
              />
              {fieldErrors.employmentStartMonth ? <small className="field-error" id="error-employmentStartMonth" role="alert">{fieldErrors.employmentStartMonth}</small> : null}
            </label>
            <fieldset className="field-group">
              <legend>התפקיד ניהולי, או דורש מידה מיוחדת של אמון אישי?</legend>
              <div className="option-row">
                <OptionButton selected={form.managerialOrTrustRole === true} onClick={() => update("managerialOrTrustRole", true)}>כן</OptionButton>
                <OptionButton selected={form.managerialOrTrustRole === false} onClick={() => update("managerialOrTrustRole", false)}>לא</OptionButton>
              </div>
              <small>אם כן — לפי סעיף 30(א) חוק שעות עבודה ומנוחה אינו חל, והדוח יאמר זאת במקום לבדוק שעות.</small>
            </fieldset>
          </div>
        )}

        {step === 5 && (
          <div className="form-stack">
            <div className="form-grid">
              <label className="field">
                <span>שנת לידה</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1940}
                  max={new Date().getFullYear() - 14}
                  value={form.birthYear}
                  onChange={(event) => update("birthYear", event.target.value)}
                  aria-invalid={fieldErrors.birthYear ? true : undefined}
                  aria-describedby={fieldErrors.birthYear ? "error-birthYear" : undefined}
                  onBlur={(event) => setFieldError("birthYear", /^\d{4}$/u.test(event.target.value) ? "" : "צריך שנה בת ארבע ספרות")}
                />
                {fieldErrors.birthYear ? <small className="field-error" id="error-birthYear" role="alert">{fieldErrors.birthYear}</small> : null}
              </label>
              <fieldset className="field-group">
                <legend>מין</legend>
                <div className="option-row option-row--three">
                  <OptionButton selected={form.sex === "female"} onClick={() => update("sex", "female")}>אישה</OptionButton>
                  <OptionButton selected={form.sex === "male"} onClick={() => update("sex", "male")}>גבר</OptionButton>
                  <OptionButton selected={form.sex === "unspecified"} onClick={() => update("sex", "unspecified")}>מעדיף/ה לא לציין</OptionButton>
                </div>
              </fieldset>
            </div>
            <fieldset className="field-group">
              <legend>כשהתחלת לעבוד, כבר הייתה לך קרן פנסיה?</legend>
              <div className="option-row">
                <OptionButton selected={form.hadPensionFundAtHire === true} onClick={() => update("hadPensionFundAtHire", true)}>כן</OptionButton>
                <OptionButton selected={form.hadPensionFundAtHire === false} onClick={() => update("hadPensionFundAtHire", false)}>לא</OptionButton>
              </div>
              <small>קובע מתי מתחילה חובת ההפרשה.</small>
            </fieldset>
            <fieldset className="field-group">
              <legend>המעסיק מספק הסעה?</legend>
              <div className="option-row">
                <OptionButton selected={form.employerProvidesTransport === true} onClick={() => update("employerProvidesTransport", true)}>כן</OptionButton>
                <OptionButton selected={form.employerProvidesTransport === false} onClick={() => update("employerProvidesTransport", false)}>לא</OptionButton>
              </div>
            </fieldset>
            {form.employerProvidesTransport === false ? (
              <fieldset className="field-group">
                <legend>המרחק מהבית לעבודה מעל 500 מטר?</legend>
                <div className="option-row">
                  <OptionButton selected={form.commuteOver500m === true} onClick={() => update("commuteOver500m", true)}>כן</OptionButton>
                  <OptionButton selected={form.commuteOver500m === false} onClick={() => update("commuteOver500m", false)}>לא</OptionButton>
                </div>
              </fieldset>
            ) : null}
          </div>
        )}

        {step === 6 && (
          <div className="form-stack">
            <div className="option-row" role="group" aria-labelledby="questionnaire-step-title">
              <OptionButton selected={form.payslipAvailable === true} onClick={() => update("payslipAvailable", true)}>כן, יש לי</OptionButton>
              <OptionButton selected={form.payslipAvailable === false} onClick={() => update("payslipAvailable", false)}>אמצא אחר כך</OptionButton>
            </div>
            <div className="form-summary">
              <b>המסמך נשמר באזור פרטי.</b>
              <p>אין קישור ציבורי לקובץ, והוא לא נשלח למעסיק.</p>
            </div>
          </div>
        )}

        {step === 7 && (
          <label className="field">
            <span>אפשר לכתוב כאן — או פשוט להמשיך</span>
            <textarea
              rows={5}
              value={form.suspectedIssue}
              onChange={(event) => update("suspectedIssue", event.target.value)}
              placeholder="למשל: השעות הנוספות לא נראות לי נכונות"
            />
          </label>
        )}

        {step === 8 && (
          <div className="form-stack">
            <div className="form-grid">
              <label className="field">
                <span>שם פרטי</span>
                <input
                  autoComplete="given-name"
                  value={form.firstName}
                  aria-invalid={fieldErrors.firstName ? true : undefined}
                  aria-describedby={fieldErrors.firstName ? "error-firstName" : undefined}
                  onChange={(event) => update("firstName", event.target.value)}
                  onBlur={(event) => setFieldError("firstName", event.target.value.trim() ? "" : "צריך שם פרטי כדי לפנות אליך.")}
                />
                {fieldErrors.firstName ? <small className="field-error" id="error-firstName" role="alert">{fieldErrors.firstName}</small> : null}
              </label>
              <label className="field">
                <span>טלפון</span>
                <input
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  dir="ltr"
                  value={form.phone}
                  aria-invalid={fieldErrors.phone ? true : undefined}
                  aria-describedby={fieldErrors.phone ? "error-phone" : undefined}
                  onChange={(event) => update("phone", event.target.value)}
                  onBlur={(event) => setFieldError("phone", phoneProblem(event.target.value))}
                />
                {fieldErrors.phone ? <small className="field-error" id="error-phone" role="alert">{fieldErrors.phone}</small> : null}
              </label>
              <label className="field field--wide">
                <span>אימייל</span>
                <input
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  dir="ltr"
                  value={form.email}
                  aria-invalid={fieldErrors.email ? true : undefined}
                  aria-describedby={fieldErrors.email ? "error-email" : undefined}
                  onChange={(event) => update("email", event.target.value)}
                  onBlur={(event) => setFieldError("email", emailProblem(event.target.value))}
                />
                {fieldErrors.email ? <small className="field-error" id="error-email" role="alert">{fieldErrors.email}</small> : null}
              </label>
            </div>
            <div className="questionnaire__trust">
              <span><LockKey weight="duotone" aria-hidden="true" /> פרטי ומאובטח</span>
              <span><Timer weight="duotone" aria-hidden="true" /> נשלח קוד אימות, ואז מעלים תלוש</span>
            </div>
          </div>
        )}
      </div>

      {error && <div className="form-error" role="alert">{error}</div>}

      <div className="questionnaire__actions">
        {step > 0 ? (
          <button className="button button--secondary" type="button" onClick={() => moveTo(step - 1)}>
            <ArrowRight aria-hidden="true" /> חזרה
          </button>
        ) : <span />}
        {step < stepTitles.length - 1 ? (
          <button className="button button--primary" type="button" onClick={nextStep}>
            המשך <ArrowLeft aria-hidden="true" />
          </button>
        ) : (
          <button className="button button--primary" type="button" disabled={submitting} onClick={submit}>
            {submitting ? (caseCreated ? "שולחים קוד..." : "פותחים את הבדיקה...") : caseCreated ? "עדכון ושליחת קוד" : "פתיחת תיק ושליחת קוד אימות"}
            <ArrowLeft aria-hidden="true" />
          </button>
        )}
      </div>
      <p className="questionnaire__saved">התשובות נשמרות בדפדפן אם צריך לעצור ולחזור.</p>
    </div>
  );
}
