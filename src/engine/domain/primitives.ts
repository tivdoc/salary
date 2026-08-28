import { z } from "zod";

export const uuidSchema = z.uuid();
export const isoDateSchema = z.iso.date();
export const isoTimestampSchema = z.iso.datetime({ offset: true });

export const domainCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/, "Must be a stable machine-readable code");

export const versionSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d*(?:\.\d+){0,2}$/, "Must be a numeric version such as 1 or 1.2.0");

export const confidenceSchema = z.number().min(0).max(1);

export const decimalStringSchema = z
  .string()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/, "Must be a canonical decimal string");

export const nonNegativeDecimalStringSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, "Must be a non-negative canonical decimal string");

export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, "Must be an ISO 4217 currency code");

/**
 * Monetary values are stored as integer minor units (agorot for ILS). This is
 * JSON-safe and prevents binary floating-point arithmetic in legal calculations.
 */
export const moneySchema = z
  .object({
    currency: currencyCodeSchema,
    minor_units: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const nonNegativeMoneySchema = moneySchema.refine((money) => money.minor_units >= 0, {
  message: "Monetary values in findings and employment facts cannot be negative",
  path: ["minor_units"],
});

export const dateRangeSchema = z
  .object({
    start_date: isoDateSchema,
    end_date: isoDateSchema.nullable(),
  })
  .strict()
  .refine(({ start_date, end_date }) => end_date === null || end_date >= start_date, {
    message: "End date cannot precede start date",
    path: ["end_date"],
  });

export const agentNameSchema = z.enum([
  "document_intelligence",
  "fact_resolver",
  "interview",
  "investigator",
  "legal_applicability",
  "report",
]);

export type Money = Readonly<z.infer<typeof moneySchema>>;
export type DateRange = Readonly<z.infer<typeof dateRangeSchema>>;
export type AgentName = z.infer<typeof agentNameSchema>;
