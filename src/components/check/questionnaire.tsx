"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check } from "@phosphor-icons/react";
import { trackEvent } from "@/lib/analytics";
import { metaEventDescriptor, trackMetaBrowserEventOnce } from "@/lib/meta-browser";
import { questionnaireSchema } from "@/lib/validation";

type FormState = {
  firstName: string;
  phone: string;
  email: string;
  employmentStartDate: string;
  stillEmployed: boolean;
  salaryType: "monthly" | "hourly";
  statedSalary: string;
  typicalHoursPerDay: string;
  workDaysPerWeek: string;
  worksFriday: boolean;
  worksSaturday: boolean;
  breakMinutes: string;
  contractRole: string;
  actualRole: string;
  industry: string;
  bonuses: string;
  travelArrangement: string;
  pension: "yes" | "no" | "not_sure";
  attendanceReportAvailable: boolean;
  suspectedIssue: string;
};

const initialForm: FormState = {
  firstName: "",
  phone: "",
  email: "",
  employmentStartDate: "",
  stillEmployed: true,
  salaryType: "monthly",
  statedSalary: "",
  typicalHoursPerDay: "8",
  workDaysPerWeek: "5",
  worksFriday: false,
  worksSaturday: false,
  breakMinutes: "30",
  contractRole: "",
  actualRole: "",
  industry: "",
  bonuses: "",
  travelArrangement: "",
  pension: "not_sure",
  attendanceReportAvailable: false,
  suspectedIssue: "",
};

const stepTitles = [
  ["נתחיל בהיכרות קצרה.", "נשתמש בפרטים האלה כדי לקשר את המסמכים לבדיקה שלך."],
  ["מה כתוב על השכר?", "פרטי ההעסקה הבסיסיים עוזרים לנו להבין את נקודת ההתחלה."],
  ["איך שבוע העבודה באמת נראה?", "לא מה אמור לקרות. מה קורה ברוב השבועות."],
  ["חוזה לחוד, עבודה בפועל לחוד.", "כאן נכנס המידע שלא מופיע בשורות התלוש."],
  ["מה גרם לך לעצור ולבדוק?", "אפשר לכתוב חופשי. כל פרט קטן עשוי לעזור בבדיקה."],
];

function OptionButton({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={selected ? "option-button is-selected" : "option-button"} type="button" aria-pressed={selected} onClick={onClick}>
      {selected && <Check weight="bold" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Questionnaire() {
  const router = useRouter();
  const started = useRef(false);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(initialForm);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setError("");
    if (!started.current) {
      started.current = true;
      trackEvent("questionnaire_started");
    }
  }

  function validateCurrentStep() {
    if (step === 0 && (!form.firstName.trim() || !form.phone.trim() || !form.email.trim())) {
      return "צריך למלא שם, טלפון ואימייל כדי להמשיך.";
    }
    if (step === 1 && (!form.employmentStartDate || !form.statedSalary)) {
      return "צריך לבחור תאריך ולהזין את השכר שסוכם.";
    }
    if (step === 2 && (!form.typicalHoursPerDay || !form.workDaysPerWeek || form.breakMinutes === "")) {
      return "צריך להשלים את פרטי שבוע העבודה.";
    }
    if (step === 3 && (!form.contractRole.trim() || !form.actualRole.trim() || !form.industry.trim() || !form.travelArrangement.trim())) {
      return "צריך להשלים את פרטי התפקיד, התחום והנסיעות.";
    }
    if (step === 4 && form.suspectedIssue.trim().length < 10) {
      return "כדאי להוסיף לפחות משפט קצר על מה שנראה לא תקין.";
    }
    return "";
  }

  function nextStep() {
    const validationError = validateCurrentStep();
    if (validationError) {
      setError(validationError);
      return;
    }
    setStep((current) => Math.min(stepTitles.length - 1, current + 1));
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  }

  async function submit() {
    const validationError = validateCurrentStep();
    if (validationError) {
      setError(validationError);
      return;
    }

    const parsed = questionnaireSchema.safeParse(form);
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
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "פתיחת הבדיקה נכשלה");
      sessionStorage.setItem("tivdoc-public-id", result.publicId);
      const metaEvent = metaEventDescriptor(result.metaEvent);
      if (metaEvent) trackMetaBrowserEventOnce(metaEvent);
      trackEvent("questionnaire_completed");
      router.push("/check/upload");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "משהו השתבש. אפשר לנסות שוב.");
      setSubmitting(false);
    }
  }

  return (
    <div className="questionnaire" onFocusCapture={() => !started.current && update("firstName", form.firstName)}>
      <div className="questionnaire__heading">
        <span className="mono">{String(step + 1).padStart(2, "0")} / {String(stepTitles.length).padStart(2, "0")}</span>
        <h1>{stepTitles[step][0]}</h1>
        <p>{stepTitles[step][1]}</p>
      </div>

      <div className="questionnaire__body">
        {step === 0 && (
          <div className="form-grid">
            <label className="field"><span>שם פרטי</span><input autoComplete="given-name" value={form.firstName} onChange={(e) => update("firstName", e.target.value)} /></label>
            <label className="field"><span>טלפון</span><input type="tel" inputMode="tel" autoComplete="tel" dir="ltr" value={form.phone} onChange={(e) => update("phone", e.target.value)} /></label>
            <label className="field field--wide"><span>אימייל</span><input type="email" inputMode="email" autoComplete="email" dir="ltr" value={form.email} onChange={(e) => update("email", e.target.value)} /></label>
          </div>
        )}

        {step === 1 && (
          <div className="form-stack">
            <label className="field"><span>מתי התחלת לעבוד?</span><input type="date" dir="ltr" value={form.employmentStartDate} onChange={(e) => update("employmentStartDate", e.target.value)} /></label>
            <fieldset className="field-group"><legend>עדיין עובד/ת שם?</legend><div className="option-row"><OptionButton selected={form.stillEmployed} onClick={() => update("stillEmployed", true)}>כן</OptionButton><OptionButton selected={!form.stillEmployed} onClick={() => update("stillEmployed", false)}>לא</OptionButton></div></fieldset>
            <fieldset className="field-group"><legend>איך השכר מוגדר?</legend><div className="option-row"><OptionButton selected={form.salaryType === "monthly"} onClick={() => update("salaryType", "monthly")}>שכר חודשי</OptionButton><OptionButton selected={form.salaryType === "hourly"} onClick={() => update("salaryType", "hourly")}>שכר שעתי</OptionButton></div></fieldset>
            <label className="field"><span>{form.salaryType === "monthly" ? "השכר החודשי שסוכם" : "השכר לשעה שסוכם"}</span><div className="money-input"><input type="number" inputMode="decimal" min="1" value={form.statedSalary} onChange={(e) => update("statedSalary", e.target.value)} /><b>₪</b></div></label>
          </div>
        )}

        {step === 2 && (
          <div className="form-stack">
            <fieldset className="field-group"><legend>כמה שעות אתה באמת עובד ביום?</legend><div className="option-row option-row--four">{["8", "9", "10", "11"].map((hours) => <OptionButton key={hours} selected={form.typicalHoursPerDay === hours} onClick={() => update("typicalHoursPerDay", hours)}><bdi dir="ltr">{hours === "11" ? "11+" : hours}</bdi></OptionButton>)}</div></fieldset>
            <label className="field"><span>כמה ימים בשבוע?</span><input type="number" inputMode="numeric" min="1" max="7" value={form.workDaysPerWeek} onChange={(e) => update("workDaysPerWeek", e.target.value)} /></label>
            <div className="form-grid">
              <fieldset className="field-group"><legend>עבודה ביום שישי?</legend><div className="option-row"><OptionButton selected={form.worksFriday} onClick={() => update("worksFriday", true)}>כן</OptionButton><OptionButton selected={!form.worksFriday} onClick={() => update("worksFriday", false)}>לא</OptionButton></div></fieldset>
              <fieldset className="field-group"><legend>עבודה בשבת?</legend><div className="option-row"><OptionButton selected={form.worksSaturday} onClick={() => update("worksSaturday", true)}>כן</OptionButton><OptionButton selected={!form.worksSaturday} onClick={() => update("worksSaturday", false)}>לא</OptionButton></div></fieldset>
            </div>
            <label className="field"><span>משך הפסקה טיפוסית בדקות</span><input type="number" inputMode="numeric" min="0" max="300" value={form.breakMinutes} onChange={(e) => update("breakMinutes", e.target.value)} /></label>
          </div>
        )}

        {step === 3 && (
          <div className="form-stack">
            <label className="field"><span>התפקיד שכתוב בחוזה</span><input value={form.contractRole} onChange={(e) => update("contractRole", e.target.value)} /></label>
            <label className="field"><span>מה עושים בפועל?</span><textarea rows={4} value={form.actualRole} onChange={(e) => update("actualRole", e.target.value)} /></label>
            <label className="field"><span>תחום הפעילות של המעסיק</span><input value={form.industry} onChange={(e) => update("industry", e.target.value)} /></label>
            <label className="field"><span>בונוסים או עמלות (אם יש)</span><input value={form.bonuses} onChange={(e) => update("bonuses", e.target.value)} /></label>
            <label className="field"><span>איך מסודרות הנסיעות?</span><input value={form.travelArrangement} onChange={(e) => update("travelArrangement", e.target.value)} /></label>
            <fieldset className="field-group"><legend>מופרשת פנסיה?</legend><div className="option-row option-row--three"><OptionButton selected={form.pension === "yes"} onClick={() => update("pension", "yes")}>כן</OptionButton><OptionButton selected={form.pension === "no"} onClick={() => update("pension", "no")}>לא</OptionButton><OptionButton selected={form.pension === "not_sure"} onClick={() => update("pension", "not_sure")}>לא בטוח</OptionButton></div></fieldset>
            <fieldset className="field-group"><legend>יש דוח נוכחות?</legend><div className="option-row"><OptionButton selected={form.attendanceReportAvailable} onClick={() => update("attendanceReportAvailable", true)}>כן</OptionButton><OptionButton selected={!form.attendanceReportAvailable} onClick={() => update("attendanceReportAvailable", false)}>לא</OptionButton></div></fieldset>
          </div>
        )}

        {step === 4 && (
          <div className="form-stack">
            <label className="field"><span>מה גורם לך לחשוב שמשהו לא תקין?</span><textarea rows={8} value={form.suspectedIssue} onChange={(e) => update("suspectedIssue", e.target.value)} placeholder="למשל: אני נשאר כמעט כל יום שעה נוספת, אבל בתלוש מופיע סכום קבוע..." /></label>
            <div className="form-summary"><b>מה יקרה בהמשך?</b><p>נפתח תיק בדיקה, נבקש תלוש אחד לפחות ונעביר אותך לתשלום המאובטח של Invoice4u.</p></div>
          </div>
        )}
      </div>

      {error && <div className="form-error" role="alert">{error}</div>}

      <div className="questionnaire__actions">
        {step > 0 ? <button className="button button--secondary" type="button" onClick={() => { setStep((current) => current - 1); setError(""); }}><ArrowRight aria-hidden="true" /> חזרה</button> : <span />}
        {step < stepTitles.length - 1 ? <button className="button button--primary" type="button" onClick={nextStep}>המשך <ArrowLeft aria-hidden="true" /></button> : <button className="button button--primary" type="button" disabled={submitting} onClick={submit}>{submitting ? "פותחים את הבדיקה..." : "שמירה ומעבר למסמכים"}<ArrowLeft aria-hidden="true" /></button>}
      </div>
    </div>
  );
}
