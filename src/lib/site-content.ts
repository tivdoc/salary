// Site S5 (brief §4). The home page's content slots, validated once.
//
// The rule this file exists to enforce: a section that needs an asset the owner
// has not supplied, or data the funnel has not produced, is OMITTED. It is not
// filled with stock imagery, an AI-generated person, a placeholder name, or a
// number nobody can source. A slot goes from null to a value and the section
// appears — configuration, not code.
//
// Why the schema refuses an empty string: `""` is how a placeholder sneaks in.
// A slot is either absent (null) or a real value.
import { z } from "zod";
import contentJson from "../config/site-content.json" with { type: "json" };

const assetSchema = z.object({
  /** Path under /public, or an absolute https URL. */
  src: z.string().min(3),
  alt: z.string().min(3),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict().nullable();

const testimonialSchema = z.object({
  quote: z.string().min(10),
  /** A real person who consented. No initials-only, no invented names. */
  attribution: z.string().min(2),
  /** Where the consent is recorded, so a reader can check it exists. */
  consent_reference: z.string().min(3),
}).strict();

export const siteContentSchema = z.object({
  schema_version: z.literal("tivdoc-site-content-v1"),
  note: z.string(),
  assets: z.object({
    founder_photo: assetSchema,
    video: z.object({ src: z.string().min(3), poster: z.string().min(3), duration_seconds: z.number().int().positive() }).strict().nullable(),
    video_poster: assetSchema,
    payroll_controller_photo: assetSchema,
    checks_illustration: assetSchema,
  }).strict(),
  content: z.object({
    /** The founder's own words. Never model-written: an invented founder story is a placeholder person. */
    story: z.object({ paragraphs: z.array(z.string().min(20)).min(1), attribution: z.string().min(2) }).strict().nullable(),
    testimonials: z.array(testimonialSchema),
    /** D-11 funnel figures. Every number here must come from the funnel's own counters. */
    proof_strip: z.object({
      payslips_checked: z.number().int().nonnegative(),
      source: z.string().min(3),
      measured_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    }).strict().nullable(),
  }).strict(),
}).strict();

export type SiteContent = z.infer<typeof siteContentSchema>;

let cached: SiteContent | null = null;

export function siteContent(): SiteContent {
  if (cached === null) cached = siteContentSchema.parse(contentJson);
  return cached;
}

/** Which optional sections have what they need. The page asks this, never the raw config. */
export function sectionsAvailable(content: SiteContent = siteContent()) {
  return {
    proof_strip: content.content.proof_strip !== null,
    video: content.assets.video !== null,
    story: content.content.story !== null,
    testimonials: content.content.testimonials.length > 0,
    checks_illustration: content.assets.checks_illustration !== null,
    payroll_controller_photo: content.assets.payroll_controller_photo !== null,
  } as const;
}
