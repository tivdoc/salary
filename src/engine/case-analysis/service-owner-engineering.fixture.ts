import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {ownerEngineeringFixture} from '../ai-release-runtime/owner-engineering.fixture.ts';
import {prepareAiReleaseRuntime} from '../ai-release-runtime/generator-manifest.ts';
import {fixture as sourceFixture} from '../entitlement-review/compose.fixture.ts';
import {CaseAnalysisService,type CaseAnalysisOwnerEngineeringContext,type CaseAnalysisOwnerEngineeringPreparation,type CaseAnalysisServiceDependencies} from './service.ts';
import type {StoredCaseInputSnapshot} from './contracts.ts';
import {buildSyntheticCaseFixture} from './synthetic-fixtures.ts';
import {FixedClock,FixtureReportBuilder} from './fixture-ports.ts';
import {createIntegratedFullSystemHarness} from '../../server/engine/case-analysis/integrated-harness.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from '../document-review/contracts.ts';
import {composeEntitlementReview} from '../entitlement-review/compose.ts';

// Synthetic in-memory service harness only. No DB, provider or legal issuance.
export function ownerEngineeringServiceSetup(overrides:Partial<CaseAnalysisServiceDependencies>={},sourceOverride?:DocumentReviewInput){
 const original=sourceOverride??sourceFixture().input;
 // Ordinary canonical provenance requires a UUID, unlike the pure source fixture.
 const source=composeEntitlementReview(documentReviewInputSchema.parse(JSON.parse(JSON.stringify(original).replaceAll('synthetic.entitlement.doc','44444444-4444-4444-8444-444444444444'))));
 const base=buildSyntheticCaseFixture({fixture_id:'ai-service-source',mode:'real'}),empty=canonicalSha256([]);
 const stored:StoredCaseInputSnapshot={...base.stored,documents:[],extractions:[],document_snapshot_sha256:empty,
  extraction_snapshot_sha256:empty,declared_fact_snapshot:{...base.stored.declared_fact_snapshot,facts:[],snapshot_sha256:empty},document_review_input:source,
  source_journal:{case_id:source.case_id,input_revision:79,input_sha256:canonicalSha256({synthetic:'source journal'})}};
 const command={...base.command,case_id:source.case_id,case_revision:11,document_snapshot_sha256:empty,extraction_snapshot_sha256:empty,
  declared_fact_snapshot_sha256:empty,period:{start_date:source.period.from,end_date:source.period.to},population:'general_private_adult_21_59',
  as_of:'2026-09-12',document_review_sha256:canonicalSha256(source)};
 const h=createIntegratedFullSystemHarness([stored]),reportBuilder=new FixtureReportBuilder(h.hashes,h.ids);
 const dependencies={...h,clock:new FixedClock('2026-09-12T10:00:00Z'),reportBuilder,reportRegistration:h.review,templateVersion:'synthetic-ai-wrapper-v1',...overrides};
 return {h,command,stored,source,dependencies,reportBuilder,service:new CaseAnalysisService(dependencies)};
}
export function issueOwnerEngineeringService(context:CaseAnalysisOwnerEngineeringContext):CaseAnalysisOwnerEngineeringPreparation{
 // Local synthetic AI reviewer only. Production code has no issuer here.
 const i=ownerEngineeringFixture(context.document_review_input);
 i.analysis_run_id=context.analysis_run_id;
 i.assessment_input.current.scope={...i.assessment_input.current.scope,case_id:context.command.case_id,
  facts_sha256:context.facts_snapshot_sha256,input_revision:context.source_journal?.input_revision??79,
  input_sha256:context.source_journal?.input_sha256??canonicalSha256({synthetic:'source journal'}),population:context.command.population};
 i.assessment_input.assessment.scope=i.assessment_input.current.scope;
 const prepared=prepareAiReleaseRuntime({source:i.source,analysis_run_id:i.analysis_run_id,trusted_generator_pins:i.trusted_generator_pins});i.assessment_input.current.expected_generated_rules=structuredClone(prepared.expected_generated_rules);
 for(const branch of i.assessment_input.assessment.branches){
  const expected=prepared.expected_generated_rules.find(e=>e.branch_id===branch.branch_id)!;
  branch.rule_sha256=expected.rule_sha256;branch.parameter_set_sha256=expected.parameter_set_sha256;
  branch.generated_from={generator:expected.generator,source_evidence_sha256:expected.source_evidence_sha256};
 }
 const {sha256,...body}=i.assessment_input.assessment;void sha256;
 i.assessment_input.assessment.sha256=canonicalSha256(body);i.assessment_input.current.assessment_sha256=i.assessment_input.assessment.sha256;
 return {assessment_input:i.assessment_input,trusted_generator_pins:i.trusted_generator_pins};
}
