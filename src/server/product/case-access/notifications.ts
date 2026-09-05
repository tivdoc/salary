// UX Run 1 / U4. The one outbound channel a case has: the contact it gave.
// Three templates — the case link, the access code, and "the report is ready"
// (the site brief's addition, fired by report_published once the S3.2
// contract exists; until then from /operations by hand, in S6).
//
// There is no email or SMS provider in this repository, and this run adds
// none: the sender resolves a provider by configuration, and the only ones
// that exist are a file sink for the local runtime and tests (refused under a
// production or preview deployment) and "none", which fails every send in a
// recorded way so the received screen can offer a resend. A real provider is
// a configuration and an adapter later, not a change to any caller.
//
// The database row a send leaves carries the template, the channel, the
// provider, the outcome and a digest of the payload — never the payload: the
// token and the code exist in the message and nowhere else.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ContactChannel } from "./crypto.ts";

export type NotificationTemplate = "case_link" | "access_code" | "report_ready";

export type NotificationMessage = Readonly<{
  template: NotificationTemplate;
  channel: ContactChannel;
  to: string;
  subject: string;
  body: string;
}>;

export type NotificationOutcome = Readonly<{
  state: "sent" | "failed";
  provider: string;
  error_code: string | null;
  payload_sha256: string;
}>;

export type NotificationProvider = Readonly<{
  id: string;
  send(message: NotificationMessage): Promise<Readonly<{ ok: true } | { ok: false; error_code: string }>>;
}>;

export function renderCaseLink(input: Readonly<{ firstName: string | null; publicId: string; linkUrl: string; expiresInDays: number }>): Pick<NotificationMessage, "subject" | "body"> {
  const name = input.firstName ? ` ${input.firstName}` : "";
  return {
    subject: `Tivdoc — הקישור לתיק ${input.publicId}`,
    body: [
      `שלום${name},`,
      `התשלום אומת והבדיקה של תיק ${input.publicId} התקבלה.`,
      `הקישור לתיק שלך: ${input.linkUrl}`,
      `בפתיחת הקישור נשלח קוד בן 6 ספרות לערוץ הזה. הקישור תקף ${input.expiresInDays} ימים; אחריו אפשר להיכנס עם הטלפון או האימייל שמסרת.`,
      "Tivdoc בודקת, לא קובעת: הדוח מציג נקודות לבדיקה ורמת ודאות, לא קביעה משפטית.",
    ].join("\n"),
  };
}

export function renderAccessCode(input: Readonly<{ code: string; expiresInMinutes: number }>): Pick<NotificationMessage, "subject" | "body"> {
  return {
    subject: "Tivdoc — קוד כניסה",
    body: [
      `קוד הכניסה שלך: ${input.code}`,
      `הקוד תקף ${input.expiresInMinutes} דקות ומיועד לכניסה אחת. אם לא ביקשת קוד, אפשר להתעלם מההודעה.`,
    ].join("\n"),
  };
}

export function renderReportReady(input: Readonly<{ publicId: string; linkUrl: string }>): Pick<NotificationMessage, "subject" | "body"> {
  return {
    subject: `Tivdoc — הדוח לתיק ${input.publicId} מוכן`,
    body: [
      `הדוח הראשוני לתיק ${input.publicId} מוכן.`,
      `לצפייה: ${input.linkUrl}`,
      "הדוח מציג מה נבדק, מה לא נבדק ומדוע, ורמת ודאות לכל נקודה.",
    ].join("\n"),
  };
}

/** The local runtime's and the tests' inbox: one JSON line per message, in a path configuration names. Refused on a deployment. */
export function fileSinkProvider(sinkPath: string): NotificationProvider {
  return Object.freeze({
    id: "file_sink",
    async send(message: NotificationMessage) {
      const vercelEnv = process.env.VERCEL_ENV?.toLowerCase();
      if (process.env.VERCEL === "1" || vercelEnv === "production" || vercelEnv === "preview") return { ok: false as const, error_code: "sink_refused_on_deployment" };
      try {
        mkdirSync(path.dirname(sinkPath), { recursive: true });
        appendFileSync(sinkPath, `${JSON.stringify({ at: new Date().toISOString(), ...message })}\n`, "utf8");
        return { ok: true as const };
      } catch {
        return { ok: false as const, error_code: "sink_write_failed" };
      }
    },
  });
}

/** No provider is configured: every send fails, recorded, and the customer is offered a resend; payment verification is never blocked. */
export const noProvider: NotificationProvider = Object.freeze({
  id: "none",
  async send() {
    return { ok: false as const, error_code: "no_provider_configured" };
  },
});

let providerOverride: NotificationProvider | null = null;

export function installNotificationProviderForTests(provider: NotificationProvider | null): void {
  providerOverride = provider;
}

export function resolveNotificationProvider(): NotificationProvider {
  if (providerOverride) return providerOverride;
  const sink = process.env.TIVDOC_NOTIFY_SINK_PATH;
  if (sink) return fileSinkProvider(sink);
  return noProvider;
}

export function payloadDigest(message: NotificationMessage): string {
  return createHash("sha256").update(`${message.template}|${message.channel}|${message.to}|${message.subject}|${message.body}`, "utf8").digest("hex");
}

export async function sendNotification(message: NotificationMessage, provider: NotificationProvider = resolveNotificationProvider()): Promise<NotificationOutcome> {
  const digest = payloadDigest(message);
  const result = await provider.send(message);
  return result.ok
    ? { state: "sent", provider: provider.id, error_code: null, payload_sha256: digest }
    : { state: "failed", provider: provider.id, error_code: result.error_code, payload_sha256: digest };
}
