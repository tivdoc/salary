// UX Run 1 / U9 (D-4.3, D-7.3). The one configuration source for price,
// currency, delivery estimate and access limits. Components render what this
// returns; analytics events carry what this returns; nothing else holds a
// figure. The JSON file is the configuration; this module only validates it,
// so a client component and a server route read the very same values.
import { z } from "zod";
import offerJson from "../config/product-offer.json" with { type: "json" };

const moneySchema = z.object({
  amount: z.string().regex(/^\d+\.\d{2}$/u),
  currency: z.literal("ILS"),
  default: z.boolean().optional(),
}).strict();

const durationSchema = z.object({
  value: z.number().int().positive(),
  unit: z.enum(["minutes", "hours", "business_days"]),
  default: z.boolean().optional(),
}).strict();

export const productOfferSchema = z.object({
  schema_version: z.literal("tivdoc-product-offer-v1"),
  note: z.string(),
  currency: z.literal("ILS"),
  initial_check: z.object({
    price: moneySchema,
    delivery: z.object({ automatic: durationSchema, human: durationSchema }).strict(),
  }).strict(),
  full_report: z.object({ price: moneySchema, delivery: durationSchema }).strict(),
  second_product_sentence: z.string().min(20),
  access: z.object({
    // External review #1, finding 8: the path token lives hours, not days; the session keeps its thirty days.
    link_token_ttl_hours: z.number().int().positive(),
    challenge_cookie_minutes: z.number().int().positive(),
    code_ttl_minutes: z.number().int().positive(),
    code_max_attempts: z.number().int().min(1).max(10),
    session_ttl_days: z.number().int().positive(),
    session_roll_after_hours: z.number().int().positive(),
    request_limit_per_identity: z.number().int().positive(),
    request_limit_per_ip: z.number().int().positive(),
    request_window_minutes: z.number().int().positive(),
    resend_limit_per_case: z.number().int().positive(),
    default: z.boolean().optional(),
  }).strict(),
  verification_wait: z.object({
    poll_interval_seconds: z.number().int().positive(),
    named_state_after_seconds: z.number().int().positive(),
  }).strict(),
  contact: z.object({
    support_email: z.string().email().nullable(),
    // Long run 9 / 1.4: the local-format number, for display and tel: links; `whatsapp` stays the
    // international format wa.me needs. The same physical line, two renderings, both configuration.
    phone: z.string().regex(/^0[0-9]{8,9}$/u).nullable(),
    whatsapp: z.string().regex(/^\+?[0-9]{9,15}$/u).nullable(),
  }).strict(),
}).strict();

export type ProductOffer = z.infer<typeof productOfferSchema>;

let cached: ProductOffer | null = null;

/** The validated offer. Parsed once; a malformed file fails the first read loudly rather than rendering a wrong price. */
export function productOffer(): ProductOffer {
  if (cached === null) cached = productOfferSchema.parse(offerJson);
  return cached;
}

/** The initial check's price as a number, for the payment provider and the analytics `value`. */
export function initialCheckPriceNumber(): number {
  return Number(productOffer().initial_check.price.amount);
}

/** "9.99 ₪" — the one rendering of the price every screen uses. */
export function formatPrice(money: Readonly<{ amount: string; currency: string }>): string {
  const amount = money.amount.endsWith(".00") ? money.amount.slice(0, -3) : money.amount;
  return `${amount} ₪`;
}

/** "15 דקות" / "יום עסקים אחד" / "3 ימי עסקים" — the delivery estimate in Hebrew. */
export function formatDuration(duration: Readonly<{ value: number; unit: "minutes" | "hours" | "business_days" }>): string {
  if (duration.unit === "minutes") return duration.value === 1 ? "דקה אחת" : `${duration.value} דקות`;
  if (duration.unit === "hours") return duration.value === 1 ? "שעה אחת" : `${duration.value} שעות`;
  return duration.value === 1 ? "יום עסקים אחד" : `${duration.value} ימי עסקים`;
}
