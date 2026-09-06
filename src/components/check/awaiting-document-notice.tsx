// Site S2.4. The line the upload screen shows a customer who already told us
// they did not have the payslip yet.
//
// It exists so the screen does not repeat the question. They answered it: "I'll
// find it later". What they need on arriving here is confirmation that nothing
// was lost, and the one date that actually constrains them — the request on the
// thread expires ten days after it opened (D-9), and after that the case stops
// waiting.

const DAY = 24 * 60 * 60 * 1000;

function daysLeft(expiresAt: string, now: Date): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / DAY));
}

export function AwaitingDocumentNotice({ expiresAt, now = new Date() }: { expiresAt: string; now?: Date }) {
  const left = daysLeft(expiresAt, now);
  return (
    <div className="form-summary" role="status">
      <b>התיק שלך שמור וממתין לתלוש.</b>
      <p>
        {left > 0
          ? `אפשר לצרף אותו עכשיו. הבקשה פתוחה בתיק עוד ${left} ימים, ואחריה הבדיקה לא תמתין יותר — אבל מה שמילאת נשמר.`
          : "הבקשה שהייתה פתוחה בתיק פגה. אפשר עדיין לצרף את התלוש כאן, והבדיקה תתחיל ממנו."}
      </p>
      <p>שלחנו קישור לצירוף גם לאמצעי הקשר שאימתת, כדי שלא תצטרך לזכור את הכתובת.</p>
    </div>
  );
}
