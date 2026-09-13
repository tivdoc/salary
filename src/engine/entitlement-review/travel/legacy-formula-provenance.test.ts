import {describe,it,expect} from 'vitest';
import {build} from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {TRAVEL_ACTUAL_COST_SPEC} from '../../legal-quality/release-rulespecs.ts';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {createRuleSpecPackage} from '../../legal-operations/rulespec.ts';
import {documentReviewCalculationInputSchema} from '../../document-review/calculations.ts';
import {resolveTravelEntitlement} from './index.ts';
import {TRAVEL_LEGACY_FORMULA_PROVENANCE} from './legacy-formula-provenance.ts';

describe('travel formula provenance without the historical authoring dependency',()=>{
 it('pins the exact retained RuleSpec, without changing that historical package',()=>{
  expect(TRAVEL_LEGACY_FORMULA_PROVENANCE).toEqual({rule_spec_id:TRAVEL_ACTUAL_COST_SPEC.rule_spec_id,
   rule_spec_version:TRAVEL_ACTUAL_COST_SPEC.rule_spec_version,content_sha256:TRAVEL_ACTUAL_COST_SPEC.content_sha256});
 });
 it('preserves the generated golden-case binding and RuleSpec content hash',()=>{
  const source={document_id:'synthetic-provenance-doc',version_id:'synthetic.provenance.v1',file_sha256:'a'.repeat(64),page:1,
   locator:'Synthetic factual source',label:'Synthetic no-transport statement',reading:'ai_document_review',reading_receipt_sha256:'b'.repeat(64)};
  const unknown={state:'unknown',value:null,source:null,basis:'identified_document_reading'};
  const result=resolveTravelEntitlement({schema_version:'travel-entitlement-input-v1',catalog_id:'il.review.travel.general.2026',catalog_version:'1.0.0',
   case_id:'synthetic-provenance-case',run_id:'synthetic-provenance-run',check_prefix:'synthetic.provenance.travel',
   period:{from:'2026-06-01',to:'2026-06-30'},evaluated_at:'2026-09-12T00:00:00Z',
   source_manifest:[{document_id:source.document_id,version_id:source.version_id,file_sha256:source.file_sha256,page_count:1,kind:'case_document',case_id:'synthetic-provenance-case'}],
   facts:{needs_transport:{state:'known',value:false,source,basis:'identified_document_reading'},employer_transport:unknown,free_travel:unknown},
   commute_days:null,discounted_daily_fare:null,monthly_pass:unknown,monthly_pass_cost:null,recorded:null,applicability:[]});
  expect(result.checks).toHaveLength(1);
  const operation=documentReviewCalculationInputSchema.parse(result.checks[0].calculation).operation;
  if(operation.kind!=='candidate_rule')throw Error('SYNTHETIC_RULE_REQUIRED');
  const {content_sha256,...draft}=operation.rule;
  const oldBinding=canonicalSha256({daily:'12.00',days:20,pass:'200.00',expected:'200.00',legacy_formula_sha256:TRAVEL_ACTUAL_COST_SPEC.content_sha256});
  expect(draft.golden_case_set_sha256).toBe(oldBinding);
  expect(createRuleSpecPackage({...draft,golden_case_set_sha256:oldBinding}).content_sha256).toBe(content_sha256);
 });
 it('keeps reference authoring modules and markers outside the product dependency graph',async()=>{
  const root=fileURLToPath(new URL('../../../../',import.meta.url));
  const result=await build({absWorkingDir:path.resolve(root),entryPoints:[fileURLToPath(new URL('./index.ts',import.meta.url))],bundle:true,
   platform:'node',format:'esm',target:'node22',packages:'external',metafile:true,write:false,minify:true,logLevel:'silent'});
  const inputs=Object.keys(result.metafile!.inputs).map(file=>file.replaceAll('\\','/'));
  expect(inputs.filter(file=>file.includes('/legal-quality/')||file.includes('/shadow/'))).toEqual([]);
  expect(result.outputFiles[0].text).not.toContain('legal.reference.il');
 });
});
