import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {sourceMonetaryComparisonSchema} from '@/engine/findings/source-comparison';
import {decodeBundle,decodeReport} from '@/server/platform/persistence/postgres/analysis/validation';
import {resolveCaseAccessDb} from '../case-access/db';
import {devFinancialPreviewEnabled} from './dev-financial-customer';
export async function readJune2026CanonicalTest(caseId:string,identityId:string,runId:string){
 z.uuid().parse(caseId);z.uuid().parse(identityId);z.uuid().parse(runId);
 if(!devFinancialPreviewEnabled())return null;
 const db=await resolveCaseAccessDb();if(!db)throw Error('JUNE_TEST_REPORT_STORE');
 const rows=await db.rpc<{value:unknown}>('case_report_june_canonical_test',{target_case:caseId,target_identity:identityId,target_run:runId});
 if(rows.length!==1||rows[0].value===null)return null;
 const row=z.object({completion:z.object({bundle:z.unknown(),report:z.unknown()}).passthrough(),comparison:z.unknown(),admission:z.unknown(),current:z.boolean()}).strict().parse(rows[0].value);
 const bundle=decodeBundle(row.completion.bundle,['minimum_wage']),report=decodeReport(row.completion.report);
 if(bundle.case_id!==caseId||bundle.analysis_run_id!==runId||report.analysis_result_sha256!==bundle.result_sha256)throw Error('JUNE_TEST_REPORT_SCOPE');
 const comparison=row.comparison===null?null:sourceMonetaryComparisonSchema.parse(row.comparison);
 if(comparison&&canonicalSha256(comparison.trace)!==canonicalSha256(bundle.topic_results[0].trace))throw Error('JUNE_TEST_REPORT_COMPARISON');
 const json=JSON.parse(Buffer.from(report.json).toString('utf8'));
 if(canonicalSha256(json.bundle)!==canonicalSha256(bundle)||canonicalSha256(json.admission)!==canonicalSha256(row.admission)
  ||canonicalSha256(json.comparison)!==canonicalSha256(comparison)||json.human_approval!==false||json.legal_activation!==false)throw Error('JUNE_TEST_REPORT_BYTES');
 return {bundle,report,current:row.current};
}
