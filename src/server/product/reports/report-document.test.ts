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
