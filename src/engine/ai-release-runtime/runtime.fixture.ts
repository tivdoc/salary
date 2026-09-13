import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from '../document-review/contracts.ts';
import {documentReviewCalculationInputSchema} from '../document-review/calculations.ts';
import {AI_RELEASE_TOPICS,aiReleaseAssessmentInputSchema,aiReleaseSourceReceiptSchema} from '../ai-release/contracts.ts';
import {fixture as pensionFixture} from '../entitlement-review/compose.fixture.ts';
import {travelFixture,minimumFixture,vacationFixture} from '../entitlement-review/product-branch.fixture.ts';
import {convalescenceFixture,obligationsFixture} from '../entitlement-review/final-branch.fixture.ts';
import {weekInput} from '../entitlement-review/working-time/working-time.fixture.ts';
import {obligationTextSha256} from '../entitlement-review/obligations/contracts.ts';
import {AI_RELEASE_RUNTIME_FAMILIES,aiReleaseRuntimeInputSchema,type AiReleaseRuntimeInput} from './contracts.ts';
import {prepareAiReleaseRuntime} from './generator-manifest.ts';

// Unit fixtures only. These are not saved evidence, active legal receipts,
// real payments or authority for any external application.
export const runtimeFixtureHash=(text:string)=>canonicalSha256({synthetic_runtime:text});
const h=runtimeFixtureHash;
const seal=<T extends object>(body:T)=>({...body,sha256:canonicalSha256(body)});
const period={from:'2026-06-01',to:'2026-06-30'},caseId='77777777-7777-4777-8777-777777777777';
const validity={issued_at:'2026-09-12T00:00:00Z',expires_at:'2026-09-13T00:00:00Z'};

export function nineTopicRuntimeSource():DocumentReviewInput{
 const pension=pensionFixture().pension,working=weekInput([10,10,10,10,10,8,8]),travel=travelFixture(),minimum=minimumFixture(),vacation=vacationFixture(),convalescence=convalescenceFixture(),obligations=obligationsFixture();
 const contract=structuredClone(obligations.obligations[0]);contract.topic='contract';contract.obligation_id='salary.addendum';
 contract.clause.text='Synthetic separate contract clause: a fixed salary supplement of 500 ILS for June.';contract.clause.text_sha256=obligationTextSha256(contract.clause.text);
 contract.clause.source={...contract.clause.source,locator:'Synthetic separate clause 2'};
 if(contract.promise.kind==='fixed'&&contract.promise.amount)contract.promise.amount.source=contract.clause.source;
 contract.assessments=contract.assessments.map(d=>({...d,sources:[contract.clause.source]}));contract.recorded=null;obligations.obligations.push(contract);
 const branches=[pension,working,travel,minimum,vacation,convalescence,obligations];
 for(const b of branches){b.case_id=caseId;for(const m of b.source_manifest)if(m.kind==='case_document')m.case_id=caseId;}
 const citationSchema=documentReviewCalculationInputSchema.shape.operands.element.shape.source;
 const readings:ReturnType<typeof citationSchema.parse>[]=[];
 function visit(value:unknown){
  if(!value||typeof value!=='object')return;
  const reading=citationSchema.safeParse(value);if(reading.success){readings.push(reading.data);return;}
  for(const nested of Object.values(value))visit(nested);
 }
 branches.forEach(visit);
 const docs=branches.flatMap(b=>b.source_manifest).filter(m=>m.kind==='case_document').map(m=>{
  const receipts=[...new Set(readings.filter(r=>r.document_id===m.document_id&&r.version_id===m.version_id).map(r=>r.reading_receipt_sha256))];
  if(!receipts.length)throw Error('SYNTHETIC_READING_REQUIRED');
  return {case_id:caseId,document_id:m.document_id,version_id:m.version_id,file_sha256:m.file_sha256,page_count:m.page_count,
   kind:'payslip' as const,label:'Synthetic source fixture, not a customer',period,reading_origin:'ai_document_review' as const,
   reading_sha256:receipts[0],...(receipts.length>1?{accepted_reading_sha256:receipts}:{})};
 });
 const documents=[...new Map(docs.map(d=>[d.document_id,d])).values()];
 return documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:caseId,period,
  purchased_scope:{order_id:'synthetic-order',receipt_sha256:h('original receipt'),origin:'legacy_paid_receipt',topics:AI_RELEASE_TOPICS},
  documents,checks:[],coverage_gaps:[],completion_input:{case_id:caseId,period,documents:documents.map(d=>({pin:{case_id:caseId,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256},kind:'payslip',period,review:'complete'})),needs:[],evidence:[]},
  entitlement_evidence:{schema_version:'entitlement-source-evidence-v1',case_id:caseId,order_id:'synthetic-order',receipt_sha256:h('original receipt'),period,
   pension,working_time:[working],travel,minimum_wage:minimum,vacation,convalescence,obligations}});
}

export function runtimeFixture(source:DocumentReviewInput=nineTopicRuntimeSource()):AiReleaseRuntimeInput{
 const trusted_generator_pins=AI_RELEASE_RUNTIME_FAMILIES.map(f=>({family_id:f.family_id,generator:{id:f.generator_id,version:f.generator_version,code_sha256:h(f.generator_id)}}));
 const prepared=prepareAiReleaseRuntime({source,analysis_run_id:'synthetic-normal-run',trusted_generator_pins});
 const legal=[...new Map(prepared.review.checks.flatMap(c=>c.calculation.input.source_manifest.filter(m=>m.kind==='legal_source')).map(m=>[m.version_id,m])).values()];
 const source_receipts=legal.map((m,index)=>aiReleaseSourceReceiptSchema.parse(seal({schema_version:'tivdoc-ai-source-review-v1',receipt_id:`source.${index}`,
  source_version_id:m.version_id,artifact_sha256:m.file_sha256,transcription_sha256:h(`synthetic transcription ${index}`),acquisition:'synthetic_fixture',source_url:'https://example.test/synthetic-source.pdf',
  locators:[{page:1,provision:'Synthetic audit metadata only',excerpt_sha256:h('excerpt')}],verification_evidence_sha256:h('verification'),amendment_inventory_sha256:h('amendments'),authority_analysis_sha256:h('source role'),
  valid_period:{from:'1951-01-01',to:null},available_from:validity.issued_at,populations:['general_private_adult_21_59'],topics:AI_RELEASE_TOPICS,status:'accepted',
  reviewer_id:'synthetic-ai',reviewer_version:'1',review_method_version:'synthetic-method-v1',confidence:0.9,confidence_explanation:'Synthetic legal audit fixture only, not a provider confidence.',...validity})));
 if(!source_receipts.length)throw Error('SYNTHETIC_LEGAL_FIXTURE_REQUIRED');
 const sourceHashes=source_receipts.map(s=>s.sha256);
 const selected=prepared.families.filter(f=>f.selected&&f.expected);
 const interpretations=selected.map(f=>seal({schema_version:'tivdoc-ai-interpretation-review-v1',receipt_id:`interpretation.${f.family_id}`,
  branch_id:f.branch_id,generator:f.generator,source_receipt_sha256s:sourceHashes,period,populations:['general_private_adult_21_59'],method_sha256:h('method'),
  reasoning:'Synthetic review of the compiled recipe; no actual legal activation.',limitations:['Qualified AI result; no cash-debt attestation.'],
  human_by_law:{state:'not_required_for_supported_branch',basis_sha256:h('synthetic basis'),source_receipt_sha256s:sourceHashes,explanation:'Synthetic branch scope only.'},
  status:'accepted',reviewer_id:'synthetic-ai',reviewer_version:'1',review_method_version:'synthetic-method-v1',confidence:0.9,confidence_explanation:'Synthetic receipt.',...validity}));
 const tests=selected.map((f,i)=>seal({schema_version:'tivdoc-ai-rule-tests-v1',receipt_id:`tests.${f.family_id}`,branch_id:f.branch_id,generator:f.generator,
  source_receipt_sha256s:sourceHashes,interpretation_receipt_sha256:interpretations[i].sha256,code_sha256:h('test build'),test_definition_sha256:h('unit test'),independent_oracle_sha256:h('manual expected'),
  results_sha256:h('test receipt'),categories:['positive','unknown'],passed:2,failed:0,outcome:'passed',...validity}));
 const policy=seal({schema_version:'tivdoc-ai-release-policy-v1',policy_id:'synthetic-runtime-policy',version:'1',namespace:'isolated_test',allowed_environments:['development'],
  product_decision_sha256:h('synthetic product decision'),review_method_version:'synthetic-method-v1',minimum_review_confidence:0.8,claim_kind:'qualified_ai_report',human_attestation:null,...validity,
  branches:selected.map((f,i)=>({branch_id:f.branch_id,topic:f.topic,period,populations:['general_private_adult_21_59'],generator:f.generator,
   source_receipt_sha256s:sourceHashes,interpretation_receipt_sha256:interpretations[i].sha256,test_receipt_sha256s:[tests[i].sha256],required_test_categories:['positive','unknown'],required_fact_keys:[],document_reading_fact_keys:[],required_decision_ids:[]}))});
 const registry=seal({schema_version:'tivdoc-ai-release-registry-v1',registry_id:'synthetic-registry',revision:1,namespace:'isolated_test',policy_sha256:policy.sha256,...validity,
  reviewers:[{actor_kind:'ai_reviewer',actor_id:'synthetic-ai',actor_version:'1',model_reference:'synthetic-model',review_method_version:'synthetic-method-v1',...validity}],revocations:[]});
 const scope={case_id:source.case_id,order_id:source.purchased_scope.order_id,order_origin:source.purchased_scope.origin,order_receipt_sha256:source.purchased_scope.receipt_sha256,
  input_revision:3,input_sha256:h('saved source head'),period:source.period,facts_sha256:h('pinned canonical facts'),population:'general_private_adult_21_59',authority_dependency_sha256:h('dependency')};
 const assessment=seal({schema_version:'tivdoc-ai-case-assessment-v1',assessment_id:'synthetic-assessment',policy_sha256:policy.sha256,registry_sha256:registry.sha256,actor_kind:'ai_reviewer',reviewer_id:'synthetic-ai',reviewer_version:'1',scope,...validity,
  branches:selected.map(f=>({branch_id:f.branch_id,rule_sha256:f.expected!.rule_sha256,parameter_set_sha256:f.expected!.parameter_set_sha256,
   generated_from:{generator:f.generator,source_evidence_sha256:f.expected!.source_evidence_sha256},facts:[],decisions:[]}))});
 const assessment_input=aiReleaseAssessmentInputSchema.parse({policy,registry,source_receipts,interpretation_receipts:interpretations,test_receipts:tests,assessment,
  current:{evaluated_at:'2026-09-12T10:00:00Z',environment:'development',namespace:'isolated_test',is_qa:true,policy_sha256:policy.sha256,registry_sha256:registry.sha256,registry_revision:1,assessment_sha256:assessment.sha256,
   scope,source_pins:source.documents.map(d=>({case_id:source.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256})),expected_generated_rules:prepared.expected_generated_rules}});
 return aiReleaseRuntimeInputSchema.parse({source,analysis_run_id:'synthetic-normal-run',trusted_generator_pins,assessment_input});
}
