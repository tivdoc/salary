import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {canonicalSha256} from '../../../engine/rule-runtime/canonical';
import {reportDocumentSchema} from './report-document';
import {S04_HIGH_CERTAINTY} from './case-report-projection.fixtures';
function document(){
 const evidenceId=randomUUID();
 return {schema_version:'tivdoc-report-document-v2',id:randomUUID(),case_id:randomUUID(),order_id:randomUUID(),revision:1,input_sha256:'a'.repeat(64),projection_sha256:canonicalSha256(S04_HIGH_CERTAINTY),purchased_period:{from:'2026-06',to:'2026-06'},projection:S04_HIGH_CERTAINTY,evidence:[{id:evidenceId,document_id:randomUUID(),version_id:randomUUID(),sha256:'b'.repeat(64),page:1,field:'gross',fact_version:'1'}],findings:[{id:randomUUID(),topic:'minimum_wage',evidence_ids:[evidenceId],rule_versions:['minimum-wage-v1'],parameter_versions:['rate-v1']}],publication:{state:'published',approved_input_sha256:'a'.repeat(64),approval_actor_kind:'automation',published_at:'2026-09-07T06:00:00Z'},correction_policy:'append_new_revision_preserve_published'};
}
describe('versioned report evidence contract',()=>{
 it('accepts a fully linked initial report',()=>expect(reportDocumentSchema.safeParse(document()).success).toBe(true));
 it.each(['source','period','hash','approval'])('rejects invalid %s linkage',kind=>{
  const doc=document();
  if(kind==='source')doc.findings[0].evidence_ids=[randomUUID()];
  if(kind==='period')doc.purchased_period.from='2026-07';
  if(kind==='hash')doc.projection_sha256='0'.repeat(64);
  if(kind==='approval')doc.publication.approved_input_sha256='0'.repeat(64);
  expect(reportDocumentSchema.safeParse(doc).success).toBe(false);
 });
 it('requires human review for full delivery',()=>{
  const doc=document();doc.projection={...doc.projection,report_kind:'full'};doc.projection_sha256=canonicalSha256(doc.projection);
  expect(reportDocumentSchema.safeParse(doc).success).toBe(false);
  doc.publication.approval_actor_kind='human';expect(reportDocumentSchema.safeParse(doc).success).toBe(true);
 });
});

function aiDocument(){
 const old=structuredClone(document());const projection={...old.projection,report_kind:'full' as const};
 return {...old,schema_version:'tivdoc-report-document-v3',service_kind:'ai_assisted',publication_policy:'tivdoc-ai-publication-v1',order_offer_sha256:'c'.repeat(64),projection,projection_sha256:canonicalSha256(projection)};
}
describe('explicit AI report envelope v3',()=>{
 it('reads a permitted full AI report without claiming human review',()=>{
  const doc=reportDocumentSchema.parse(aiDocument());
  expect(doc.schema_version).toBe('tivdoc-report-document-v3');expect(doc.publication.approval_actor_kind).toBe('automation');
 });
 it.each(['actor','policy','offer','input','time','evidence','projection','legacy'])('refuses changed %s provenance',kind=>{
  const doc=aiDocument();
  if(kind==='actor')doc.publication.approval_actor_kind='human';
  if(kind==='policy')doc.publication_policy='unknown-policy';
  if(kind==='offer')doc.order_offer_sha256='';
  if(kind==='input')doc.publication.approved_input_sha256='d'.repeat(64);
  if(kind==='time')doc.publication.published_at='';
  if(kind==='evidence')doc.findings[0].evidence_ids=[randomUUID()];
  if(kind==='projection')doc.projection_sha256='d'.repeat(64);
  if(kind==='legacy')doc.schema_version='tivdoc-report-document-v2';
  expect(reportDocumentSchema.safeParse(doc).success).toBe(false);
 });
 it.each(['incomplete','contradiction','ceiling','inactive'])('retains the %s gate for AI',kind=>{
  const doc=aiDocument();const topic=doc.projection.topics.find(t=>t.gate==='checked');if(!topic||topic.gate!=='checked')throw Error('fixture');
  if(kind==='incomplete')topic.basis_complete=false;
  if(kind==='contradiction')topic.missing_facts=['conflict:hours_regular'];
  if(kind==='ceiling')topic.amount={currency:'ILS',minor_units:500001};
  if(kind==='inactive')topic.parameter_grades={rate:'awaiting_verification' as never};
  doc.projection_sha256=canonicalSha256(doc.projection);
  expect(reportDocumentSchema.safeParse(doc).success).toBe(false);
 });
 it('preserves the AI actor and guards in superseded history',()=>{
  const doc=aiDocument();doc.publication.state='superseded';
  expect(reportDocumentSchema.safeParse(doc).success).toBe(true);
  doc.publication.approved_input_sha256='d'.repeat(64);
  expect(reportDocumentSchema.safeParse(doc).success).toBe(false);
 });
});
