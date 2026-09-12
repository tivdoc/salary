import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {entitlementLegalDocuments} from '@/engine/entitlement-review/legal-documents';
import {OBLIGATIONS_CASE_POLICY} from '@/engine/entitlement-review/obligations/source-policy';
import {TRAVEL_GENERAL_ORDER_FLOOR_POLICY} from '@/engine/entitlement-review/travel/floor-policy';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';

const sql=readFileSync('supabase/migrations/20260912185000_review_public_source_inventory.sql','utf8');
const inventory:Record<string,unknown>[]=JSON.parse(sql.split('$sources$')[1]);
describe('ordinary review public-source inventory',()=>{
 it('matches every exact compiled source variant across purchased topic subsets',()=>{
  const topics=['working_time','pension','minimum_wage','travel','vacation','convalescence','contract','bonuses'];
  const expected=new Set<string>();
  for(let mask=0;mask<256;mask++)for(let policy=0;policy<4;policy++){
   const selected=topics.filter((_,index)=>mask&(1<<index));
   for(const document of entitlementLegalDocuments('00000000-0000-4000-8000-000000000001',selected,{
    ...(policy&1?{obligations_policy:OBLIGATIONS_CASE_POLICY}:{}),...(policy&2?{travel_policy:TRAVEL_GENERAL_ORDER_FLOOR_POLICY}:{})})){
    const {case_id,...body}=document;void case_id;expected.add(canonicalSha256(body));
   }
  }
  expect(new Set(inventory.map(canonicalSha256))).toEqual(expected);
  expect(inventory).toHaveLength(expected.size);
 });
 it('keeps source recognition exact and separate from case scope and activation',()=>{
  expect(sql).toContain("candidate->>'case_id'=target_case::text");
  expect(sql).toContain("candidate=jsonb_build_object('case_id',target_case::text)||p");
  expect(sql).not.toMatch(/security definer|grant execute|update private\.|insert into/iu);
  expect(inventory.every(d=>d.kind==='other'&&d.period===null&&!('case_id'in d))).toBe(true);
  expect(inventory.some(d=>d.document_id==='il.hours-work-rest-law.1951')).toBe(true);
 });
});
