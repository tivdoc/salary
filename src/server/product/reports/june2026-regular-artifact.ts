import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {decodeBundle,decodeReport} from '@/server/platform/persistence/postgres/analysis/validation';
import {sourceMonetaryComparisonV2Schema} from '@/engine/findings/source-comparison';
import {findingV2Schema} from '@/engine/findings/contracts';
import {resolveCaseAccessDb} from '../case-access/db';
import {reportDocumentV3Schema} from './report-document';

/** The same immutable renderer bytes that committed with the execution.
 * SQL checks ownership, publication and namespace before returning any source. */
export async function readJune2026RegularArtifact(caseId:string,identityId:string,projectionId:string){
 [caseId,identityId,projectionId].forEach(id=>z.uuid().parse(id));
 const db=await resolveCaseAccessDb();if(!db)throw Error('REGULAR_REPORT_STORE');
 const rows=await db.rpc<{value:unknown}>('june2026_regular_report_artifact',{target_case:caseId,target_identity:identityId,target_projection:projectionId});
 if(rows.length!==1||rows[0].value===null)return null;
 const row=z.object({completion:z.object({bundle:z.unknown(),report:z.unknown()}).passthrough(),execution:z.unknown(),namespace:z.enum(['real','isolated_test']),current:z.boolean(),authority_current:z.boolean(),projection_id:z.uuid()}).strict().parse(rows[0].value);
 const bundle=decodeBundle(row.completion.bundle,['minimum_wage']),report=decodeReport(row.completion.report);
 const json=z.object({schema_version:z.literal('june2026-regular-service-report-v1'),namespace:z.enum(['real','isolated_test']),
  bundle:z.unknown(),execution:z.object({case_id:z.uuid(),analysis_run_id:z.uuid(),comparison:sourceMonetaryComparisonV2Schema,finding:findingV2Schema.nullable()}).passthrough(),document:reportDocumentV3Schema}).passthrough()
  .parse(JSON.parse(Buffer.from(report.json).toString('utf8')));
 if(row.projection_id!==projectionId||report.report_id!==projectionId||bundle.case_id!==caseId||json.document.id!==projectionId
  ||json.execution.case_id!==caseId||json.execution.analysis_run_id!==bundle.analysis_run_id||json.namespace!==row.namespace
  ||json.document.execution_authority?.namespace!==row.namespace||json.document.execution_authority.analysis_run_id!==bundle.analysis_run_id
  ||report.analysis_result_sha256!==bundle.result_sha256||canonicalSha256(bundle)!==canonicalSha256(json.bundle)
  ||canonicalSha256(row.execution)!==canonicalSha256(json.execution)
  ||canonicalSha256(json.execution.comparison.trace)!==canonicalSha256(bundle.topic_results[0].trace))throw Error('REGULAR_REPORT_ARTIFACT_BINDING');
 // The definer returns only a currentness decision, never the private trust
 // registry. This is a current authority fence, not a new signature check.
 // Historical bytes remain unchanged; the HTTP layer refuses a false result.
 return {bundle,report,current:row.current&&row.authority_current,document:json.document};
}
