import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {reviewPeriodSchema,reviewSourcePinSchema} from '@/engine/document-review/completions';

export const LEGACY_PAID_TOPICS=['working_time','pension','vacation','convalescence','travel','rest_day','minimum_wage','bonuses','contract'] as const;
export const LEGACY_PAID_POLICY='legacy-saved-paid-receipt-v1' as const;
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const optionalText=z.string().nullable();
export const legacyPaidReceiptInputSchema=z.object({
 case:z.object({id:z.uuid(),public_id:z.string().min(1),payment_status:z.string(),is_qa:z.boolean().nullable(),attribution_status:optionalText.optional()}).strict(),
 payment:z.object({id:z.uuid(),case_id:z.uuid(),provider:z.string(),amount:z.union([z.string(),z.number().finite()]),currency:z.string(),status:z.string(),
  verified_at:z.iso.datetime({offset:true}).nullable(),idempotency_key:optionalText,provider_order_id:optionalText,provider_payment_id:optionalText,
  provider_reference:optionalText,provider_clearing_log_id:optionalText,provider_confirmation_number:optionalText}).strict(),
 source:z.object({project_ref:z.string().regex(/^[a-z]{20}$/u),captured_at:z.iso.datetime({offset:true}),snapshot_sha256:hash}).strict(),
 periods:z.array(z.object({period:reviewPeriodSchema,evidence_sha256:hash,source_pins:z.array(reviewSourcePinSchema).min(1).max(32)}).strict()).max(600).default([]),
}).strict();
export type LegacyPaidReceiptInput=z.infer<typeof legacyPaidReceiptInputSchema>;
export const legacyPaidScopeSchema=z.object({
 schema_version:z.literal(LEGACY_PAID_POLICY),kind:z.literal('legacy_initial'),origin:z.literal('legacy_paid_receipt'),id:z.uuid(),case_id:z.uuid(),payment_id:z.uuid(),
 receipt_sha256:hash,source:legacyPaidReceiptInputSchema.shape.source,payment_record_sha256:hash,case_record_sha256:hash,
 amount_minor:z.number().int().positive().safe(),currency:z.literal('ILS'),payment_assurance:z.literal('saved_server_verified'),
 topics:z.tuple([z.literal('working_time'),z.literal('pension'),z.literal('vacation'),z.literal('convalescence'),z.literal('travel'),z.literal('rest_day'),z.literal('minimum_wage'),z.literal('bonuses'),z.literal('contract')]),
 periods:legacyPaidReceiptInputSchema.shape.periods,period_state:z.enum(['source_observed','missing']),scope_basis:z.literal('legacy_initial_scope_not_versioned'),
 historical_offer_commit:z.literal('8d00dc9'),deployment_at_purchase_verified:z.literal(false),new_payment_required:z.literal(false),publication_authority:z.literal(false),
}).strict().superRefine((scope,ctx)=>{
 const {receipt_sha256,...body}=scope;
 if(canonicalSha256(body)!==receipt_sha256)ctx.addIssue({code:'custom',message:'LEGACY_RECEIPT_HASH'});
 if(scope.id!==scope.payment_id)ctx.addIssue({code:'custom',message:'LEGACY_RECEIPT_ID'});
 if(scope.period_state!==(scope.periods.length?'source_observed':'missing'))ctx.addIssue({code:'custom',message:'LEGACY_PERIOD_STATE'});
 if(scope.periods.some(e=>e.source_pins.some(pin=>pin.case_id!==scope.case_id)))ctx.addIssue({code:'custom',message:'LEGACY_PERIOD_CASE_BINDING'});
 if(new Set(scope.periods.map(e=>canonicalSha256(e.period))).size!==scope.periods.length)ctx.addIssue({code:'custom',message:'LEGACY_PERIOD_AMBIGUOUS'});
});
export type LegacyPaidScope=Readonly<{
 schema_version:typeof LEGACY_PAID_POLICY;kind:'legacy_initial';origin:'legacy_paid_receipt';id:string;case_id:string;payment_id:string;
 receipt_sha256:string;source:LegacyPaidReceiptInput['source'];payment_record_sha256:string;case_record_sha256:string;
 amount_minor:number;currency:'ILS';payment_assurance:'saved_server_verified';topics:typeof LEGACY_PAID_TOPICS;
 periods:LegacyPaidReceiptInput['periods'];period_state:'source_observed'|'missing';scope_basis:'legacy_initial_scope_not_versioned';
 historical_offer_commit:'8d00dc9';deployment_at_purchase_verified:false;new_payment_required:false;publication_authority:false;
}>;
type Blocked=Readonly<{state:'payment_review_required'|'ownership_review_required'|'inactive';case_id:string;payment_id:string;reasons:readonly string[]}>;
export const parseLegacyPaidScope=(candidate:unknown):LegacyPaidScope=>deepFreeze(legacyPaidScopeSchema.parse(candidate));
const present=(v:string|null)=>v!==null&&v.trim().length>0;
function minorAmount(amount:string|number):number|null{
 const text=String(amount);if(!/^(?:0|[1-9][0-9]{0,10})(?:\.[0-9]{1,2})?$/u.test(text))return null;
 const [whole,fraction='']=text.split('.'),minor=Number(whole)*100+Number(fraction.padEnd(2,'0'));
 return Number.isSafeInteger(minor)&&minor>0?minor:null;
}

/** Read-only admission of a saved historical payment. It does not settle money,
 * create a product_order, assign a purchase month, or grant legal/publication
 * authority. Callers must authenticate their source snapshot before invoking it. */
export function buildLegacyPaidScope(candidate:unknown):Readonly<{state:'admitted';scope:LegacyPaidScope}>|Blocked{
 const input=legacyPaidReceiptInputSchema.parse(candidate),c=input.case,p=input.payment;
 const blocked=(state:Blocked['state'],reasons:string[]):Blocked=>deepFreeze({state,case_id:c.id,payment_id:p.id,reasons});
 if(p.case_id!==c.id)throw Error('LEGACY_RECEIPT_CASE_BINDING');
 if(input.periods.some(e=>e.source_pins.some(pin=>pin.case_id!==c.id)))throw Error('LEGACY_PERIOD_CASE_BINDING');
 if(new Set(input.periods.map(e=>canonicalSha256(e.period))).size!==input.periods.length)throw Error('LEGACY_PERIOD_AMBIGUOUS');
 if(['refunded','cancelled'].includes(p.status)||['refunded','cancelled'].includes(c.payment_status))return blocked('inactive',['refund_or_cancellation_recorded']);
 const reasons:string[]=[],amount=minorAmount(p.amount);
 if(p.status!=='verified'||c.payment_status!=='verified'||p.verified_at===null)reasons.push('saved_verification_incomplete');
 if(p.provider!=='invoice4u'||p.currency!=='ILS'||amount===null)reasons.push('payment_amount_currency_or_provider');
 if(p.idempotency_key!==`${c.id}:initial-check`||p.provider_order_id!==`tivdoc-salary:${c.public_id}`)reasons.push('original_order_binding');
 if(![p.provider_payment_id,p.provider_reference,p.provider_clearing_log_id,p.provider_confirmation_number].every(present)
  ||/^0+$/u.test(p.provider_payment_id?.trim()??''))reasons.push('provider_reference_missing');
 if(p.provider_reference!==p.provider_clearing_log_id)reasons.push('clearing_reference_mismatch');
 if(reasons.length)return blocked('payment_review_required',reasons);
 if(c.is_qa!==false||c.attribution_status==='internal_qa')return blocked('ownership_review_required',['qa_or_unknown_ownership_flag_preserved']);
 return deepFreeze({state:'admitted',scope:verifiedReceiptScope(input,amount!)});
}

function verifiedReceiptScope(input:LegacyPaidReceiptInput,amount:number):LegacyPaidScope{
 const c=input.case,p=input.payment;
 const periods=[...input.periods].sort((a,b)=>a.period.from.localeCompare(b.period.from)||a.period.to.localeCompare(b.period.to));
 const body={schema_version:LEGACY_PAID_POLICY,kind:'legacy_initial' as const,origin:'legacy_paid_receipt' as const,id:p.id,
  case_id:c.id,payment_id:p.id,source:input.source,payment_record_sha256:canonicalSha256(p),case_record_sha256:canonicalSha256(c),
  amount_minor:amount,currency:'ILS' as const,payment_assurance:'saved_server_verified' as const,topics:LEGACY_PAID_TOPICS,periods,
  period_state:periods.length?'source_observed' as const:'missing' as const,scope_basis:'legacy_initial_scope_not_versioned' as const,
  historical_offer_commit:'8d00dc9' as const,deployment_at_purchase_verified:false as const,new_payment_required:false as const,publication_authority:false as const};
 return parseLegacyPaidScope({...body,receipt_sha256:canonicalSha256(body)});
}

/** Internal owner review may inspect a genuinely verified purchase whose
 * ownership classification is unresolved. This never grants public/worker
 * admission: the original QA flag remains in case_record_sha256, and the SQL
 * registration gate independently refuses that original source classification. */
export function inspectLegacyPaidReceiptForInternalReview(candidate:unknown){
 const input=legacyPaidReceiptInputSchema.parse(candidate),admission=buildLegacyPaidScope(input);
 if(admission.state==='inactive'||admission.state==='payment_review_required')return deepFreeze({
  state:admission.state,admission:false as const,public_execution:false as const,scope:null,blockers:admission.reasons});
 const ownership=admission.state==='ownership_review_required';
 return deepFreeze({state:'internal_review' as const,admission:false as const,public_execution:false as const,
  scope:admission.state==='admitted'?admission.scope:verifiedReceiptScope(input,minorAmount(input.payment.amount)!),
  ownership_review_required:ownership,blockers:ownership?admission.reasons:[]});
}

/** Monthly execution is narrower than the historical purchase. A period that
 * merely overlaps a month does not supply a complete month's source coverage. */
export function legacyPaidMonthlyScope(scope:LegacyPaidScope,month:string){
 scope=parseLegacyPaidScope(scope);
 z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u).parse(month);
 const {receipt_sha256,...body}=scope;if(canonicalSha256(body)!==receipt_sha256)throw Error('LEGACY_RECEIPT_HASH');
 const from=month+'-01',to=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10);
 const coverage=scope.periods.filter(e=>e.period.from<=from&&e.period.to>=to);
 if(!coverage.length)return deepFreeze({state:'period_evidence_required' as const,scope_id:scope.id,month,receipt_sha256});
 return deepFreeze({state:'ready' as const,id:scope.id,kind:scope.kind,origin:scope.origin,case_id:scope.case_id,
  from,to:from,topics:scope.topics,receipt_sha256,source_periods:coverage,scope_basis:scope.scope_basis});
}

/** Cohort replay rejects reused provider identifiers across cases. Duplicate
 * copies of one exact saved record collapse; divergent copies are retained as
 * errors instead of silently selecting a last payment attempt. */
export function adaptLegacyPaidCohort(candidates:readonly unknown[]){
 const inputs=candidates.map(v=>legacyPaidReceiptInputSchema.parse(v)),unique=new Map<string,LegacyPaidReceiptInput>();
 for(const input of inputs){
  const prior=unique.get(input.payment.id);
  if(prior&&canonicalSha256(prior)!==canonicalSha256(input))throw Error('LEGACY_RECEIPT_DUPLICATE_CONFLICT');
  unique.set(input.payment.id,input);
 }
 const bindings=new Map<string,string>();
 for(const input of unique.values())for(const field of ['provider_payment_id','provider_clearing_log_id'] as const){
  const value=input.payment[field];if(!present(value)||value==='0')continue;
  const key=`${input.payment.provider}:${field}:${value}`,owner=bindings.get(key);
  if(owner&&owner!==input.case.id)throw Error('LEGACY_PROVIDER_REFERENCE_REUSE');bindings.set(key,input.case.id);
 }
 return [...unique.values()].sort((a,b)=>a.payment.id.localeCompare(b.payment.id)).map(buildLegacyPaidScope);
}
