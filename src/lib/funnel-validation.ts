import { z } from "zod";

const nullableText = (max: number) => z.string().trim().max(max).nullable();

export const firstTouchSchema = z.object({
  funnelId: z.uuid(),
  utmSource: nullableText(200),
  utmMedium: nullableText(200),
  utmCampaign: nullableText(200),
  utmContent: nullableText(200),
  utmTerm: nullableText(200),
  fbclid: nullableText(512),
  fbp: nullableText(512),
  fbc: nullableText(512),
  gaClientId: nullableText(100),
  landingUrl: z.url().max(500),
  referrer: z.url().max(500).nullable(),
  firstTouchAt: z.iso.datetime(),
});

export const funnelEventSchema = z.object({
  attribution: firstTouchSchema,
  eventName: z.enum([
    "landing_view",
    "start_check",
    "questionnaire_started",
    "questionnaire_step_viewed",
    "questionnaire_step_completed",
    "questionnaire_completed",
    "case_created",
    "document_uploaded",
    "checkout_started",
    "payment_verified",
  ]),
  stepNumber: z.number().int().min(1).max(7).optional(),
  publicCaseId: z.string().regex(/^TV-[A-F0-9]{8}$/).optional(),
});
