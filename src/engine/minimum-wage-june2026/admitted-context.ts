import {z} from 'zod';
import type {CalculationSourceBinding} from '../calculations/source-trace.ts';
import type {CanonicalFact} from '../facts/contracts.ts';
import {employmentSnapshotSchema} from '../facts/snapshot.ts';
import {normalizedPayslipExtractionSchema, type NormalizedCandidateField} from '../extraction/payslip.ts';
import {createTopicRuleInputSnapshot} from '../rule-input/snapshot.ts';
import {canonicalSha256, deepFreeze} from '../rule-runtime/canonical.ts';
import {ruleInputSnapshotSchema} from '../wave1/contracts.ts';
import {createJune2026CollectionTarget, june2026CollectionTargetSchema, resolveJune2026CollectionAnswer} from './collection.ts';
import {JUNE2026_MINIMUM_WAGE_POLICY_SHA256} from './sources.ts';

const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const pinSchema = z.object({case_id: z.uuid(), analysis_run_id: z.uuid(), input_revision: z.number().int().safe().positive(),
  input_sha256: sha, order_id: z.uuid(), month: z.literal('2026-06')}).strict();
const documentSchema = z.object({product_document_id: z.uuid(), version_id: z.uuid(), sha256: sha,
  page_count: z.number().int().safe().positive().max(1000)}).strict();
const checkpointSchema = z.object({schema_version: z.literal('tivdoc-saved-extraction-v1'), case_id: z.uuid(), product_document_id: z.uuid(),
  version_id: z.uuid(), input_sha256: sha, expected_month: z.literal('2026-06'), period_mismatch: z.boolean(), result_sha256: sha,
  run: z.object({result: z.object({final_extraction: normalizedPayslipExtractionSchema}).passthrough()}).passthrough()}).passthrough();
const stageSchema = z.object({facts: employmentSnapshotSchema, facts_snapshot_sha256: sha}).strict();
const fieldDefinitions = [
  ['work.regular_hours', 'regular_hours'], ['compensation.base_monthly_salary', 'base_monthly_salary'],
  ['compensation.gross_salary', 'gross_salary'], ['compensation.salary_type', 'salary_type'], ['documents.period', 'salary_period'],
] as const;
const applicability = ['age_18_entire_month', 'sector', 'hours_rest_law_applies', 'no_better_minimum_wage_arrangement',
  'no_adapted_minimum_wage', 'regular_hours_exclude_absence_overtime_rest'] as const;
type ContextPin = z.infer<typeof pinSchema>;
export type June2026AdmittedContextInput = Readonly<{
  current: ContextPin & Readonly<{topics: readonly string[]; document: z.infer<typeof documentSchema>}>;
  saved: ContextPin;
  canonicalStage: z.infer<typeof stageSchema>;
  ruleInput: z.infer<typeof ruleInputSnapshotSchema>;
  checkpoint: unknown;
  extractionPolicyVersion: string;
  collection: unknown;
}>;
type FactualIssue = Readonly<{field: string; reason: string}>;

function valueOf(candidate: NormalizedCandidateField, versionId: string): unknown {
  if (candidate.field === 'salary_period') return candidate.normalized_value === null ? null : {
    document_id: versionId, period: {start_date: candidate.normalized_value.start_date, end_date: candidate.normalized_value.end_date},
  };
  return candidate.normalized_value;
}

/** This validates an existing reading; it never creates a reading confirmation.
 * The server loader must authenticate the actual journal behind any customer
 * confirmation. A self-consistent hash supplied by a client is not authority. */
function sourceMatches(source: CanonicalFact['provenance'][number], candidate: NormalizedCandidateField, input: June2026AdmittedContextInput,
  checkpoint: z.infer<typeof checkpointSchema>, requireReading = false): boolean {
  const extraction = checkpoint.run.result.final_extraction;
    if (source.source_type !== 'documented') return false;
    const reference = source.source_reference;
    if (reference.document_id !== input.current.document.version_id || reference.locator?.page !== candidate.source.page) return false;
    if (reference.locator.text_span !== undefined && reference.locator.text_span !== candidate.source.text_fragment) return false;
    if (reference.locator.bounding_box !== undefined
      && canonicalSha256(reference.locator.bounding_box) !== canonicalSha256(candidate.source.bounding_box ?? null)) return false;
    const reading = source.customer_confirmation;
    if (!reading) return !requireReading; // Preserve single-observation historical status; a multi-observation admission requires every reading.
    return source.verified === true && reading.case_id === input.current.case_id && reading.document_id === input.current.document.version_id
      && reading.month === input.current.month && reading.source_sha256 === input.current.document.sha256
      && reading.candidate_id === candidate.candidate_id && reading.candidate_sha256 === canonicalSha256(candidate)
      && reading.extraction_result_sha256 === checkpoint.result_sha256 && reading.normalized_extraction_sha256 === canonicalSha256(extraction);
}

/** Replays declarations from immutable receipt fields. No caller-supplied
 * interpretation, hash, 'confirmed' flag or precomputed state is trusted. */
function readCollection(input: June2026AdmittedContextInput) {
  const collection = z.object({schema_version: z.literal('saved-june2026-collection-evidence-v1'), case_id: z.uuid(), month: z.literal('2026-06'),
    evaluated_at: z.iso.datetime({offset: true}), resolutions: z.array(z.unknown()).max(512), legal_confirmation: z.literal(false), rule_activation: z.literal(false)}).parse(input.collection);
  if (collection.case_id !== input.current.case_id) throw Error('JUNE_CONTEXT_COLLECTION_CASE_MISMATCH');
  const requestIds = new Set<string>();
  const targetHashes = new Set<string>();
  const resolutions = collection.resolutions.map(raw => {
    const state = z.object({state: z.enum(['declared', 'unknown', 'conflicted', 'stale', 'expired', 'missing'])}).parse(raw).state;
    if (typeof raw === 'object' && raw !== null && 'declaration' in raw) {
      const declaration = z.object({target: june2026CollectionTargetSchema, request_id: z.uuid(), answer_revision: z.number().int().safe().positive(),
        identity_id: z.uuid(), answered_at: z.iso.datetime({offset: true}), answer: z.string()}).parse(raw.declaration);
      const replayed = resolveJune2026CollectionAnswer({target: declaration.target, currentCheckpoint: input.checkpoint, policyVersion: input.extractionPolicyVersion,
        caseId: input.current.case_id, month: input.current.month, requestId: declaration.request_id, answerRevision: declaration.answer_revision,
        identityId: declaration.identity_id, answeredAt: declaration.answered_at, answer: declaration.answer});
      if (canonicalSha256(raw) !== canonicalSha256(replayed)) throw Error('JUNE_CONTEXT_DECLARATION_REPLAY_MISMATCH');
      if (requestIds.has(declaration.request_id) || targetHashes.has(declaration.target.target_sha256)) throw Error('JUNE_CONTEXT_COLLECTION_AMBIGUOUS');
      requestIds.add(declaration.request_id); targetHashes.add(declaration.target.target_sha256);
      return replayed;
    }
    if (state !== 'missing' && state !== 'expired' && state !== 'stale') throw Error('JUNE_CONTEXT_DECLARATION_REQUIRED');
    const row = z.object({state: z.enum(['missing', 'expired', 'stale']), request_id: z.uuid(), target: june2026CollectionTargetSchema,
      expires_at: z.iso.datetime({offset: true}), legal_classification_status: z.literal('unreviewed'), candidate_evidence_admitted: z.literal(false)}).strict().parse(raw);
    if (row.target.case_id !== input.current.case_id) throw Error('JUNE_CONTEXT_COLLECTION_CASE_MISMATCH');
    if (requestIds.has(row.request_id) || targetHashes.has(row.target.target_sha256)) throw Error('JUNE_CONTEXT_COLLECTION_AMBIGUOUS');
    requestIds.add(row.request_id); targetHashes.add(row.target.target_sha256);
    let current = false;
    try {
      const subject = row.target.subject;
      current = createJune2026CollectionTarget({checkpoint: input.checkpoint, policyVersion: input.extractionPolicyVersion,
        subject: subject.kind === 'component' ? {kind: 'component', componentId: subject.component.component_id} : subject}).target_sha256 === row.target.target_sha256;
    } catch { /* Historical targets stay stale; they do not become current declarations. */ }
    return {...row, state: !current ? 'stale' as const : row.state === 'expired' || Date.parse(row.expires_at) <= Date.parse(collection.evaluated_at) ? 'expired' as const : row.state};
  }).sort((a, b) => {
    const left = 'declaration' in a ? a.declaration.target : a.target;
    const right = 'declaration' in b ? b.declaration.target : b.target;
    return left.target_sha256 < right.target_sha256 ? -1 : left.target_sha256 > right.target_sha256 ? 1 : 0;
  });
  return {evaluated_at: collection.evaluated_at, resolutions};
}

/** Pure validation/materialization over a server-loaded current-source context.
 * 'Factual context ready' authorizes no execution or publication. The ordinary
 * legal catalog and case-assessment gates remain separate and indispensable. */
export function prepareJune2026AdmittedContext(input: June2026AdmittedContextInput) {
  const current = pinSchema.parse(Object.fromEntries(Object.entries(input.current).filter(([key]) => key !== 'topics' && key !== 'document')));
  const saved = pinSchema.parse(input.saved), document = documentSchema.parse(input.current.document);
  if (canonicalSha256(current) !== canonicalSha256(saved)) throw Error('JUNE_CONTEXT_CURRENT_PIN_MISMATCH');
  if (!z.array(z.string()).max(7).parse(input.current.topics).includes('minimum_wage')) throw Error('JUNE_CONTEXT_PURCHASED_TOPIC_REQUIRED');
  const stage = stageSchema.parse(input.canonicalStage), facts = stage.facts;
  if (facts.case_id !== current.case_id || facts.analysis_run_id !== current.analysis_run_id
    || canonicalSha256(facts) !== stage.facts_snapshot_sha256) throw Error('JUNE_CONTEXT_CANONICAL_STAGE_MISMATCH');
  const ruleInput = createTopicRuleInputSnapshot(facts, 'minimum_wage');
  if (canonicalSha256(ruleInputSnapshotSchema.parse(input.ruleInput)) !== canonicalSha256(ruleInput)) throw Error('JUNE_CONTEXT_RULE_INPUT_MISMATCH');
  const checkpoint = checkpointSchema.parse(input.checkpoint), extraction = checkpoint.run.result.final_extraction;
  // The collection builder also rejects invented provider customer readings,
  // ambiguous periods, duplicate components and a mismatched result digest.
  createJune2026CollectionTarget({checkpoint: input.checkpoint, policyVersion: input.extractionPolicyVersion, subject: {kind: 'earnings_completeness'}});
  if (checkpoint.case_id !== current.case_id || checkpoint.product_document_id !== document.product_document_id || checkpoint.version_id !== document.version_id
    || checkpoint.input_sha256 !== document.sha256 || extraction.quality_metrics.page_count !== document.page_count) throw Error('JUNE_CONTEXT_SOURCE_BINDING_MISMATCH');
  const collection = readCollection(input), issues: FactualIssue[] = [];
  const boundFacts: {path: CanonicalFact['path']; fact_id: string; fact_sha256: string; candidate_id: string|null; candidate_sha256: string|null}[] = [];
  for (const [path, field] of fieldDefinitions) {
    const fact = facts.facts.find(item => item.path === path), candidates = extraction.fields.filter(item => item.field === field);
    if(path==='work.regular_hours'&&candidates.length===0&&fact?.value!==null&&fact?.status==='needs_confirmation'
      &&fact.conflicting_fact_ids.length===0&&fact.provenance.length===1&&fact.provenance[0].source_type==='declared'
      &&fact.provenance[0].source_reference.kind==='case_request_answer'){
      boundFacts.push({path,fact_id:fact.fact_id,fact_sha256:canonicalSha256(fact),candidate_id:null,candidate_sha256:null});
      issues.push({field:path,reason:'declared_hours_assessment_required'});continue;
    }
    if (!fact || fact.status !== 'confirmed' || fact.value === null || fact.conflicting_fact_ids.length > 0) {
      issues.push({field: path, reason: fact?.status === 'conflicted' || (fact?.conflicting_fact_ids.length ?? 0) > 0 ? 'conflicted_canonical_fact' : 'confirmed_canonical_fact_required'}); continue;
    }
    if (candidates.length === 0 || candidates.some(candidate => candidate.normalized_value === null)) {issues.push({field: path, reason: 'one_documented_candidate_required'}); continue;}
    const multiple = candidates.length > 1;
    // Do not select one convenient observation. Every value must agree and
    // every retained source must bind its own identified reading. Repeated IDs
    // or duplicated provenance cannot stand in for an unconfirmed observation.
    const provenanceBound = multiple
      ? fact.provenance.length === candidates.length
        && new Set(fact.provenance.map(source => source.source_type === 'documented' ? source.customer_confirmation?.request_id : undefined)).size === candidates.length
        && new Set(fact.provenance.map(source => source.source_type === 'documented' ? source.customer_confirmation?.target_sha256 : undefined)).size === candidates.length
        && candidates.every(candidate => fact.provenance.filter(source => sourceMatches(source, candidate, input, checkpoint, true)).length === 1)
        && fact.provenance.every(source => candidates.filter(candidate => sourceMatches(source, candidate, input, checkpoint, true)).length === 1)
      : fact.provenance.length > 0 && fact.provenance.every(source => sourceMatches(source, candidates[0], input, checkpoint));
    if (new Set(candidates.map(candidate => candidate.candidate_id)).size !== candidates.length
      || candidates.some(candidate => candidate.source.document_id !== document.version_id || candidate.source.page > document.page_count
        || canonicalSha256(fact.value) !== canonicalSha256(valueOf(candidate, document.version_id))) || !provenanceBound) {
      issues.push({field: path, reason: 'current_document_fact_binding_required'}); continue;
    }
    for (const candidate of candidates) boundFacts.push({path, fact_id: fact.fact_id, fact_sha256: canonicalSha256(fact), candidate_id: candidate.candidate_id, candidate_sha256: canonicalSha256(candidate)});
  }
  const byPath = new Map(facts.facts.map(fact => [fact.path, fact]));
  const salary = byPath.get('compensation.salary_type'), hours = byPath.get('work.regular_hours'), base = byPath.get('compensation.base_monthly_salary'), gross = byPath.get('compensation.gross_salary');
  if (salary?.value !== 'hourly') issues.push({field: 'compensation.salary_type', reason: 'hourly_scope_required'});
  if (hours?.path === 'work.regular_hours' && hours.value) {
    const match = /^(0|[1-9]\d{0,2})(?:\.(\d{1,4}))?$/u.exec(hours.value.amount);
    if (!match || hours.value.unit !== 'hours_per_month' || BigInt(match[1] + (match[2] ?? '')) <= BigInt(0)
      || BigInt(match[1] + (match[2] ?? '')) > BigInt(182) * BigInt(10) ** BigInt((match[2] ?? '').length)) issues.push({field: hours.path, reason: 'supported_positive_hours_required'});
  }
  const monetary = extraction.additional_components.filter(component => component.amount !== null);
  let singleComponent: (typeof monetary)[number] | null = null;
  if (monetary.length !== 1) issues.push({field: 'components', reason: 'single_monetary_component_required'});
  else if (base?.path !== 'compensation.base_monthly_salary' || gross?.path !== 'compensation.gross_salary' || !base.value || !gross.value
    || base.value.currency !== 'ILS' || gross.value.currency !== 'ILS' || monetary[0].amount?.currency !== 'ILS'
    || base.value.minor_units !== gross.value.minor_units || base.value.minor_units !== monetary[0].amount?.minor_units) {
    issues.push({field: 'components', reason: 'documented_base_gross_component_reconciliation_required'});
  } else singleComponent = monetary[0];
  const sourceFactBindings: CalculationSourceBinding[] = issues.length ? [] : [
    {input_id: 'fact.regular.hours', source: {kind: 'fact', fact_id: boundFacts.find(fact => fact.path === 'work.regular_hours')!.fact_id, value_path: []}},
    {input_id: 'fact.component.1', source: {kind: 'fact', fact_id: boundFacts.find(fact => fact.path === 'compensation.base_monthly_salary')!.fact_id, value_path: []}},
  ];
  const legalGates = [...applicability.map(field => ({field: `applicability.${field}`, status: 'not_admitted' as const})),
    {field: 'wage_components_complete', status: 'not_admitted' as const}, {field: 'components.legal_classification', status: 'not_admitted' as const},
    {field: 'active_legal_catalog', status: 'not_admitted' as const}];
  const seed = {schema_version: 'tivdoc-june2026-factual-context-v1', state: issues.length ? 'factual_context_blocked' as const : 'factual_context_ready' as const,
    authority: 'current_source_factual_mapping_only', current, document, facts_snapshot_sha256: stage.facts_snapshot_sha256, rule_input: ruleInput,
    extraction_result_sha256: checkpoint.result_sha256, extraction_policy_version: input.extractionPolicyVersion, legal_policy_sha256: JUNE2026_MINIMUM_WAGE_POLICY_SHA256,
    bound_facts: boundFacts, source_fact_bindings: sourceFactBindings, single_monetary_component: singleComponent, component_legal_classification: 'unreviewed',
    collection, factual_issues: issues, legal_gates: legalGates, legal_activation: false, publication_allowed: false};
  return deepFreeze({...seed, context_sha256: canonicalSha256(seed)});
}
export type June2026AdmittedContext = ReturnType<typeof prepareJune2026AdmittedContext>;
