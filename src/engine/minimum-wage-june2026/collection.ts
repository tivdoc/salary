import {z} from 'zod';
import {normalizedPayslipExtractionSchema} from '../extraction/payslip.ts';
import {moneySchema} from '../domain/primitives.ts';
import {canonicalSha256, deepFreeze} from '../rule-runtime/canonical.ts';
import {JUNE2026_MINIMUM_WAGE_POLICY_SHA256} from './sources.ts';

const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const policyVersion = z.string().trim().min(1).max(100);
const field = z.enum(['age_18_entire_month', 'sector', 'hours_rest_law_applies', 'no_better_minimum_wage_arrangement', 'no_adapted_minimum_wage', 'regular_hours_exclude_absence_overtime_rest']);
export const JUNE2026_COLLECTION_SCHEMA = 'minimum-wage-june2026-collection-v1' as const;
export const JUNE2026_COLLECTION_NAMESPACE = 'minimum_wage_june2026:' as const;
export const JUNE2026_UNKNOWN_ANSWER = 'איני יודע/ת';
export const JUNE2026_CONFLICTED_ANSWER = 'יש מידע סותר';
export const JUNE2026_DECLARATION_OPTIONS = Object.freeze(['כן, לפי המידע שברשותי', 'לא, לפי המידע שברשותי', JUNE2026_UNKNOWN_ANSWER, JUNE2026_CONFLICTED_ANSWER] as const);
/** These are customer descriptions of a payment's substance, not approved legal
 * classifications. In particular a label cannot admit an eligible wage line. */
export const JUNE2026_COMPONENT_DECLARATIONS = Object.freeze({
  base_salary: 'שכר יסוד או שכר משולב',
  cost_of_living: 'תוספת יוקר שאינה כלולה כבר בשכר המשולב',
  fixed_work_supplement: 'תוספת קבועה עקב העבודה',
  seniority: 'תוספת ותק', family: 'תוספת משפחה', shift_premium: 'תוספת משמרות',
  productivity_premium: 'פרמיית תפוקה', thirteenth_salary: 'משכורת שלוש עשרה',
  annual_bonus: 'מענק שנתי', expense_reimbursement: 'החזר הוצאות',
  overtime: 'תשלום בעד שעות נוספות', weekly_rest: 'תשלום בעד עבודה במנוחה השבועית',
  paid_absence: 'תשלום בעד היעדרות', deduction: 'ניכוי מהשכר', other: 'רכיב מסוג אחר',
} as const);
export const JUNE2026_COMPONENT_OPTIONS = Object.freeze([...Object.values(JUNE2026_COMPONENT_DECLARATIONS), JUNE2026_UNKNOWN_ANSWER, JUNE2026_CONFLICTED_ANSWER]);

const selectorSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('applicability'), field}).strict(),
  z.object({kind: z.literal('earnings_completeness')}).strict(),
  z.object({kind: z.literal('component'), componentId: z.uuid()}).strict(),
]);
export type June2026CollectionSelector = z.infer<typeof selectorSchema>;
// The complete checkpoint hash still binds confidence, raw readings, quantity,
// rate and geometry. Keep only safe integers in the target projection itself:
// JSONB expands scientific notation while JSON.stringify may retain it.
const componentProjectionSchema = z.object({
  component_id: z.uuid(), source_label: z.string().trim().min(1).max(160),
  source: z.object({document_id: z.uuid(), page: z.number().int().safe().positive()}).strict(),
  amount: moneySchema.nullable(),
}).strict();
const subjectSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('applicability'), field}).strict(),
  z.object({kind: z.literal('earnings_completeness')}).strict(),
  z.object({kind: z.literal('component'), component: componentProjectionSchema}).strict(),
]);
const checkpointSchema = z.object({
  schema_version: z.literal('tivdoc-saved-extraction-v1'), case_id: z.uuid(), product_document_id: z.uuid(), version_id: z.uuid(),
  input_sha256: sha, expected_month: z.literal('2026-06'), period_mismatch: z.boolean(), result_sha256: sha,
  run: z.object({result: z.object({final_extraction: normalizedPayslipExtractionSchema}).passthrough()}).passthrough(),
});

export const june2026CollectionTargetSchema = z.object({
  schema_version: z.literal(JUNE2026_COLLECTION_SCHEMA), case_id: z.uuid(), product_document_id: z.uuid(), version_id: z.uuid(),
  source_sha256: sha, month: z.literal('2026-06'), extraction_policy_version: policyVersion,
  extraction_result_sha256: sha, legal_policy_sha256: sha, subject: subjectSchema, target_sha256: sha,
}).strict().superRefine((target, context) => {
  if (target.subject.kind === 'component' && target.subject.component.source.document_id !== target.version_id) {
    context.addIssue({code: 'custom', message: 'Collection component must belong to the exact source version'});
  }
  const {target_sha256, ...body} = target;
  if (canonicalSha256(body) !== target_sha256) context.addIssue({code: 'custom', message: 'Collection target hash mismatch'});
}).readonly();
export type June2026CollectionTarget = z.infer<typeof june2026CollectionTargetSchema>;

/** Called by the saved worker on a locked, authorized checkpoint. No case input
 * revision is in the target: answering one sibling must not invalidate all
 * other source-bound questions. The SQL boundary must independently verify the
 * current document/checkpoint, identity and purchased month/topic on every write. */
export function createJune2026CollectionTarget(input: {checkpoint: unknown; policyVersion: string; subject: June2026CollectionSelector}): June2026CollectionTarget {
  const checkpoint = checkpointSchema.parse(input.checkpoint), selector = selectorSchema.parse(input.subject);
  const extraction = checkpoint.run.result.final_extraction;
  if (extraction.customer_readings !== undefined) throw Error('JUNE_COLLECTION_PROVIDER_CONFIRMATION_FORBIDDEN');
  if (extraction.document_id !== checkpoint.version_id || canonicalSha256(checkpoint.run.result) !== checkpoint.result_sha256) throw Error('JUNE_COLLECTION_CHECKPOINT_MISMATCH');
  const periods = extraction.fields.filter(candidate => candidate.field === 'salary_period');
  // Header and date-range observations may independently describe the same
  // month. Preserve every observation in the checkpoint; none can disagree,
  // reuse another candidate's identity, or come from an unbound source/page.
  if (checkpoint.period_mismatch || periods.length === 0
    || new Set(periods.map(period => period.candidate_id)).size !== periods.length
    || periods.some(period => period.source.document_id !== checkpoint.version_id || period.source.page > extraction.quality_metrics.page_count
      || !period.normalized_value || period.normalized_value.year !== 2026 || period.normalized_value.month !== 6
      || period.normalized_value.start_date !== '2026-06-01' || period.normalized_value.end_date !== '2026-06-30')) throw Error('JUNE_COLLECTION_PERIOD_UNSUPPORTED');
  if (extraction.additional_components.length > 32
    || new Set(extraction.additional_components.map(component => component.component_id)).size !== extraction.additional_components.length
    || extraction.additional_components.some(component => component.source.document_id !== checkpoint.version_id || component.source.page > extraction.quality_metrics.page_count)) throw Error('JUNE_COLLECTION_COMPONENT_INVENTORY_INVALID');
  let subject: z.infer<typeof subjectSchema>;
  if (selector.kind === 'component') {
    const matches = extraction.additional_components.filter(component => component.component_id === selector.componentId);
    if (matches.length !== 1) throw Error('JUNE_COLLECTION_COMPONENT_MISSING');
    const component = matches[0];
    subject = {kind: 'component', component: componentProjectionSchema.parse({component_id: component.component_id, source_label: component.source_label,
      source: {document_id: component.source.document_id, page: component.source.page}, amount: component.amount})};
  } else subject = selector;
  const body = {schema_version: JUNE2026_COLLECTION_SCHEMA, case_id: checkpoint.case_id, product_document_id: checkpoint.product_document_id,
    version_id: checkpoint.version_id, source_sha256: checkpoint.input_sha256, month: checkpoint.expected_month,
    extraction_policy_version: policyVersion.parse(input.policyVersion), extraction_result_sha256: checkpoint.result_sha256,
    legal_policy_sha256: JUNE2026_MINIMUM_WAGE_POLICY_SHA256, subject};
  return deepFreeze(june2026CollectionTargetSchema.parse({...body, target_sha256: canonicalSha256(body)}));
}

const prompts = Object.freeze({
  age_18_entire_month: 'האם ביום 1 ביוני 2026 כבר מלאו לך 18?',
  sector: 'מה תחום הפעילות של המעסיק ביוני 2026, והאם ידוע לך על הסכם ענפי או קיבוצי שחל בעבודה? נא לתאר את המידע שברשותך.',
  hours_rest_law_applies: 'נא לתאר את התפקיד בפועל ביוני 2026, אופן הפיקוח על שעות העבודה והסמכויות בעבודה. המידע דרוש לבירור התחולה; אין צורך לקבוע בעצמך מסקנה משפטית.',
  no_better_minimum_wage_arrangement: 'האם ידוע לך על חוזה, הסכם או הסדר אחר שקובע עבורך שכר מינימום גבוה מהשכר הכללי ביוני 2026?',
  no_adapted_minimum_wage: 'האם נקבע עבורך שכר מינימום מותאם בהחלטה מוסמכת שחלה ביוני 2026?',
  regular_hours_exclude_absence_overtime_rest: 'האם השעות הרגילות בתלוש יוני 2026 כוללות רק עבודה רגילה, ללא היעדרות, שעות נוספות או עבודה במנוחה השבועית?',
});

export function june2026CollectionQuestion(input: June2026CollectionTarget) {
  const target = june2026CollectionTargetSchema.parse(input), subject = target.subject;
  let question: string, answerKind: 'choice' | 'text' = 'choice';
  let options: readonly string[] | null = JUNE2026_DECLARATION_OPTIONS;
  if (subject.kind === 'component') {
    const labelCharacters=[...subject.component.source_label];
    const label=labelCharacters.length>120?labelCharacters.slice(0,119).join('')+'…':subject.component.source_label;
    question = `מה מהות הרכיב ״${label}״ בעמוד ${subject.component.source.page} בתלוש יוני 2026, לפי המידע שברשותך? התיאור יישמר כהצהרתך לצורך בירור הרכיב.`;
    options = JUNE2026_COMPONENT_OPTIONS;
  } else if (subject.kind === 'earnings_completeness') {
    question = 'לאחר בדיקת כל שורות התשלום בתלוש יוני 2026 ובקשות בירור רכיבי השכר, האם כל רכיב תשלום בתלוש מופיע בבקשות הבירור? אין לכלול ניכויים כשורות תשלום.';
  } else {
    question = prompts[subject.field];
    if (subject.field === 'sector' || subject.field === 'hours_rest_law_applies') {
      answerKind = 'text'; options = null;
      question += ` אפשר גם לכתוב ״${JUNE2026_UNKNOWN_ANSWER}״ או ״${JUNE2026_CONFLICTED_ANSWER}״.`;
    }
  }
  return deepFreeze({code: `${JUNE2026_COLLECTION_NAMESPACE}${target.target_sha256}`, question, answer_kind: answerKind,
    options: options === null ? null : [...options], field_crop: 'minimum_wage', blocking: false});
}

type Interpretation = Readonly<{kind: 'unknown' | 'conflicted'; value: null}>
  | Readonly<{kind: 'boolean_declaration'; value: boolean}>
  | Readonly<{kind: 'text_declaration'; value: string}>
  | Readonly<{kind: 'component_substance_declaration'; value: keyof typeof JUNE2026_COMPONENT_DECLARATIONS}>;
function interpret(target: June2026CollectionTarget, raw: string): {answer: string; interpretation: Interpretation} {
  const answer = z.string().trim().min(1).max(1500).parse(raw);
  const question = june2026CollectionQuestion(target);
  if (question.options && !question.options.includes(answer)) throw Error('JUNE_COLLECTION_ANSWER_INVALID');
  if (answer === JUNE2026_UNKNOWN_ANSWER) return {answer, interpretation: {kind: 'unknown', value: null}};
  if (answer === JUNE2026_CONFLICTED_ANSWER) return {answer, interpretation: {kind: 'conflicted', value: null}};
  if (question.answer_kind === 'text') return {answer, interpretation: {kind: 'text_declaration', value: answer}};
  if (target.subject.kind === 'component') {
    const entry = Object.entries(JUNE2026_COMPONENT_DECLARATIONS).find(([, label]) => label === answer);
    if (!entry) throw Error('JUNE_COLLECTION_ANSWER_INVALID');
    return {answer, interpretation: {kind: 'component_substance_declaration', value: entry[0] as keyof typeof JUNE2026_COMPONENT_DECLARATIONS}};
  }
  const yes = answer === JUNE2026_DECLARATION_OPTIONS[0];
  // These questions ask whether the exceptional arrangement exists. The field
  // is expressed negatively; a customer's yes therefore declares value=false.
  const inverse = target.subject.kind === 'applicability' && (target.subject.field === 'no_better_minimum_wage_arrangement' || target.subject.field === 'no_adapted_minimum_wage');
  return {answer, interpretation: {kind: 'boolean_declaration', value: inverse ? !yes : yes}};
}

/** The caller supplies the authenticated immutable answer row from the current
 * input journal. This pure function cannot authenticate a request UUID or decide
 * whether revision3 is actually the latest DB revision. Customer declarations
 * stay distinct from legal classifications even when the answer says yes. */
export function resolveJune2026CollectionAnswer(input: {target: unknown; currentCheckpoint: unknown; policyVersion: string;
  caseId: string; month: string; requestId: string; answerRevision: number; identityId: string; answeredAt: string; answer: string}) {
  const target = june2026CollectionTargetSchema.parse(input.target);
  const actor = z.object({caseId: z.uuid(), requestId: z.uuid(), answerRevision: z.number().int().positive(), identityId: z.uuid(), answeredAt: z.iso.datetime({offset: true})})
    .parse(input);
  if (target.case_id !== actor.caseId) throw Error('JUNE_COLLECTION_CASE_MISMATCH');
  const {answer, interpretation} = interpret(target, input.answer);
  const body = {schema_version: 'minimum-wage-june2026-customer-declaration-v1', actor_kind: 'customer_declaration', target,
    request_id: actor.requestId, answer_revision: actor.answerRevision, identity_id: actor.identityId, answered_at: actor.answeredAt,
    answer, interpretation,
    provenance: [{source_type: 'declared', source_reference: {kind: 'case_request_answer', request_id: actor.requestId, answer_revision: actor.answerRevision}}],
    evidence_status: interpretation.kind === 'unknown' ? 'missing' : interpretation.kind === 'conflicted' ? 'conflicted' : 'needs_confirmation',
    legal_classification_status: 'unreviewed', candidate_evidence_admitted: false,
  } as const;
  const declaration = deepFreeze({...body, declaration_sha256: canonicalSha256(body)});
  const stale = () => deepFreeze({state: 'stale' as const, declaration});
  if (target.month !== input.month || target.extraction_policy_version !== input.policyVersion || target.legal_policy_sha256 !== JUNE2026_MINIMUM_WAGE_POLICY_SHA256) return stale();
  let current: June2026CollectionTarget;
  try {
    current = createJune2026CollectionTarget({checkpoint: input.currentCheckpoint, policyVersion: input.policyVersion,
      subject: target.subject.kind === 'component' ? {kind: 'component', componentId: target.subject.component.component_id} : target.subject});
  } catch { return stale(); }
  if (current.target_sha256 !== target.target_sha256) return stale();
  const state = interpretation.kind === 'unknown' ? 'unknown' as const : interpretation.kind === 'conflicted' ? 'conflicted' as const : 'declared' as const;
  return deepFreeze({state, declaration});
}
export type June2026CollectionResolution = ReturnType<typeof resolveJune2026CollectionAnswer>;
