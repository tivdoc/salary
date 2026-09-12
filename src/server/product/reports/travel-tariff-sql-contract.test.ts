import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {TRAVEL_TARIFF_POLICY} from '@/engine/entitlement-review/travel/tariff-contracts';
import {documentTravelTariffTarget,type DocumentTravelTariffSource} from './document-travel-tariff';

const read=(name:string)=>readFileSync(`supabase/migrations/${name}.sql`,'utf8').replaceAll('\r\n','\n');
const purpose=read('20260912190000_travel_tariff_document_purpose');
const targets=read('20260912191500_travel_tariff_reading_targets');
function body(sql:string,name:string){
 const start=sql.indexOf(`function ${name}(`),end=sql.indexOf('$$;',start);
 if(start<0||end<0)throw Error(`SQL_FUNCTION_MISSING:${name}`);
 return sql.slice(start,end+3);
}
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const source:DocumentTravelTariffSource={document:{case_id:id(1),document_id:id(2),version_id:id(3),file_sha256:'a'.repeat(64),
 page_count:3,month:'2026-06',evidence_purpose:'travel_tariff',document_type:'other',purpose_sha256:'b'.repeat(64)},group:{page:2,locator:'Synthetic tariff table'}};

/** Static contract checks only. PostgreSQL compilation, RLS, trigger execution,
 * and JSONB canonicalization parity still require the transactional preflight. */
describe('travel tariff SQL source authority contract',()=>{
 it('keeps the SQL policy payload identical to the compiled source-reading policy',()=>{
  const literal=body(targets,'private.travel_tariff_target_matches').match(/compact_text\('(\{[^']+\})'::jsonb\)/u)?.[1];
  expect(literal).toBeDefined();
  const parsed:unknown=JSON.parse(literal!);
  expect(parsed).toEqual(TRAVEL_TARIFF_POLICY);
  expect(canonicalSha256(parsed)).toBe(canonicalSha256(TRAVEL_TARIFF_POLICY));
  expect(parsed).toMatchObject({provider_proposal:false,source_reading_only:true,legal_applicability_approved:false});
 });

 it('reconstructs every wrapper and inner field from the persisted purpose, retaining both target hashes',()=>{
  const matcher=body(targets,'private.travel_tariff_target_matches');
  for(const subject of ['context','daily_fare','ticket_inventory','monthly_pass_cost'] as const){
   const target=documentTravelTariffTarget({source,subject});
   for(const key of [...Object.keys(target),...Object.keys(target.tariff),...Object.keys(target.tariff.document)])
    expect(matcher,`${subject}:${key}`).toContain(`'${key}'`);
   expect(target.target_sha256).not.toBe(target.tariff.target_sha256);
  }
  expect(matcher).toContain("target=outer_body||jsonb_build_object('target_sha256'");
  expect(matcher).toContain("private.governance_jsonb_compact_text(inner_body)");
  expect(matcher).toContain("private.governance_jsonb_compact_text(outer_body)");
 });

 it('selects the latest purpose before checking current bytes, without resurrecting an earlier source',()=>{
  const journal=body(purpose,'private.document_source_purpose_journal');
  expect(journal).toContain('select distinct on(month)');
  expect(journal).toContain('order by month,sequence desc) p\n join public.documents d');
  for(const pin of ['d.case_id=p.case_id','d.id=p.document_id','d.version_id=p.version_id',"d.content_sha256=p.payload->>'file_sha256'"])
   expect(journal).toContain(pin);
  const current=body(targets,'private.travel_tariff_target_current');
  for(const pin of ['v.revision=h.revision','v.input_sha256=h.input_sha256',"jsonb_array_elements(v.input->'source_purposes') pinned where pinned=p",
   'private.travel_tariff_paid','private.travel_tariff_target_matches'])expect(current).toContain(pin);
  expect(current).not.toContain('document_versions');
 });

 it('requires an authenticated upload actor, paid travel month and server physical page count',()=>{
  const reserve=body(purpose,'public.case_documents_reserve');
  expect(reserve).toContain('target_identity is null');
  expect(reserve).toContain('i.case_id=target_case and i.identity_id=target_identity');
  expect(reserve).toContain('c.contact_verified_at is not null');
  expect(reserve).toContain('prior.case_id<>target_case or prior.identity_id<>target_identity');
  expect(body(purpose,'private.travel_tariff_paid')).toContain("'travel'=any(o.topics)");
  expect(body(purpose,'private.travel_tariff_paid')).toContain("o.refund_state<>'refunded'");
  expect(body(purpose,'private.document_tariff_upload_validate')).toContain('private.travel_tariff_paid(target_case,m)');
  expect(body(purpose,'private.document_tariff_upload_validate')).toContain("jsonb_typeof(purpose->'locator')='string'");
  expect(body(purpose,'private.document_tariff_upload_record')).toContain("'page_count'");
  expect(body(purpose,'private.document_tariff_upload_record')).toContain("then raise exception 'UPLOAD_UNVERIFIED'");
  expect(body(purpose,'private.document_tariff_upload_record')).not.toMatch(/jsonb_array_elements\(b\.files\) f\s+where f->>/u);
 });

 it('does not grant purpose mutation to callers or add legal/activation authority',()=>{
  for(const table of ['document_upload_actors','document_source_purposes']){
   expect(purpose).toContain(`alter table private.${table} force row level security`);
   expect(purpose).toMatch(new RegExp(`create policy [^;]+on private\\.${table} to tivdoc_dev_migrator`,'u'));
  }
  for(const sql of [purpose,targets]){
   const uncommented=sql.replace(/^--.*$/gmu,'');
   expect(uncommented).not.toMatch(/grant\s+(?:all|insert|update|delete|truncate|select)\b/iu);
   expect(uncommented).not.toMatch(/grant[^;]+\bto\s+(?:public|anon|authenticated)\b/iu);
   expect(uncommented).not.toMatch(/\b(?:delete from|truncate|alter role|bypassrls)\b/iu);
   expect(uncommented).not.toMatch(/\b(?:insert into|update)\s+private\.(?:ai_release|owner_engineering|legal_)/iu);
  }
  expect(purpose).toContain("raise exception 'UPLOAD_PURPOSE_IMMUTABLE'");
 });

 it('rejects missing/null envelope discriminants and forbids confirm or extra negative-answer fields',()=>{
  const validator=body(targets,'private.travel_tariff_answer_valid');
  expect(validator).toContain("a->>'schema_version' is distinct from 'document-field-answer-v3'");
  expect(validator).toContain("a->>'action' is distinct from 'correct'");
  expect(validator).toContain("return a=jsonb_build_object('schema_version','document-field-answer-v3','action',a->>'action')");
  expect(validator).toContain("b->'page'=target#>'{tariff,group,page}'");
  expect(validator).not.toContain("a->>'action'='confirm'");
 });

 it('dispatches only the versioned tariff target and preserves the historical verifier',()=>{
  expect(body(targets,'private.document_field_current')).toContain('else private.document_field_current_before_tariff_v1(target_case,target) end');
  const scope=body(targets,'private.document_reading_question_scope_v4');
  expect(scope).toContain("'travel'=any(purchased_topics)");
  expect(scope).toContain('else private.document_reading_question_scope_before_tariff_v1(purchased_topics,target) end');
  expect(targets).toContain("then private.travel_tariff_answer_valid(t,answer) when t->>''schema_version''=''document-evidence-reading-v1''");
  expect(targets).toContain("{tariff,group,page}");
  expect(targets).not.toMatch(/update\s+(?:private\.case_request_answer_versions|private\.document_field_targets)/iu);
 });
});
