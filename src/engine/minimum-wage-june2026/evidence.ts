import { z } from 'zod';
import { evidenceReferenceSchema } from '../facts/contracts.ts';

const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const assertion = <T extends z.ZodType>(value: T) => z.object({
  status: z.enum(['confirmed', 'missing', 'conflicted']),
  value: value.nullable(),
  provenance: z.array(evidenceReferenceSchema).max(16),
}).strict().superRefine((entry, context) => {
  const assertedValue: unknown = Reflect.get(entry, 'value');
  if (entry.status === 'confirmed' && (assertedValue === null || entry.provenance.length === 0)) {
    context.addIssue({code: 'custom', message: 'Confirmed assessment requires a value and its evidence'});
  }
  if (entry.status === 'missing' && assertedValue !== null) {
    context.addIssue({code: 'custom', message: 'Missing assessment cannot carry an assumed value'});
  }
});

/** Classification is an explicit evidence-backed assertion. A label emitted by
 * OCR alone is never an approval of its legal substance. The ordinary-pay rule
 * is deliberately narrower than every possible remuneration arrangement. */
export const june2026ComponentClasses = [
  'base_salary', 'cost_of_living', 'fixed_work_supplement',
  'seniority', 'family', 'shift_premium', 'productivity_premium',
  'thirteenth_salary', 'annual_bonus', 'expense_reimbursement',
  'overtime', 'weekly_rest', 'paid_absence', 'unclassified',
] as const;

export const june2026ComponentSchema = z.object({
  component_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,119}$/u),
  classification: z.enum(june2026ComponentClasses),
  classification_status: z.enum(['confirmed', 'missing', 'conflicted']),
  classification_provenance: z.array(evidenceReferenceSchema).max(16),
  amount_minor: z.number().int().safe().nonnegative(),
  currency: z.literal('ILS'),
  version_id: z.uuid(),
  page: z.number().int().positive(),
  locator: z.string().trim().min(1).max(500),
}).strict().readonly();

export const june2026WageEvidenceSchema = z.object({
  schema_version: z.literal('tivdoc-june2026-minimum-wage-evidence-v1'),
  case_id: z.uuid(),
  analysis_run_id: z.uuid(),
  facts_snapshot_sha256: sha,
  documents: z.array(z.object({
    product_document_id: z.uuid(), version_id: z.uuid(), sha256: sha,
    page_count: z.number().int().positive().max(1000),
  }).strict()).min(1).max(32),
  applicability: z.object({
    age_18_entire_month: assertion(z.boolean()),
    sector: assertion(z.enum(['general_private', 'other'])),
    hours_rest_law_applies: assertion(z.boolean()),
    no_better_minimum_wage_arrangement: assertion(z.boolean()),
    no_adapted_minimum_wage: assertion(z.boolean()),
    regular_hours_exclude_absence_overtime_rest: assertion(z.boolean()),
  }).strict(),
  wage_components_complete: assertion(z.boolean()),
  components: z.array(june2026ComponentSchema).max(32),
}).strict().superRefine((evidence, context) => {
  if (new Set(evidence.documents.map(d => d.product_document_id)).size !== evidence.documents.length
      || new Set(evidence.documents.map(d => d.version_id)).size !== evidence.documents.length) {
    context.addIssue({code: 'custom', message: 'One exact version per document is required'});
  }
  if (new Set(evidence.components.map(c => c.component_id)).size !== evidence.components.length) {
    context.addIssue({code: 'custom', message: 'Component IDs must be unique'});
  }
  // Two OCR labels for one printed line cannot become two payments.
  if (new Set(evidence.components.map(c => `${c.version_id}:${c.page}:${c.locator}`)).size !== evidence.components.length) {
    context.addIssue({code: 'custom', message: 'Component source locators must be unique'});
  }
  for (const [index, component] of evidence.components.entries()) {
    const document = evidence.documents.find(d => d.version_id === component.version_id);
    if (!document || component.page > document.page_count) {
      context.addIssue({code: 'custom', message: 'Component must bind the exact document version and page', path: ['components', index]});
    }
  }
}).readonly();

export type June2026WageEvidence = z.infer<typeof june2026WageEvidenceSchema>;
export type June2026WageComponent = z.infer<typeof june2026ComponentSchema>;

export const JUNE2026_APPLICABILITY_REQUESTS = Object.freeze({
  age_18_entire_month: 'האם מלאו לך 18 לפני תחילת יוני 2026?',
  sector: 'מה תחום הפעילות של המעסיק והאם חלים תנאי שכר ענפיים?',
  hours_rest_law_applies: 'נדרש בירור תחולת חוק שעות עבודה ומנוחה, לרבות כל חריגי סעיף 30(א).',
  no_better_minimum_wage_arrangement: 'האם קיים חוזה, הסכם או הסדר שמקנה שכר מינימום גבוה יותר?',
  no_adapted_minimum_wage: 'האם נקבע עבורך שכר מינימום מותאם לפי החלטה מוסמכת?',
  regular_hours_exclude_absence_overtime_rest: 'האם השעות הרגילות כוללות רק עבודה רגילה ומופרדות מהיעדרות, שעות נוספות ומנוחה שבועית?',
});
